'use strict';

/* global window, document */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const lower = (value) => String(value ?? '').toLowerCase();
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const state = {
  snap: null,
  draft: [],
  analysis: null,
  filter: 'all',
  search: '',
  activeTab: 'diag',
  selectedLog: null,
  logData: null,
  logs: [],
  dragging: null,
  launching: false,
  hook: null,
};

let modalState = null;
let analysisSeq = 0;

// ---------- 基础 ----------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

async function call(method, ...args) {
  if (!window.api || typeof window.api[method] !== 'function') {
    throw new Error(`接口不可用：${method}`);
  }
  const result = await window.api[method](...args);
  if (!result || result.ok !== true) {
    const message = (result && result.error) || '操作失败';
    toast(message, 'error');
    throw new Error(message);
  }
  return result.data;
}

function activeName() {
  return state.snap ? state.snap.activeProfile : null;
}

function currentList() {
  return (state.snap && state.snap.lists[state.snap.activeProfile]) || [];
}

function isDirty() {
  const saved = currentList();
  if (saved.length !== state.draft.length) return true;
  return saved.some((name, index) => lower(name) !== lower(state.draft[index]));
}

function findMod(jarName) {
  if (!state.snap) return null;
  return state.snap.mods.find((mod) => lower(mod.jarName) === lower(jarName)) || null;
}

function profileMeta(name) {
  return (state.snap && state.snap.profileMeta && state.snap.profileMeta[name]) || {};
}

// ---------- 快照 ----------

function applySnapshot(snap) {
  state.snap = snap;
  state.analysis = snap.analysis;
  state.draft = [...(snap.lists[snap.activeProfile] || [])];
  if (!state.logs.length) state.logs = snap.logs || [];
  renderAll();
  refreshHookStatus();
}

function renderAll() {
  renderGameStatus();
  renderProfiles();
  renderMods();
  renderLaunchBox();
  renderDiag();
}

function renderGameStatus() {
  const paths = state.snap.paths;
  const dot = $('#game-dot');
  const label = $('#game-path');
  const note = $('#mts-note');

  if (paths.gameDir) {
    label.textContent = paths.gameDir;
    label.title = paths.gameDir;
    dot.className = `dot ${paths.mtsInstalled ? 'ok' : 'bad'}`;
  } else {
    label.textContent = '未找到游戏目录，请手动选择';
    label.title = '';
    dot.className = 'dot bad';
  }

  note.className = 'mts-note';
  if (!paths.gameDir) {
    note.textContent = '未检测到《杀戮尖塔》。点击「选择目录」，指向包含 SlayTheSpire.exe 的文件夹。';
    note.classList.add('warn');
  } else if (!paths.mtsInstalled) {
    note.textContent = '已找到游戏，但没有 ModTheSpire.jar。请先在 Steam 创意工坊订阅 ModTheSpire，或手动放入游戏目录后重新扫描。';
    note.classList.add('warn');
  } else {
    const kind =
      paths.mtsKind === 'workshop'
        ? '（Steam 工坊版）'
        : paths.mtsKind === 'mts-launcher'
          ? '（通过 mts-launcher 引导）'
          : '';
    note.textContent = `已连接 ModTheSpire${kind}${paths.workshopDir ? '，创意工坊目录已发现' : '（未发现创意工坊 mod 目录）'}。`;
  }

  renderHookButton();
}

async function refreshHookStatus() {
  if (!window.api) return;
  try {
    state.hook = await call('hookStatus');
    renderHookButton();
  } catch {
    /* call 已提示 */
  }
}

function renderHookButton() {
  const dot = $('#steam-hook-dot');
  const button = $('#btn-steam-hook');
  if (!dot || !button) return;
  const hook = state.hook;
  if (!hook) {
    dot.className = 'dot';
    button.title = 'Steam 启动接管状态未知';
    return;
  }
  const modeClass =
    hook.mode === 'installed'
      ? 'ok'
      : hook.mode === 'stale'
        ? 'warn'
        : hook.mode === 'unsupported'
          ? 'bad'
          : '';
  dot.className = `dot ${modeClass}`.trim();
  button.title = hook.message || 'Steam 启动接管';
}

