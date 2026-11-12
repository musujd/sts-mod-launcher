'use strict';

const fs = require('fs');
const path = require('path');
const javaHook = require('../src/main/java-hook');

const root = path.join(process.env.TMPDIR, 'video-demo');
fs.rmSync(root, { recursive: true, force: true });

const game = path.join(root, 'game');
const workshop = path.join(root, 'workshop', '646570');
const mts = path.join(root, 'mts');
const userData = path.join(root, 'userdata');
fs.mkdirSync(path.join(game, 'mods'), { recursive: true });
fs.mkdirSync(path.join(game, 'jre', 'bin'), { recursive: true });
fs.mkdirSync(path.join(workshop, '24680'), { recursive: true });
fs.mkdirSync(mts, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

fs.writeFileSync(path.join(game, 'SlayTheSpire.exe'), 'demo');
fs.writeFileSync(path.join(game, 'ModTheSpire.jar'), 'demo');
fs.writeFileSync(path.join(game, 'jre', 'bin', 'javaw.exe'), 'demo-javaw');

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
  fs.writeFileSync(file, makeZip({ 'ModTheSpire.json': JSON.stringify(manifest, null, 2) }));
}

writeJar(path.join(game, 'mods', 'BaseMod.jar'), {
  modid: 'basemod',
  name: 'BaseMod',
  version: '5.56.0',
  author_list: ['t-larson'],
  description: '所有 mod 的基础前置库。',
  dependencies: [],
});
writeJar(path.join(game, 'mods', 'CoolMod.jar'), {
  modid: 'coolmod',
  name: 'Cool Mod',
  version: '1.2.0',
  author_list: ['someone'],
  description: '一个示例 mod，依赖 BaseMod。',
  dependencies: ['basemod'],
});
writeJar(path.join(game, 'mods', 'QualityOfLife.jar'), {
  modid: 'qol',
  name: 'Quality of Life',
  version: '3.4.1',
  author_list: ['community'],
  description: '界面与操作优化合集。',
  dependencies: ['basemod'],
});
writeJar(path.join(game, 'mods', 'MissingDep.jar'), {
  modid: 'missingdep',
  name: 'Missing Dependency Mod',
  version: '0.1',
  dependencies: ['notinstalled'],
});
fs.writeFileSync(path.join(game, 'mods', 'Broken.jar'), makeZip({ 'readme.txt': 'no manifest' }));
writeJar(path.join(workshop, '24680', 'WorkshopMod.jar'), {
  modid: 'workshopmod',
  name: 'Workshop Mod',
  version: '2.0.0',
  author_list: ['steam-user'],
  description: '来自创意工坊的示例 mod。',
  dependencies: ['basemod'],
});

fs.writeFileSync(
  path.join(mts, 'mod_lists.json'),
  JSON.stringify(
    {
      defaultList: 'main',
      lists: {
        main: ['BaseMod.jar', 'CoolMod.jar', 'QualityOfLife.jar'],
        纯净: [],
        大型整合包: ['CoolMod.jar', 'WorkshopMod.jar', 'BaseMod.jar', 'MissingDep.jar'],
      },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(userData, 'launcher-state.json'),
  JSON.stringify(
    {
      gameDir: game,
      workshopDir: workshop,
      activeProfile: 'main',
      autoHookDone: true,
      profileMeta: {
        main: { description: '日常 QoL 组合' },
        纯净: { description: '不加载任何 mod' },
        大型整合包: { description: '全量 mod，启动较慢' },
      },
    },
    null,
    2,
  ),
);

const launcherPath = process.env.STS_LAUNCHER_EXE || path.join(process.env.LOCALAPPDATA || '', 'STSModLauncher', '尖塔Mod启动器.exe');
javaHook.install(game, {
  launcherPath,
  wrapperPath: path.join(__dirname, '..', 'tools', 'JavaWrapper.exe'),
  mtsInstalled: true,
});

console.log(JSON.stringify({ root, game, workshop, mts, userData, launcherPath }, null, 2));
