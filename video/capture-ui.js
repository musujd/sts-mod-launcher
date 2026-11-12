'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const port = Number(arg('--port', '9230'));
const duration = Number(arg('--duration', '57'));
const appExe = path.resolve(
  arg('--app', process.env.STS_LAUNCHER_EXE || path.join(process.env.LOCALAPPDATA || '', 'STSModLauncher', '尖塔Mod启动器.exe')),
);
const demoRoot = path.join(process.env.TMPDIR, 'video-demo');
const userData = path.join(demoRoot, 'userdata');
const mtsDir = path.join(demoRoot, 'mts');
const outDir = path.join(__dirname, 'out');
const uiRaw = path.join(outDir, 'ui-raw.mp4');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find((target) => target.type === 'page');
      if (page) return page;
    } catch {
      // 等待应用启动
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(uiRaw)) fs.rmSync(uiRaw, { force: true });

  const child = spawn(appExe, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      STS_LAUNCHER_USER_DATA: userData,
      STS_MTS_CONFIG_DIR: mtsDir,
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  let socket;
  let ffmpeg;
  try {
    const page = await waitForPage();
    socket = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };

    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = (nextId += 1);
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.bringToFront');
    await sleep(1600);

    await evaluate(`(() => {
      if (document.querySelector('#demo-cursor')) return;
      const style = document.createElement('style');
      style.textContent = \`
        #demo-cursor {
          position: fixed; left: 640px; top: 420px;
          width: 22px; height: 22px;
          border: 2px solid #f3cd85; border-radius: 50%;
          box-shadow: 0 0 0 5px rgba(224,183,108,.12), 0 0 20px rgba(224,183,108,.8);
          z-index: 99999; pointer-events: none;
          transform: translate(-50%, -50%);
          transition: left .22s ease, top .22s ease;
        }
        #demo-cursor::after {
          content: ''; position: absolute; left: 50%; top: 50%;
          width: 5px; height: 5px; border-radius: 50%;
          background: #f3cd85; transform: translate(-50%, -50%);
        }
      \`;
      document.head.append(style);
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      document.body.append(cursor);
      window.__demoMove = (x, y) => { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; };
    })()`);

    const geometry = await evaluate(`({
      dpr: window.devicePixelRatio || 1,
      sx: window.screenX || 0,
      sy: window.screenY || 0,
      ow: window.outerWidth || window.innerWidth,
      oh: window.outerHeight || window.innerHeight
    })`);

    let bounds = null;
    try {
      const windowInfo = await send('Browser.getWindowForTarget', { targetId: page.id });
      bounds = windowInfo.bounds;
    } catch {
      bounds = null;
    }
    const dpr = geometry.dpr || 1;
    const left = Math.round((bounds ? bounds.left : geometry.sx) * dpr);
    const top = Math.round((bounds ? bounds.top : geometry.sy) * dpr);
    const width = Math.round((bounds ? bounds.width : geometry.ow) * dpr);
    const height = Math.round((bounds ? bounds.height : geometry.oh) * dpr);
    if (width < 200 || height < 150) throw new Error(`窗口尺寸异常: ${width}x${height}`);

    await send('Page.bringToFront');
    await sleep(700);

    ffmpeg = spawn(
      FFMPEG,
      [
        '-y',
        '-f', 'gdigrab',
        '-framerate', '30',
        '-draw_mouse', '1',
        '-offset_x', String(left),
        '-offset_y', String(top),
        '-video_size', `${width}x${height}`,
        '-i', 'desktop',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-t', String(duration),
        '-movflags', '+faststart',
        uiRaw,
      ],
      { cwd: __dirname, stdio: ['pipe', 'ignore', 'ignore'] },
    );

    let ffmpegExited = false;
    const ffmpegDone = new Promise((resolve) => {
      ffmpeg.on('exit', () => {
        ffmpegExited = true;
        resolve();
      });
    });
    await sleep(700);

    const moveTo = async (selector) => {
      const point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (point) await evaluate(`window.__demoMove(${point.x}, ${point.y})`);
      return point;
    };

    const click = async (selector, waitAfter = 450) => {
      const point = await moveTo(selector);
      if (!point) throw new Error(`找不到元素: ${selector}`);
      await sleep(280);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await sleep(waitAfter);
    };

    const scroll = async (topValue) => {
      await evaluate(`document.querySelector('#mods-scroll').scrollTo({ top: ${topValue}, behavior: 'smooth' })`);
      await sleep(900);
    };

    const recordStart = Date.now();
    await sleep(2200);
    await click('.profile-card[data-name="大型整合包"]', 5600);
    await click('.profile-card[data-name="main"]', 3200);
    await scroll(360);
    await scroll(0);
    await click('#disabled-list .mod-card[data-jar="MissingDep.jar"] input[type="checkbox"]', 4600);
    await click('#enabled-list .mod-card[data-jar="MissingDep.jar"] input[type="checkbox"]', 3200);
    await click('#disabled-list .mod-card[data-jar="WorkshopMod.jar"] input[type="checkbox"]', 4200);
    await click('#enabled-list .mod-card[data-jar="CoolMod.jar"] .mod-name', 4600);
    await click('#modal-ok', 1600);
    await click('#btn-steam-hook', 5200);
    await click('#modal-ok', 1500);
    await click('.profile-card[data-name="纯净"]', 2800);
    await click('.profile-card[data-name="main"]', 2200);
    await moveTo('#btn-launch');
    await sleep(2400);

    while ((Date.now() - recordStart) / 1000 < duration) {
      await sleep(300);
    }

    // FFmpeg 带 -t 自己停止；等它完成 MP4 封装，避免直接 kill 造成文件损坏。
    await Promise.race([ffmpegDone, sleep(8000)]);
    if (!ffmpegExited) {
      try {
        execFileSync('taskkill', ['/PID', String(ffmpeg.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // ignore
      }
      await Promise.race([ffmpegDone, sleep(1500)]);
    }

    const captureSeconds = (Date.now() - recordStart) / 1000;
    const meta = {
      video: uiRaw,
      captureSeconds: Number(captureSeconds.toFixed(3)),
      width,
      height,
      dpr,
      bounds: { left, top, width, height },
      targetDuration: duration,
    };
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));

    try {
      socket.close();
    } catch {
      // ignore
    }
  } finally {
    if (ffmpeg && !ffmpeg.killed) {
      try {
        ffmpeg.kill();
      } catch {
        // ignore
      }
    }
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已退出
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