async function showHookPanel() {
  await refreshHookStatus();
  const hook = state.hook;
  if (!hook) return;

  const lines = [
    `游戏目录：${hook.gameDir || '未设置'}`,
    `当前状态：${hook.message}`,
    `启动器：${hook.launcherPath}${hook.launcherExists ? '' : '（不存在）'}`,
    `原 javaw.exe 备份：${hook.backupExists ? hook.backupPath : '尚未创建'}`,
  ];

  if (hook.mode === 'installed') {
    lines.push('\n从 Steam 点「启动 with mod」会先打开启动器；点「启动原始版本」会直接进入原版游戏。');
  } else if (hook.mode === 'stale') {
    lines.push('\nSteam 校验或游戏更新还原了 javaw.exe。原备份仍在，可以重新安装接管。');
  } else if (hook.mode === 'vanilla') {
    lines.push('\n安装后，从 Steam 点「启动 with mod」会先打开启动器；「启动原始版本」不受影响。');
  } else {
    lines.push('\n请先在上方选择正确的游戏目录。');
  }
  lines.push(
    '\n安装会替换游戏内置 JRE 的 jre\\bin\\javaw.exe；只拦截「启动 with mod」，原版启动仍直接进游戏。Steam 校验或游戏更新会还原它；个别杀毒软件可能误报。卸载会把原文件恢复回来。',
  );

  const actionLabel =
    hook.mode === 'installed'
      ? '卸载接管'
      : hook.canInstall
        ? hook.mode === 'stale'
          ? '重新安装接管'
          : '安装接管'
        : '';

  await openModal({
    title: 'Steam 启动接管',
    text: lines.join('\n'),
    okText: '关闭',
    extraLabel: actionLabel,
    onExtra: () => {
      if (hook.mode === 'installed') confirmHookRemove();
      else confirmHookInstall();
    },
  });
}

async function confirmHookInstall() {
  settleModal(null);
  const confirmed = await openModal({
    title: '确认安装 Steam 启动接管',
    text: [
      '这会把游戏内置 JRE 的 jre\\bin\\javaw.exe 替换成一个很小的启动包装器：',
      '• 原文件备份为 javaw.exe.original',
      '• 从 Steam 点「启动 with mod」会先打开启动器',
      '• 「启动原始版本」仍然直接进入原版游戏',
      '• Steam 校验文件或游戏更新会还原 javaw.exe，需要重新安装接管',
      '• 个别杀毒软件可能误报',
      '• 随时可以在「Steam 接管」里卸载，恢复原文件',
      '',
      '游戏正在运行时请先退出。',
    ].join('\n'),
    okText: '确认安装',
  });
  if (!confirmed) return;

  try {
    const status = await call('installHook');
    state.hook = status;
    renderHookButton();
    toast('Steam 启动接管已安装', 'ok');
  } catch {
    /* call 已提示 */
  }
  await showHookPanel();
}

async function confirmHookRemove() {
  settleModal(null);
  const confirmed = await openModal({
    title: '确认卸载 Steam 启动接管',
    text: [
      '会删除 JRE 里的启动包装器，并恢复 javaw.exe.original。',
      '如果 Steam 已经还原了 javaw.exe，则只清理接管标记，不会覆盖当前文件。',
      '卸载后从 Steam 启动会直接进入原版游戏。',
    ].join('\n'),
    okText: '确认卸载',
  });
  if (!confirmed) return;

  try {
    const result = await call('removeHook');
    state.hook = result.status;
    renderHookButton();
    toast(
      result.restored ? '已卸载并恢复原 exe' : '已清理接管标记（Steam 已还原 exe）',
      'ok',
    );
  } catch {
    /* call 已提示 */
  }
  await showHookPanel();
}

// ---------- 配置档 ----------

function renderProfiles() {
  const container = $('#profile-list');
  container.innerHTML = '';
  const entries = Object.entries(state.snap.lists);

  for (const [name, jarNames] of entries) {
    const card = document.createElement('div');
    card.className = `profile-card ${name === state.snap.activeProfile ? 'active' : ''}`;
    card.dataset.name = name;
    const desc = profileMeta(name).description || '';
    card.innerHTML = `
      <div class="profile-name-row">
        <span class="profile-name">${esc(name)}</span>
        ${name === state.snap.activeProfile && isDirty() ? '<span class="unsaved-mark" title="有未保存修改"></span>' : ''}
        <span class="profile-count">${jarNames.length}</span>
      </div>
      <div class="profile-desc">${esc(desc || '未填写说明')}</div>
    `;
    container.append(card);
  }
}

async function selectProfile(name) {
  if (name === state.snap.activeProfile) return;
  if (isDirty() && !window.confirm('当前组合有未保存的修改，切换配置档会丢失这些修改。继续吗？')) return;
  try {
    const snap = await call('selectProfile', name);
    applySnapshot(snap);
  } catch {
    /* call 已提示 */
  }
}

