'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const zip = require('../src/main/zip');
const mods = require('../src/main/mods');
const profiles = require('../src/main/profiles');
const launcher = require('../src/main/launcher');
const steam = require('../src/main/steam');
const { resolveUserData } = require('../src/main/user-data');
const hook = require('../src/main/hook');
const javaHook = require('../src/main/java-hook');

// ---------- 测试用 zip 构造 ----------

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const names = Object.keys(files);

  for (const name of names) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(files[name], 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function writeJar(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeZip({ 'ModTheSpire.json': JSON.stringify(manifest) }));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sts-launcher-test-'));
}

// ---------- 测试环境 ----------

const root = tempDir();
const gameDir = path.join(root, 'SlayTheSpire');
const workshopDir = path.join(root, 'workshop', '646570');
const mtsDir = path.join(root, 'ModTheSpire');
fs.mkdirSync(gameDir, { recursive: true });
fs.writeFileSync(path.join(gameDir, 'SlayTheSpire.exe'), 'fake');
fs.writeFileSync(path.join(gameDir, 'ModTheSpire.jar'), 'fake');

writeJar(path.join(gameDir, 'mods', 'BaseMod.jar'), {
  modid: 'basemod',
  name: 'BaseMod',
  version: '5.56.0',
  author_list: ['t-larson'],
  dependencies: [],
});
writeJar(path.join(gameDir, 'mods', 'CoolMod.jar'), {
  modid: 'coolmod',
  name: 'Cool Mod',
  version: '1.2.0',
  author_list: ['someone'],
  dependencies: ['basemod'],
});
writeJar(path.join(gameDir, 'mods', 'DepMod.jar'), {
  modid: 'depmod',
  name: 'Dep Mod',
  dependencies: ['missingmod'],
});
fs.writeFileSync(path.join(gameDir, 'mods', 'Broken.jar'), makeZip({ 'readme.txt': 'no manifest' }));
writeJar(path.join(workshopDir, '12345', 'WorkshopMod.jar'), {
  modid: 'workshopmod',
  name: 'Workshop Mod',
  version: '2.0',
  dependencies: ['basemod'],
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- zip ----------

test('zip: 可以读取 jar 内的 ModTheSpire.json', () => {
  const json = zip.readJsonFromJar(path.join(gameDir, 'mods', 'BaseMod.jar'), 'ModTheSpire.json');
  assert.equal(json.modid, 'basemod');
  assert.equal(json.version, '5.56.0');
});

test('zip: 缺失文件返回 null', () => {
  assert.equal(zip.readJsonFromJar(path.join(gameDir, 'mods', 'BaseMod.jar'), 'nope.json'), null);
});

test('zip: 损坏文件抛出可读错误', () => {
  assert.throws(() => zip.listEntries(Buffer.from('not a zip at all')), /找不到 zip 中央目录|太小/);
});

// ---------- 扫描 ----------

test('mods: 同时扫描本地 mods/ 与创意工坊目录', () => {
  const list = mods.scanMods({ gameDir, workshopDir });
  const names = list.map((mod) => mod.jarName).sort();
  assert.deepEqual(names, ['BaseMod.jar', 'Broken.jar', 'CoolMod.jar', 'DepMod.jar', 'WorkshopMod.jar']);

  const workshop = list.find((mod) => mod.jarName === 'WorkshopMod.jar');
  assert.equal(workshop.source, 'workshop');
  assert.equal(workshop.workshopId, '12345');
  assert.equal(workshop.metadata.modid, 'workshopmod');

  const broken = list.find((mod) => mod.jarName === 'Broken.jar');
  assert.match(broken.metadata.parseError, /ModTheSpire\.json/);
});

test('mods: 去重逻辑不会把 ModTheSpire.jar / desktop jar 当成 mod', () => {
  const list = mods.scanMods({ gameDir, workshopDir });
  assert.equal(list.some((mod) => /^(modthespire|desktop-1\.0)\.jar$/i.test(mod.jarName)), false);
});

// ---------- mod_lists.json ----------

test('profiles: 没有配置文件时返回 main 空列表', () => {
  const store = profiles.readModLists(path.join(root, 'empty-mts'));
  assert.equal(store.existed, false);
  assert.equal(store.defaultList, 'main');
  assert.deepEqual(store.lists.main, []);
});

test('profiles: 写入保留未知字段并生成备份', () => {
  const dir = path.join(root, 'mts-write');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mod_lists.json'),
    JSON.stringify({ defaultList: 'a', lists: { a: ['x.jar'] }, someFutureField: 42 }),
  );

  const store = profiles.readModLists(dir);
  store.lists.b = ['y.jar'];
  store.defaultList = 'b';
  profiles.writeModLists(store, dir);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'mod_lists.json'), 'utf8'));
  assert.equal(raw.someFutureField, 42);
  assert.deepEqual(raw.lists.b, ['y.jar']);
  assert.equal(raw.defaultList, 'b');
  assert.ok(fs.existsSync(path.join(dir, 'mod_lists.json.bak')));
});

