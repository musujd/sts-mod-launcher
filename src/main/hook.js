'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAME_EXE = 'SlayTheSpire.exe';
const BACKUP_EXE = 'SlayTheSpire.exe.original';
const LAUNCHER_PATH_FILE = 'sts-launcher.path';
const HOOK_STATE_FILE = 'sts-launcher-hook.json';
const WRAPPER_FILE = 'SteamWrapper.exe';

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
    const raw = JSON.parse(fs.readFileSync(path.join(gameDir, HOOK_STATE_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function readLauncherPath(gameDir) {
  try {
    return fs.readFileSync(path.join(gameDir, LAUNCHER_PATH_FILE), 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return null;
  }
}

function status(gameDir, options = {}) {
  const launcher = options.launcherPath || defaultLauncherPath();
  const wrapper = options.wrapperPath || wrapperPath();
  const result = {
    gameDir: gameDir || null,
    gameExe: gameDir ? path.join(gameDir, GAME_EXE) : null,
    backupPath: gameDir ? path.join(gameDir, BACKUP_EXE) : null,
    launcherPath: launcher,
    launcherExists: Boolean(launcher && fs.existsSync(launcher)),
    wrapperAvailable: Boolean(wrapper && fs.existsSync(wrapper)),
    mode: 'unsupported',
    installed: false,
    stale: false,
    backupExists: false,
    originalHash: null,
    wrapperHash: null,
    currentHash: null,
    installedAt: null,
    canInstall: false,
    canRemove: false,
    message: '',
  };

  if (!gameDir || !fs.existsSync(result.gameExe)) {
    result.message = '没有找到 SlayTheSpire.exe';
    return result;
  }

  const state = readState(gameDir);
  result.backupExists = fs.existsSync(result.backupPath);
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
      ? '接管已失效（Steam 校验或游戏更新还原了 exe），可以重新安装；原 exe 备份仍在'
      : '接管状态异常：缺少原 exe 备份，重新安装前请先确认游戏文件完整';
  } else {
    result.mode = 'vanilla';
    result.message = '未接管：Steam 启动会直接进入游戏';
  }

  result.canInstall =
    result.mode !== 'unsupported' && result.launcherExists && result.wrapperAvailable;
  if (!result.wrapperAvailable) result.message = '缺少 SteamWrapper.exe，请重新安装启动器';
  else if (!result.launcherExists) result.message = `找不到启动器：${launcher}`;

  return result;
}

function writeLauncherPath(gameDir, launcher) {
  fs.writeFileSync(path.join(gameDir, LAUNCHER_PATH_FILE), `${launcher}\r\n`, 'utf8');
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
    throw new Error('缺少 SteamWrapper.exe，请重新打包并安装启动器');
  }

  const current = status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
  if (current.mode === 'unsupported') throw new Error('游戏目录无效，找不到 SlayTheSpire.exe');

  const gameExe = path.join(gameDir, GAME_EXE);
  const backup = path.join(gameDir, BACKUP_EXE);

  if (current.mode === 'installed') {
    if (!fs.existsSync(backup)) {
      throw new Error('已接管但找不到原 exe 备份，请先用 Steam 校验游戏文件');
    }
    writeLauncherPath(gameDir, launcher);
    return status(gameDir, { launcherPath: launcher, wrapperPath: wrapper });
  }

  // 用于安装过程中任何一步失败时恢复当前 exe（即使已有旧备份，也不会把旧备份写回去）。
  const rollbackData = fs.readFileSync(gameExe);

  if (!fs.existsSync(backup)) {
    // 首次安装：只在备份不存在时创建，绝不覆盖已有备份。
    fs.copyFileSync(gameExe, backup);
  }
  const originalHash = fileHash(backup);

  const wrapperData = fs.readFileSync(wrapper);
  const wrapperHash = sha256(wrapperData);
  const temp = path.join(gameDir, `${GAME_EXE}.new`);

  try {
    fs.writeFileSync(temp, wrapperData);
    writeLauncherPath(gameDir, launcher);

    // Windows 上 rename 到已存在的文件会失败，先移除原 exe（已有备份）。
    fs.rmSync(gameExe, { force: true });
    fs.renameSync(temp, gameExe);

    fs.writeFileSync(
      path.join(gameDir, HOOK_STATE_FILE),
      JSON.stringify(
        {
          wrapperHash,
          originalHash,
          originalSize: fs.statSync(backup).size,
          installedAt: new Date().toISOString(),
          launcherPath: launcher,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    // 失败回滚：优先写回安装前的 exe 内容；绝不覆盖已有 .original 备份。
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
      // 忽略清理失败
    }
    try {
      fs.rmSync(path.join(gameDir, LAUNCHER_PATH_FILE), { force: true });
    } catch {
      // 忽略清理失败
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
  if (current.mode === 'unsupported') throw new Error('游戏目录无效，找不到 SlayTheSpire.exe');
  if (current.mode === 'vanilla') throw new Error('当前没有安装 Steam 启动接管');

  const gameExe = path.join(gameDir, GAME_EXE);
  const backup = path.join(gameDir, BACKUP_EXE);
  const state = readState(gameDir);
  let restored = false;

  if (current.mode === 'installed') {
    if (!fs.existsSync(backup)) {
      throw new Error('找不到原 exe 备份，已停止恢复。请用 Steam 校验游戏文件。');
    }
    const backupHash = fileHash(backup);
    if (state && state.originalHash && backupHash !== state.originalHash) {
      throw new Error('原 exe 备份校验失败，已停止恢复。请用 Steam 校验游戏文件。');
    }
    fs.copyFileSync(backup, gameExe);
    restored = true;
  }
  // stale（Steam 已还原）时保留当前 exe 与备份，只清理接管标记。

  fs.rmSync(path.join(gameDir, LAUNCHER_PATH_FILE), { force: true });
  fs.rmSync(path.join(gameDir, HOOK_STATE_FILE), { force: true });

  return {
    removed: true,
    restored,
    status: status(gameDir, { launcherPath: launcher, wrapperPath: wrapper }),
  };
}

module.exports = {
  GAME_EXE,
  BACKUP_EXE,
  LAUNCHER_PATH_FILE,
  HOOK_STATE_FILE,
  WRAPPER_FILE,
  defaultLauncherPath,
  wrapperPath,
  readLauncherPath,
  status,
  install,
  remove,
};
