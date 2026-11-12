'use strict';

const path = require('path');

/**
 * 固定启动器的 userData 目录，避免打包后 productName 变成中文导致配置路径变化。
 * 仍允许用 STS_LAUNCHER_USER_DATA 覆盖（便携/测试）。
 */
function resolveUserData(env, appData) {
  if (env.STS_LAUNCHER_USER_DATA) return path.resolve(env.STS_LAUNCHER_USER_DATA);
  return path.join(appData, 'sts-mod-launcher');
}

module.exports = { resolveUserData };
