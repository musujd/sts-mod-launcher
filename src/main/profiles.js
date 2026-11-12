'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIST_NAME = 'main';

function mtsConfigDir(localAppData = process.env.LOCALAPPDATA) {
  if (process.env.STS_MTS_CONFIG_DIR) return path.resolve(process.env.STS_MTS_CONFIG_DIR);
  if (!localAppData) {
    const home = process.env.USERPROFILE || process.env.HOME || '.';
    return path.join(home, 'AppData', 'Local', 'ModTheSpire');
  }
  return path.join(localAppData, 'ModTheSpire');
}

function emptyStore() {
  return { defaultList: DEFAULT_LIST_NAME, lists: { [DEFAULT_LIST_NAME]: [] } };
}

/** 读取 ModTheSpire 的 mod_lists.json，保留未知字段。 */
function readModLists(dir = mtsConfigDir()) {
  const file = path.join(dir, 'mod_lists.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { ...emptyStore(), file, existed: false, raw: null };
  }
  const lists = {};
  const sourceLists = raw && typeof raw.lists === 'object' && raw.lists ? raw.lists : {};
  for (const [name, value] of Object.entries(sourceLists)) {
    if (Array.isArray(value)) lists[name] = value.map(String);
  }
  if (!Object.keys(lists).length) lists[DEFAULT_LIST_NAME] = [];
  const defaultList =
    typeof raw.defaultList === 'string' && lists[raw.defaultList] ? raw.defaultList : Object.keys(lists)[0];
  return { defaultList, lists, file, existed: true, raw };
}

function writeModLists(data, dir = mtsConfigDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mod_lists.json');
  const previous = data.raw && typeof data.raw === 'object' ? data.raw : {};
  const payload = { ...previous, defaultList: data.defaultList, lists: data.lists };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');

  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // 备份失败不应阻止保存
    }
  }
  fs.renameSync(tmp, file);
  return { file, payload };
}

function sameJar(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** 把列表里的 jar 名去重并保留原始大小写。 */
function dedupeJarNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(name));
  }
  return out;
}

function readLauncherState(file) {
  const fallback = { gameDir: null, workshopDir: null, profileMeta: {}, activeProfile: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      ...fallback,
      ...raw,
      profileMeta: raw && typeof raw.profileMeta === 'object' && raw.profileMeta ? raw.profileMeta : {},
    };
  } catch {
    return fallback;
  }
}

function writeLauncherState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- 依赖分析 ----------

function findProvider(mods, modid) {
  const key = String(modid).toLowerCase();
  return mods.filter((mod) => (mod.metadata.modid || '').toLowerCase() === key);
}

function analyze(mods, enabledJarNames, allListNames = []) {
  const enabledKeys = new Set((enabledJarNames || []).map((name) => String(name).toLowerCase()));
  const issues = [];

  const byJarName = new Map();
  for (const mod of mods) {
    const key = mod.jarName.toLowerCase();
    if (!byJarName.has(key)) byJarName.set(key, []);
    byJarName.get(key).push(mod);
  }

  for (const name of enabledJarNames || []) {
    const entries = byJarName.get(String(name).toLowerCase());
    if (!entries) {
      issues.push({
        level: 'error',
        type: 'missing-file',
        jarName: name,
        message: `列表中的 ${name} 在本地/工坊目录中不存在（mod 可能已被删除或改名）`,
      });
    } else if (entries.length > 1) {
      issues.push({
        level: 'warn',
        type: 'duplicate-jar-name',
        jarName: name,
        message: `本地 mods/ 与工坊里都存在 ${name}，ModTheSpire 只能按文件名识别其中一个`,
      });
    }
  }

  const enabled = mods.filter((mod) => enabledKeys.has(mod.jarName.toLowerCase()));
  const enabledModIds = new Map();
  for (const mod of enabled) {
    const key = (mod.metadata.modid || '').toLowerCase();
    if (!enabledModIds.has(key)) enabledModIds.set(key, []);
    enabledModIds.get(key).push(mod);
  }
  for (const [modid, group] of enabledModIds) {
    if (group.length > 1) {
      issues.push({
        level: 'warn',
        type: 'duplicate-modid',
        jarName: group[0].jarName,
        message: `同时启用了多个 modid 为 ${modid} 的 mod：${group
          .map((mod) => mod.jarName)
          .join('、')}，可能互相覆盖`,
      });
    }
  }

  for (const mod of enabled) {
    for (const dep of mod.metadata.dependencies || []) {
      const providers = findProvider(mods, dep);
      if (providers.length === 0) {
        issues.push({
          level: 'error',
          type: 'missing-dependency',
          jarName: mod.jarName,
          dependency: dep,
          message: `${mod.metadata.name || mod.jarName} 需要前置 ${dep}，但未找到对应 mod`,
        });
      } else if (!providers.some((provider) => enabledKeys.has(provider.jarName.toLowerCase()))) {
        issues.push({
          level: 'error',
          type: 'disabled-dependency',
          jarName: mod.jarName,
          dependency: dep,
          message: `${mod.metadata.name || mod.jarName} 需要前置 ${dep}（${
            providers[0].metadata.name || providers[0].jarName
          }），但前置没有启用`,
        });
      }
    }
  }

  const order = suggestedOrder(enabled, mods);
  for (const name of order.cycles) {
    issues.push({
      level: 'warn',
      type: 'dependency-cycle',
      jarName: name,
      message: `检测到循环依赖，已保留原有顺序：${name}`,
    });
  }

  const unusedLists = allListNames.filter((name) => name !== DEFAULT_LIST_NAME);
  return {
    issues,
    enabledJarNames: dedupeJarNames(enabledJarNames),
    suggestedOrder: order.names,
    enabledMods: enabled.map((mod) => mod.jarName),
    unknownLists: unusedLists,
  };
}

