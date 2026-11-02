// editView.js — 逐条编辑（原文 / 译文）的块结构与写回绑定
//
// 由各工作台的「编辑」开关控制进出编辑态；这里只管两件事：
//   1. editBlockHtml：一条单元渲染成「原文 + 译文」两块可编辑区
//   2. bindEditables：容器上绑一次事件，失焦写回单元对象
//
// contenteditable 用 plaintext-only，粘贴不会带进外部格式；读回一律走 textContent，
// 不碰 innerHTML，避免把用户输入当 HTML 执行。

import { escapeHtml } from '../../utils.js';

/**
 * 一条单元的可编辑块
 * @param {Object} o
 * @param {number} o.index       在单元数组里的下标（写回时靠它定位）
 * @param {string} o.original    原文（内部会转义）
 * @param {string} o.translated  译文（内部会转义）
 * @param {string} [o.thumb]     缩略图 dataURL（图片工作台用）
 * @param {string} [o.meta]      附加说明（文件路径 / 行号），已转义过的 HTML
 */
export function editBlockHtml(o) {
  const idx = o.index;
  const src = escapeHtml(o.original || '');
  const dst = escapeHtml(o.translated || '');
  return `<div class="ut-edit" data-index="${idx}">
    ${o.thumb ? `<img class="ut-edit__thumb" src="${o.thumb}" alt="">` : ''}
    <div class="ut-edit__body">
      ${o.meta ? `<span class="ut-edit__meta">${o.meta}</span>` : ''}
      <div class="ut-edit__row">
        <span class="ut-edit__tag">原文</span>
        <div class="ut-edit__cell" data-field="original" data-index="${idx}"
             contenteditable="plaintext-only" spellcheck="false">${src}</div>
      </div>
      <div class="ut-edit__row">
        <span class="ut-edit__tag">译文</span>
        <div class="ut-edit__cell ut-edit__cell--dst" data-field="translated" data-index="${idx}"
             contenteditable="plaintext-only" spellcheck="false">${dst}</div>
      </div>
    </div>
  </div>`;
}

/** 一条块里是否有被改过的格子 */
function markBlock(cell) {
  const block = cell.closest('.ut-edit');
  if (!block) return;
  const dirty = Array.from(block.querySelectorAll('.ut-edit__cell'))
    .some(c => c.classList.contains('is-edited'));
  block.classList.toggle('is-modified', dirty);
}

/** 取格子的纯文本值（去掉末尾换行和 nbsp） */
function cellValue(cell) {
  return (cell.textContent || '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
}

/** 渲染完编辑视图后调用：把当前内容存为基准值，供「是否改过」判断 */
export function snapshotBases(root) {
  if (!root) return;
  root.querySelectorAll('.ut-edit__cell').forEach(c => {
    c.dataset.base = c.textContent || '';
    c.classList.remove('is-edited');
  });
  root.querySelectorAll('.ut-edit').forEach(b => b.classList.remove('is-modified'));
}

/**
 * 在容器上绑定编辑事件，只需调用一次
 * @param {HTMLElement} root            容器
 * @param {Object} opts
 * @param {() => Array} opts.getUnits   返回当前渲染的单元数组
 * @param {(u, field) => string} [opts.getField] 读字段，默认 u[field]
 * @param {(u, field, v) => void} [opts.setField] 写字段，默认 u[field] = v
 * @param {(u, field, value) => void} [opts.onChange] 写回后的回调
 */
export function bindEditables(root, opts) {
  if (!root || root.__editBound) return;
  root.__editBound = true;
  const getUnits = opts.getUnits;
  const getField = opts.getField || ((u, f) => u[f] || '');
  const setField = opts.setField || ((u, f, v) => { u[f] = v; });

  const writeBack = cell => {
    const units = getUnits();
    const u = units[Number(cell.dataset.index)];
    if (!u) return;
    const field = cell.dataset.field;
    const value = cellValue(cell);
    const before = getField(u, field) || '';
    if (value === before) return;
    setField(u, field, value);
    markBlock(cell);
    if (opts.onChange) opts.onChange(u, field, value);
  };

  root.addEventListener('focusout', e => {
    const cell = e.target.closest && e.target.closest('.ut-edit__cell');
    if (cell && root.contains(cell)) writeBack(cell);
  });

  // 输入时只做「是否改过」的即时视觉反馈，真正写回在失焦
  root.addEventListener('input', e => {
    const cell = e.target.closest && e.target.closest('.ut-edit__cell');
    if (!cell) return;
    cell.classList.toggle('is-edited', cellValue(cell) !== (cell.dataset.base || ''));
    markBlock(cell);
  });

  // 单行语义：Enter 结束编辑，Shift+Enter 才换行
  root.addEventListener('keydown', e => {
    const cell = e.target.closest && e.target.closest('.ut-edit__cell');
    if (!cell) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      cell.blur();
    }
    if (e.key === 'Escape') cell.blur();
  });
}