async function newProfile() {
  const result = await openModal({
    title: '新建 Mod 组合',
    text: '为这套 mod 组合取个名字，之后可以一键切换。',
    input: true,
    placeholder: '例如：纯净原版 / 大型整合包',
    checkLabel: '复制当前组合的 mod 列表',
    check: true,
  });
  if (!result || !result.value) return;
  try {
    const snap = await call('createProfile', result.value, result.checked ? activeName() : null);
    applySnapshot(snap);
    toast(`已创建组合「${result.value}」`, 'ok');
  } catch {
    /* handled */
  }
}

async function duplicateProfile() {
  try {
    const snap = await call('duplicateProfile', activeName());
    applySnapshot(snap);
    toast('已复制当前组合', 'ok');
  } catch {
    /* handled */
  }
}

async function renameProfile() {
  const current = activeName();
  const result = await openModal({
    title: '重命名组合',
    text: '只会修改启动器与 ModTheSpire 列表中的名称。',
    input: true,
    value: current,
  });
  if (!result || !result.value || result.value === current) return;
  try {
    const snap = await call('renameProfile', current, result.value);
    applySnapshot(snap);
    toast('已重命名', 'ok');
  } catch {
    /* handled */
  }
}

async function deleteProfile() {
  const current = activeName();
  if (!window.confirm(`确定删除组合「${current}」吗？\n只删除这套组合配置，不会删除 mod 文件。`)) return;
  try {
    const snap = await call('deleteProfile', current);
    applySnapshot(snap);
    toast('已删除组合', 'ok');
  } catch {
    /* handled */
  }
}

async function editDescription() {
  const current = activeName();
  const result = await openModal({
    title: '组合说明',
    text: '写一句备注，方便区分不同组合。',
    textarea: true,
    value: profileMeta(current).description || '',
    placeholder: '例如：只开 QoL mod，冲进阶 20',
  });
  if (!result) return;
  try {
    const snap = await call('updateProfileMeta', current, result.value);
    applySnapshot(snap);
  } catch {
    /* handled */
  }
}

// ---------- Mod 列表 ----------

function matchesSearch(mod) {
  if (!state.search) return true;
  const meta = mod.metadata || {};
  const haystack = [meta.name, meta.modid, mod.jarName, ...(meta.authors || [])].join(' ').toLowerCase();
  return haystack.includes(state.search.toLowerCase());
}

function modMetaLine(mod) {
  if (mod.missing) return '该 mod 已不在本地 mods/ 或创意工坊目录中';
  const meta = mod.metadata || {};
  const bits = [];
  if (meta.modid) bits.push(meta.modid);
  if (meta.authors && meta.authors.length) bits.push(meta.authors.join(' / '));
  if (!bits.length) bits.push(mod.jarName);
  return bits.join(' · ');
}

function modNameMap() {
  const map = new Map();
  const list = state.snap ? state.snap.mods : [];
  for (const mod of list) {
    const id = lower(mod.metadata && mod.metadata.modid);
    if (id && !map.has(id)) map.set(id, (mod.metadata && mod.metadata.name) || mod.jarName);
  }
  return map;
}

function enabledModIdSet() {
  const enabledKeys = new Set(state.draft.map(lower));
  const ids = new Set();
  for (const mod of state.snap ? state.snap.mods : []) {
    if (!enabledKeys.has(lower(mod.jarName))) continue;
    const id = lower(mod.metadata && mod.metadata.modid);
    if (id) ids.add(id);
  }
  return ids;
}

