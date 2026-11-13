// utils.js — 通用工具函数（无 DOM 依赖的部分保持纯净，便于 node 单测）

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** djb2 哈希，用于缓存 key */
export function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + (s % 60) + 's';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 保存导出文件：优先弹系统保存对话框（选位置+命名），失败/不可用时回退浏览器下载 */
export async function saveBlobDialog(blob, suggestedName) {
  const pick = await pickSaveFile(suggestedName);
  if (pick.ok) {
    await writeSaveHandle(pick.handle, blob);
    return true;
  }
  if (pick.cancelled) return true;   // 用户取消
  downloadBlob(blob, suggestedName);
  return false;
}

/** 在用户激活窗口内提前弹保存框拿句柄（必须在点击事件的同步/首拍调用） */
export async function pickSaveFile(suggestedName) {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName });
      return { ok: true, handle };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, cancelled: true };   // 用户取消
    return { ok: false, error: e };
  }
  return { ok: false };
}

/** 把 blob 写入已选中的保存句柄 */
export async function writeSaveHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** 选一个目录（多文件导出用）。必须在点击事件的首拍调用，否则会失用户激活 */
export async function pickDirectory() {
  try {
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      return { ok: true, handle };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, cancelled: true };
    return { ok: false, error: e };
  }
  return { ok: false };
}

/** 目录下该文件名是否已存在（不创建、不覆盖） */
async function dirFileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);   // 不带 create：存在则拿到句柄，不存在抛 NotFoundError
    return true;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return false;
    // 部分实现抛别的异常，退回列举目录判断，宁可多查一次也不能误判成"不存在"
    try {
      for await (const entry of dirHandle.values()) {
        if (entry.name === name && entry.kind === 'file') return true;
      }
      return false;
    } catch (e2) {
      throw e;
    }
  }
}

/** 在目标目录里挑一个不冲突的文件名：a.txt 已存在就用 a_2.txt、a_3.txt… */
export async function uniqueDirName(dirHandle, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let k = 2;
  while (await dirFileExists(dirHandle, candidate)) {
    candidate = stem + '_' + (k++) + ext;
  }
  return candidate;
}

/**
 * 把 blob 写入目录句柄下的指定文件名。
 * 目标目录已有同名文件时自动加序号，不覆盖原文件；返回实际使用的文件名。
 */
export async function writeDirFile(dirHandle, name, blob) {
  const finalName = await uniqueDirName(dirHandle, name);
  const fh = await dirHandle.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return finalName;
}

/** 把字符串里第 n 次（0 起）出现的 from 替换为 to */
export function replaceNth(s, from, to, n) {
  let idx = -1, count = 0;
  while ((idx = s.indexOf(from, idx + 1)) !== -1) {
    if (count === n) return s.slice(0, idx) + to + s.slice(idx + from.length);
    count++;
  }
  return s;
}
