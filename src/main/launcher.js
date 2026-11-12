'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mtsConfigDir } = require('./profiles');

function findOnPath(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 跳过无权限目录
      }
    }
  }
  return null;
}

function findJava(gameDir) {
  const bundled = [
    path.join(gameDir, 'jre', 'bin', 'javaw.exe'),
    path.join(gameDir, 'jre', 'bin', 'java.exe'),
    path.join(gameDir, 'jre', 'bin', 'java'),
  ];
  for (const candidate of bundled) {
    if (fs.existsSync(candidate)) return { command: candidate, bundled: true };
  }
  const fallback = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const command = findOnPath(fallback) || findOnPath(process.platform === 'win32' ? 'java.exe' : 'java');
  return { command, bundled: false };
}

/**
 * 构造启动命令但不执行，便于测试与在界面上展示。
 * mtsJar 可以是本地 ModTheSpire.jar，也可以是工坊 1605060445 里的 ModTheSpire.jar。
 */
function buildLaunchCommand(gameDir, profileName, { mtsJar, skipLauncher = true, skipIntro = true } = {}) {
  if (!gameDir || !fs.existsSync(gameDir)) throw new Error('游戏目录不存在，请先在设置里选择正确的目录');
  const jar = mtsJar || path.join(gameDir, 'ModTheSpire.jar');
  if (!jar || !fs.existsSync(jar)) {
    throw new Error('没有找到 ModTheSpire.jar，请先安装 ModTheSpire');
  }

  const java = findJava(gameDir);
  if (!java.command) {
    throw new Error('未找到 Java：游戏目录下没有 jre/，系统 PATH 里也没有 java。请检查 ModTheSpire 安装是否完整。');
  }

  const args = ['-jar', jar];
  if (profileName) args.push('--profile', profileName);
  if (skipLauncher) args.push('--skip-launcher');
  if (skipIntro) args.push('--skip-intro');

  return { command: java.command, args, jar, bundledJava: java.bundled };
}

/**
 * 用 ModTheSpire 指定的 profile 启动游戏。
 * 返回 { pid, command, args, profile }，调用失败时抛错。
 */
function launchGame(gameDir, profileName, options = {}) {
  const built = buildLaunchCommand(gameDir, profileName, options);
  const child = spawn(built.command, built.args, {
    cwd: gameDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    // 让 Java 包装器知道这是启动器自己的子进程，直接转发给原版 javaw。
    env: { ...process.env, STS_LAUNCHER_CHILD: '1' },
  });
  // spawn 失败是异步事件；不让它冒泡成未捕获异常。
  child.on('error', () => {});
  child.unref();

  return {
    pid: child.pid,
    ...built,
    profile: profileName,
    argsForwarded: options.mtsKind !== 'mts-launcher',
  };
}

function isGameRunning() {
  // 只做轻量提示：Electron 侧不强行结束进程。
  return false;
}

// ---------- 日志 ----------

function logDirs(gameDir) {
  const dirs = [];
  if (gameDir) {
    dirs.push(path.join(gameDir, 'logs'));
    dirs.push(path.join(gameDir, 'sendToDevs', 'logs'));
    dirs.push(path.join(gameDir, 'sendToDevs'));
  }
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(mtsConfigDir(local));
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}

function listLogs(gameDir) {
  const logs = [];
  for (const dir of logDirs(gameDir)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(log|txt)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        logs.push({ file, name: entry.name, dir, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件被占用/删除，忽略
      }
    }
  }
  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60);
}

function tailFile(file, maxBytes = 320 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const start = stat.size - length;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buffer.toString('utf8'), truncated: stat.size > length, size: stat.size };
}

const ERROR_LINE = /exception|fatal|error|caused by|could not|unable to|failed|no such file|classnotfound/i;
const NOISE_LINE = /log4j|slf4j|class path contains multiple|deprecated|^\s*\d{2}:\d{2}:\d{2}[.,]\d+\s+INFO\b/i;

function extractErrors(text, limit = 120) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (!ERROR_LINE.test(line) || NOISE_LINE.test(line)) return;
    if (hits.length >= limit) return;
    hits.push({ line: index + 1, text: line.trim().slice(0, 500) });
  });
  return hits;
}

function readLog(gameDir, file) {
  if (!file) throw new Error('未指定日志文件');
  const resolved = path.resolve(file);
  const allowed = logDirs(gameDir).some((dir) => {
    const rel = path.relative(dir, resolved);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!allowed) throw new Error('只能读取游戏 logs/ 与 ModTheSpire 配置目录下的日志');
  const tail = tailFile(resolved);
  return {
    file: resolved,
    name: path.basename(resolved),
    ...tail,
    errors: extractErrors(tail.text),
  };
}

module.exports = { launchGame, buildLaunchCommand, findJava, listLogs, readLog, extractErrors, isGameRunning, logDirs };