function modCardHTML(mod, enabled, context = {}) {
  const meta = mod.metadata || {};
  const name = mod.missing ? mod.jarName : meta.name || mod.jarName;
  const names = context.names || new Map();
  const enabledModIds = context.enabledModIds || new Set();

  const dependencies = meta.dependencies || [];
  const dependencyNames = dependencies.map((dep) => names.get(lower(dep)) || dep);
  const missing = enabled
    ? dependencies
        .filter((dep) => !enabledModIds.has(lower(dep)))
        .map((dep) => names.get(lower(dep)) || dep)
    : [];
  const depsLine = dependencies.length
    ? `<div class="mod-deps ${missing.length ? 'missing-deps' : ''}" title="前置：${esc(
        dependencyNames.join('、'),
      )}">前置：${esc(dependencyNames.join('、'))}${
        missing.length ? ` · 缺少 ${esc(missing.join('、'))}` : ''
      }</div>`
    : '';
  const descLine = meta.description
    ? `<div class="mod-desc" title="${esc(meta.description)}">${esc(meta.description)}</div>`
    : '';

  let warning = '';
  if (mod.missing) warning = '';
  else if (meta.parseError) warning = `元数据读取失败：${meta.parseError}`;
  else if (mod.duplicateOf && mod.duplicateOf.length) warning = `同名 mod 冲突：${mod.duplicateOf.join('、')}`;

  const source = mod.missing
    ? '<span class="source-tag local" style="color:var(--red);background:rgba(224,108,108,.12)">缺失</span>'
    : `<span class="source-tag ${mod.source}">${mod.source === 'workshop' ? '工坊' : '本地'}</span>`;

  return `
    <div class="mod-card ${enabled ? 'is-enabled' : ''} ${mod.missing ? 'missing' : ''}"
         data-jar="${esc(mod.jarName)}" ${enabled && !mod.missing ? 'draggable="true"' : ''}>
      <input type="checkbox" ${enabled ? 'checked' : ''} title="${enabled ? '禁用' : '启用'}">
      <div class="mod-main">
        <div class="mod-title">
          <span class="mod-name">${esc(name)}</span>
          ${meta.version ? `<span class="mod-version">${esc(meta.version)}</span>` : ''}
          ${source}
        </div>
        <div class="mod-meta">${esc(modMetaLine(mod))}</div>
        ${depsLine}
        ${warning ? `<div class="mod-warn">${esc(warning)}</div>` : ''}
        ${descLine}
      </div>
      ${enabled && !mod.missing ? '<span class="drag-handle" title="拖拽调整加载顺序">⋮⋮</span>' : ''}
    </div>
  `;
}

function renderMods() {
  if (!state.snap) return;
  const scroll = $('#mods-scroll');
  const scrollTop = scroll.scrollTop;
  const enabledKeys = new Set(state.draft.map(lower));
  const byJar = new Map();
  for (const mod of state.snap.mods) {
    if (!byJar.has(lower(mod.jarName))) byJar.set(lower(mod.jarName), mod);
  }

  const enabledItems = state.draft.map((name) => byJar.get(lower(name)) || {
    jarName: name,
    missing: true,
    source: 'local',
    metadata: {},
  });
  const disabledItems = state.snap.mods.filter((mod) => !enabledKeys.has(lower(mod.jarName)));

  const visibleEnabled = enabledItems.filter(matchesSearch);
  const visibleDisabled = disabledItems.filter(matchesSearch);

  const enabledGroup = $('#enabled-group');
  const disabledGroup = $('#disabled-group');
  enabledGroup.hidden = state.filter === 'disabled';
  $('#enabled-list').hidden = state.filter === 'disabled';
  disabledGroup.hidden = state.filter === 'enabled';
  $('#disabled-list').hidden = state.filter === 'enabled';

  const context = { names: modNameMap(), enabledModIds: enabledModIdSet() };
  $('#enabled-list').innerHTML = visibleEnabled
    .map((mod) => modCardHTML(mod, !mod.missing, context))
    .join('');
  $('#disabled-list').innerHTML = visibleDisabled
    .map((mod) => modCardHTML(mod, false, context))
    .join('');
  $('#enabled-count').textContent = enabledItems.length;
  $('#disabled-count').textContent = disabledItems.length;
  $('#dirty-badge').hidden = !isDirty();

  const empty = $('#mods-empty');
  if (!state.snap.paths.gameDir) {
    empty.hidden = false;
    empty.textContent = '还没有找到游戏目录。点击右上角「选择目录」，选中包含 SlayTheSpire.exe 的文件夹。';
  } else if (!state.snap.mods.length) {
    empty.hidden = false;
    empty.textContent = '没有扫描到 mod。请确认游戏目录下的 mods/ 文件夹或 Steam 创意工坊里已经订阅了 mod。';
  } else if (!visibleEnabled.length && !visibleDisabled.length) {
    empty.hidden = false;
    empty.textContent = '没有匹配当前搜索/筛选条件的 mod。';
  } else {
    empty.hidden = true;
  }

  scroll.scrollTop = scrollTop;
}