// ---------- 依赖分析 ----------

function analyze(jarNames) {
  const list = mods.scanMods({ gameDir, workshopDir });
  return profiles.analyze(list, jarNames, ['main', 'other']);
}

test('analyze: 前置存在但未启用时报告 disabled-dependency', () => {
  const result = analyze(['CoolMod.jar']);
  const issue = result.issues.find((item) => item.type === 'disabled-dependency');
  assert.ok(issue);
  assert.equal(issue.dependency, 'basemod');
  assert.equal(issue.level, 'error');
});

test('analyze: 启用前置后无错误', () => {
  const result = analyze(['CoolMod.jar', 'BaseMod.jar']);
  assert.equal(result.issues.filter((item) => item.level === 'error').length, 0);
});

test('analyze: 缺失前置报告 missing-dependency', () => {
  const result = analyze(['DepMod.jar']);
  const issue = result.issues.find((item) => item.type === 'missing-dependency');
  assert.ok(issue);
  assert.equal(issue.dependency, 'missingmod');
});

test('analyze: 列表里不存在的 jar 报告 missing-file', () => {
  const result = analyze(['Gone.jar']);
  assert.ok(result.issues.some((item) => item.type === 'missing-file'));
});

test('analyze: suggestedOrder 把前置排在依赖它的 mod 前面', () => {
  const result = analyze(['CoolMod.jar', 'BaseMod.jar']);
  assert.deepEqual(result.suggestedOrder, ['BaseMod.jar', 'CoolMod.jar']);
});

test('withDependencies: 递归补齐前置并报告缺失项', () => {
  const list = mods.scanMods({ gameDir, workshopDir });
  const result = profiles.withDependencies(list, ['CoolMod.jar']);
  assert.deepEqual(new Set(result.jarNames), new Set(['CoolMod.jar', 'BaseMod.jar']));
  assert.equal(result.missing.length, 0);

  const missing = profiles.withDependencies(list, ['DepMod.jar']);
  assert.equal(missing.missing.length, 1);
  assert.equal(missing.missing[0].dependency, 'missingmod');
});

test('analyze: 同名 modid 同时启用时给出冲突警告', () => {
  const list = mods.scanMods({ gameDir, workshopDir });
  list.push({
    jarName: 'CoolMod2.jar',
    source: 'workshop',
    workshopId: '999',
    metadata: { ...list.find((mod) => mod.jarName === 'CoolMod.jar').metadata },
  });
  const result = profiles.analyze(list, ['CoolMod.jar', 'CoolMod2.jar'], ['main']);
  assert.ok(result.issues.some((item) => item.type === 'duplicate-modid'));
});

// ---------- 日志 ----------

test('logs: 提取明显的错误行并忽略噪音', () => {
  const errors = launcher.extractErrors(
    [
      'INFO starting game',
      'slf4j: something deprecated',
      'java.lang.NullPointerException: boom',
      'Caused by: java.lang.IllegalStateException',
      'INFO done',
    ].join('\n'),
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0].text, /NullPointerException/);
});

test('logs: 只允许读取 logs/ 与 ModTheSpire 配置目录下的文件', () => {
  const logDir = path.join(gameDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'ModTheSpire.log');
  fs.writeFileSync(logFile, 'ERROR boom\n');

  const data = launcher.readLog(gameDir, logFile);
  assert.match(data.text, /ERROR boom/);
  assert.equal(data.errors.length, 1);

  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  assert.throws(() => launcher.readLog(gameDir, outside), /只能读取/);
});