/**
 * 稳定拓扑排序：依赖在前，其余保持用户当前顺序。
 * 循环依赖的节点保持原顺序并记录下来。
 */
function suggestedOrder(enabledMods, allMods) {
  const byModId = new Map();
  for (const mod of allMods) {
    const key = (mod.metadata.modid || '').toLowerCase();
    if (!byModId.has(key)) byModId.set(key, []);
    byModId.get(key).push(mod);
  }
  const enabledKeys = new Set(enabledMods.map((mod) => mod.jarName.toLowerCase()));
  const order = [];
  const state = new Map(); // jarKey -> 'visiting' | 'done'
  const cycles = [];

  const visit = (mod, trail) => {
    const key = mod.jarName.toLowerCase();
    const current = state.get(key);
    if (current === 'done') return;
    if (current === 'visiting') {
      cycles.push(mod.jarName);
      return;
    }
    state.set(key, 'visiting');
    for (const dep of mod.metadata.dependencies || []) {
      const providers = byModId.get(String(dep).toLowerCase()) || [];
      for (const provider of providers) {
        if (enabledKeys.has(provider.jarName.toLowerCase())) {
          if (state.get(provider.jarName.toLowerCase()) === 'visiting') {
            cycles.push(provider.jarName);
            continue;
          }
          visit(provider, [...trail, key]);
        }
      }
    }
    state.set(key, 'done');
    order.push(mod);
  };

  for (const mod of enabledMods) visit(mod, []);
  return { names: order.map((mod) => mod.jarName), cycles: [...new Set(cycles)] };
}

/** 给定要启用的 jar 列表，补齐所有（递归）前置。 */
function withDependencies(mods, jarNames) {
  const byModId = new Map();
  for (const mod of mods) {
    const key = (mod.metadata.modid || '').toLowerCase();
    if (!byModId.has(key)) byModId.set(key, []);
    byModId.get(key).push(mod);
  }
  const byJar = new Map(mods.map((mod) => [mod.jarName.toLowerCase(), mod]));
  const result = dedupeJarNames(jarNames);
  const seen = new Set(result.map((name) => name.toLowerCase()));
  const missing = [];

  const queue = [...result];
  while (queue.length) {
    const name = queue.shift();
    const mod = byJar.get(String(name).toLowerCase());
    if (!mod) continue;
    for (const dep of mod.metadata.dependencies || []) {
      const providers = byModId.get(String(dep).toLowerCase()) || [];
      if (!providers.length) {
        missing.push({ mod: mod.jarName, dependency: dep });
        continue;
      }
      const provider = providers[0];
      if (!seen.has(provider.jarName.toLowerCase())) {
        seen.add(provider.jarName.toLowerCase());
        result.push(provider.jarName);
        queue.push(provider.jarName);
      }
    }
  }
  return { jarNames: result, missing };
}

module.exports = {
  DEFAULT_LIST_NAME,
  mtsConfigDir,
  readModLists,
  writeModLists,
  readLauncherState,
  writeLauncherState,
  analyze,
  suggestedOrder,
  withDependencies,
  dedupeJarNames,
  sameJar,
};
