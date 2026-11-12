'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const steam = require('./steam');
const { scanMods } = require('./mods');
const { resolveUserData } = require('./user-data');
const hook = require('./java-hook');
const {
  mtsConfigDir,
  readModLists,
  writeModLists,
  readLauncherState,
  writeLauncherState,
  analyze,
  withDependencies,
  dedupeJarNames,
} = require('./profiles');
const launcher = require('./launcher');

let mainWindow = null;
let stateFile = null;
let state = { gameDir: null, workshopDir: null, profileMeta: {}, activeProfile: null };
let autoDetected = { gameDir: null, workshopDir: null };
let modsCache = [];

app.setPath('userData', resolveUserData(process.env, app.getPath('appData')));

function resolvePaths() {
  const gameDir = state.gameDir && steam.isGameDir(state.gameDir) ? state.gameDir : autoDetected.gameDir;
  let workshopDir = state.workshopDir;
  if (!workshopDir || !fs.existsSync(workshopDir)) {
    workshopDir = steam.inferWorkshopDir(gameDir) || autoDetected.workshopDir || null;
  }
  const mts = steam.findModTheSpireJar(gameDir, workshopDir);
  return {
    gameDir: gameDir || null,
    workshopDir: workshopDir || null,
    mtsConfigDir: mtsConfigDir(),
    mtsInstalled: Boolean(mts),
    mtsJar: mts ? mts.path : null,
    mtsKind: mts ? mts.kind : null,
    autoGameDir: autoDetected.gameDir,
  };
}

function launcherPath() {
  // 打包安装后使用当前 exe 的真实路径；源码运行时回退到约定的安装位置。
  return app.isPackaged ? process.execPath : hook.defaultLauncherPath();
}

function autoSetupHook() {
  if (!app.isPackaged || state.autoHookDone) return;
  if (!paths.gameDir || !paths.mtsInstalled) return;

  const options = {
    launcherPath: launcherPath(),
    wrapperPath: hook.wrapperPath(),
    mtsInstalled: paths.mtsInstalled,
  };

  try {
    const current = hook.status(paths.gameDir, options);
    if (current.mode !== 'vanilla' && current.mode !== 'installed') return;
    if (!current.canInstall) return;

    const wasVanilla = current.mode === 'vanilla';
    hook.install(paths.gameDir, options);
    state.autoHookDone = true;
    saveState();

    if (mainWindow) {
      mainWindow.webContents.send('hook:updated');
      if (wasVanilla) mainWindow.webContents.send('hook:auto-installed');
    }
  } catch {
    // 自动接管失败不阻塞启动，用户仍可在「Steam 接管」面板手动安装。
  }
}

function saveState() {
  writeLauncherState(stateFile, state);
}

function currentStore() {
  return readModLists(paths.mtsConfigDir);
}

function buildSnapshot() {
  paths = resolvePaths();
  modsCache = scanMods(paths);
  const store = currentStore();
  let activeProfile = state.activeProfile;
  if (!activeProfile || !store.lists[activeProfile]) activeProfile = store.defaultList;
  const enabled = store.lists[activeProfile] || [];
  const analysis = analyze(modsCache, enabled, Object.keys(store.lists));
  return {
    appVersion: app.getVersion(),
    paths,
    mods: modsCache,
    lists: store.lists,
    defaultList: store.defaultList,
    activeProfile,
    profileMeta: state.profileMeta,
    analysis,
    logs: launcher.listLogs(paths.gameDir),
  };
}

function validProfileName(store, name, exceptName) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('配置档名称不能为空');
  if (trimmed.length > 40) throw new Error('配置档名称最多 40 个字符');
  if (/[\\/:*?"<>|]/.test(trimmed)) throw new Error('配置档名称不能包含 \\ / : * ? " < > |');
  if (trimmed !== exceptName && store.lists[trimmed]) throw new Error(`配置档「${trimmed}」已存在`);
  return trimmed;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });
}

