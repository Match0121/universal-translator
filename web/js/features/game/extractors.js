// extractors.js — 格式提取器（行级单元模型）
//
// 核心思路：把文本按行拆开，提取器逐行产出"翻译单元"。
// 每个单元记录 { 行号, 行内出现次序, 原文, raw(行内形态, 用于写回) }，
// 提取与写回共用同一套定位，因此天然支持原文/译文切换与导出回原格式。
// 本文件无 DOM 依赖，可在 node 中直接单测。

import { extOf } from '../../utils.js';

export const TEXT_EXT = new Set([
  'txt', 'md', 'log', 'story', 'script', 'dialogue', 'text',
  'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf',
  'srt', 'ass', 'ssa', 'rpy', 'ks', 'csv', 'tsv',
]);

const RE_URL = /^(https?:\/\/|www\.|ftp:|\/\/|\w+:\\|\/)/i;
const RE_JUNK = /^[\d\s.,%+\-*\/=<>:;|!?()[\]{}"'`~^#$@&]+$/;

/** 判断是否为中文文本（目标语言为中文时跳过，避免中文行送译被判失败）
 *  规则：含汉字、无假名，且命中中文强特征（中文标点/中文虚词/4+汉字长句）
 *  日文纯汉字短词（回復薬、勇者）不含这些特征，不会被误伤 */
export function isChineseText(t) {
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!han) return false;
  if (/[\u3040-\u30ff\uff61-\uff9f]/.test(t)) return false; // 含假名 → 日文
  if (/[，。！？；：「」“”、《》【】]/.test(t)) return true;     // 中文标点
  if (/[的吧了是在这那吗呢和被与就都还很从到对]/.test(t)) return true; // 中文虚词
  return han >= 4; // 4+ 汉字无假名 → 中文（日文纯汉字词通常很短）
}

/** 判断一行文本是否需要翻译（目标是中文时，已是中文的行跳过） */
let _targetLang = 'zh-CN';   // 由 extractFile 设置，避免每层函数都传参

