'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonFromJar } = require('./zip');

const MANIFEST = 'ModTheSpire.json';
const IGNORED_JARS = new Set(['modthespire.jar', 'desktop-1.0.jar', 'mts.jar']);

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeMetadata(json, jarPath) {
  const modid = String(json.modid || json.modId || json.id || '').trim();
  const dependencies = asArray(json.dependencies).map((dep) => {
    if (typeof dep === 'object' && dep !== null) return String(dep.modid || dep.id || '').trim();
    return dep;
  });
  const optional = asArray(json.optional_dependencies || json.optionalDependencies);
  return {
    modid: modid || path.basename(jarPath, path.extname(jarPath)).toLowerCase(),
    name: String(json.name || modid || path.basename(jarPath, '.jar')).trim(),
    version: String(json.version || '').trim(),
    authors: asArray(json.author_list || json.authors || json.author),
    description: String(json.description || '').trim(),
    dependencies: dependencies.filter(Boolean),
    optionalDependencies: optional.filter(Boolean),
    stsVersion: String(json.sts_version || '').trim(),
    mtsVersion: String(json.mts_version || '').trim(),
  };
}

const metadataCache = new Map();

function readModMetadata(jarPath, stat) {
  const key = jarPath.toLowerCase();
  const stamp = stat ? `${stat.size}:${stat.mtimeMs}` : '';
  const cached = metadataCache.get(key);
  if (cached && cached.stamp === stamp) return cached.metadata;

  let metadata;
  try {
    const json = readJsonFromJar(jarPath, MANIFEST);
    if (!json) {
      metadata = { parseError: `jar 内没有 ${MANIFEST}` };
    } else {
      metadata = normalizeMetadata(json, jarPath);
    }
  } catch (error) {
    metadata = { parseError: error.message };
  }
  metadataCache.set(key, { stamp, metadata });
  return metadata;
}

function listJars(dir, { recursive = false, depth = 0 } = {}) {
  const jars = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return jars;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
      if (!IGNORED_JARS.has(entry.name.toLowerCase())) jars.push(full);
    } else if (recursive && entry.isDirectory() && depth < 2) {
      jars.push(...listJars(full, { recursive: true, depth: depth + 1 }));
    }
  }
  return jars;
}

function scanLocalJars(gameDir) {
  if (!gameDir) return [];
  return listJars(path.join(gameDir, 'mods')).map((jarPath) => ({
    jarPath,
    jarName: path.basename(jarPath),
    source: 'local',
    workshopId: null,
  }));
}

function scanWorkshopJars(workshopDir) {
  if (!workshopDir || !fs.existsSync(workshopDir)) return [];
  const found = [];
  let ids;
  try {
    ids = fs.readdirSync(workshopDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const id of ids) {
    if (!id.isDirectory()) continue;
    const itemDir = path.join(workshopDir, id.name);
    let jars = listJars(itemDir);
    // 部分工坊包把 jar 放在 mods/ 子目录里。
    if (jars.length === 0) jars = listJars(path.join(itemDir, 'mods'));
    for (const jarPath of jars) {
      found.push({
        jarPath,
        jarName: path.basename(jarPath),
        source: 'workshop',
        workshopId: id.name,
      });
    }
  }
  return found;
}

function scanMods({ gameDir, workshopDir }) {
  const local = scanLocalJars(gameDir);
  const workshop = scanWorkshopJars(workshopDir);
  const all = [];

  for (const item of [...local, ...workshop]) {
    let stat = null;
    try {
      stat = fs.statSync(item.jarPath);
    } catch {
      // 文件在扫描后消失，保留条目但无法读元数据
    }
    const metadata = readModMetadata(item.jarPath, stat);
    all.push({ ...item, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0, metadata });
  }

  const byModId = new Map();
  for (const mod of all) {
    if (!mod.metadata.modid) continue;
    const key = mod.metadata.modid.toLowerCase();
    if (!byModId.has(key)) byModId.set(key, []);
    byModId.get(key).push(mod);
  }
  for (const mods of byModId.values()) {
    if (mods.length < 2) continue;
    for (const mod of mods) {
      mod.duplicateOf = mods.filter((other) => other !== mod).map((other) => other.jarName);
    }
  }

  all.sort((a, b) => {
    const an = (a.metadata.name || a.jarName).toLowerCase();
    const bn = (b.metadata.name || b.jarName).toLowerCase();
    return an.localeCompare(bn, 'zh-CN');
  });
  return all;
}

module.exports = { MANIFEST, scanMods, readModMetadata, listJars };
