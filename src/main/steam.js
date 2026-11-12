'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ID = '646570';
const MTS_WORKSHOP_ID = '1605060445';

function queryRegistryValue(key, valueName) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const match = out.match(new RegExp(`\\s${valueName}\\s+REG_[A-Z_]+\\s+(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function steamRoots() {
  const roots = new Set();
  const candidates = [
    queryRegistryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    queryRegistryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    queryRegistryValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) roots.add(path.resolve(candidate));
  }
  return [...roots];
}

/** 解析 libraryfolders.vdf，返回这库里的 steamapps 目录。 */
function librarySteamApps(steamRoot) {
  const result = new Set();
  result.add(path.join(steamRoot, 'steamapps'));

  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  if (!fs.existsSync(vdfPath)) return [...result];
  let text;
  try {
    text = fs.readFileSync(vdfPath, 'utf8');
  } catch {
    return [...result];
  }
  const pathRe = /"path"\s+"([^"]+)"/gi;
  let match;
  while ((match = pathRe.exec(text)) !== null) {
    const library = match[1].replace(/\\\\/g, '\\');
    result.add(path.join(library, 'steamapps'));
  }
  return [...result];
}

function isGameDir(dir) {
  if (!dir) return false;
  return (
    fs.existsSync(path.join(dir, 'SlayTheSpire.exe')) ||
    fs.existsSync(path.join(dir, 'desktop-1.0.jar')) ||
    fs.existsSync(path.join(dir, 'ModTheSpire.jar')) ||
    fs.existsSync(path.join(dir, 'mts-launcher.jar'))
  );
}

function isModTheSpireInstalled(dir) {
  if (!dir) return false;
  return (
    fs.existsSync(path.join(dir, 'ModTheSpire.jar')) ||
    fs.existsSync(path.join(dir, 'mts-launcher.jar'))
  );
}

function findWorkshopMtsJar(workshopDir) {
  if (!workshopDir) return null;
  const known = path.join(workshopDir, MTS_WORKSHOP_ID, 'ModTheSpire.jar');
  if (fs.existsSync(known)) return known;
  let items;
  try {
    items = fs.readdirSync(workshopDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const candidate = path.join(workshopDir, item.name, 'ModTheSpire.jar');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 找出真正能接收 --profile 的 ModTheSpire 入口。
 * 优先级：本地 ModTheSpire.jar → 工坊 1605060445 里的 ModTheSpire.jar → mts-launcher.jar。
 * 注意 mts-launcher.jar 只是 Steam 引导器，不解析 --profile 参数。
 */
function findModTheSpireJar(gameDir, workshopDir) {
  if (gameDir) {
    const local = path.join(gameDir, 'ModTheSpire.jar');
    if (fs.existsSync(local)) return { path: local, kind: 'local' };
  }
  const workshop = findWorkshopMtsJar(workshopDir);
  if (workshop) return { path: workshop, kind: 'workshop' };
  if (gameDir) {
    const launcher = path.join(gameDir, 'mts-launcher.jar');
    if (fs.existsSync(launcher)) return { path: launcher, kind: 'mts-launcher' };
  }
  return null;
}

/**
 * 自动寻找游戏与创意工坊目录。
 * 返回 { gameDir, workshopDir, steamApps, mtsInstalled, detected }，找不到时 gameDir 为 null。
 */
function detectInstall() {
  for (const root of steamRoots()) {
    for (const steamApps of librarySteamApps(root)) {
      const gameDir = path.join(steamApps, 'common', 'SlayTheSpire');
      if (isGameDir(gameDir)) {
        const workshopDir = path.join(steamApps, 'workshop', 'content', APP_ID);
        const mts = findModTheSpireJar(gameDir, workshopDir);
        return {
          gameDir,
          workshopDir,
          steamApps,
          mtsInstalled: Boolean(mts),
          mtsJar: mts ? mts.path : null,
          mtsKind: mts ? mts.kind : null,
          detected: true,
        };
      }
    }
  }
  return {
    gameDir: null,
    workshopDir: null,
    steamApps: null,
    mtsInstalled: false,
    mtsJar: null,
    mtsKind: null,
    detected: true,
  };
}

/** 用户手动选了游戏目录后，推导工坊目录。 */
function inferWorkshopDir(gameDir) {
  if (!gameDir) return null;
  const steamApps = path.dirname(path.dirname(gameDir)); // .../steamapps/common/<game> -> .../steamapps
  if (path.basename(steamApps).toLowerCase() !== 'steamapps') return null;
  const workshopDir = path.join(steamApps, 'workshop', 'content', APP_ID);
  return fs.existsSync(workshopDir) ? workshopDir : null;
}

module.exports = {
  APP_ID,
  MTS_WORKSHOP_ID,
  detectInstall,
  inferWorkshopDir,
  isGameDir,
  isModTheSpireInstalled,
  findModTheSpireJar,
  findWorkshopMtsJar,
  steamRoots,
};