export function isTranslateable(s, targetLang = _targetLang, skipPureHan = false) {
  if (!s) return false;
  const t = s.trim();
  if (!t || t.length > 800) return false;
  if (RE_URL.test(t) || RE_JUNK.test(t)) return false;
  if (/\s{3,}/.test(t)) return false;
  if (targetLang && targetLang.startsWith('zh') && isChineseText(t)) return false;
  if (targetLang && targetLang.startsWith('zh') && skipPureHan) {
    const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const kana = (t.match(/[\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    if (han > 0 && kana === 0 && han / t.length > 0.3) return false; // 纯中文行，跳过
  }
  return true;
}

function decodeEsc(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function escapeJsonStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** 行级单元构造器：matcher(line, idx) → [{original, raw?, ex?, meta?}] | null */
function makeUnits(lines, file, skipPureHan, matcher) {
  const units = [];
  lines.forEach((line, idx) => {
    const ms = matcher(line, idx);
    if (!ms || !ms.length) return;
    const lineSeen = new Map();
    for (const m of ms) {
      const original = m.original;
      if (!original) continue;
      if (!isTranslateable(original, _targetLang, skipPureHan)) continue;
      const raw = m.raw || original;
      const occ = lineSeen.get(raw) || 0;
      lineSeen.set(raw, occ + 1);
      units.push({
        id: `${file}|${idx}|${occ}`,
        file,
        lineIndex: idx,
        occurrence: occ,
        original,
        raw,
        translated: '',
        error: '',
        ex: m.ex || 'plain',
        meta: m.meta || null,
      });
    }
  });
  return units;
}

// 匹配三种引号对：ASCII " "、' '，日文「」、『』
// 分组：1=ASCII 引号字符，2=ASCII 引号内容，3=「内容」，4=『内容』
const RE_QUOTED = /(["'])((?:\\.|(?!\1).)*?)\1|「([^「」]*?)」|『([^『』]*?)』/g;

function quotedParts(m) {
  if (m[1] !== undefined) return { quote: m[1], inner: m[2] };
  if (m[3] !== undefined) return { quote: '「', inner: m[3] };
  return { quote: '『', inner: m[4] };
}

/* ---------------- 各格式提取器 ---------------- */

const EXTRACTORS = [
  {
    name: 'plain',
    exts: ['txt', 'md', 'log', 'story', 'script', 'dialogue', 'text'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        const t = line.trim();
        if (!isTranslateable(t, _targetLang, skipPureHan)) return null;
        return [{ original: t }];
      });
    },
  },

  {
    name: 'json',
    exts: ['json'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        const out = [];
        const re = /:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = re.exec(line))) {
          const decoded = decodeEsc(m[1]);
          if (!isTranslateable(decoded, _targetLang, skipPureHan)) continue;
          out.push({ original: decoded, raw: m[0], ex: 'json' });
        }
        return out.length ? out : null;
      });
    },
  },

  {
    name: 'ini',
    exts: ['ini', 'cfg', 'conf'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        if (/^\s*[;#]/.test(line) || /^\s*\[/.test(line) || !line.includes('=')) return null;
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (!key || !isTranslateable(val, _targetLang, skipPureHan)) return null;
        return [{ original: val, raw: line, ex: 'ini' }];
      });
    },
  },

  {
    name: 'srt',
    exts: ['srt'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        const t = line.trim();
        if (!t || /^\d+$/.test(t) || /-->/.test(t)) return null;
        if (!isTranslateable(t, _targetLang, skipPureHan)) return null;
        return [{ original: t }];
      });
    },
  },

  {
    name: 'ass',
    exts: ['ass', 'ssa'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        if (!/^Dialogue:/.test(line)) return null;
        const parts = line.split(',');
        if (parts.length < 10) return null;
        const textField = parts.slice(9).join(',');
        const tags = [];
        const plain = textField.replace(/\{[^}]*\}/g, (tag) => { tags.push(tag); return ''; }).trim();
        if (!plain || !isTranslateable(plain, _targetLang, skipPureHan)) return null;
        // raw 取 plain 在行内的最小形态；写回时标签拼回译文前
        return [{ original: plain, raw: plain, ex: 'ass', meta: { tags } }];
      });
    },
  },

  {
    name: 'rpy',
    exts: ['rpy'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line, idx) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return null;
        if (/^\$/.test(t) || /^(label\s|init\s|python\b|screen\b|transform\s|image\s)/.test(t)) return null;
        const out = [];
        const re = new RegExp(RE_QUOTED.source, 'g');
        let m;
        while ((m = re.exec(line))) {
          const p = quotedParts(m);
          const inner = decodeEsc(p.inner);
          const tr = inner.trim();
          if (!isTranslateable(tr, _targetLang, skipPureHan)) continue;
          if (/^\{.*\}$/.test(tr) || /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(tr)) continue; // 插值/标识符
          out.push({ original: tr, raw: m[0], ex: 'rpy', meta: { q: p.quote } });
        }
        return out.length ? out : null;
      });
    },
  },

  {
    name: 'ks',
    exts: ['ks'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        const t = line.trim();
        if (!t || t.startsWith(';') || /^\*/.test(t) || /^@/.test(t)) return null;
        const out = [];
        const re = new RegExp(RE_QUOTED.source, 'g');
        let m;
        while ((m = re.exec(line))) {
          const p = quotedParts(m);
          const inner = decodeEsc(p.inner);
          if (!isTranslateable(inner, _targetLang, skipPureHan)) continue;
          out.push({ original: inner, raw: m[0], ex: 'ks', meta: { q: p.quote } });
        }
        return out.length ? out : null;
      });
    },
  },

  {
    name: 'yaml',
    exts: ['yaml', 'yml'],
    extract(lines, file, skipPureHan) {
      return makeUnits(lines, file, skipPureHan, (line) => {
        const m = /^(\s*[^#][^:]*?:\s*)(["'])(.*?)\2\s*$/.exec(line);
        if (!m) return null;
        const orig = decodeEsc(m[3]);
        if (!isTranslateable(orig, _targetLang, skipPureHan)) return null;
        return [{ original: orig, raw: line, ex: 'yaml' }];
      });
    },
  },

  {
    name: 'csv',
    exts: ['csv', 'tsv'],
    extract() { return []; }, // 数据文件，默认不翻译
  },
];

export function extractFile(text, fileName, encoding, targetLang) {
  if (targetLang) _targetLang = targetLang;
  const ext = extOf(fileName);
  const ex = EXTRACTORS.find(e => e.exts.includes(ext));
  if (!ex) return [];
  // 只有 GBK（中文游戏）才启用“跳过纯汉字行”，避免误伤日文纯汉字词（回復薬/勇者）
  const skipPureHan = encoding === 'gbk';
  const lines = text.split(/\r?\n/);
  return ex.extract(lines, fileName, skipPureHan);
}

/** 由提取器名推断文件类型（用于 UI 展示） */
export function formatNameOf(fileName) {
  const ext = extOf(fileName);
  const ex = EXTRACTORS.find(e => e.exts.includes(ext));
  return ex ? ex.name : ext;
}
