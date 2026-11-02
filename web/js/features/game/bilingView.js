// bilingView.js — 双语视图渲染 + 一键切换
// 浏览模式：左侧文件树 + 右侧"翻译后的完整文件内容"（按文件查看，而非逐句卡片）

import { $, escapeHtml, fmtBytes } from '../../utils.js';
import { store } from '../../store.js';
import { rebuild } from './exporter.js';
import { readText } from './encoding.js';
import { editBlockHtml, bindEditables, snapshotBases } from '../shared/editView.js';

/* ---------- 文件列表（扫描阶段） ---------- */

export function renderFileList(files) {
  const el = $('#fileList');
  const total = files.length;
  const usable = files.filter(f => !f.skipped).length;
  $('#scanTitle').textContent = `扫描到 ${total} 个文本文件${usable < total ? `（${usable} 个可提取）` : ''}`;
  el.innerHTML = files.map(f => `
    <label class="ut-file-item${f.skipped ? ' is-skipped' : ''}">
      <input type="checkbox" data-path="${escapeHtml(f.path)}" ${f.skipped ? 'disabled' : 'checked'}>
      <span class="ut-file-item__name" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
      <span class="ut-file-item__size">${fmtBytes(f.size)}</span>
      ${f.skipped ? '<span class="ut-badge ut-badge--warn">超过大小上限，跳过</span>' : ''}
    </label>`).join('') || '<p class="ut-muted">未发现可翻译的文本文件</p>';
}

/* ---------- 文件树（浏览阶段） ---------- */

export function renderFileTree(files, units) {
  const el = $('#fileTree');
  const countByFile = new Map();
  for (const u of units) countByFile.set(u.file, (countByFile.get(u.file) || 0) + 1);
  const active = store.state.activeFile;
  const list = files.filter(f => !f.skipped);
  el.innerHTML = list.map(f => {
    const n = countByFile.get(f.path) || 0;
    const done = units.filter(u => u.file === f.path && u.translated).length;
    return `
    <div class="ut-file-node${f.path === active ? ' is-active' : ''}" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
      <span class="ut-file-node__name">${escapeHtml(f.path)}</span>
      <span class="ut-file-node__count">${n}${done ? ` / ${done}✓` : ''}</span>
    </div>`;
  }).join('') || '<p class="ut-muted">无文本文件</p>';
}

/* ---------- 文件内容视图（浏览阶段主区域） ---------- */

let editUnits = [];   // 编辑视图当前渲染的单元数组（写回时靠下标定位）

/**
 * 渲染当前选中文件的翻译后完整内容
 * 视图模式由 store.state.view 决定：original=原文 / translated=译文 / bilingual=原文（译文）
 * store.state.editing 为真时改为逐条可编辑（原文 / 译文各一块）
 */
export async function renderFileContent(files, units) {
  const el = $('#unitList');
  try {
    const activePath = store.state.activeFile;
    const file = files.find(f => f.path === activePath && !f.skipped);
    if (!file) {
      el.classList.remove('is-editing');
      editUnits = [];
      el.innerHTML = '<p class="ut-empty-small">选择左侧文件查看翻译结果<br><span class="ut-muted">或回到上一步提取文本</span></p>';
      return;
    }
    const fileUnits = units
      .filter(u => u.file === file.path)
      .sort((a, b) => (a.lineIndex - b.lineIndex) || ((a.occurrence || 0) - (b.occurrence || 0)));

    // 编辑态：逐条渲染成可改的原文 / 译文两块
    if (store.state.editing) {
      el.classList.add('is-editing');
      editUnits = fileUnits;
      el.innerHTML = fileUnits.map((u, i) => editBlockHtml({
        index: i,
        original: u.original,
        translated: u.translated || '',
        meta: `第 ${(u.lineIndex || 0) + 1} 行${u.error ? ' · ' + escapeHtml(u.error) : ''}`,
      })).join('') || '<p class="ut-empty-small">这个文件没有可编辑的文本</p>';
      snapshotBases(el);
      return;
    }

    el.classList.remove('is-editing');
    editUnits = [];
    const { text } = await readText(file.file);
    const mode = store.state.view;
    const content = mode === 'original' ? text : rebuild(text, fileUnits, mode);
    el.innerHTML = `<pre class="ut-file-content">${escapeHtml(content)}</pre>`;
  } catch (e) {
    console.error('renderFileContent 失败:', e);
    el.innerHTML = '<p class="ut-muted" style="color:var(--danger)">渲染错误: ' + escapeHtml(e.message) + '</p>';
  }
}

// 编辑写回：直接改内存单元，导出/封包时自然用新值
bindEditables($('#unitList'), {
  getUnits: () => editUnits,
  onChange: () => {
    renderFileTree(store.state.files, store.state.units);
  },
});

/* ---------- 进度 ---------- */

export function showProgress(done, total, failed = 0) {
  const wrap = $('#progressWrap');
  if (!wrap) return;
  wrap.hidden = false;
  const pct = total ? Math.round(done / total * 100) : 100;
  // 填充条 absolute left:24px，宽度按轨道可视宽（容器宽 - 左右 24px）算像素，避免超出右边界
  const track = Math.max(0, wrap.clientWidth - 48);
  $('#progressBar').style.width = Math.round(track * pct / 100) + 'px';
  $('#progressText').textContent = `${done} / ${total}${failed ? ` · 失败 ${failed}` : ''}（${pct}%）`;
}

export function hideProgress() {
  const wrap = $('#progressWrap');
  if (wrap) wrap.hidden = true;
}
