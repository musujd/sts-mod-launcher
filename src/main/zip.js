'use strict';

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const stop = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 只读取 zip 的中央目录，不解压整个包。
 * 支持 stored / deflate，拒绝 ZIP64（mod jar 不会用到）。
 */
function listEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('文件太小，不是有效的 jar/zip');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('找不到 zip 中央目录');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('不支持 ZIP64 格式');

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('zip 中央目录已损坏');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error(`条目 ${entry.name} 的本地头无效`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`条目 ${entry.name} 数据越界`);
  const raw = buffer.subarray(start, end);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
      throw new Error(`条目 ${entry.name} 解压后过大`);
    }
    return zlib.inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });
  }
  throw new Error(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`);
}

function findEntry(entries, wantedName) {
  const lower = wantedName.toLowerCase();
  return (
    entries.find((entry) => entry.name.toLowerCase() === lower) ||
    entries.find((entry) => entry.name.toLowerCase().endsWith(`/${lower}`)) ||
    null
  );
}

/** 读取 jar 内的一个文本文件，找不到返回 null。 */
function readTextFromJar(jarPath, innerPath) {
  const buffer = fs.readFileSync(jarPath);
  const entries = listEntries(buffer);
  const entry = findEntry(entries, innerPath);
  if (!entry) return null;
  return readEntry(buffer, entry).toString('utf8');
}

/** 读取 jar 内的 JSON，找不到或解析失败返回 null。 */
function readJsonFromJar(jarPath, innerPath) {
  const text = readTextFromJar(jarPath, innerPath);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

module.exports = { listEntries, readEntry, readTextFromJar, readJsonFromJar };
