'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JAVA_REL = path.join('jre', 'bin', 'javaw.exe');
const BACKUP_REL = path.join('jre', 'bin', 'javaw.exe.original');
const REAL_REL = path.join('jre', 'bin', 'javaw-real.exe');
const LAUNCHER_PATH_REL = path.join('jre', 'bin', 'sts-launcher.path');
const STATE_REL = path.join('jre', 'bin', 'sts-java-hook.json');
const WRAPPER_FILE = 'JavaWrapper.exe';

function defaultLauncherPath(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || '.', 'AppData', 'Local');
  return path.join(local, 'STSModLauncher', '尖塔Mod启动器.exe');
}

function wrapperPath() {
  return path.join(__dirname, '..', '..', 'tools', WRAPPER_FILE);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function readState(gameDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(gameDir, STATE_REL), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function readLauncherPath(gameDir) {
  try {
    return fs.readFileSync(path.join(gameDir, LAUNCHER_PATH_REL), 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return null;
  }
}

function status(gameDir, options = {}) {
  const launcher = options.launcherPath || defaultLauncherPath();
  const wrapper = options.wrapperPath || wrapperPath();
  const result = {
    gameDir: gameDir || null,
    gameExe: gameDir ? path.join(gameDir, JAVA_REL) : null,
    backupPath: gameDir ? path.join(gameDir, BACKUP_REL) : null,
    realPath: gameDir ? path.join(gameDir, REAL_REL) : null,
    launcherPath: launcher,
    launcherExists: Boolean(launcher && fs.existsSync(launcher)),
    wrapperAvailable: Boolean(wrapper && fs.existsSync(wrapper)),
    mode: 'unsupported',
    installed: false,
    stale: false,
    backupExists: false,
    realExists: false,
    originalHash: null,
    wrapperHash: null,
    currentHash: null,
    installedAt: null,
    canInstall: false,
    canRemove: false,
    message: '',
  };

  if (!gameDir || !fs.existsSync(result.gameExe)) {
    result.message = '游戏目录里没有内置 JRE（jre\\bin\\javaw.exe），无法接管 Steam 启动';
    return result;
  }

  const state = readState(gameDir);
  result.backupExists = fs.existsSync(result.backupPath);
  result.realExists = fs.existsSync(result.realPath);
  result.currentHash = fileHash(result.gameExe);
  result.originalHash = state && state.originalHash
    ? state.originalHash
    : result.backupExists
      ? fileHash(result.backupPath)
      : null;
  result.wrapperHash = fs.existsSync(wrapper) ? fileHash(wrapper) : null;
  result.installedAt = state && state.installedAt ? state.installedAt : null;

  if (result.wrapperHash && result.currentHash === result.wrapperHash) {
    result.mode = 'installed';
    result.installed = true;
    result.canRemove = true;
    result.message = '已接管：从 Steam 启动会打开启动器';
  } else if (state) {
    result.mode = 'stale';
    result.stale = true;
    result.canRemove = true;
    result.message = result.backupExists
      ? '接管已失效（Steam 校验或游戏更新还原了 javaw.exe），可以重新安装；原文件备份仍在'
      : '接管状态异常：缺少原 javaw.exe 备份，重新安装前请先用 Steam 校验游戏文件';
  } else {
    result.mode = 'vanilla';
    result.message = '未接管：Steam 启动会直接进入游戏';
  }

  result.canInstall =
    result.mode !== 'unsupported' && result.launcherExists && result.wrapperAvailable;
  if (!result.wrapperAvailable) result.message = '缺少 JavaWrapper.exe，请重新安装启动器';
  else if (!result.launcherExists) result.message = `找不到启动器：${launcher}`;

  return result;
}

function writeLauncherPath(gameDir, launcher) {
  fs.writeFileSync(path.join(gameDir, LAUNCHER_PATH_REL), `${launcher}\r\n`, 'utf8');
}

function install(gameDir, options = {}) {
  const launcher = options.launcherPath || defaultLauncherPath();
  const wrapper = options.wrapperPath || wrapperPath();

  if (!gameDir) throw new Error('未指定游戏目录');
  if (options.mtsInstalled === false) {
    throw new Error('未检测到 ModTheSpire，无法安装 Steam 启动接管');
  }
  if (!fs.existsSync(launcher)) {
    throw new Error(`找不到启动器：${launcher}。请先运行 npm run install-local。`);
  }
  if (!fs.existsSync(wrapper)) {
    throw new Error('缺少 JavaWrapper.exe，请重新打包并安装启动器');
  }

  const current = status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
  if (current.mode === 'unsupported') {
    throw new Error('游戏目录里没有内置 JRE（jre\\bin\\javaw.exe），无法接管 Steam 启动');
  }

  const gameExe = path.join(gameDir, JAVA_REL);
  const backup = path.join(gameDir, BACKUP_REL);
  const real = path.join(gameDir, REAL_REL);

  if (current.mode === 'installed') {
    if (!fs.existsSync(backup)) {
      throw new Error('已接管但找不到原 javaw.exe 备份，请先用 Steam 校验游戏文件');
    }
    writeLauncherPath(gameDir, launcher);
    return status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
  }

  // 任何一步失败时恢复当前 javaw.exe，且不覆盖已有备份。
  const rollbackData = fs.readFileSync(gameExe);
  const createdReal = !fs.existsSync(real);
  if (createdReal) fs.copyFileSync(gameExe, real);
  if (!fs.existsSync(backup)) fs.copyFileSync(gameExe, backup);
  const originalHash = fileHash(backup);

  const wrapperData = fs.readFileSync(wrapper);
  const wrapperHash = sha256(wrapperData);
  const temp = path.join(gameDir, `${JAVA_REL}.new`);

  try {
    fs.writeFileSync(temp, wrapperData);
    writeLauncherPath(gameDir, launcher);

    fs.rmSync(gameExe, { force: true });
    fs.renameSync(temp, gameExe);

    fs.writeFileSync(
      path.join(gameDir, STATE_REL),
      JSON.stringify(
        {
          wrapperHash,
          originalHash,
          createdReal,
          installedAt: new Date().toISOString(),
          launcherPath: launcher,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    try {
      fs.writeFileSync(gameExe, rollbackData);
    } catch {
      try {
        if (fs.existsSync(backup)) fs.copyFileSync(backup, gameExe);
      } catch {
        // 恢复失败时保留备份供手动恢复
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
    if (createdReal) {
      try {
        fs.rmSync(real, { force: true });
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(path.join(gameDir, LAUNCHER_PATH_REL), { force: true });
    } catch {
      // ignore
    }
    throw error;
  }

  return status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
}

function remove(gameDir, options = {}) {
  const launcher = options.launcherPath || defaultLauncherPath();
  const wrapper = options.wrapperPath || wrapperPath();
  if (!gameDir) throw new Error('未指定游戏目录');

  const current = status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
  if (current.mode === 'unsupported') throw new Error('游戏目录里没有内置 JRE（jre\\bin\\javaw.exe）');
  if (current.mode === 'vanilla') throw new Error('当前没有安装 Steam 启动接管');

  const gameExe = path.join(gameDir, JAVA_REL);
  const backup = path.join(gameDir, BACKUP_REL);
  const real = path.join(gameDir, REAL_REL);
  const state = readState(gameDir);
  let restored = false;

  if (current.mode === 'installed') {
    if (!fs.existsSync(backup)) {
      throw new Error('找不到原 javaw.exe 备份，已停止恢复。请用 Steam 校验游戏文件。');
    }
    const backupHash = fileHash(backup);
    if (state && state.originalHash && backupHash !== state.originalHash) {
      throw new Error('原 javaw.exe 备份校验失败，已停止恢复。请用 Steam 校验游戏文件。');
    }
    fs.copyFileSync(backup, gameExe);
    restored = true;
    if (state && state.createdReal) {
      try {
        fs.rmSync(real, { force: true });
      } catch {
        // ignore
      }
    }
  }
  // stale（Steam 已还原）时保留当前 javaw.exe 与备份，只清理接管标记。

  fs.rmSync(path.join(gameDir, LAUNCHER_PATH_REL), { force: true });
  fs.rmSync(path.join(gameDir, STATE_REL), { force: true });

  return {
    removed: true,
    restored,
    status: status(gameDir, { launcherPath: launcher, wrapperPath: wrapper }),
  };
}

module.exports = {
  JAVA_REL,
  BACKUP_REL,
  REAL_REL,
  LAUNCHER_PATH_REL,
  STATE_REL,
  WRAPPER_FILE,
  defaultLauncherPath,
  wrapperPath,
  readLauncherPath,
  status,
  install,
  remove,
};