test('logs: 能发现并读取 sendToDevs 下的排障日志', () => {
  const dir = path.join(gameDir, 'sendToDevs');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const file = path.join(dir, 'mts_process_launch.log');
  fs.writeFileSync(file, 'ERROR: Unable to find dependency SignatureLib\n');

  const logs = launcher.listLogs(gameDir);
  assert.ok(logs.some((log) => log.file === file));
  const data = launcher.readLog(gameDir, file);
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0].text, /SignatureLib/);
});

// ---------- Steam 定位 ----------

test('steam: isGameDir 识别包含 exe / ModTheSpire.jar 的目录', () => {
  assert.equal(steam.isGameDir(gameDir), true);
  assert.equal(steam.isGameDir(root), false);
  assert.equal(steam.isModTheSpireInstalled(gameDir), true);
});

test('profiles: 默认配置档不存在时回退到第一个可用列表', () => {
  const dir = path.join(root, 'mts-default');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mod_lists.json'),
    JSON.stringify({ defaultList: 'ghost', lists: { only: [] } }),
  );
  const store = profiles.readModLists(dir);
  assert.equal(store.defaultList, 'only');
});

// ---------- 启动入口 ----------

test('steam: 本地 ModTheSpire.jar 优先，其次工坊 MTS jar，最后 mts-launcher', () => {
  assert.equal(steam.findModTheSpireJar(gameDir, workshopDir).kind, 'local');

  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SlayTheSpire.exe'), '');
  fs.writeFileSync(path.join(legacy, 'mts-launcher.jar'), '');
  assert.equal(steam.findModTheSpireJar(legacy, null).kind, 'mts-launcher');

  const mtsWorkshop = path.join(workshopDir, steam.MTS_WORKSHOP_ID);
  fs.mkdirSync(mtsWorkshop, { recursive: true });
  fs.writeFileSync(path.join(mtsWorkshop, 'ModTheSpire.jar'), '');
  assert.equal(steam.findModTheSpireJar(legacy, workshopDir).kind, 'workshop');
});

test('launcher: buildLaunchCommand 使用指定入口并附加 profile 参数', () => {
  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(path.join(legacy, 'jre', 'bin'), { recursive: true });
  fs.copyFileSync('C:\\Windows\\System32\\cmd.exe', path.join(legacy, 'jre', 'bin', 'javaw.exe'));
  const jar = path.join(workshopDir, steam.MTS_WORKSHOP_ID, 'ModTheSpire.jar');
  const built = launcher.buildLaunchCommand(legacy, '大型整合包', { mtsJar: jar });
  assert.deepEqual(built.args, [
    '-jar',
    jar,
    '--profile',
    '大型整合包',
    '--skip-launcher',
    '--skip-intro',
  ]);
  assert.match(built.command, /javaw\.exe$/i);
});

test('user-data: 默认固定为 AppData\\sts-mod-launcher，可用环境变量覆盖', () => {
  const appData = 'C:\\Users\\me\\AppData\\Roaming';
  assert.equal(resolveUserData({}, appData), path.join(appData, 'sts-mod-launcher'));
  assert.equal(
    resolveUserData({ STS_LAUNCHER_USER_DATA: 'D:\\portable' }, appData),
    path.resolve('D:\\portable'),
  );
});

// ---------- Steam 启动接管 ----------

