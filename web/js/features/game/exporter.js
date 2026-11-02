// exporter.js — 行级写回 + zip 导出（JSZip 走 CDN，window.JSZip）

import { groupBy, replaceNth, downloadBlob } from '../../utils.js';
import { readText, encodeText } from './encoding.js';

/* 各种 raw 形态的写回组装 */

function rebuildJsonRaw(raw, translated) {
  const i = raw.indexOf('"');
  const j = raw.lastIndexOf('"');
  if (i < 0 || j <= i) return raw;
  const escaped = translated.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return raw.slice(0, i + 1) + escaped + raw.slice(j);
}

function rebuildQuotedRaw(raw, translated) {
  // raw 形如 "xxx" 或 'xxx' 或 「xxx」／『xxx』，替换引号内内容（ASCII 引号保留转义）
  const q = raw[0];
  const q2 = raw.length > 1 ? raw[raw.length - 1] : q;
  let escaped = translated;
  if (q === '"' || q === "'") {
    escaped = translated.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q);
  }
  return q + escaped + q2;
}

/** 单个单元应用到某一行；返回 { line, extra }（extra 用于双语模式下插入额外行） */
function applyUnitToLine(line, u, mode) {
  const translated = u.translated || u.original;
  if (mode === 'bilingual') {
    if (u.ex === 'srt' || u.ex === 'ass') {
      // 字幕双语：原行替换为译文，下一行插入原文
      return { line: replaceNth(line, u.raw, translated, u.occurrence), extra: [u.original] };
    }
    // 其他格式双语：结构保留（引号/冒号等），引号内替换为 原文（译文）
    const both = u.original + '（' + translated + '）';
    let rep;
    switch (u.ex) {
      case 'json': rep = rebuildJsonRaw(u.raw, both); break;
      case 'ini': rep = u.raw.replace(/\s*=\s*[\s\S]*$/, '=' + both); break;
      case 'rpy':
      case 'ks': rep = rebuildQuotedRaw(u.raw, both); break;
      case 'yaml': rep = u.raw.replace(u.original, both); break;
      default: rep = both;
    }
    return { line: replaceNth(line, u.raw, rep, u.occurrence), extra: [] };
  }
  let rep;
  switch (u.ex) {
    case 'json': rep = rebuildJsonRaw(u.raw, translated); break;
    case 'ini': rep = u.raw.replace(/\s*=\s*[\s\S]*$/, '=' + translated); break;
    case 'rpy':
    case 'ks': rep = rebuildQuotedRaw(u.raw, translated); break;
    case 'yaml': rep = u.raw.replace(u.original, translated); break;
    case 'ass': rep = (u.meta && u.meta.tags ? u.meta.tags.join('') : '') + translated; break;
    default: rep = translated;
  }
  return { line: replaceNth(line, u.raw, rep, u.occurrence), extra: [] };
}

/** 按行重建文件内容 */
export function rebuild(text, units, mode = 'translated') {
  const lines = text.split(/\r?\n/);
  const byLine = groupBy(units, 'lineIndex');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const us = (byLine.get(i) || []).slice().sort((a, b) => a.occurrence - b.occurrence);
    if (!us.length) { out.push(lines[i]); continue; }
    let line = lines[i];
    const extras = [];
    for (const u of us) {
      const r = applyUnitToLine(line, u, mode);
      line = r.line;
      extras.push(...r.extra);
    }
    out.push(line, ...extras);
  }
  return out.join('\n');
}

/** 导出为 zip（按原目录结构）。返回 { warnings }：编码降级等提示 */
export async function exportZip(files, units, mode, zipName, saveFn) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip 未加载，请检查网络后刷新页面');
  const zip = new JSZip();
  const byFile = groupBy(units, 'file');
  const targets = files.filter(f => byFile.has(f.path) && !f.skipped);
  const warnings = [];
  let done = 0;
  for (const f of targets) {
    try {
      const { text, encoding } = await readText(f.file);
      const rebuilt = rebuild(text, byFile.get(f.path), mode);
      // 资源包内文件（xp3Rel）用包内路径，避免与散装文件冲突
      const zipPath = f.xp3Rel ? 'xp3_unpack/' + f.xp3Rel : f.path;
      if (encoding && encoding !== 'utf-8') {
        try {
          // 保持原编码写回（Shift-JIS/GBK 由本地服务编码）
          zip.file(zipPath, await encodeText(rebuilt, encoding));
        } catch (e) {
          // 原编码无法表示译文（如 Shift-JIS 装不下简体中文）→ 降级 UTF-8
          zip.file(zipPath, rebuilt);
          warnings.push(`${zipPath}：原编码 ${encoding} 无法表示译文，已转存为 UTF-8（游戏可能需要中文字库才能正常显示）`);
        }
      } else {
        zip.file(zipPath, rebuilt);
      }
    } catch (e) {
      console.warn('导出失败:', f.path, e);
    }
    done++;
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  if (saveFn) await saveFn(blob, zipName || 'translated.zip');
  else downloadBlob(blob, zipName || 'translated.zip');
  return { warnings };
}

/** 封包：把资源包内已翻译文件写回并重新打包为 xp3（本地服务端合并 + 封包）
 *  返回 { warnings } 编码降级提示 */
export async function exportXp3(files, units, mode, name, saveFn) {
  const byFile = groupBy(units, 'file');
  const targets = files.filter(f => f.xp3Rel && byFile.has(f.path) && !f.skipped);
  if (!targets.length) throw new Error('没有已翻译的资源包文件');
  const tempId = targets[0].tempId;
  const modified = {};
  const warnings = [];
  for (const f of targets) {
    const { text, encoding } = await readText(f.file);
    const rebuilt = rebuild(text, byFile.get(f.path), mode);
    let bytes;
    try {
      bytes = (encoding && encoding !== 'utf-8')
        ? await encodeText(rebuilt, encoding)
        : new TextEncoder().encode(rebuilt);
    } catch (e) {
      bytes = new TextEncoder().encode(rebuilt);
      warnings.push(`${f.xp3Rel}：原编码无法表示译文，已转存 UTF-8（游戏可能需要中文字库才能正常显示）`);
    }
    const u8 = new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    modified[f.xp3Rel] = btoa(bin);
  }
  const resp = await fetch('/api/pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempId, files: modified }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    throw new Error((err && err.error) || '封包失败（HTTP ' + resp.status + '）');
  }
  const blob = await resp.blob();
  if (saveFn) await saveFn(blob, name || 'translated.xp3');
  else downloadBlob(blob, name || 'translated.xp3');
  return { warnings };
}