async function toggleMod(jarName, enable) {
  try {
    if (enable) {
      const before = new Set(state.draft.map(lower));
      const result = await call('withDependencies', [...state.draft, jarName]);
      const canonical = (findMod(jarName) || {}).jarName || jarName;
      const added = result.jarNames.filter(
        (name) => !before.has(lower(name)) && lower(name) !== lower(jarName),
      );
      state.draft = [...state.draft, ...added, canonical];
      if (result.missing.length) {
        toast(`缺少前置：${[...new Set(result.missing.map((m) => m.dependency))].join('、')}`, 'error');
      } else if (added.length) {
        toast(`已自动启用前置：${added.join('、')}`, 'ok');
      }
    } else {
      const mod = findMod(jarName);
      const modid = lower((mod && mod.metadata && mod.metadata.modid) || '');
      const dependents = [
        ...new Set(
          state.snap.mods
            .filter((candidate) => {
              if (lower(candidate.jarName) === lower(jarName)) return false;
              if (!state.draft.some((name) => lower(name) === lower(candidate.jarName))) return false;
              return ((candidate.metadata && candidate.metadata.dependencies) || []).some(
                (dep) => lower(dep) === modid,
              );
            })
            .map((candidate) => (candidate.metadata && candidate.metadata.name) || candidate.jarName),
        ),
      ];
      if (dependents.length) {
        const ok = window.confirm(
          `以下已启用的 mod 依赖它：\n${dependents.join('、')}\n\n禁用后它们可能无法加载，仍要继续吗？`,
        );
        if (!ok) {
          renderMods();
          return;
        }
      }
      state.draft = state.draft.filter((name) => lower(name) !== lower(jarName));
    }
  } catch {
    renderMods();
    return;
  }
  renderMods();
  renderProfiles();
  renderLaunchBox();
  await refreshAnalysis();
}

async function sortByDependencies() {
  if (!state.analysis || !state.analysis.suggestedOrder) return;
  state.draft = [...state.analysis.suggestedOrder];
  renderMods();
  renderProfiles();
  renderLaunchBox();
  await refreshAnalysis();
}

function showModDetail(jarName) {
  const mod = findMod(jarName);
  if (!mod) return;
  const meta = mod.metadata || {};
  const names = modNameMap();
  const dependencyNames = (meta.dependencies || []).map((dep) => names.get(lower(dep)) || dep);
  const lines = [
    `名称：${meta.name || mod.jarName}`,
    `modid：${meta.modid || '（未知）'}`,
    `版本：${meta.version || '（未知）'}`,
    `作者：${meta.authors && meta.authors.length ? meta.authors.join('、') : '（未知）'}`,
    `来源：${mod.source === 'workshop' ? `创意工坊 ${mod.workshopId || ''}` : '本地 mods/ 文件夹'}`,
    `jar：${mod.jarName}`,
    `路径：${mod.jarPath || '（缺失）'}`,
  ];
  if (dependencyNames.length) lines.push(`前置：${dependencyNames.join('、')}`);
  if (meta.optionalDependencies && meta.optionalDependencies.length) {
    lines.push(`可选前置：${meta.optionalDependencies.join('、')}`);
  }
  if (mod.duplicateOf && mod.duplicateOf.length) {
    lines.push(`\n⚠ 同名 modid 还存在于：${mod.duplicateOf.join('、')}`);
  }
  if (meta.parseError) lines.push(`\n读取元数据失败：${meta.parseError}`);
  if (meta.description) lines.push(`\n${meta.description}`);
  openModal({
    title: meta.name || mod.jarName,
    text: lines.join('\n'),
    okText: '关闭',
    extraLabel: mod.source === 'workshop' && mod.workshopId ? '打开工坊页面' : '',
    onExtra: () => openWorkshopPage(mod.workshopId),
  });
}

async function openWorkshopPage(workshopId) {
  if (!workshopId) return;
  try {
    await call('openExternal', `steam://url/CommunityFilePage/${workshopId}`);
  } catch {
    /* call 已提示 */
  }
}

async function enableDependency(depId) {
  const provider = state.snap.mods.find(
    (mod) => lower(mod.metadata && mod.metadata.modid) === lower(depId),
  );
  if (!provider) {
    toast(`没有找到前置 ${depId}，请先在创意工坊订阅`, 'error');
    return;
  }
  if (state.draft.some((name) => lower(name) === lower(provider.jarName))) {
    toast('该前置已经启用', 'ok');
    return;
  }
  await toggleMod(provider.jarName, true);
}

// ---------- 启动与诊断 ----------

function stats() {
  const issues = (state.analysis && state.analysis.issues) || [];
  return {
    enabled: state.draft.length,
    errors: issues.filter((issue) => issue.level === 'error').length,
    warnings: issues.filter((issue) => issue.level === 'warn').length,
    issues,
  };
}

function orderDiffers(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  return a.some((name, index) => lower(name) !== lower(b[index]));
}

