'use strict';

const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, '..', 'dist', '尖塔Mod启动器-win32-x64');
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local');
const target = path.join(localAppData, 'STSModLauncher');
const exe = path.join(target, '尖塔Mod启动器.exe');

if (!fs.existsSync(source)) {
  console.error('找不到打包产物，请先运行：npm run package');
  process.exit(1);
}

try {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
} catch (error) {
  if (error.code === 'EBUSY' || error.code === 'EPERM') {
    console.error('复制失败：启动器可能正在运行，请先关闭 %LOCALAPPDATA%\\STSModLauncher 下的启动器再重试。');
  } else {
    console.error(error.message);
  }
  process.exit(1);
}

if (!fs.existsSync(exe)) {
  console.error(`复制完成但找不到主程序：${exe}`);
  process.exit(1);
}

console.log(exe);
