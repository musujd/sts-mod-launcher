'use strict';

const path = require('path');

async function main() {
  // 国内网络优先走 npmmirror，已有 Electron 缓存时会直接复用。
  process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  const { packager } = await import('@electron/packager');

  const appPaths = await packager({
    dir: path.resolve(__dirname, '..'),
    name: '尖塔Mod启动器',
    platform: 'win32',
    arch: 'x64',
    out: path.resolve(__dirname, '..', 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/],
  });

  console.log(appPaths.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
