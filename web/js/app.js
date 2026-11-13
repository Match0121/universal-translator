// app.js — 入口：路由 + 游戏翻译全流程编排

import { $, $$, debounce, extOf, fmtBytes, escapeHtml, downloadBlob, saveBlobDialog, pickSaveFile, writeSaveHandle, pickDirectory, writeDirFile } from './utils.js';
import { store } from './store.js';
import { parseExe } from './features/game/exeParser.js';
import { pickGameFolder, scanFolder } from './features/game/dirScanner.js';
import { extractFile, TEXT_EXT } from './features/game/extractors.js';
import { readText } from './features/game/encoding.js';
import { translateUnits, clearCache } from './features/game/translator.js';
import { renderFileList, renderFileTree, renderFileContent, showProgress, hideProgress } from './features/game/bilingView.js';
import { exportZip, exportXp3 } from './features/game/exporter.js';
import { detectDocType, extractDoc, rebuildDoc, docText, exportPdfDoc, docxToHtml, DOC_EXT } from './features/doc/docParser.js';
import { mdToHtml, textToHtml, unitsToHtml } from './features/doc/mdRender.js';
import { initImgWorkbench } from './features/img/imgWorkbench.js';
import { collectFromDataTransfer, fromFileList, makeFileInput } from './features/shared/fsDrop.js';
import { editBlockHtml, bindEditables, snapshotBases } from './features/shared/editView.js';

/* ---------------- 基础 ---------------- */

store.load();

// 图片翻译工作台
initImgWorkbench();

// 诊断钩子：页面内显示运行时错误（排查用）
window.__ut = { store, errs: [] };
function showDiag() {
  let el = document.getElementById('diagBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'diagBar';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7a1f1f;color:#ffd9d9;padding:6px 14px;font:12px/1.5 monospace;white-space:pre-wrap;word-break:break-all;';
    document.body.prepend(el);
  }
  el.textContent = '⚠ 运行时错误: ' + window.__ut.errs.join(' | ');
}
window.addEventListener('error', e => { window.__ut.errs.push(e.message); showDiag(); });
window.addEventListener('unhandledrejection', e => { window.__ut.errs.push('REJ: ' + ((e.reason && e.reason.message) || e.reason)); showDiag(); });

// 状态诊断日志（F12 控制台可见）
function diagLog(tag) {
  console.log(`[诊断:${tag}] stage=${store.state.stage} units=${store.state.units.length}`
    + ` view=${store.state.view} filter=${store.state.filter} search=${JSON.stringify(store.state.search || '')}`
    + ` cards=${document.querySelectorAll('.ut-unit').length} errs=${window.__ut.errs.length}`);
}

function showWorkspace(name) {
  $$('.ut-workspace').forEach(ws => { ws.hidden = ws.id !== 'ws-' + name; });
  $$('.ut-nav__item').forEach(b => b.classList.toggle('is-active', b.dataset.ws === name));
  // 切换工作台时刷新引擎状态（保证各拖拽框状态行均有内容且占位一致）
  if (typeof refreshEngineStatus === 'function') refreshEngineStatus();
}

function showStage(name) {
  // 只操作游戏工作台内的 stage，避免误伤文档/图片工作台的同名 class
  $$('#ws-game .ut-stage').forEach(s => { s.hidden = s.id !== 'stage-' + name; });
  store.set('stage', name);
}

function setView(view) {
  document.body.dataset.view = view;
  $$('#viewSwitch .ut-seg__item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  store.set('view', view);
  // 切视图时退出编辑态，避免“点了没反应”的困惑
  if (store.state.editing) {
    store.state.editing = false;
    const eb = $('#editToggle');
    if (eb) eb.textContent = '编辑';
  }
  // 已有内容时立即按新视图刷新当前文件
  if (store.state.units.length && !store.state.extracting && !store.state.translating) {
    renderFileContent(store.state.files, store.state.units);
  }
}

/* ---------------- 导航 ---------------- */

$('#mainNav').addEventListener('click', e => {
  const btn = e.target.closest('.ut-nav__item');
  if (btn) showWorkspace(btn.dataset.ws);
});

/* ---------------- 翻译引擎状态显示 ---------------- */

const ENGINE_INFO = {
  mymemory: { name: 'MyMemory', desc: '免费引擎，无需配置，注意每日额度', need: null },
  baidu: { name: '百度翻译', hint: '需填写 APP ID 与密钥', need: () => !!(store.state.settings.baiduAppid && store.state.settings.apiKey) },
  deepl: { name: 'DeepL', hint: '需填写 API Key', need: () => !!store.state.settings.apiKey },
  openai: { name: 'OpenAI 兼容接口', hint: '需填写接口地址与模型名', need: () => !!(store.state.settings.baseUrl && store.state.settings.model) },
};

function refreshEngineStatus() {
  const s = store.state.settings;
  const info = ENGINE_INFO[s.provider] || ENGINE_INFO.mymemory;
  const configured = info.need ? info.need() : true;
  const es = $('#engineStatus');
  const des = $('#docEngineStatus');
  const ies = $('#imgEngineStatus');
  const text = `翻译引擎：${info.name}${configured ? ' · 已配置 ✓' : ' · 待配置（右上角 ⚙ 设置）'}`;
  const color = configured ? 'var(--ok)' : 'var(--warn)';
  if (es) { es.textContent = text; es.style.color = color; }
  if (des) { des.textContent = text; des.style.color = color; }
  if (ies) { ies.textContent = text; ies.style.color = color; }
  const ps = $('#providerStatus');
  if (ps) {
    ps.textContent = info.need
      ? (configured ? '已配置 ✓，可正常翻译' : '未配置：' + info.hint)
      : info.desc;
    ps.className = 'ut-field__status' + (info.need ? (configured ? ' is-ok' : ' is-warn') : '');
  }
}

/* ---------------- 游戏：拖入文件夹 或 点击选择（一步到位） ---------------- */

const gameDropzone = $('#gameDropzone');

gameDropzone.addEventListener('click', () => pickAndScan());
gameDropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') pickAndScan();
});
['dragenter', 'dragover'].forEach(ev => gameDropzone.addEventListener(ev, e => {
  e.preventDefault();
  gameDropzone.classList.add('is-dragover');
}));
['dragleave', 'drop'].forEach(ev => gameDropzone.addEventListener(ev, e => {
  e.preventDefault();
  gameDropzone.classList.remove('is-dragover');
}));
gameDropzone.addEventListener('drop', e => {
  const flist = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
  if (!flist.length || !flist[0].webkitRelativePath) {
    alert('请拖入整个文件夹（不是单个文件）');
    return;
  }
  handleFolderDrop(flist);
});