function renderLaunchBox() {
  if (!state.snap) return;
  const name = activeName();
  const meta = profileMeta(name);
  const { enabled, errors, warnings } = stats();
  $('#current-profile-name').textContent = name || '-';
  $('#current-profile-desc').textContent = meta.description || '（点击右侧 ✎ 添加组合说明）';

  const statsEl = $('#launch-stats');
  statsEl.innerHTML = `
    <span class="stat"><strong>${enabled}</strong> 个已启用</span>
    ${errors ? `<span class="stat err"><strong>${errors}</strong> 个错误</span>` : ''}
    ${warnings ? `<span class="stat warn"><strong>${warnings}</strong> 个警告</span>` : ''}
    ${!errors && !warnings ? '<span class="stat">依赖检查通过</span>' : ''}
  `;

  const paths = state.snap.paths;
  const canLaunch = Boolean(paths.gameDir && paths.mtsInstalled);
  $('#btn-launch').disabled = !canLaunch || state.launching;
  $('#btn-launch').textContent = state.launching ? '正在启动…' : '▶ 保存并启动游戏';
  $('#btn-save').disabled = state.launching;
  $('#btn-suggest-order').hidden = !state.analysis || !orderDiffers(state.draft, state.analysis.suggestedOrder);

  const hint = $('#launch-hint');
  hint.className = 'launch-hint';
  if (!paths.gameDir) {
    hint.textContent = '尚未设置游戏目录，先点击右上角「选择目录」。';
    hint.classList.add('error');
  } else if (!paths.mtsInstalled) {
    hint.textContent = '未检测到 ModTheSpire.jar，暂时无法启动游戏。';
    hint.classList.add('error');
  } else if (paths.mtsKind === 'mts-launcher') {
    hint.textContent = '将通过 mts-launcher 启动；若它不转发参数，可能会先显示 ModTheSpire 的选 mod 界面。';
  } else if (isDirty()) {
    hint.textContent = '有未保存的修改，启动时会先写入 ModTheSpire 列表。';
  } else {
    hint.textContent = '启动时会使用当前组合，并跳过 ModTheSpire 的选 mod 界面。';
  }
}

function renderDiag() {
  if (!state.snap) return;
  const issues = (state.analysis && state.analysis.issues) || [];
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warn');
  $('#diag-summary').textContent = issues.length
    ? `发现 ${errors.length} 个错误、${warnings.length} 个警告`
    : '';
  const list = $('#issue-list');
  list.innerHTML = issues
    .map((issue) => {
      const level = issue.level === 'error' ? 'error' : issue.level === 'warn' ? 'warn' : 'info';
      const icon = level === 'error' ? '✕' : level === 'warn' ? '!' : 'i';
      const action =
        issue.type === 'disabled-dependency' && issue.dependency
          ? `<button class="issue-action" data-dep="${esc(issue.dependency)}">启用前置</button>`
          : '';
      return `<div class="issue ${level}" data-jar="${esc(issue.jarName || '')}">
        <span class="ico">${icon}</span>
        <span class="issue-text">${esc(issue.message)}</span>
        ${action}
      </div>`;
    })
    .join('');
  $('#diag-empty').hidden = issues.length > 0;
  const badge = $('#diag-badge');
  badge.hidden = errors.length + warnings.length === 0;
  badge.textContent = errors.length + warnings.length;
  $('#diag-badge').style.background = errors.length ? 'var(--red)' : 'var(--gold)';
}

async function refreshAnalysis() {
  const seq = (analysisSeq += 1);
  try {
    const analysis = await call('analyze', state.draft);
    if (seq !== analysisSeq) return;
    state.analysis = analysis;
    renderLaunchBox();
    renderDiag();
    renderMods();
  } catch {
    /* handled */
  }
}

async function save() {
  try {
    const snap = await call('saveProfile', activeName(), state.draft);
    applySnapshot(snap);
    toast('已保存，并设为 ModTheSpire 的默认列表', 'ok');
  } catch {
    /* handled */
  }
}

async function launch() {
  if (state.launching) return;
  state.launching = true;
  renderLaunchBox();
  try {
    const result = await call('launch', activeName(), state.draft);
    applySnapshot(result.snapshot);
    toast(`游戏已启动（PID ${result.launch.pid}）`, 'ok');
    if (state.activeTab === 'logs') setTimeout(loadLogs, 5000);
  } catch {
    /* handled */
  } finally {
    state.launching = false;
    renderLaunchBox();
  }
}

function locateMod(jarName) {
  if (!jarName) return;
  state.search = '';
  state.filter = 'all';
  $('#search').value = '';
  $$('#filter button').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'all'));
  renderMods();
  const card = $$('.mod-card').find((element) => lower(element.dataset.jar) === lower(jarName));
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
}

// ---------- 日志 ----------

function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $('#tab-diag').hidden = tab !== 'diag';
  $('#tab-logs').hidden = tab !== 'logs';
  if (tab === 'logs') loadLogs();
}

