// docParser.js — 文档翻译解析器（P1：md/txt/html + docx + epub）
//
// 原理：
//  - txt/md 是纯文本，按行处理
//  - html/epub 是 DOM 文本节点，按节点提取与写回
//  - docx/epub 本质是 ZIP + XML（OOXML / XHTML），用 JSZip 解压、改 XML、重新打包
//
// 单元模型与游戏翻译对齐：{file, seq, original, raw, translated, error, ex, docType}
//  - txt/md 的 raw 记录 lineIndex（行级写回）
//  - html/docx/epub 的 raw 记录节点定位（seq），写回时用同一过滤规则重新定位节点

import { readText } from '../game/encoding.js';
import { store } from '../../store.js';

export const DOC_EXT = new Set(['md', 'txt', 'html', 'htm', 'docx', 'epub', 'xlsx', 'pptx', 'pdf']);
const DOCX_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export function detectDocType(fileName) {
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  if (ext === 'docx') return 'docx';
  if (ext === 'epub') return 'epub';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'txt') return 'plain';
  return null;
}

function isTranslateableDoc(s) {
  if (!s) return false;
  const t = s.trim();
  if (!t || t.length > 800) return false;
  // 纯数字 / 符号 / 标点行没有可译内容
  if (/^[\d\s.,%+\-*\/=<>:;|!?()[\]{}"'`~^#$@&]+$/.test(t)) return false;
  return true;
}


function unitText(u, mode) {
  if (mode === 'original') return u.original;
  if (mode === 'translated') return u.translated || u.original;
  return u.original + '（' + (u.translated || '') + '）';
}

/* ---------------- 纯文本（txt/md） ---------------- */

/**
 * 拆解一行 Markdown：把「结构前缀」与「可译文字」分开。
 * 翻译只送 text，导出时再用 prefix 拼回，这样标题井号、列表符号、表格分隔符不会被翻译引擎吃掉。
 *
 * kind: heading | bullet | ordered | quote | table | tableSep | fence | hr | blank | para
 */
export function analyzeMdLine(line) {
  const t = line.replace(/\s+$/, '');
  if (!t.trim()) return { kind: 'blank', prefix: '', text: '' };
  // 代码围栏必须在其他规则之前判，否则 ``` 会被当普通段
  if (/^\s*(```|~~~)/.test(t)) return { kind: 'fence', prefix: '', text: '' };
  // 分隔线：--- / *** / ___ ；要先于无序列表判断，否则 --- 会被当成 - 开头的列表项
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(t)) return { kind: 'hr', prefix: '', text: '' };
  // 标题
  const hm = t.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (hm) {
    return { kind: 'heading', level: hm[2].length, prefix: hm[1] + hm[2] + hm[3], text: hm[4].replace(/\s+$/, '') };
  }
  // 表格
  if (/^\s*\|/.test(t) || (/\s\|\s/.test(t) && /\|.*\|/.test(t))) {
    const body = t.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = body.split('|').map(c => c.trim());
    // 分隔行：| --- | :--: |
    if (cells.length && cells.every(c => /^:?-{1,}:?$/.test(c))) {
      return { kind: 'tableSep', prefix: '', text: '', cells };
    }
    return { kind: 'table', prefix: '', text: '', cells };
  }
  // 引用
  const qm = t.match(/^(\s*(?:>\s*)+)(.*)$/);
  if (qm) return { kind: 'quote', prefix: qm[1], text: qm[2].replace(/\s+$/, '') };
  // 无序列表
  const bm = t.match(/^(\s*)([-*+])(\s+)(.*)$/);
  if (bm) return { kind: 'bullet', prefix: bm[1] + bm[2] + bm[3], text: bm[4].replace(/\s+$/, '') };
  // 有序列表
  const om = t.match(/^(\s*)(\d+[.)])(\s+)(.*)$/);
  if (om) return { kind: 'ordered', prefix: om[1] + om[2] + om[3], text: om[4].replace(/\s+$/, '') };
  return { kind: 'para', prefix: '', text: t.trim() };
}

async function extractPlain(file, fileName, isMd) {
  const { text } = await readText(file);
  const lines = text.split(/\r?\n/);
  const units = [];
  let inFence = false;
  lines.forEach((line, idx) => {
    if (isMd) {
      const a = analyzeMdLine(line);
      if (a.kind === 'fence') { inFence = !inFence; return; }
      if (inFence) return;                       // 代码块内容原样保留，不送翻
      if (a.kind === 'tableSep' || a.kind === 'hr' || a.kind === 'blank') return;
      if (a.kind === 'table') {
        // 每个非空单元格单独成单元，整行原文挂在第一个单元的 rowRaw 上，
        // 这样重建时没被送翻的格子（纯数字等）能原样回填
        a.cells.forEach((cellText, ci) => {
          if (!isTranslateableDoc(cellText)) return;
          units.push({
            file: fileName, seq: units.length, lineIndex: idx, cellIndex: ci,
            rowRaw: a.cells.slice(), mdKind: 'cell', prefix: '',
            original: cellText, raw: line, translated: '', error: '', ex: 'plain', docType: 'plain',
          });
        });
        return;
      }
      if (!isTranslateableDoc(a.text)) return;
      units.push({
        file: fileName, seq: units.length, lineIndex: idx,
        mdKind: a.kind, mdLevel: a.level || 0, prefix: a.prefix,
        original: a.text, raw: line, translated: '', error: '', ex: 'plain', docType: 'plain',
      });
      return;
    }
    // txt：按行处理，无结构
    const original = line.trim();
    if (!isTranslateableDoc(original)) return;
    units.push({ file: fileName, seq: units.length, lineIndex: idx, original, raw: line, translated: '', error: '', ex: 'plain', docType: 'plain' });
  });
  return { units, meta: { text } };
}

function rebuildPlain(meta, units, mode) {
  const lines = meta.text.split(/\r?\n/);
  const byLine = new Map();
  for (const u of units) {
    if (u.lineIndex == null) continue;
    if (!byLine.has(u.lineIndex)) byLine.set(u.lineIndex, []);
    byLine.get(u.lineIndex).push(u);
  }
  for (const [idx, us] of byLine) {
    if (us[0].cellIndex !== undefined && us[0].cellIndex !== null) {
      // 表格行：用原始单元格数组回填，只覆盖被翻译过的格子
      const cells = us[0].rowRaw ? us[0].rowRaw.slice() : [];
      for (const u of us) cells[u.cellIndex] = unitText(u, mode);
      lines[idx] = '| ' + cells.join(' | ') + ' |';
    } else {
      lines[idx] = (us[0].prefix || '') + unitText(us[0], mode);
    }
  }
  return { text: lines.join('\n') };
}

/* ---------------- HTML / EPUB（DOM 文本节点） ---------------- */

function extractHtmlDom(html, fileName, docType, container) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const units = [];
  const nodes = [];
  const walker = dom.createTreeWalker(dom.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      return isTranslateableDoc(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((n, i) => {
    units.push({
      file: fileName, seq: i, original: (n.nodeValue || '').trim(),
      raw: { container },
      translated: '', error: '', ex: 'html', docType,
    });
  });
  return units;
}

async function extractHtmlFile(file, fileName) {
  const { text } = await readText(file);
  const units = extractHtmlDom(text, fileName, 'html', null);
  return { units, meta: { text } };
}

function rebuildHtmlDom(meta, units, mode) {
  const dom = new DOMParser().parseFromString(meta.text, 'text/html');
  const nodes = [];
  const walker = dom.createTreeWalker(dom.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      return isTranslateableDoc(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const bySeq = new Map(units.map(u => [u.seq, u]));
  nodes.forEach((n, i) => {
    const u = bySeq.get(i);
    if (u) n.nodeValue = unitText(u, mode);
  });
  return { text: new XMLSerializer().serializeToString(dom) };
}

/* ---------------- DOCX（ZIP + word/document.xml） ---------------- */

async function loadZip(blob) {
  if (!window.JSZip) throw new Error('JSZip 未加载（离线时请先连接网络加载一次）');
  return window.JSZip.loadAsync(blob);
}

function docxParagraphs(dom) {
  return Array.from(dom.getElementsByTagNameNS(DOCX_NS, 'p'));
}

function paraText(para) {
  const tNodes = para.getElementsByTagNameNS(DOCX_NS, 't');
  let s = '';
  for (const t of tNodes) s += t.textContent || '';
  return s.trim();
}

async function extractDocx(file, fileName) {
  const zip = await loadZip(file);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('docx 缺少 word/document.xml');
  const xml = await entry.async('string');
  const stylesEntry = zip.file('word/styles.xml');
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : '';
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const units = [];
  const paras = docxParagraphs(dom);
  let seq = 0;
  for (const para of paras) {
    const original = paraText(para);
    if (!isTranslateableDoc(original)) continue;
    units.push({ file: fileName, seq: seq++, original, raw: null, translated: '', error: '', ex: 'docx', docType: 'docx' });
  }
  return { units, meta: { xml, stylesXml } };
}

/* ---------------- docx → HTML（导出 PDF 用，保留标题层级与表格） ---------------- */

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _directChild(node, localName) {
  if (!node) return null;
  for (const c of node.children) if (c.localName === localName) return c;
  return null;
}

function _ancestor(node, localName) {
  let n = node ? node.parentNode : null;
  while (n && n.localName) {
    if (n.localName === localName) return n;
    n = n.parentNode;
  }
  return null;
}

/** 从 styles.xml 读出 styleId → 标题级别（中文版 Word 的 styleId 常是 "1"/"2"） */
function _headingStyleMap(stylesXml) {
  const map = new Map();
  if (!stylesXml) return map;
  const dom = new DOMParser().parseFromString(stylesXml, 'application/xml');
  const styles = dom.getElementsByTagNameNS(DOCX_NS, 'style');
  for (const st of styles) {
    const id = st.getAttribute('w:styleId') || '';
    if (!id) continue;
    const pPr = _directChild(st, 'pPr');
    let level = 0;
    if (pPr) {
      const ol = _directChild(pPr, 'outlineLvl');
      if (ol) {
        const v = parseInt(ol.getAttribute('w:val') || '-1', 10);
        if (v >= 0 && v <= 5) level = v + 1;
      }
    }
    if (!level) {
      const low = id.toLowerCase();
      const m = low.match(/^heading\s*([1-6])$/) || low.match(/^([1-6])$/);
      if (m) level = parseInt(m[1], 10);
      else if (low === 'title') level = 1;
      else if (low === 'subtitle') level = 2;
    }
    if (level) map.set(id, level);
  }
  return map;
}

/** 段落样式 → 标签：h1..h6 / li / p */
function _paraTag(p, styleMap) {
  const pPr = _directChild(p, 'pPr');
  if (!pPr) return { tag: 'p' };
  const ol = _directChild(pPr, 'outlineLvl');
  if (ol) {
    const v = parseInt(ol.getAttribute('w:val') || '-1', 10);
    if (v >= 0 && v <= 5) return { tag: 'h' + (v + 1) };
  }
  const st = _directChild(pPr, 'pStyle');
  if (st) {
    const id = st.getAttribute('w:val') || '';
    const lvl = styleMap.get(id);
    if (lvl) return { tag: 'h' + lvl };
    if (/^(list|listparagraph)/i.test(id)) return { tag: 'li' };
  }
  if (_directChild(pPr, 'numPr')) return { tag: 'li' };
  return { tag: 'p' };
}

/**
 * 把 docx 正文转成 HTML 片段。
 * 段落枚举顺序与 extractDocx 完全一致（同一个 docxParagraphs + 同样的可译判定），
 * 因此 seq 能准确对上 units。译文与原文的 run 边界对不上，
 * 所以 run 级粗体/斜体不保留，段落级样式与表格结构保留。
 */
export async function docxToHtml(file, units, mode) {
  const zip = await loadZip(file);
  const docEntry = zip.file('word/document.xml');
  if (!docEntry) throw new Error('docx 缺少 word/document.xml');
  const xml = await docEntry.async('string');
  const stylesEntry = zip.file('word/styles.xml');
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : '';
  return docxMarkupToHtml(xml, stylesXml, units, mode);
}

/** 把 docx 正文转成 HTML 片段（接受已解析的 XML 字符串，便于测试与复用） */
export function docxMarkupToHtml(documentXml, stylesXml, units, mode) {
  const dom = new DOMParser().parseFromString(documentXml, 'application/xml');
  const styleMap = _headingStyleMap(stylesXml);
  const paras = docxParagraphs(dom);
  let seq = 0;
  const out = [];
  let openList = false;
  let curTbl = null, curRow = null, curCell = null;

  const closeCell = () => { if (curCell) { out.push('</td>'); curCell = null; } };
  const closeRow = () => { closeCell(); if (curRow) { out.push('</tr>'); curRow = null; } };
  const closeTbl = () => { closeRow(); if (curTbl) { out.push('</table>'); curTbl = null; } };
  const closeList = () => { if (openList) { out.push('</ul>'); openList = false; } };

  for (const p of paras) {
    const original = paraText(p);
    const translatable = isTranslateableDoc(original);
    let text = original;
    if (translatable) {
      const u = units[seq++];
      if (u) text = unitText(u, mode);
    }

    const tbl = _ancestor(p, 'tbl');
    if (tbl !== curTbl) {
      closeList();
      closeTbl();
      if (tbl) { out.push('<table>'); curTbl = tbl; }
    }

    if (tbl) {
      const tr = _ancestor(p, 'tr');
      if (tr !== curRow) { closeRow(); out.push('<tr>'); curRow = tr; }
      const tc = _ancestor(p, 'tc');
      if (tc !== curCell) { closeCell(); out.push('<td>'); curCell = tc; }
      if (text) out.push('<p>' + _esc(text) + '</p>');
      continue;
    }

    const { tag } = _paraTag(p, styleMap);
    if (tag === 'li') {
      if (!openList) { out.push('<ul>'); openList = true; }
      out.push('<li>' + _esc(text) + '</li>');
      continue;
    }
    closeList();
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) out.push('<' + tag + '>' + _esc(text) + '</' + tag + '>');
    else out.push('<p>' + _esc(text) + '</p>');
  }
  closeList();
  closeTbl();
  return out.join('\n');
}

function rebuildDocx(meta, units, mode) {
  const dom = new DOMParser().parseFromString(meta.xml, 'application/xml');
  const paras = docxParagraphs(dom);
  let seq = 0;
  const bySeq = new Map(units.map(u => [u.seq, u]));
  for (const para of paras) {
    const original = paraText(para);
    if (!isTranslateableDoc(original)) continue;
    const u = bySeq.get(seq);
    seq++;
    if (!u) continue;
    const tNodes = para.getElementsByTagNameNS(DOCX_NS, 't');
    if (!tNodes.length) continue;
    const text = unitText(u, mode);
    // 译文写入段落首个 w:t，其余 w:t 文本清空（保留 run 格式框架）
    tNodes[0].textContent = text;
    for (let i = 1; i < tNodes.length; i++) tNodes[i].textContent = '';
  }
  return { text: new XMLSerializer().serializeToString(dom) };
}

/* ---------------- EPUB（ZIP + 多个 XHTML） ---------------- */

const EPUB_HTML_RE = /\.(x?html?|xhtm)$/i;

async function extractEpub(file, fileName) {
  const zip = await loadZip(file);
  const htmlEntries = Object.keys(zip.files).filter(n => EPUB_HTML_RE.test(n));
  const units = [];
  const metas = [];
  for (const name of htmlEntries) {
    const xml = await zip.file(name).async('string');
    const us = extractHtmlDom(xml, fileName, 'epub', name);
    metas.push({ name, xml });
    units.push(...us);
  }
  return { units, meta: { zip, metas } };
}

function rebuildEpub(meta, units, mode) {
  const byContainer = new Map();
  for (const m of meta.metas) byContainer.set(m.name, { xml: m.xml, dom: new DOMParser().parseFromString(m.xml, 'text/html') });
  const changed = new Set();
  for (const u of units) {
    const c = byContainer.get(u.raw && u.raw.container);
    if (!c) continue;
    const nodes = [];
    const walker = c.dom.createTreeWalker(c.dom.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
        return isTranslateableDoc(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const node = nodes[u.seq];
    if (node) node.nodeValue = unitText(u, mode);
    changed.add(u.raw.container);
  }
  const newXmls = {};
  for (const name of changed) {
    newXmls[name] = new XMLSerializer().serializeToString(byContainer.get(name).dom);
  }
  return { zipEntries: newXmls };
}

/* ---------------- XLSX（ZIP + sharedStrings / sheet XML） ---------------- */

function siText(si, ns) {
  // <si> 聚合所有 <t> 的文本（含富文本 run）
  const ts = si.getElementsByTagNameNS(ns, 't');
  let s = '';
  for (const t of ts) s += t.textContent || '';
  return s.trim();
}

async function extractXlsx(file, fileName) {
  const zip = await loadZip(file);
  const units = [];
  let seq = 0;
  // 1) sharedStrings.xml
  const ssEntry = zip.file('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = await ssEntry.async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const sis = Array.from(dom.getElementsByTagNameNS(SPREADSHEET_NS, 'si'));
    sis.forEach((si, idx) => {
      const original = siText(si, SPREADSHEET_NS);
      if (!isTranslateableDoc(original)) return;
      units.push({ file: fileName, seq: seq++, original, raw: { kind: 'shared', idx }, translated: '', error: '', ex: 'xlsx', docType: 'xlsx' });
    });
  }
  // 2) 各 sheet 的 inline strings（<c t="inlineStr"><is><t>…</t></is></c>）
  const sheetNames = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  for (const name of sheetNames) {
    const xml = await zip.file(name).async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const isNodes = dom.getElementsByTagNameNS(SPREADSHEET_NS, 'is');
    let inSeq = 0;
    for (const isNode of isNodes) {
      const tNode = isNode.getElementsByTagNameNS(SPREADSHEET_NS, 't')[0];
      if (!tNode) continue;
      const original = (tNode.textContent || '').trim();
      if (!isTranslateableDoc(original)) continue;
      units.push({ file: fileName, seq: seq++, original, raw: { kind: 'inline', sheet: name, inSeq: inSeq++ }, translated: '', error: '', ex: 'xlsx', docType: 'xlsx' });
    }
  }
  return { units, meta: {} };
}

async function rebuildXlsx(file, units, mode) {
  const zip = await loadZip(file);
  // sharedStrings
  const ssEntry = zip.file('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = await ssEntry.async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const sis = Array.from(dom.getElementsByTagNameNS(SPREADSHEET_NS, 'si'));
    const byIdx = new Map(units.filter(u => u.raw.kind === 'shared').map(u => [u.raw.idx, u]));
    sis.forEach((si, idx) => {
      const u = byIdx.get(idx);
      if (!u) return;
      const tNodes = si.getElementsByTagNameNS(SPREADSHEET_NS, 't');
      if (!tNodes.length) return;
      tNodes[0].textContent = unitText(u, mode);
      for (let i = 1; i < tNodes.length; i++) tNodes[i].textContent = '';
    });
    zip.file('xl/sharedStrings.xml', new XMLSerializer().serializeToString(dom));
  }
  // inline strings
  const bySheet = new Map();
  for (const u of units.filter(u => u.raw.kind === 'inline')) {
    if (!bySheet.has(u.raw.sheet)) bySheet.set(u.raw.sheet, []);
    bySheet.get(u.raw.sheet).push(u);
  }
  for (const [sheet, sus] of bySheet) {
    const xml = await zip.file(sheet).async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const isNodes = dom.getElementsByTagNameNS(SPREADSHEET_NS, 'is');
    let inSeq = 0;
    const byInSeq = new Map(sus.map(u => [u.raw.inSeq, u]));
    for (const isNode of isNodes) {
      const tNode = isNode.getElementsByTagNameNS(SPREADSHEET_NS, 't')[0];
      if (!tNode) continue;
      const original = (tNode.textContent || '').trim();
      if (!isTranslateableDoc(original)) continue;
      const u = byInSeq.get(inSeq++);
      if (u) tNode.textContent = unitText(u, mode);
    }
    zip.file(sheet, new XMLSerializer().serializeToString(dom));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob };
}

/* ---------------- PPTX（ZIP + slides XML 的 a:t 文本） ---------------- */

function slideParaText(p, ns) {
  const ts = p.getElementsByTagNameNS(ns, 't');
  let s = '';
  for (const t of ts) s += t.textContent || '';
  return s.trim();
}

async function extractPptx(file, fileName) {
  const zip = await loadZip(file);
  const units = [];
  const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let seq = 0;
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const paras = dom.getElementsByTagNameNS(DRAWING_NS, 'p');
    for (const p of paras) {
      const original = slideParaText(p, DRAWING_NS);
      if (!isTranslateableDoc(original)) continue;
      units.push({ file: fileName, seq: seq++, original, raw: { slide: name }, translated: '', error: '', ex: 'pptx', docType: 'pptx' });
    }
  }
  return { units, meta: {} };
}

async function rebuildPptx(file, units, mode) {
  const zip = await loadZip(file);
  const bySlide = new Map();
  units.forEach((u, i) => {
    if (!bySlide.has(u.raw.slide)) bySlide.set(u.raw.slide, []);
    bySlide.get(u.raw.slide).push(u);
  });
  for (const [slide, sus] of bySlide) {
    const xml = await zip.file(slide).async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const paras = dom.getElementsByTagNameNS(DRAWING_NS, 'p');
    let seq = 0;
    const bySeq = new Map(sus.map(u => [u.seq, u]));
    for (const p of paras) {
      const original = slideParaText(p, DRAWING_NS);
      if (!isTranslateableDoc(original)) continue;
      const u = bySeq.get(seq++);
      if (!u) continue;
      const tNodes = p.getElementsByTagNameNS(DRAWING_NS, 't');
      if (!tNodes.length) continue;
      tNodes[0].textContent = unitText(u, mode);
      for (let i = 1; i < tNodes.length; i++) tNodes[i].textContent = '';
    }
    zip.file(slide, new XMLSerializer().serializeToString(dom));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob };
}

/* ---------------- PDF（后端 pymupdf 解析 + OCR 图片型） ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function extractPdf(file, fileName, onProgress, forceOcr) {
  const res = await fetch('/api/pdf/extract', { method: 'POST', body: file });
  const data = await res.json().catch(() => ({}));
  if (!data || !data.ok) throw new Error((data && data.error) || 'PDF 解析失败（请确认文件有效）');
  const mkUnits = (paragraphs, pdfKind) => (paragraphs || []).map((p, i) => ({
    file: fileName, seq: i, original: p.original,
    raw: { tempId: data.tempId, pdfKind }, translated: '', error: '', ex: 'pdf', docType: 'pdf',
  }));
  let units = mkUnits(data.paragraphs, forceOcr ? 'ocr' : data.pdf_kind);
  // OCR 触发：图片型（扫描件）自动，或用户强制图片 OCR（文字层乱码/缺失时）
  if (forceOcr || data.pdf_kind === 'image') {
    if (onProgress) onProgress(`OCR 识别 ${fileName}（${forceOcr ? '强制图片 OCR' : '扫描版'}，共 ${data.page_count} 页）…`);
    await fetch('/api/pdf/ocr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempId: data.tempId }),
    });
    for (let i = 0; i < 6000; i++) {
      await sleep(500);
      const st = await fetch(`/api/pdf/ocr/status?tempId=${data.tempId}`).then(r => r.json()).catch(() => ({}));
      if (!st.ok) break;
      if (st.error) throw new Error('OCR 识别失败：' + st.error);
      if (st.running && st.page > 0 && onProgress) onProgress(`OCR 识别 ${fileName}：${st.page}/${st.total} 页`);
      if (!st.running && st.paragraphs) {
        units = mkUnits(st.paragraphs, forceOcr ? 'ocr' : 'image');
        break;
      }
    }
    if (!units.length) throw new Error('OCR 未能识别到文字（扫描件可能过于模糊）');
  }
  return { units, meta: { tempId: data.tempId, pdfKind: forceOcr ? 'ocr' : data.pdf_kind, totalChars: data.total_chars, pageCount: data.page_count } };
}

/** PDF 导出：调后端生成 Word / Markdown / 重排 PDF */
export async function exportPdfDoc(tempId, units, fmt) {
  const translated = units.map(u => ({ seq: u.seq, translated: u.translated || u.original }));
  const res = await fetch('/api/pdf/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempId, translated, fmt }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d && d.error) || '导出失败');
  }
  const ct = res.headers.get('Content-Disposition') || '';
  const m = ct.match(/filename="([^"]+)"/);
  const blob = await res.blob();
  return { blob, filename: m ? m[1] : 'translated.' + fmt };
}

/* ---------------- 统一入口 ---------------- */

export async function extractDoc(file, fileName, onProgress, forceOcr) {
  const type = detectDocType(fileName);
  switch (type) {
    case 'plain': return extractPlain(file, fileName, /\.(md|markdown)$/i.test(fileName));
    case 'html': return extractHtmlFile(file, fileName);
    case 'docx': return extractDocx(file, fileName);
    case 'epub': return extractEpub(file, fileName);
    case 'xlsx': return extractXlsx(file, fileName);
    case 'pptx': return extractPptx(file, fileName);
    case 'pdf': return extractPdf(file, fileName, onProgress, forceOcr);
    default: throw new Error('不支持的文档格式：' + fileName);
  }
}

/** 写回：返回 { blob?, text? } 或 { zipEntries } 由调用方打包 */
export async function rebuildDoc(file, fileName, units, mode) {
  const type = detectDocType(fileName);
  switch (type) {
    case 'plain': {
      const { text } = await readText(file);
      return rebuildPlain({ text }, units, mode);
    }
    case 'html': {
      const { text } = await readText(file);
      return rebuildHtmlDom({ text }, units, mode);
    }
    case 'docx': {
      const zip = await loadZip(file);
      const xml = await zip.file('word/document.xml').async('string');
      const rebuilt = rebuildDocx({ xml }, units, mode);
      zip.file('word/document.xml', rebuilt.text);
      const blob = await zip.generateAsync({ type: 'blob' });
      return { blob };
    }
    case 'epub': {
      const zip = await loadZip(file);
      const htmlEntries = Object.keys(zip.files).filter(n => EPUB_HTML_RE.test(n));
      const metas = [];
      for (const name of htmlEntries) {
        const xml = await zip.file(name).async('string');
        metas.push({ name, xml });
      }
      const rebuilt = rebuildEpub({ metas }, units, mode);
      for (const [name, xml] of Object.entries(rebuilt.zipEntries)) {
        zip.file(name, xml);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      return { blob };
    }
    case 'xlsx': return rebuildXlsx(file, units, mode);
    case 'pptx': return rebuildPptx(file, units, mode);
    default: throw new Error('不支持的文档格式：' + fileName);
  }
}

/** 文档查看：每单元一行（原文 / 对照 / 译文） */
export function docText(units, mode) {
  return units.slice().sort((a, b) => a.seq - b.seq).map(u => unitText(u, mode)).join('\n');
}