/** 点击选择：浏览器目录授权（可写回） */
async function pickAndScan() {
  gameDropzone.classList.add('is-busy');
  try {
    const handle = await pickGameFolder();
    store.set('rootHandle', handle);
    const maxBytes = (store.state.settings.maxSizeMB || 8) * 1024 * 1024;
    const { files, exes, xp3s } = await scanFolder(handle, maxBytes);
    await handleScanResult(files, exes, xp3s);
  } catch (e) {
    if (e.name !== 'AbortError') alert('扫描失败：' + e.message);
  } finally {
    gameDropzone.classList.remove('is-busy');
  }
}

/** 拖入文件夹：直接用拖入的文件列表（无目录句柄，读取与导出不受影响） */
async function handleFolderDrop(flist) {
  gameDropzone.classList.add('is-busy');
  try {
    const maxBytes = (store.state.settings.maxSizeMB || 8) * 1024 * 1024;
    const files = [];
    const exes = [];
    const xp3s = [];
    for (const f of flist) {
      const ext = extOf(f.name);
      const path = f.webkitRelativePath || f.name;
      if (ext === 'exe') {
        exes.push({ name: f.name, path, size: f.size, file: f });
        continue;
      }
      if (ext === 'xp3') {
        xp3s.push({ name: f.name, path, size: f.size, file: f });
        continue;
      }
      if (!TEXT_EXT.has(ext)) continue;
      files.push({ name: f.name, path, ext, size: f.size, file: f, skipped: f.size > maxBytes, unitCount: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    await handleScanResult(files, exes, xp3s);
  } catch (e) {
    alert('处理失败：' + e.message);
  } finally {
    gameDropzone.classList.remove('is-busy');
  }
}

/** 扫描结果统一处理：游戏信息 + 文件列表 + 资源包提示 + 进入扫描阶段 */
async function handleScanResult(files, exes, xp3s) {
  if (!files.length && !(xp3s && xp3s.length)) {
    alert('没有发现可翻译的文本文件（支持的格式：txt/json/ini/cfg/srt/ass/rpy/ks/yaml 等）');
    return;
  }
  store.set('files', files);
  store.set('selected', new Set(files.filter(f => !f.skipped).map(f => f.path)));
  store.set('xp3s', xp3s || []);
  // 资源包提示条（吉里吉里 xp3 可解包）
  const xp3sList = xp3s || [];
  if (xp3sList.length) {
    $('#xp3BarText').textContent = '发现资源包：' + xp3sList.map(x => `${x.name}（${fmtMB(x.size)}）`).join('、') + '，文本可能打包在资源包内';
  }
  // 自动找 exe 解析游戏信息（尽力而为，找不到不影响翻译）
  const game = await resolveGame(exes);
  store.set('game', game);
  const card = $('#gameCard');
  if (game) {
    card.hidden = false;
    $('#gameName').textContent = game.product || game.name;
    $('#gameMeta').textContent = [game.company, game.version, game.description].filter(Boolean).join(' · ') || '未读取到版本信息';
    const badge = $('#gameEngineBadge');
    badge.textContent = game.engine || '引擎未知';
    badge.classList.toggle('ut-badge--accent', !!game.engine);
  } else {
    card.hidden = true;
  }
  renderFileList(files);
  bindFileList();
  $('#xp3Bar').hidden = !xp3sList.length;
  $('#unpackXp3Btn').disabled = false;
  showStage('scan');
}

function fmtMB(n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

/** 解包所有检测到的 xp3 资源包：把包内文本文件加入文件列表 */
async function unpackXp3s() {
  const btn = $('#unpackXp3Btn');
  btn.disabled = true;
  try {
    const xp3s = store.state.xp3s || [];
    const newFiles = [];
    for (const xp3 of xp3s) {
      const buf = await xp3.file.arrayBuffer();
      const resp = await fetch('/api/unpack', { method: 'POST', body: buf });
      const data = await resp.json();
      if (!data.ok) { alert('解包失败（' + xp3.name + '）：' + data.error); continue; }
      const tempId = data.tempId;
      for (const f of data.files) {
        const rel = String(f.name).replace(/\\/g, '/');
        const ext = rel.includes('.') ? rel.split('.').pop().toLowerCase() : '';
        if (!TEXT_EXT.has(ext)) continue; // 只取文本文件
        const fr = await fetch(`/api/unpack-file?tempId=${tempId}&rel=${encodeURIComponent(rel)}`);
        if (!fr.ok) continue;
        const bytes = new Uint8Array(await fr.arrayBuffer());
        newFiles.push({
          name: rel.split('/').pop(),
          path: '【xp3】' + rel,
          ext, size: bytes.length,
          file: new Blob([bytes]),
          skipped: false, unitCount: 0,
          xp3Rel: rel, tempId,
        });
      }
    }
    if (!newFiles.length) { alert('资源包内未发现可翻译的文本文件'); return; }
    const files = store.state.files.concat(newFiles);
    store.set('files', files);
    const sel = store.state.selected;
    newFiles.forEach(f => sel.add(f.path));
    renderFileList(files);
    bindFileList();
    $('#xp3BarText').textContent = '✅ 已解包 ' + xp3s.length + ' 个资源包，新增 ' + newFiles.length + ' 个文本文件（以【xp3】标记）';
  } catch (e) {
    alert('解包失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/** 在扫描结果中找 exe 解析游戏信息；优先根目录、较大的 exe */
async function resolveGame(exes) {
  if (!exes || !exes.length) return null;
  const sorted = exes.slice().sort((a, b) => {
    const da = a.path.includes('/') ? 1 : 0;
    const db = b.path.includes('/') ? 1 : 0;
    return da - db || b.size - a.size;
  });
  for (const exe of sorted.slice(0, 3)) {
    try {
      return await parseExe(exe.file);
    } catch (e) { /* 解析失败尝试下一个 */ }
  }
  return null;
}

$('#resetGameBtn').addEventListener('click', () => {
  showStage('import');
  $('#gameCard').hidden = true;
  $('#xp3Bar').hidden = true;
  store.set('game', null);
  store.set('files', []);
  store.set('units', []);
});

function bindFileList() {
  const files = store.state.files;
  const update = () => {
    const sel = new Set();
    $$('#fileList input[type="checkbox"]:checked').forEach(i => sel.add(i.dataset.path));
    store.set('selected', sel);
    $('#startTranslateBtn').disabled = sel.size === 0;
  };
  $('#fileList').addEventListener('change', update);
  $('#checkAll').addEventListener('change', e => {
    $$('#fileList input[type="checkbox"]:not(:disabled)').forEach(i => { i.checked = e.target.checked; });
    update();
  });
  update(); // 立即同步按钮状态（修复：扫描后按钮应立即可用）
}

/* ---------------- 游戏：提取 + 翻译 ---------------- */

let stopRef = null;

/** 翻译未完成的单元；支持中途停止与继续 */
async function runTranslation() {
  const units = store.state.units;
  const todo = units.filter(u => !u.translated);
  const stopBtn = $('#stopBtn');
  if (!todo.length) {
    hideProgress();
    stopBtn.hidden = true;
    renderFileContent(store.state.files, units);
    return;
  }
  stopRef = { stopped: false };
  stopBtn.textContent = '停止';
  stopBtn.disabled = false;
  stopBtn.hidden = false;
  store.set('translating', true);
  showProgress(0, todo.length, 0);
  try {
    await translateUnits(todo, store.state.settings, (d, t, f) => showProgress(d, t, f), stopRef);
  } catch (e) {
    alert('翻译中止：' + e.message);
  } finally {
    store.set('translating', false);
    const remaining = units.filter(u => !u.translated).length;
    if (remaining > 0) {
      const doneCount = units.length - remaining;
      showProgress(doneCount, units.length, 0);
      $('#progressText').textContent = `已停止：完成 ${doneCount} / 共 ${units.length}，剩余 ${remaining} 条`;
      stopBtn.textContent = '继续翻译';
      stopBtn.disabled = false;
      stopBtn.hidden = false;
    } else {
      // 翻译完成：保留进度条显示完成状态（不隐藏）
      const failed = units.filter(u => u.error).length;
      const track = Math.max(0, $('#progressWrap').clientWidth - 48);
      $('#progressBar').style.width = track + 'px';
      $('#progressText').textContent = failed > 0
        ? `完成 ${units.length} / ${units.length} · 失败 ${failed}（100%）`
        : `完成 ${units.length} / ${units.length}（100%）`;
      stopBtn.hidden = true;
    }
    renderFileTree(store.state.files, units);
    renderFileContent(store.state.files, units);
    diagLog('翻译结束');
  }
}

$('#stopBtn').addEventListener('click', () => {
  if (store.state.translating) {
    // 停止当前翻译
    stopRef.stopped = true;
    $('#stopBtn').disabled = true;
    $('#progressText').textContent = '正在停止，等待当前请求完成…';
  } else {
    // 继续翻译剩余
    runTranslation();
  }
});

$('#unpackXp3Btn').addEventListener('click', unpackXp3s);

$('#startTranslateBtn').addEventListener('click', async () => {
  const files = store.state.files.filter(f => store.state.selected.has(f.path));
  if (!files.length) return;
  const btn = $('#startTranslateBtn');
  btn.disabled = true;

  // 提取
  store.set('extracting', true);
  showStage('browse');
  showProgress(0, files.length, 0);
  const units = [];
  let done = 0;
  for (const f of files) {
    try {
      const { text, encoding } = await readText(f.file);
      f.encoding = encoding;
      const us = extractFile(text, f.path, encoding, store.state.settings.targetLang);
      f.unitCount = us.length;
      units.push(...us);
    } catch (e) {
      console.warn('提取失败:', f.path, e);
    }
    done++;
    showProgress(done, files.length, 0);
  }
  store.set('units', units);
  hideProgress();
  store.set('activeFile', (store.state.files.find(f => !f.skipped) || {}).path);
  renderFileTree(store.state.files, units);
  renderFileContent(store.state.files, units);
  $('#exportBtn').disabled = units.length === 0;
  $('#exportXp3Btn').hidden = !store.state.files.some(f => f.xp3Rel);
  store.set('extracting', false);
  diagLog('提取完成');

  // 翻译
  if (!units.length) { btn.disabled = false; return; }
  await runTranslation();
  btn.disabled = false;
});

/* ---------------- 游戏：返回导入阶段 ---------------- */

$('#backToImportBtn').addEventListener('click', () => {
  showStage('import');
  $('#gameCard').hidden = true;
  $('#xp3Bar').hidden = true;
});

/* ---------------- 游戏：双语浏览 ---------------- */

// 文件树：点击切换当前查看的文件
$('#fileTree').addEventListener('click', e => {
  const node = e.target.closest('.ut-file-node');
  if (!node) return;
  store.set('activeFile', node.dataset.path);
  $$('#fileTree .ut-file-node').forEach(n => n.classList.toggle('is-active', n === node));
  renderFileContent(store.state.files, store.state.units);
});

$('#viewSwitch').addEventListener('click', e => {
  const b = e.target.closest('.ut-seg__item');
  if (b) setView(b.dataset.view);
});

// 逐条编辑开关：打开后预览变成可改的原文 / 译文两块
$('#editToggle').addEventListener('click', () => {
  const next = !store.state.editing;
  store.state.editing = next;
  $('#editToggle').textContent = next ? '完成' : '编辑';
  renderFileContent(store.state.files, store.state.units);
});

/*（筛选与搜索已由文件内容视图取代，相关绑定已移除）*/

/* ---------------- 游戏：导出 ---------------- */

$('#exportBtn').addEventListener('click', async () => {
  const btn = $('#exportBtn');
  const game = store.state.game;
  const name = (game ? game.product || game.name : 'translated') + '_' + store.state.view + '.zip';
  // 先弹保存框（需用户激活）；WebView2 里 a[download] 会被默默丢弃
  const pick = await pickSaveFile(name);
  if (pick.cancelled) return;
  btn.disabled = true;
  try {
    const saver = async (blob, fname) => {
      if (pick.ok) await writeSaveHandle(pick.handle, blob);
      else downloadBlob(blob, fname);
    };
    const { warnings } = await exportZip(store.state.files, store.state.units, store.state.view, name, saver);
    if (warnings && warnings.length) {
      alert('导出完成，但有以下提示：\n\n' + warnings.join('\n'));
    }
  } catch (e) {
    alert('导出失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('#exportXp3Btn').addEventListener('click', async () => {
  const btn = $('#exportXp3Btn');
  const game = store.state.game;
  const name = (game ? game.product || game.name : 'translated') + '_translated.xp3';
  const pick = await pickSaveFile(name);
  if (pick.cancelled) return;
  btn.disabled = true;
  try {
    const saver = async (blob, fname) => {
      if (pick.ok) await writeSaveHandle(pick.handle, blob);
      else downloadBlob(blob, fname);
    };
    const { warnings } = await exportXp3(store.state.files, store.state.units, store.state.view, name, saver);
    if (warnings && warnings.length) {
      alert('封包完成，但有以下提示：\n\n' + warnings.join('\n'));
    }
  } catch (e) {
    alert('封包失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 文档翻译 ---------------- */

const docState = { files: [], units: [], view: 'bilingual', activeFile: null, editing: false };
let docEditUnits = [];   // 编辑视图当前渲染的单元数组

const DOC_ACCEPT = '.md,.txt,.html,.htm,.docx,.epub,.xlsx,.pptx,.pdf';
const isDocName = name => !!detectDocType(name);

function docShowStage(name) {
  $$('#ws-document .ut-stage').forEach(s => { s.hidden = s.id !== 'doc-stage-' + name; });
}

/** 加入文档。list 元素形如 {file, relPath}，relPath 带子目录前缀，用作唯一标识 */
async function docAddFiles(list) {
  const files = [];
  const seen = new Set();
  for (const item of list) {
    if (!detectDocType(item.file.name)) continue;
    // 不同子目录下可能出现同名文件，冲突时加序号保标识唯一
    const rel = item.relPath || item.file.name;
    let uniq = rel;
    let k = 2;
    while (seen.has(uniq)) uniq = rel + '#' + k++;
    seen.add(uniq);
    files.push({
      name: item.file.name,
      relPath: uniq,
      file: item.file,
      size: item.file.size,
      type: detectDocType(item.file.name),
      unitCount: 0,
    });
  }
  if (!files.length) {
    alert('没有找到支持的文档（支持 md / txt / html / docx / epub / xlsx / pptx / pdf）');
    return;
  }
  docState.files = files;
  docState.units = [];
  docRenderList();
  docShowStage('scan');
}

function docRenderList() {
  $('#docScanTitle').textContent = `共 ${docState.files.length} 个文档`;
  $('#docFileList').innerHTML = docState.files.map(f => `
    <label class="ut-file-item">
      <input type="checkbox" data-path="${escapeHtml(f.relPath)}" checked>
      <span class="ut-file-item__name" title="${escapeHtml(f.relPath)}">${escapeHtml(f.name)}</span>
      <span class="ut-file-item__size">${fmtBytes(f.size)}</span>
    </label>`).join('') || '<p class="ut-muted">未添加文档</p>';
}

function docRenderTree() {
  const el = $('#docFileTree');
  el.innerHTML = docState.files.map(f => {
    const n = docState.units.filter(u => u.file === f.relPath).length;
    const done = docState.units.filter(u => u.file === f.relPath && u.translated).length;
    const active = f.relPath === docState.activeFile;
    return `<div class="ut-file-node${active ? ' is-active' : ''}" data-doc="${escapeHtml(f.relPath)}" title="${escapeHtml(f.relPath)}">
      <span class="ut-file-node__name">${escapeHtml(f.name)}</span>
      <span class="ut-file-node__count">${n}${done ? ` / ${done}✓` : ''}</span>
    </div>`;
  }).join('') || '<p class="ut-muted">无文档</p>';
}

function docRenderContent() {
  const el = $('#docContent');
  const f = docState.files.find(x => x.relPath === docState.activeFile);
  if (!f) {
    el.classList.remove('is-editing');
    docEditUnits = [];
    el.innerHTML = '<p class="ut-empty-small">选择左侧文档查看翻译结果</p>';
    return;
  }
  const us = docState.units.filter(u => u.file === f.relPath).sort((a, b) => a.seq - b.seq);

  // 编辑态：逐条渲染成可改的原文/译文两块
  if (docState.editing) {
    docEditUnits = us;
    el.classList.add('is-editing');
    el.innerHTML = us.map((u, i) => editBlockHtml({
      index: i,
      original: u.original,
      translated: u.translated || '',
      meta: u.error ? `<span style="color:var(--danger)">${escapeHtml(u.error)}</span>` : '',
    })).join('') || '<p class="ut-empty-small">这个文件没有可编辑的文本</p>';
    snapshotBases(el);
    return;
  }

  el.classList.remove('is-editing');
  docEditUnits = [];
  el.innerHTML = `<pre class="ut-file-content">${escapeHtml(docText(us, docState.view))}</pre>`;
}

function setDocEditing(on) {
  docState.editing = on;
  const btn = $('#docEditToggle');
  if (btn) btn.textContent = on ? '完成' : '编辑';
  docRenderContent();
}

// 编辑写回：直接改内存里的单元，导出时自然用新值
bindEditables($('#docContent'), {
  getUnits: () => docEditUnits,
  onChange: () => {
    docRenderTree();
    docSyncExportEnabled(docState.units.some(u => u.translated));
  },
});

$('#docEditToggle').addEventListener('click', () => setDocEditing(!docState.editing));

const docDz = $('#docDropzone');
docDz.addEventListener('dragover', e => { e.preventDefault(); docDz.classList.add('is-dragover'); });
docDz.addEventListener('dragleave', () => docDz.classList.remove('is-dragover'));
docDz.addEventListener('drop', async e => {
  e.preventDefault();
  docDz.classList.remove('is-dragover');
  const dt = e.dataTransfer;
  if (!dt) return;
  // 支持整个文件夹递归收集
  const list = await collectFromDataTransfer(dt, isDocName);
  if (list.length) await docAddFiles(list);
});

// 两个入口都在拖拽框内：点框 = 选文档（多选），点按钮 = 选整个文件夹
const docFileInput = makeFileInput({
  accept: DOC_ACCEPT,
  multiple: true,
  onFiles: files => docAddFiles(fromFileList(files, isDocName)),
});
const docDirInput = makeFileInput({
  accept: DOC_ACCEPT,
  directory: true,
  onFiles: files => docAddFiles(fromFileList(files, isDocName)),
});
docDz.addEventListener('click', () => docFileInput.click());
docDz.addEventListener('keydown', e => {
  if (e.target.closest('button')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); docFileInput.click(); }
});
$('#docPickFiles').addEventListener('click', e => { e.stopPropagation(); docFileInput.click(); });
$('#docPickFolder').addEventListener('click', e => { e.stopPropagation(); docDirInput.click(); });

$('#docBackBtn').addEventListener('click', () => { docState.files = []; docState.units = []; docShowStage('import'); });
$('#docViewBackBtn').addEventListener('click', () => {
  if (docState.editing) setDocEditing(false);   // 返回重提时退出编辑态
  docShowStage('scan');
});

$('#docTranslateBtn').addEventListener('click', async () => {
  const btn = $('#docTranslateBtn');
  btn.disabled = true;
  try {
    if (!docState.files.length) return;
    if (docState.editing) setDocEditing(false);   // 重新提取前回到只读预览
    docShowStage('view');
    $('#docProgressWrap').hidden = false;
    const units = [];
    for (let i = 0; i < docState.files.length; i++) {
      const f = docState.files[i];
      $('#docProgressText').textContent = `提取 ${i + 1}/${docState.files.length}：${f.name}`;
      const forceOcr = (($('#docPdfMode .ut-seg__item.is-active') || {}).dataset || {}).mode === 'ocr';
      const { units: us } = await extractDoc(f.file, f.relPath, msg => { $('#docProgressText').textContent = msg; }, forceOcr);
      f.unitCount = us.length;
      units.push(...us);
    }
    docState.units = units;
    docState.activeFile = (docState.files[0] || {}).relPath;
    docRenderTree();
    docRenderContent();
    docSyncExportUi();
    docSyncExportEnabled(units.length > 0);
    if (units.length) await docTranslateUnits();
  } catch (e) {
    alert('处理失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

let docStopRef = null;

/** 翻译文档单元；支持停止/继续，进度与游戏翻译一致 */
async function docTranslateUnits() {
  const units = docState.units;
  const todo = units.filter(u => !u.translated);
  const stopBtn = $('#docStopBtn');
  const wrap = $('#docProgressWrap');
  if (!todo.length) { wrap.hidden = true; stopBtn.hidden = true; docRenderContent(); return; }
  docStopRef = { stopped: false };
  stopBtn.textContent = '停止';
  stopBtn.disabled = false;
  stopBtn.hidden = false;
  wrap.hidden = false;
  const docTrack = () => Math.max(0, wrap.clientWidth - 48);
  $('#docProgressBar').style.width = '0px';
  $('#docProgressText').textContent = `0 / ${todo.length}（0%）`;
  try {
    await translateUnits(todo, store.state.settings, (d, t, f) => {
      const p = t ? Math.round(d / t * 100) : 100;
      $('#docProgressBar').style.width = Math.round(docTrack() * p / 100) + 'px';
      $('#docProgressText').textContent = `${d} / ${t}${f ? ` · 失败 ${f}` : ''}（${p}%）`;
    }, docStopRef);
  } catch (e) {
    alert('翻译中止：' + e.message);
  } finally {
    const remaining = units.filter(u => !u.translated).length;
    if (remaining > 0) {
      const doneCount = units.length - remaining;
      $('#docProgressBar').style.width = Math.round(docTrack() * doneCount / units.length) + 'px';
      $('#docProgressText').textContent = `已停止：完成 ${doneCount} / 共 ${units.length}，剩余 ${remaining} 条`;
      stopBtn.textContent = '继续翻译';
      stopBtn.disabled = false;
      stopBtn.hidden = false;
    } else {
      // 翻译完成：保留进度条显示完成状态（不隐藏）
      const failed = units.filter(u => u.error).length;
      const unchanged = units.filter(u => u.unchanged).length;
      $('#docProgressBar').style.width = docTrack() + 'px';
      const extra = [];
      if (failed) extra.push(`失败 ${failed}`);
      if (unchanged) extra.push(`${unchanged} 条原文已是目标语言`);
      $('#docProgressText').textContent =
        `完成 ${units.length} / ${units.length}` + (extra.length ? ' · ' + extra.join(' · ') : '') + '（100%）';
      stopBtn.hidden = true;
    }
    docRenderContent();
    docSyncExportEnabled(units.some(u => u.translated));
  }
}

$('#docStopBtn').addEventListener('click', () => {
  if (docStopRef && !docStopRef.stopped) {
    docStopRef.stopped = true;
    $('#docStopBtn').disabled = true;
    $('#docProgressText').textContent = '正在停止，等待当前请求完成…';
  } else {
    docTranslateUnits();
  }
});

$('#docFileTree').addEventListener('click', e => {
  const node = e.target.closest('.ut-file-node');
  if (!node) return;
  docState.activeFile = node.dataset.doc;
  docRenderTree();
  docRenderContent();
});

$('#docViewSwitch').addEventListener('click', e => {
  const b = e.target.closest('.ut-seg__item');
  if (!b) return;
  docState.view = b.dataset.view;
  $$('#docViewSwitch .ut-seg__item').forEach(x => x.classList.toggle('is-active', x === b));
  if (docState.editing) setDocEditing(false);   // 切视图时退出编辑
  else docRenderContent();
});

function docPdfFiles() {
  return docState.files.filter(f => detectDocType(f.name) === 'pdf');
}

/** 当前 PDF 文件的类型集合（text / image / empty） */
function docPdfKinds() {
  const kinds = new Set();
  for (const f of docState.files) {
    if (detectDocType(f.name) !== 'pdf') continue;
    const us = docState.units.filter(u => u.file === f.relPath);
    kinds.add((us[0] && us[0].raw.pdfKind) || 'text');
  }
  return kinds;
}

/** PDF 类型提示（导出格式与方式统一在导出面板里选） */
function docSyncExportUi() {
  const hasPdf = docPdfFiles().length > 0;
  const hint = $('#docPdfOcrHint');
  if (hint) hint.hidden = true;
  if (!hasPdf) return;
  const kinds = docPdfKinds();
  const hasImage = kinds.has('image');
  const hasEmpty = kinds.has('empty');
  if (hasImage && hint) {
    hint.hidden = false;
    hint.textContent = hasEmpty
      ? '含扫描版 / 空白 PDF：选「PDF」格式可保持原排版，空白版无内容可导'
      : '含扫描版 PDF：选「PDF」格式可保持原排版并嵌入译文';
  } else if (hasEmpty && hint) {
    hint.hidden = false;
    hint.textContent = '含空白 PDF：未识别到文字，无内容可导出';
  }
}


// PDF 提取方式切换（文字层 / 图片 OCR）
$('#docPdfMode').addEventListener('click', e => {
  const b = e.target.closest('.ut-seg__item');
  if (!b) return;
  $$('#docPdfMode .ut-seg__item').forEach(x => x.classList.toggle('is-active', x === b));
});

/** 导出按钮启用状态 */
function docSyncExportEnabled(enabled) {
  const el = $('#docExportBtn');
  if (el) el.disabled = !enabled;
}

/** 译文文件名：单体导入保持原名，来自文件夹的用扁平路径防同名覆盖 */
function docOutName(f, forceExt) {
  const dot = f.name.lastIndexOf('.');
  const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
  const ext = forceExt || (dot > 0 ? f.name.slice(dot) : '');
  const flat = f.relPath === f.name ? stem : f.relPath.replace(/\.[^.]+$/, '').replace(/[\\/]+/g, '_');
  return flat + '_译文' + ext;
}

/** 预览/导出用的单单元文本 */
function pickView(u, view) {
  if (view === 'original') return u.original;
  if (view === 'translated') return u.translated || u.original;
  return u.original + ' / ' + (u.translated || '');
}

/** HTML 导出外壳：与 PDF 同一套黑白排版，只是换成系统字体 */
function htmlShell(body) {
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<title>译文</title>\n<style>\n'
    + 'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:15px;'
    + 'line-height:1.75;color:#000;max-width:820px;margin:48px auto;padding:0 24px}\n'
    + 'h1{font-size:26px;line-height:1.35;margin:0 0 18px}\n'
    + 'h2{font-size:20px;line-height:1.4;margin:26px 0 12px}\n'
    + 'h3{font-size:17px;margin:20px 0 10px}\n'
    + 'h4,h5,h6{font-size:15px;margin:16px 0 8px}\n'
    + 'p{margin:0 0 12px}\n'
    + 'ul,ol{margin:0 0 14px;padding-left:24px}\nli{margin:0 0 5px}\n'
    + 'table{border-collapse:collapse;width:100%;margin:10px 0 16px}\n'
    + 'th,td{border:1px solid #9a9a9a;padding:6px 9px;font-size:14px;text-align:left;vertical-align:top}\n'
    + 'th{font-weight:700;border-bottom:2px solid #000}\n'
    + 'blockquote{margin:14px 0;padding-left:14px;border-left:3px solid #c8c8c8}\n'
    + 'pre{padding:6px 0 6px 14px;margin:10px 0 16px;border-left:3px solid #9a9a9a;overflow:auto}\n'
    + 'code{font-family:Consolas,"Courier New",monospace;font-size:13.5px}\n'
    + 'hr{border:none;border-top:1px solid #9a9a9a;margin:20px 0}\n'
    + 'a{color:#000}\nimg{max-width:100%}\n'
    + '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>';
}

/**
 * 把单个文件的内容转成 HTML 片段，尽量保留原始结构。
 * md → 用源文件重建后交由 marked；docx → 段落样式/表格还原；
 * 其余格式没有可复用的块结构，按段落兜底。
 */
async function docToHtml(f, us) {
  const sorted = us.slice().sort((a, b) => a.seq - b.seq);
  const view = docState.view;
  const type = detectDocType(f.name);
  if (type === 'plain') {
    if (/\.(md|markdown)$/i.test(f.name)) {
      const r = await rebuildDoc(f.file, f.relPath, sorted, view);
      return mdToHtml(r.text || '');
    }
    return textToHtml(docText(sorted, view));
  }
  if (type === 'docx') {
    return await docxToHtml(f.file, sorted, view);
  }
  return unitsToHtml(sorted, u => pickView(u, view));
}

/** 单文件跨格式转换：文本类前端拼，docx / pdf 交后端生成 */
async function docConvert(f, us, fmt) {
  const sorted = us.slice().sort((a, b) => a.seq - b.seq);
  const type = detectDocType(f.name);
  const isMd = /\.(md|markdown)$/i.test(f.name);

  if (fmt === 'txt') {
    return new Blob([docText(sorted, docState.view)], { type: 'text/plain;charset=utf-8' });
  }

  if (fmt === 'md') {
    // md 源：用原文重建，标题井号、列表符号、表格竖线原样带回
    if (type === 'plain' && isMd) {
      const r = await rebuildDoc(f.file, f.relPath, sorted, docState.view);
      return new Blob([r.text || ''], { type: 'text/markdown;charset=utf-8' });
    }
    return new Blob([docText(sorted, docState.view)], { type: 'text/markdown;charset=utf-8' });
  }

  if (fmt === 'html') {
    return new Blob([htmlShell(await docToHtml(f, sorted))], { type: 'text/html;charset=utf-8' });
  }

  if (fmt === 'pdf' && type !== 'pdf') {
    // md / txt / docx 走 HTML 渲染，结构完整保留
    const body = await docToHtml(f, sorted);
    const res = await fetch('/api/doc/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fmt: 'pdf', html: body, pageNumbers: !!docState.exportPageNum }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error((d && d.error) || ('导出失败 HTTP ' + res.status));
    }
    return await res.blob();
  }

  // docx / pdf（其它来源）：后端用 python-docx / pymupdf 生成
  const res = await fetch('/api/doc/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fmt,
      units: sorted.map(u => ({ original: u.original, translated: u.translated || '' })),
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d && d.error) || ('导出失败 HTTP ' + res.status));
  }
  return await res.blob();
}

/**
 * 生成全部产出
 * @param {string} fmt keep=原格式 / txt / md / html / docx / pdf
 */
async function docBuildOutputs(fmt, onProgress) {
  const out = [];
  const used = new Set();
  const files = docState.files;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress(i, files.length, '生成');
    const us = docState.units.filter(u => u.file === f.relPath).sort((a, b) => a.seq - b.seq);
    if (!us.length) continue;
    const isPdf = detectDocType(f.name) === 'pdf';
    const tempId = (us[0].raw && us[0].raw.tempId) || '';
    let blob = null;
    let name = '';
    try {
      if (fmt === 'keep') {
        if (isPdf) {
          if (!tempId) continue;
          const r = await exportPdfDoc(tempId, us, 'docx');
          blob = r.blob;
          name = docOutName(f, '.docx');
        } else {
          const rebuilt = await rebuildDoc(f.file, f.relPath, us, docState.view);
          blob = rebuilt.blob || (rebuilt.text ? new Blob([rebuilt.text], { type: 'text/plain;charset=utf-8' }) : null);
          name = docOutName(f);
        }
      } else if (fmt === 'pdf' && isPdf && tempId) {
        // PDF 源 + PDF 目标：原位嵌入，保持原排版
        const r = await exportPdfDoc(tempId, us, 'pdf');
        blob = r.blob;
        name = docOutName(f, '.pdf');
      } else {
        blob = await docConvert(f, us, fmt);
        name = docOutName(f, '.' + fmt);
      }
    } catch (e) {
      console.warn('导出失败:', f.relPath, e);
      continue;
    }
    if (!blob) continue;
    let fname = name;
    let k = 2;
    while (used.has(fname)) fname = name.replace(/(\.[^.]+)$/, '_' + (k++) + '$1');
    used.add(fname);
    out.push({ name: fname, blob });
  }
  if (onProgress) onProgress(files.length, files.length, '生成');
  return out;
}

/* ---------------- 导出面板：格式 × 方式 ---------------- */

docState.exportFmt = 'keep';
docState.exportMode = 'files';
docState.exportPageNum = false;

/** 页码选项只在导出 PDF 时有意义 */
function docSyncPageNumGroup() {
  const g = $('#docPageNumGroup');
  if (!g) return;
  g.hidden = docState.exportFmt !== 'pdf';
}

function docSyncExportHint() {
  const hint = $('#docExportHint');
  if (!hint) return;
  const fmt = docState.exportFmt;
  if (fmt === 'keep') hint.textContent = '每个文件按原有格式与排版导出（PDF 源生成 Word）';
  else if (fmt === 'pdf') hint.textContent = '保留标题层级、列表与表格；PDF 源文件原位嵌入保持原排版';
  else if (fmt === 'md') hint.textContent = '按 Markdown 输出，标题、列表与表格标记保留';
  else if (fmt === 'html') hint.textContent = '输出带样式的 HTML，结构保留';
  else if (fmt === 'docx') hint.textContent = '每段一段落，标题层级与表格结构不保留';
  else hint.textContent = '只保留纯文字';
}

$('#docExportBtn').addEventListener('click', e => {
  e.stopPropagation();
  const pop = $('#docExportPop');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  if (!pop.hidden) { docSyncExportHint(); docSyncPageNumGroup(); }
});

// 点面板与按钮以外的地方收起
document.addEventListener('click', e => {
  const pop = $('#docExportPop');
  if (!pop || pop.hidden) return;
  if (e.target.closest('#docExportPop') || e.target.closest('#docExportBtn')) return;
  pop.hidden = true;
});

$('#docFmtOpts').addEventListener('click', e => {
  const b = e.target.closest('.ut-chip');
  if (!b) return;
  docState.exportFmt = b.dataset.fmt;
  $$('#docFmtOpts .ut-chip').forEach(x => x.classList.toggle('is-active', x === b));
  docSyncExportHint();
  docSyncPageNumGroup();
});

$('#docPageNumOpts').addEventListener('click', e => {
  const b = e.target.closest('.ut-chip');
  if (!b) return;
  docState.exportPageNum = b.dataset.pagenum === '1';
  $$('#docPageNumOpts .ut-chip').forEach(x => x.classList.toggle('is-active', x === b));
});

$('#docModeOpts').addEventListener('click', e => {
  const b = e.target.closest('.ut-chip');
  if (!b) return;
  docState.exportMode = b.dataset.mode;
  $$('#docModeOpts .ut-chip').forEach(x => x.classList.toggle('is-active', x === b));
});

$('#docExportGo').addEventListener('click', async () => {
  const pop = $('#docExportPop');
  if (pop) pop.hidden = true;
  await docExportRun();
});

async function docExportRun() {
  const fmt = docState.exportFmt;
  const mode = docState.exportMode;
  const btn = $('#docExportBtn');
  const wrap = $('#docProgressWrap');
  const zipName = '译文文档.zip';

  // 先弹保存位置：必须在用户激活窗口内调用，否则会被拒
  let pick = null;
  let dirPick = null;
  if (mode === 'zip') {
    pick = await pickSaveFile(zipName);
    if (pick.cancelled) return;
  } else {
    dirPick = await pickDirectory();
    if (dirPick.cancelled) return;
    if (!dirPick.ok) { alert('无法选择保存目录，导出已取消'); return; }
  }

  const track = () => Math.max(0, wrap ? wrap.clientWidth - 48 : 0);
  const setP = (i, total, label) => {
    if (!wrap) return;
    const p = total ? Math.round(i / total * 100) : 100;
    $('#docProgressBar').style.width = Math.round(track() * p / 100) + 'px';
    $('#docProgressText').textContent = label + ' ' + i + ' / ' + total + '（' + p + '%）';
  };

  btn.disabled = true;
  if (wrap) {
    wrap.hidden = false;
    $('#docProgressBar').style.width = '0px';
    setP(0, docState.files.length, '生成');
  }
  try {
    const outputs = await docBuildOutputs(fmt, setP);
    if (!outputs.length) { alert('没有可导出的内容'); return; }
    if (mode === 'zip') {
      const zip = new window.JSZip();
      for (const o of outputs) zip.file(o.name, o.blob);
      const blob = await zip.generateAsync({ type: 'blob' });
      if (pick.ok) await writeSaveHandle(pick.handle, blob);
      else downloadBlob(blob, zipName);
      setP(outputs.length, outputs.length, '完成');
    } else {
      let i = 0;
      const renamed = [];
      for (const o of outputs) {
        const finalName = await writeDirFile(dirPick.handle, o.name, o.blob);
        if (finalName !== o.name) renamed.push(o.name + '  →  ' + finalName);
        i++;
        setP(i, outputs.length, '写入');
      }
      if (renamed.length) {
        const list = renamed.slice(0, 8).join('\n');
        const more = renamed.length > 8 ? '\n…共 ' + renamed.length + ' 个' : '';
        alert('目标文件夹里已有同名文件，已改名保存，原文件未动：\n\n' + list + more);
      }
    }
  } catch (e) {
    alert('导出失败：' + e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (wrap) wrap.hidden = true; }, 1200);
  }
}


$('#clearCacheBtn').addEventListener('click', async () => {
  const btn = $('#clearCacheBtn');
  btn.disabled = true;
  const ok = await clearCache();
  btn.disabled = false;
  const st = $('#cacheStatus');
  st.textContent = ok ? '✓ 已清除' : '清除失败';
  st.style.color = ok ? 'var(--ok)' : 'var(--danger)';
  setTimeout(() => { st.textContent = ''; }, 2500);
});

// 赞助入口：WebView2 内直接跳外链会把页面顶掉，统一交后端用系统浏览器打开
$('#supportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://afdian.com/a/match0121' }),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) alert('打开失败：' + (d.error || ('HTTP ' + res.status)));
  } catch (e) {
    alert('打开失败：' + e.message);
  }
});

/* ---------------- 设置抽屉 ---------------- */

const drawer = $('#settingsDrawer');
const backdrop = $('#settingsBackdrop');

function openSettings() {
  const s = store.state.settings;
  $('#providerSelect').value = s.provider;
  $('#baiduAppidInput').value = s.baiduAppid || '';
  $('#apiKeyInput').value = s.apiKey || '';
  $('#baseUrlInput').value = s.baseUrl || '';
  $('#modelInput').value = s.model || '';
  $('#targetLang').value = s.targetLang;
  $('#concurrencyInput').value = s.concurrency;
  $('#maxSizeInput').value = s.maxSizeMB;
  syncProviderFields(s.provider);
  refreshEngineStatus();
  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => $('#apiKeyInput').focus());
}
function closeSettings() {
  drawer.hidden = true;
  backdrop.hidden = true;
}
function syncProviderFields(provider) {
  $('#appidField').hidden = provider !== 'baidu';
  $('#apiKeyField').hidden = !(provider === 'baidu' || provider === 'deepl' || provider === 'openai');
  $('#baseUrlField').hidden = provider !== 'openai';
  $('#modelField').hidden = provider !== 'openai';
}

$('#openSettings').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', closeSettings);
backdrop.addEventListener('click', closeSettings);

/* ---------------- 主题切换 ---------------- */

function applyThemeIcon() {
  const b = $('#themeToggle');
  if (!b) return;
  const light = store.state.theme === 'light';
  // 图标由 CSS 驱动：body[data-theme] 控制 .ico-sun/.ico-moon 显隐
  b.title = light ? '切换到深色主题' : '切换到浅色主题';
}

$('#themeToggle').addEventListener('click', () => {
  store.set('theme', store.state.theme === 'light' ? 'dark' : 'light');
  applyThemeIcon();
});
applyThemeIcon();

/* ---------------- 翻译浏览：返回上一级 ---------------- */

$('#backBtn').addEventListener('click', () => {
  // 返回扫描阶段，翻译结果保留在状态里，重新提取会走翻译缓存（IndexedDB）
  if (store.state.editing) {
    store.state.editing = false;
    const eb = $('#editToggle');
    if (eb) eb.textContent = '编辑';
  }
  showStage('scan');
  renderFileList(store.state.files);
  bindFileList();
});
$('#providerSelect').addEventListener('change', e => {
  syncProviderFields(e.target.value);
  refreshEngineStatus();
});

drawer.addEventListener('change', e => {
  const id = e.target.id;
  const s = store.state.settings;
  if (id === 'providerSelect') s.provider = e.target.value;
  if (id === 'targetLang') s.targetLang = e.target.value;
  if (id === 'concurrencyInput') s.concurrency = Math.max(1, Math.min(10, +e.target.value || 3));
  if (id === 'maxSizeInput') s.maxSizeMB = Math.max(1, Math.min(200, +e.target.value || 8));
  store.patchSettings(s);
  refreshEngineStatus();
});
drawer.addEventListener('input', e => {
  const id = e.target.id;
  const s = store.state.settings;
  if (id === 'apiKeyInput') s.apiKey = e.target.value.trim();
  if (id === 'baiduAppidInput') s.baiduAppid = e.target.value.trim();
  if (id === 'baseUrlInput') s.baseUrl = e.target.value.trim();
  if (id === 'modelInput') s.model = e.target.value.trim();
  store.patchSettings(s);
  refreshEngineStatus();
});

/* ---------------- 主题 ---------------- */

function toggleTheme() {
  const next = store.state.theme === 'dark' ? 'light' : 'dark';
  store.state.theme = next;
  document.body.dataset.theme = next;
  try { localStorage.setItem('ut.theme', next); } catch (e) { /* ignore */ }
}

document.addEventListener('keydown', e => {
  // 快捷键：T 切换主题
  if (e.altKey && e.key.toLowerCase() === 't') toggleTheme();
});

// 初始化
showWorkspace('document');
showStage('import');
setView('bilingual');
refreshEngineStatus();
console.log('[万能翻译站] 就绪');