async function loadLogs() {
  try {
    const logs = await call('listLogs');
    state.logs = logs;
    const select = $('#log-select');
    select.innerHTML = '';
    if (!logs.length) {
      select.append(new Option('（暂无日志）', ''));
      state.selectedLog = null;
      state.logData = null;
      renderLog();
      return;
    }
    for (const log of logs) {
      const stamp = new Date(log.mtimeMs).toLocaleString();
      select.append(new Option(`${log.name} · ${stamp}`, log.file));
    }
    const target = state.selectedLog && logs.some((log) => log.file === state.selectedLog)
      ? state.selectedLog
      : logs[0].file;
    select.value = target;
    await openLog(target);
  } catch {
    /* handled */
  }
}

async function openLog(file) {
  if (!file) return;
  try {
    const data = await call('readLog', file);
    state.selectedLog = file;
    state.logData = data;
    renderLog();
  } catch {
    state.logData = null;
    renderLog();
  }
}

function renderLog() {
  const content = $('#log-content');
  const errorsEl = $('#log-errors');
  const data = state.logData;
  if (!data) {
    errorsEl.innerHTML = '';
    content.textContent = state.logs.length ? '选择一份日志查看。' : '还没有日志。启动一次游戏后，这里会列出 logs/ 目录下的文件。';
    return;
  }
  errorsEl.innerHTML = data.errors.length
    ? data.errors
        .map((error) => `<button class="log-error" data-line="${error.line}">行 ${error.line} · ${esc(error.text)}</button>`)
        .join('')
    : '<div class="empty small" style="padding:8px;color:var(--muted)">未在日志中发现明显的错误行</div>';
  content.textContent = `${data.truncated ? '（仅显示文件末尾部分）\n\n' : ''}${data.text}`;
}

// ---------- 弹窗 ----------

function openModal(options) {
  return new Promise((resolve) => {
    modalState = { resolve, options };
    $('#modal-title').textContent = options.title || '';
    $('#modal-text').textContent = options.text || '';
    $('#modal-text').hidden = !options.text;

    const input = $('#modal-input');
    input.hidden = !options.input;
    input.value = options.value || '';
    input.placeholder = options.placeholder || '';

    const textarea = $('#modal-textarea');
    textarea.hidden = !options.textarea;
    textarea.value = options.value || '';
    textarea.placeholder = options.placeholder || '';

    $('#modal-check-wrap').hidden = !options.checkLabel;
    $('#modal-check-label').textContent = options.checkLabel || '';
    $('#modal-check').checked = Boolean(options.check);
    $('#modal-ok').textContent = options.okText || '确定';
    $('#modal-cancel').hidden = options.okText === '关闭';

    const extra = $('#modal-extra');
    extra.hidden = !options.extraLabel;
    extra.textContent = options.extraLabel || '';

    $('#modal').hidden = false;
    setTimeout(() => {
      if (options.textarea) textarea.focus();
      else if (options.input) {
        input.focus();
        input.select();
      } else {
        $('#modal-ok').focus();
      }
    }, 30);
  });
}

function settleModal(value) {
  if (!modalState) return;
  const { resolve } = modalState;
  modalState = null;
  $('#modal').hidden = true;
  $('#modal-extra').hidden = true;
  resolve(value);
}

function submitModal() {
  if (!modalState) return;
  const { options } = modalState;
  const value = options.textarea
    ? $('#modal-textarea').value
    : options.input
      ? $('#modal-input').value.trim()
      : '';
  settleModal({ value, checked: $('#modal-check').checked });
}

// ---------- 事件绑定 ----------

