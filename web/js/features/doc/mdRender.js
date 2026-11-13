// mdRender.js — Markdown / 纯文本 → HTML 片段
//
// 只做结构转换，不管样式。字号、间距、边框统一由后端 pdf.py 的 CSS 控制，
// 这样导出的 PDF 与网页预览不会各写一套规则。
//
// 依赖 window.marked（vendor/marked.min.js，UMD 全局）

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markedReady() {
  return typeof window !== 'undefined'
    && window.marked && typeof window.marked.parse === 'function';
}

/** Markdown 全文 → HTML 片段 */
export function mdToHtml(md) {
  if (!markedReady()) throw new Error('Markdown 渲染库未加载');
  const html = window.marked.parse(String(md || ''), { gfm: true, breaks: false });
  return String(html || '').trim();
}

/** 纯文本 → HTML：空行分段，段内换行保留为 <br> */
export function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(block => {
      const t = block.replace(/^\n+|\n+$/g, '');
      if (!t.trim()) return '';
      return '<p>' + esc(t).replace(/\n/g, '<br>') + '</p>';
    })
    .filter(Boolean)
    .join('\n');
}

/** 单元数组 → HTML：没有源格式信息时的兜底，每单元一段 */
export function unitsToHtml(units, pick) {
  return units
    .map(u => {
      const t = pick(u);
      return t && t.trim() ? '<p>' + esc(t).replace(/\n/g, '<br>') + '</p>' : '';
    })
    .filter(Boolean)
    .join('\n');
}
