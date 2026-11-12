'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'out');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    stdio: options.stdio || 'inherit',
    timeout: options.timeout || 300000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function screenshot(html, output) {
  if (fs.existsSync(output)) fs.rmSync(output, { force: true });
  const profile = path.join(ASSETS, '.edge-profile');
  fs.mkdirSync(profile, { recursive: true });
  run(
    EDGE,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      '--force-device-scale-factor=1',
      '--window-size=1920,1080',
      '--virtual-time-budget=2500',
      `--screenshot=${output}`,
      pathToFileURL(html).href,
    ],
    { timeout: 60000, stdio: 'ignore' },
  );
  if (!fs.existsSync(output)) throw new Error(`Edge 截图失败: ${output}`);
}

function ensureFonts() {
  const fontDir = path.join(ASSETS, 'fonts');
  fs.mkdirSync(fontDir, { recursive: true });
  for (const name of ['msyh.ttc', 'msyhbd.ttc']) {
    const target = path.join(fontDir, name);
    if (fs.existsSync(target)) continue;
    const source = path.join('C:/Windows/Fonts', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  ensureFonts();
  const timing = JSON.parse(fs.readFileSync(path.join(ASSETS, 'timing.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
  const uiRaw = path.join(OUT, 'ui-raw.mp4');
  if (!meta.captureSeconds || !fs.existsSync(uiRaw)) throw new Error('没有录到启动器画面');

  const uiDuration = Math.max(6, Math.max(timing.duration, meta.captureSeconds));
  const total = 3 + uiDuration + 5;

  const titlePng = path.join(ASSETS, 'title.png');
  const outroPng = path.join(ASSETS, 'outro.png');
  screenshot(path.join(ASSETS, 'title.html'), titlePng);
  screenshot(path.join(ASSETS, 'outro.html'), outroPng);

  const filter = [
    `[0:v]scale=1920:1080,setsar=1,fps=30,trim=duration=3,setpts=PTS-STARTPTS[title]`,
    `[1:v]crop=iw:ih-40:0:0,scale=1400:-2:flags=lanczos,pad=1920:1080:(ow-iw)/2:30:color=0x0d0f14,fps=30,tpad=stop_mode=clone:stop_duration=3,trim=duration=${uiDuration.toFixed(3)},setpts=PTS-STARTPTS,drawbox=x=0:y=916:w=1920:h=164:color=0x0d0f14@0.6:t=fill,drawbox=x=260:y=30:w=1400:h=896:color=0x2a3141@0.9:t=2[ui]`,
    `[2:v]scale=1920:1080,setsar=1,fps=30,trim=duration=5,setpts=PTS-STARTPTS[outro]`,
    `[title][ui][outro]concat=n=3:v=1:a=0[base]`,
    `[base]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.6).toFixed(3)}:d=0.6,subtitles=assets/subtitles.ass:fontsdir=assets/fonts[v]`,
    `[3:a]adelay=3000|3000,apad=pad_dur=5,afade=t=in:st=3:d=0.3,afade=t=out:st=${(3 + timing.duration - 0.7).toFixed(3)}:d=0.7[a]`,
  ].join(';');

  const final = path.join(OUT, '尖塔Mod启动器-分享视频.mp4');
  run(FFMPEG, [
    '-y',
    '-loop', '1', '-t', '3', '-i', titlePng,
    '-i', uiRaw,
    '-loop', '1', '-t', '5', '-i', outroPng,
    '-i', path.join(ASSETS, 'voice.mp3'),
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '[a]',
    '-t', total.toFixed(3),
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    final,
  ]);

  const previews = [
    ['preview-title.png', 1.5],
    ['preview-mods.png', 8],
    ['preview-deps.png', Math.min(22, total - 2)],
    ['preview-hook.png', Math.min(42, total - 2)],
    ['preview-outro.png', Math.max(0, total - 1.2)],
  ];
  for (const [name, at] of previews) {
    run(FFMPEG, ['-y', '-ss', String(at), '-i', final, '-frames:v', '1', path.join(OUT, name)]);
  }

  console.log(
    JSON.stringify(
      {
        output: final,
        title: titlePng,
        outro: outroPng,
        ui: uiRaw,
        voiceDuration: timing.duration,
        uiDuration: Number(uiDuration.toFixed(3)),
        total: Number(total.toFixed(3)),
        previews: previews.map(([name]) => path.join(OUT, name)),
      },
      null,
      2,
    ),
  );
}

main();