function makeHookDir() {
  const dir = path.join(root, 'hook-game');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, hook.GAME_EXE), 'original-exe');
  fs.writeFileSync(path.join(dir, 'ModTheSpire.jar'), 'mts');
  const wrapperPath = path.join(dir, 'SteamWrapper.exe');
  fs.writeFileSync(wrapperPath, 'wrapper-exe');
  const launcherPath = path.join(dir, 'launcher.exe');
  fs.writeFileSync(launcherPath, 'launcher');
  return { dir, wrapperPath, launcherPath };
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('hook: 状态检测覆盖原版、已接管、Steam 还原失效', () => {
  const { dir, wrapperPath, launcherPath } = makeHookDir();
  const options = { wrapperPath, launcherPath };

  let current = hook.status(dir, options);
  assert.equal(current.mode, 'vanilla');
  assert.equal(current.backupExists, false);
  assert.equal(current.canInstall, true);

  const originalHash = hashFile(path.join(dir, hook.GAME_EXE));
  const wrapperHash = hashFile(wrapperPath);
  fs.copyFileSync(path.join(dir, hook.GAME_EXE), path.join(dir, hook.BACKUP_EXE));
  fs.copyFileSync(wrapperPath, path.join(dir, hook.GAME_EXE));
  fs.writeFileSync(
    path.join(dir, hook.HOOK_STATE_FILE),
    JSON.stringify({ wrapperHash, originalHash }),
  );

  current = hook.status(dir, options);
  assert.equal(current.mode, 'installed');
  assert.equal(current.installed, true);
  assert.equal(current.currentHash, wrapperHash);

  // 模拟 Steam 校验把原 exe 还回来
  fs.copyFileSync(path.join(dir, hook.BACKUP_EXE), path.join(dir, hook.GAME_EXE));
  current = hook.status(dir, options);
  assert.equal(current.mode, 'stale');
  assert.equal(current.stale, true);
  assert.equal(current.backupExists, true);
});

test('hook: 安装会备份原 exe、写入包装器/path/state，重复安装不覆盖备份', () => {
  const { dir, wrapperPath, launcherPath } = makeHookDir();
  const options = { wrapperPath, launcherPath, mtsInstalled: true };
  const originalHash = hashFile(path.join(dir, hook.GAME_EXE));
  const wrapperHash = hashFile(wrapperPath);

  assert.throws(
    () => hook.install(dir, { ...options, mtsInstalled: false }),
    /ModTheSpire/,
  );

  const installed = hook.install(dir, options);
  assert.equal(installed.mode, 'installed');
  assert.equal(hashFile(path.join(dir, hook.BACKUP_EXE)), originalHash);
  assert.equal(hashFile(path.join(dir, hook.GAME_EXE)), wrapperHash);
  assert.equal(
    fs.readFileSync(path.join(dir, hook.LAUNCHER_PATH_FILE), 'utf8').trim(),
    launcherPath,
  );

  const state = JSON.parse(fs.readFileSync(path.join(dir, hook.HOOK_STATE_FILE), 'utf8'));
  assert.equal(state.wrapperHash, wrapperHash);
  assert.equal(state.originalHash, originalHash);

  hook.install(dir, options);
  assert.equal(hashFile(path.join(dir, hook.BACKUP_EXE)), originalHash);
});

test('hook: 卸载只在已接管时恢复原 exe，Steam 还原时保留备份', () => {
  const { dir, wrapperPath, launcherPath } = makeHookDir();
  const options = { wrapperPath, launcherPath, mtsInstalled: true };
  const originalHash = hashFile(path.join(dir, hook.GAME_EXE));

  hook.install(dir, options);
  const removed = hook.remove(dir, options);
  assert.equal(removed.removed, true);
  assert.equal(removed.restored, true);
  assert.equal(hashFile(path.join(dir, hook.GAME_EXE)), originalHash);
  assert.equal(fs.existsSync(path.join(dir, hook.LAUNCHER_PATH_FILE)), false);
  assert.equal(fs.existsSync(path.join(dir, hook.HOOK_STATE_FILE)), false);
  assert.ok(fs.existsSync(path.join(dir, hook.BACKUP_EXE)));
  assert.equal(hook.status(dir, options).mode, 'vanilla');

  // 再次安装，然后模拟 Steam 校验还原；卸载不应覆盖当前 exe，也不删除备份。
  hook.install(dir, options);
  fs.copyFileSync(path.join(dir, hook.BACKUP_EXE), path.join(dir, hook.GAME_EXE));
  const staleRemove = hook.remove(dir, options);
  assert.equal(staleRemove.restored, false);
  assert.equal(hashFile(path.join(dir, hook.GAME_EXE)), originalHash);
  assert.ok(fs.existsSync(path.join(dir, hook.BACKUP_EXE)));
});

