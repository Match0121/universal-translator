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

async function extractPlain(file, fileName) {
  const { text } = await readText(file);
  const lines = text.split(/\r?\n/);
  const units = [];
  lines.forEach((line, idx) => {
    const original = line.trim();
    if (!isTranslateableDoc(original)) return;
    units.push({ file: fileName, seq: units.length, lineIndex: idx, original, raw: line, translated: '', error: '', ex: 'plain', docType: 'plain' });
  });
  return { units, meta: { text } };
}

function rebuildPlain(meta, units, mode) {
  const lines = meta.text.split(/\r?\n/);
  for (const u of units) {
    if (u.lineIndex == null) continue;
    lines[u.lineIndex] = unitText(u, mode);
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
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const units = [];
  const paras = docxParagraphs(dom);
  let seq = 0;
  for (const para of paras) {
    const original = paraText(para);
    if (!isTranslateableDoc(original)) continue;
    units.push({ file: fileName, seq: seq++, original, raw: null, translated: '', error: '', ex: 'docx', docType: 'docx' });
  }
  return { units, meta: { xml } };
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
    case 'plain': return extractPlain(file, fileName);
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