function saveProfile(profileName, jarNames) {
  const store = currentStore();
  const name = validProfileName(store, profileName, profileName);
  if (!store.lists[name]) throw new Error(`配置档「${name}」不存在`);
  store.lists[name] = dedupeJarNames(jarNames || []);
  store.defaultList = name;
  writeModLists(store, paths.mtsConfigDir);
  state.activeProfile = name;
  saveState();
  return name;
}

function registerIpc() {
  handle('app:snapshot', () => buildSnapshot());

  handle('app:chooseGameDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SlayTheSpire 安装目录（包含 ModTheSpire.jar 的目录）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    let dir = result.filePaths[0];
    const nested = path.join(dir, 'SlayTheSpire');
    if (!steam.isGameDir(dir) && steam.isGameDir(nested)) dir = nested;
    if (!steam.isGameDir(dir)) {
      throw new Error('这个目录里没有找到 SlayTheSpire.exe 或 ModTheSpire.jar，请选择游戏根目录');
    }
    state.gameDir = dir;
    state.workshopDir = steam.inferWorkshopDir(dir);
    saveState();
    return buildSnapshot();
  });

  handle('app:setGameDir', ({ dir }) => {
    if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在');
    let target = dir;
    const nested = path.join(dir, 'SlayTheSpire');
    if (!steam.isGameDir(target) && steam.isGameDir(nested)) target = nested;
    if (!steam.isGameDir(target)) throw new Error('该目录不是有效的游戏目录');
    state.gameDir = path.resolve(target);
    state.workshopDir = steam.inferWorkshopDir(state.gameDir);
    saveState();
    return buildSnapshot();
  });

  handle('app:setWorkshopDir', ({ dir }) => {
    if (dir && !fs.existsSync(dir)) throw new Error('创意工坊目录不存在');
    state.workshopDir = dir ? path.resolve(dir) : null;
    saveState();
    return buildSnapshot();
  });

  handle('app:openPath', async ({ target }) => {
    if (!target) throw new Error('缺少路径');
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
    return true;
  });

  handle('app:openExternal', async ({ url }) => {
    if (!url || !/^(https:\/\/steamcommunity\.com\/|steam:\/\/)/i.test(url)) {
      throw new Error('只允许打开 Steam 社区或 Steam 客户端链接');
    }
    await shell.openExternal(url);
    return true;
  });

  handle('app:openLogs', async () => {
    const dirs = launcher.logDirs(paths.gameDir);
    if (!dirs.length) throw new Error('还没有找到日志目录，先启动一次游戏试试');
    const result = await shell.openPath(dirs[0]);
    if (result) throw new Error(result);
    return dirs[0];
  });

  handle('steam:hookStatus', () =>
    hook.status(paths.gameDir, {
      launcherPath: launcherPath(),
      wrapperPath: hook.wrapperPath(),
    }),
  );

  handle('steam:installHook', () => {
    if (!paths.gameDir) throw new Error('还没有找到游戏目录，请先选择目录');
    if (!paths.mtsInstalled) throw new Error('未检测到 ModTheSpire，无法安装 Steam 启动接管');
    return hook.install(paths.gameDir, {
      launcherPath: launcherPath(),
      wrapperPath: hook.wrapperPath(),
      mtsInstalled: paths.mtsInstalled,
    });
  });

  handle('steam:removeHook', () => {
    if (!paths.gameDir) throw new Error('还没有找到游戏目录，请先选择目录');
    return hook.remove(paths.gameDir, {
      launcherPath: launcherPath(),
      wrapperPath: hook.wrapperPath(),
    });
  });

  handle('mods:rescan', () => buildSnapshot());

  handle('mods:analyze', ({ jarNames }) => {
    const store = currentStore();
    return analyze(modsCache, jarNames || [], Object.keys(store.lists));
  });

  handle('mods:withDependencies', ({ jarNames }) => withDependencies(modsCache, jarNames || []));

  handle('profile:select', ({ name }) => {
    const store = currentStore();
    if (!store.lists[name]) throw new Error(`配置档「${name}」不存在`);
    state.activeProfile = name;
    saveState();
    return buildSnapshot();
  });

  handle('profile:save', ({ name, jarNames }) => {
    saveProfile(name, jarNames);
    return buildSnapshot();
  });

  handle('profile:create', ({ name, copyFrom }) => {
    const store = currentStore();
    const clean = validProfileName(store, name);
    store.lists[clean] = copyFrom && store.lists[copyFrom] ? [...store.lists[copyFrom]] : [];
    store.defaultList = clean;
    state.profileMeta[clean] = {
      description: '',
      createdAt: new Date().toISOString(),
    };
    state.activeProfile = clean;
    writeModLists(store, paths.mtsConfigDir);
    saveState();
    return buildSnapshot();
  });

  handle('profile:duplicate', ({ name }) => {
    const store = currentStore();
    if (!store.lists[name]) throw new Error(`配置档「${name}」不存在`);
    let copyName = `${name} 副本`;
    let index = 2;
    while (store.lists[copyName]) {
      copyName = `${name} 副本 ${index}`;
      index += 1;
    }
    store.lists[copyName] = [...store.lists[name]];
    state.profileMeta[copyName] = { ...(state.profileMeta[name] || {}), createdAt: new Date().toISOString() };
    state.activeProfile = copyName;
    writeModLists(store, paths.mtsConfigDir);
    saveState();
    return buildSnapshot();
  });

  handle('profile:rename', ({ from, to }) => {
    const store = currentStore();
    if (!store.lists[from]) throw new Error(`配置档「${from}」不存在`);
    const clean = validProfileName(store, to, from);
    if (clean === from) return buildSnapshot();

    store.lists = Object.fromEntries(
      Object.entries(store.lists).map(([key, value]) => [key === from ? clean : key, value]),
    );
    if (store.defaultList === from) store.defaultList = clean;
    const meta = state.profileMeta[from];
    delete state.profileMeta[from];
    if (meta) state.profileMeta[clean] = meta;
    if (state.activeProfile === from) state.activeProfile = clean;
    writeModLists(store, paths.mtsConfigDir);
    saveState();
    return buildSnapshot();
  });

  handle('profile:delete', ({ name }) => {
    const store = currentStore();
    if (!store.lists[name]) throw new Error(`配置档「${name}」不存在`);
    if (Object.keys(store.lists).length <= 1) throw new Error('至少要保留一个配置档');
    delete store.lists[name];
    delete state.profileMeta[name];
    if (store.defaultList === name) store.defaultList = Object.keys(store.lists)[0];
    if (state.activeProfile === name) state.activeProfile = store.defaultList;
    writeModLists(store, paths.mtsConfigDir);
    saveState();
    return buildSnapshot();
  });

  handle('profile:updateMeta', ({ name, description }) => {
    const store = currentStore();
    if (!store.lists[name]) throw new Error(`配置档「${name}」不存在`);
    state.profileMeta[name] = { ...(state.profileMeta[name] || {}), description: String(description || '') };
    saveState();
    return buildSnapshot();
  });

  handle('game:launch', ({ profile, jarNames }) => {
    if (jarNames) saveProfile(profile, jarNames);
    const launch = launcher.launchGame(paths.gameDir, profile, {
      mtsJar: paths.mtsJar,
      mtsKind: paths.mtsKind,
    });
    return { launch, snapshot: buildSnapshot() };
  });

  handle('logs:list', () => launcher.listLogs(paths.gameDir));

  handle('logs:read', ({ file }) => launcher.readLog(paths.gameDir, file));
}

let paths = {
  gameDir: null,
  workshopDir: null,
  mtsConfigDir: mtsConfigDir(),
  mtsInstalled: false,
  autoGameDir: null,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#12141a',
    title: '尖塔 Mod 启动器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  stateFile = path.join(app.getPath('userData'), 'launcher-state.json');
  state = readLauncherState(stateFile);
  autoDetected = steam.detectInstall();
  paths = resolvePaths();
  registerIpc();
  createWindow();
  if (mainWindow) mainWindow.webContents.once('did-finish-load', autoSetupHook);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