test('hook: 安装失败自动回滚且不覆盖已存在的 .original', () => {
  const { dir, wrapperPath, launcherPath } = makeHookDir();
  const options = { wrapperPath, launcherPath, mtsInstalled: true };
  const gameExe = path.join(dir, hook.GAME_EXE);
  const backup = path.join(dir, hook.BACKUP_EXE);
  const originalHash = hashFile(gameExe);

  fs.writeFileSync(backup, 'preexisting-backup');
  // 让写 state 这一步失败，触发安装回滚
  fs.mkdirSync(path.join(dir, hook.HOOK_STATE_FILE));

  assert.throws(() => hook.install(dir, options));
  assert.equal(hashFile(gameExe), originalHash);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'preexisting-backup');
  assert.equal(fs.existsSync(path.join(dir, hook.LAUNCHER_PATH_FILE)), false);
});

// ---------- Steam Java 入口接管 ----------

function makeJavaHookDir() {
  const dir = path.join(root, 'java-hook-game');
  fs.rmSync(dir, { recursive: true, force: true });
  const bin = path.join(dir, 'jre', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ModTheSpire.jar'), 'mts');
  fs.writeFileSync(path.join(bin, 'javaw.exe'), 'original-javaw');
  fs.writeFileSync(path.join(bin, 'JavaWrapper.exe'), 'java-wrapper');
  fs.writeFileSync(path.join(bin, 'launcher.exe'), 'launcher');
  return {
    dir,
    bin,
    options: {
      wrapperPath: path.join(bin, 'JavaWrapper.exe'),
      launcherPath: path.join(bin, 'launcher.exe'),
      mtsInstalled: true,
    },
  };
}

test('java-hook: 安装/卸载 javaw.exe 入口并保留备份', () => {
  const { dir, bin, options } = makeJavaHookDir();
  const originalHash = hashFile(path.join(bin, 'javaw.exe'));

  assert.equal(javaHook.status(dir, options).mode, 'vanilla');

  const installed = javaHook.install(dir, options);
  assert.equal(installed.mode, 'installed');
  assert.equal(hashFile(path.join(bin, 'javaw.exe')), hashFile(options.wrapperPath));
  assert.equal(hashFile(path.join(bin, 'javaw.exe.original')), originalHash);
  assert.equal(hashFile(path.join(bin, 'javaw-real.exe')), originalHash);
  assert.equal(
    fs.readFileSync(path.join(bin, 'sts-launcher.path'), 'utf8').trim(),
    options.launcherPath,
  );

  const removed = javaHook.remove(dir, options);
  assert.equal(removed.restored, true);
  assert.equal(hashFile(path.join(bin, 'javaw.exe')), originalHash);
  assert.equal(fs.existsSync(path.join(bin, 'javaw-real.exe')), false);
  assert.ok(fs.existsSync(path.join(bin, 'javaw.exe.original')));
  assert.equal(javaHook.status(dir, options).mode, 'vanilla');
});

test('java-hook: Steam 还原后只清理标记并保留备份', () => {
  const { dir, bin, options } = makeJavaHookDir();
  const originalHash = hashFile(path.join(bin, 'javaw.exe'));

  javaHook.install(dir, options);
  fs.copyFileSync(path.join(bin, 'javaw.exe.original'), path.join(bin, 'javaw.exe'));

  const removed = javaHook.remove(dir, options);
  assert.equal(removed.restored, false);
  assert.equal(hashFile(path.join(bin, 'javaw.exe')), originalHash);
  assert.ok(fs.existsSync(path.join(bin, 'javaw.exe.original')));
});

test('java-hook: 安装失败回滚且不覆盖已有备份', () => {
  const { dir, bin, options } = makeJavaHookDir();
  const originalHash = hashFile(path.join(bin, 'javaw.exe'));
  fs.writeFileSync(path.join(bin, 'javaw.exe.original'), 'preexisting-javaw-backup');
  fs.mkdirSync(path.join(bin, 'sts-java-hook.json'));

  assert.throws(() => javaHook.install(dir, options));
  assert.equal(hashFile(path.join(bin, 'javaw.exe')), originalHash);
  assert.equal(
    fs.readFileSync(path.join(bin, 'javaw.exe.original'), 'utf8'),
    'preexisting-javaw-backup',
  );
  assert.equal(fs.existsSync(path.join(bin, 'sts-launcher.path')), false);
});
