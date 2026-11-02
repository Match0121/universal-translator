// fsDrop.js — 拖入/选择文件与文件夹的通用收集逻辑（图片工作台、文档工作台共用）
//
// 浏览器限制：一次点击只能打开「文件多选」或「选文件夹」其中一种对话框，
// 所以两个入口并列放在拖拽框里，而不是合并成一个。
//
// 所有函数统一返回 [{ file, relPath }]，relPath 带子目录前缀（如 "章节1/a.png"），
// 可用作同名文件的唯一标识。

/** 递归展开 FileSystemEntry，只要 accept(name) 通过的普通文件 */
export async function walkEntry(entry, prefix, out, accept) {
  if (entry.isFile) {
    try {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      if (accept(f.name) && !f.name.startsWith('.')) {
        out.push({ file: f, relPath: prefix + f.name });
      }
    } catch (e) { /* 单个文件读失败就跳过，不拖垮整批 */ }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const nextPrefix = prefix + entry.name + '/';
  // readEntries 单次最多返回 100 条，必须循环读到空为止
  while (true) {
    let batch = [];
    try {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    } catch (e) {
      break;
    }
    if (!batch || !batch.length) break;
    for (const e of batch) await walkEntry(e, nextPrefix, out, accept);
  }
}

/**
 * 从 drop 事件收集文件，支持整个文件夹递归
 * @param {DataTransfer} dt
 * @param {(name:string)=>boolean} accept 文件名过滤器
 */
export async function collectFromDataTransfer(dt, accept) {
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const ent = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (ent) entries.push(ent);
  }
  if (entries.length) {
    for (const ent of entries) await walkEntry(ent, '', out, accept);
  } else if (dt.files && dt.files.length) {
    // 兜底：拿不到 entry 时按平铺文件处理（文件夹内容会拿不到）
    for (const f of Array.from(dt.files)) {
      if (accept(f.name)) out.push({ file: f, relPath: f.name });
    }
  }
  return out;
}

/** 把 FileList 转成 {file, relPath}；webkitdirectory 会给文件带上 webkitRelativePath */
export function fromFileList(fileList, accept) {
  return Array.from(fileList || [])
    .filter(f => accept(f.name))
    .map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
}

/** 建一个隐藏的 input[type=file]（文件多选 / 选文件夹） */
export function makeFileInput({ accept, multiple = true, directory = false, onFiles }) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.multiple = multiple;
  if (directory) input.webkitdirectory = true;
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length) onFiles(files);
  });
  return input;
}