function bindEvents() {
  $('#btn-choose-dir').addEventListener('click', async () => {
    try {
      const snap = await call('chooseGameDir');
      if (snap) {
        applySnapshot(snap);
        toast('游戏目录已更新', 'ok');
      }
    } catch {
      /* handled */
    }
  });

  $('#btn-rescan').addEventListener('click', async () => {
    try {
      const snap = await call('rescan');
      applySnapshot(snap);
      toast('已重新扫描 mod', 'ok');
    } catch {
      /* handled */
    }
  });

  $('#btn-steam-hook').addEventListener('click', showHookPanel);

  $('#game-path').addEventListener('click', () => {
    const dir = state.snap && state.snap.paths.gameDir;
    if (dir) call('openPath', dir).catch(() => {});
  });

  $('#btn-new-profile').addEventListener('click', newProfile);
  $('#btn-dup-profile').addEventListener('click', duplicateProfile);
  $('#btn-rename-profile').addEventListener('click', renameProfile);
  $('#btn-delete-profile').addEventListener('click', deleteProfile);
  $('#btn-edit-desc').addEventListener('click', editDescription);

  $('#profile-list').addEventListener('click', (event) => {
    const card = event.target.closest('.profile-card');
    if (card) selectProfile(card.dataset.name);
  });

  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value.trim();
    renderMods();
  });

  $('#filter').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    $$('#filter button').forEach((item) => item.classList.toggle('active', item === button));
    renderMods();
  });

  for (const id of ['#enabled-list', '#disabled-list']) {
    $(id).addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      const card = checkbox.closest('.mod-card');
      if (card) toggleMod(card.dataset.jar, checkbox.checked);
    });
  }

  for (const id of ['#enabled-list', '#disabled-list']) {
    $(id).addEventListener('click', (event) => {
      if (event.target.closest('input, button, .drag-handle')) return;
      const card = event.target.closest('.mod-card');
      if (card && !card.classList.contains('missing')) {
        showModDetail(card.dataset.jar);
      }
    });
  }

  const enabledList = $('#enabled-list');
  enabledList.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.mod-card');
    if (!card) return;
    state.dragging = card.dataset.jar;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.jar);
  });
  enabledList.addEventListener('dragend', () => {
    state.dragging = null;
    $$('.mod-card').forEach((card) => card.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  enabledList.addEventListener('dragover', (event) => {
    event.preventDefault();
    const card = event.target.closest('.mod-card');
    $$('.mod-card').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    if (!card || !state.dragging) return;
    const rect = card.getBoundingClientRect();
    card.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
  });
  enabledList.addEventListener('drop', async (event) => {
    event.preventDefault();
    const card = event.target.closest('.mod-card');
    if (!card || !state.dragging) return;
    const draggedKey = lower(state.dragging);
    const from = state.draft.findIndex((name) => lower(name) === draggedKey);
    const overKey = lower(card.dataset.jar);
    let to = state.draft.findIndex((name) => lower(name) === overKey);
    if (from < 0 || to < 0) return;
    const moved = state.draft[from];
    const after = card.classList.contains('drop-after');
    state.draft.splice(from, 1);
    if (from < to) to -= 1;
    if (after) to += 1;
    state.draft.splice(to, 0, moved);
    state.dragging = null;
    renderMods();
    renderProfiles();
    renderLaunchBox();
    await refreshAnalysis();
  });

  $('#issue-list').addEventListener('click', (event) => {
    const action = event.target.closest('.issue-action');
    if (action) {
      event.stopPropagation();
      enableDependency(action.dataset.dep);
      return;
    }
    const issue = event.target.closest('.issue');
    if (issue) locateMod(issue.dataset.jar);
  });

  $('#btn-workshop').addEventListener('click', () => {
    call('openExternal', 'https://steamcommunity.com/app/646570/workshop/').catch(() => {});
  });

  $('#btn-save').addEventListener('click', save);
  $('#btn-launch').addEventListener('click', launch);
  $('#btn-suggest-order').addEventListener('click', sortByDependencies);

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  $('#log-select').addEventListener('change', (event) => openLog(event.target.value));
  $('#btn-log-refresh').addEventListener('click', loadLogs);
  $('#btn-open-logs').addEventListener('click', async () => {
    try {
      await call('openLogs');
    } catch {
      /* handled */
    }
  });

  $('#modal-ok').addEventListener('click', submitModal);
  $('#modal-cancel').addEventListener('click', () => settleModal(null));
  $('#modal-extra').addEventListener('click', () => {
    if (modalState && typeof modalState.options.onExtra === 'function') {
      modalState.options.onExtra();
    }
  });
  $('#modal').addEventListener('click', (event) => {
    if (event.target === $('#modal')) settleModal(null);
  });
  $('#modal-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalState) settleModal(null);
  });
}

// ---------- 启动 ----------

(async function init() {
  bindEvents();
  if (!window.api) {
    $('#game-path').textContent = '请在 Electron 中运行（npm start）';
    renderLog();
    return;
  }

  if (typeof window.api.onHookUpdated === 'function') {
    window.api.onHookUpdated(refreshHookStatus);
  }
  if (typeof window.api.onHookAutoInstalled === 'function') {
    window.api.onHookAutoInstalled(() => {
      toast('已自动接管 Steam「启动 with mod」', 'ok');
      refreshHookStatus();
    });
  }

  try {
    const snap = await call('snapshot');
    applySnapshot(snap);
  } catch {
    $('#game-path').textContent = '初始化失败';
  }
})();
