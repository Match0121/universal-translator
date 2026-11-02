// imgWorkbench.js — 图片翻译工作台（批量）
// 流程：拖入图片 / 文件夹 → 勾选 → 串行 OCR → 批量翻译 → 平铺对照列表 → 覆盖图 ZIP 导出
//
// 与旧版单图工作台的区别：
//  - 支持整个文件夹递归收集图片
//  - 先选图，确认后才跑 OCR 和翻译（不再拖入即自动识别）
//  - 结果按「一条文本一行」平铺，每行带所属图片缩略图
//  - 导出默认是覆盖译文图 ZIP，可选同时带文本对照
import { $, $$, extOf, escapeHtml, fmtBytes, downloadBlob, sleep, pickSaveFile, writeSaveHandle, pickDirectory, writeDirFile } from '../../utils.js';
import { store } from '../../store.js';
import { translateUnits } from '../game/translator.js';
import { collectFromDataTransfer } from '../shared/fsDrop.js';
import { editBlockHtml, bindEditables, snapshotBases } from '../shared/editView.js';

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
const THUMB_MAX = 96;     // 缩略图长边像素
const MAX_IMAGES = 500;   // 单批上限，防止缩略图与解码内存堆积
const MAX_ROWS = 1500;    // 平铺列表单次渲染上限

const bs = {
  images: [],   // {id, file, name, relPath, size, thumb, width, height, boxes, selected, ocrState, error}
  view: 'bilingual',
  seq: 0,
  stop: null,
  editing: false,
  editRows: [],   // 编辑视图当前渲染的行（{img, b, first}）
  previewId: null, // 非空时正在放大查看某张图的覆盖图
};

/* ---------------- 阶段切换 ---------------- */

function imgShowStage(name) {
  $$('#ws-image .ut-stage').forEach(s => { s.hidden = s.id !== 'img-stage-' + name; });
}

function imgReset() {
  bs.images = [];
  bs.seq = 0;
  bs.stop = null;
  $('#imgFileList').innerHTML = '';
  $('#imgRows').innerHTML = '';
  imgProgressHide();
  imgShowStage('import');
}

/* ---------------- 进度条 ---------------- */

/** 选图阶段和结果阶段各有一个进度条，按当前可见 stage 取对应那个 */
function pg() {
  const stage = $('#img-stage-select');
  const inSelect = stage && !stage.hidden;
  return inSelect
    ? { wrap: $('#imgProgressWrapS'), bar: $('#imgProgressBarS'), text: $('#imgProgressTextS'), stop: $('#imgStopBtnS') }
    : { wrap: $('#imgProgressWrap'), bar: $('#imgProgressBar'), text: $('#imgProgressText'), stop: $('#imgStopBtn') };
}

function imgProgressShow(text) {
  const p = pg();
  if (!p.wrap) return;
  p.wrap.hidden = false;
  if (p.stop) p.stop.hidden = false;
  if (p.bar) p.bar.style.width = '0px';
  if (p.text) p.text.textContent = text || '';
}

function imgProgressSet(done, total, extra) {
  const p = pg();
  if (!p.wrap || !p.bar) return;
  const pct = total ? Math.round(done / total * 100) : 100;
  const track = Math.max(0, p.wrap.clientWidth - 48);
  p.bar.style.width = Math.round(track * pct / 100) + 'px';
  if (p.text) p.text.textContent = `${done} / ${total}${extra ? ` · ${extra}` : ''}（${pct}%）`;
}

function imgProgressHide() {
  ['imgProgressWrap', 'imgProgressWrapS'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ['imgStopBtn', 'imgStopBtnS'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

/* ---------------- 收集图片（文件夹递归走共用模块） ---------------- */

const isImage = name => IMG_EXT.has(extOf(name));

/* ---------------- 缩略图 ---------------- */

async function makeThumb(file) {
  const bmp = await createImageBitmap(file);
  const width = bmp.width;
  const height = bmp.height;
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height || 1));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').drawImage(bmp, 0, 0, tw, th);
  const thumb = c.toDataURL('image/jpeg', 0.72);
  if (bmp.close) bmp.close();
  return { thumb, width, height };
}

/* ---------------- 加入图片列表 ---------------- */

async function addImageList(list) {
  if (!list.length) {
    alert('没有找到图片。支持 PNG / JPG / WebP / BMP，可拖入整个文件夹。');
    return;
  }
  const room = MAX_IMAGES - bs.images.length;
  if (room <= 0) {
    alert(`一次最多处理 ${MAX_IMAGES} 张图片，请分批导入。`);
    return;
  }
  const take = list.slice(0, room);
  const skipped = list.length - take.length;

  imgShowStage('select');
  imgProgressShow('正在读取图片…');

  // 先按顺序建好记录，缩略图并发生成后回填，列表顺序保持稳定
  const created = take.map(item => ({
    id: 'img' + (++bs.seq),
    file: item.file,
    name: item.file.name,
    relPath: item.relPath || item.file.name,
    size: item.file.size,
    thumb: '',
    width: 0,
    height: 0,
    boxes: [],
    selected: true,
    ocrState: 'idle',
    error: '',
  }));

  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= created.length) return;
      const img = created[i];
      try {
        const { thumb, width, height } = await makeThumb(img.file);
        img.thumb = thumb;
        img.width = width;
        img.height = height;
      } catch (e) {
        img.error = '图片无法读取：' + (e.message || e);
        img.selected = false;
      }
      // 文件系统入口（拖文件夹 / 选文件夹）偶尔会拿到空文件，提前拦下
      if (!img.error && !img.size) {
        img.error = '文件内容为空（读取失败）';
        img.selected = false;
      }
      done++;
      imgProgressSet(done, created.length, img.name);
    }
  };
  // 缩略图是纯前端解码，4 路并发能把几百张的处理时间压到几秒
  await Promise.all(Array.from({ length: Math.min(4, created.length) }, worker));

  bs.images.push(...created);
  imgProgressHide();
  renderSelect();
  if (skipped > 0) alert(`超出上限，已忽略 ${skipped} 张图片。`);
}

/* ---------------- 阶段 2：选图 ---------------- */

function renderSelect() {
  const el = $('#imgFileList');
  el.innerHTML = bs.images.map(img => {
    const dir = img.relPath.includes('/') ? img.relPath.slice(0, img.relPath.lastIndexOf('/')) : '';
    const dim = img.width && img.height ? `${img.width}×${img.height}` : '—';
    return `<label class="ut-file-item ut-file-item--thumb${img.error ? ' is-skipped' : ''}" data-id="${img.id}">
      <input type="checkbox" data-id="${img.id}"${img.selected ? ' checked' : ''}${img.error ? ' disabled' : ''}>
      ${img.thumb ? `<img class="ut-file-item__thumb" src="${img.thumb}" alt="">` : '<span class="ut-file-item__thumb ut-file-item__thumb--empty"></span>'}
      <span class="ut-file-item__main">
        <span class="ut-file-item__name" title="${escapeHtml(img.relPath)}">${escapeHtml(img.name)}</span>
        <span class="ut-file-item__meta">${dim} · ${fmtBytes(img.size)}${dir ? ' · ' + escapeHtml(dir) : ''}${img.error ? ' · ' + escapeHtml(img.error) : ''}</span>
      </span>
    </label>`;
  }).join('') || '<p class="ut-muted">未添加图片</p>';
  syncSelectHead();
}

function syncSelectHead() {
  const total = bs.images.length;
  const sel = bs.images.filter(i => i.selected && !i.error).length;
  const bad = bs.images.filter(i => i.error).length;
  $('#imgScanTitle').textContent = `共 ${total} 张图片${bad ? ` · ${bad} 张无法读取` : ''}`;
  $('#imgScanSummary').textContent = `已选 ${sel} 张`;
  const all = $('#imgCheckAll');
  all.checked = total > 0 && sel === total - bad;
  all.disabled = total === 0;
  $('#imgStartBtn').disabled = sel === 0;
}

/* ---------------- OCR ---------------- */

async function postOcr(img, body) {
  let res;
  try {
    res = await fetch('/api/img/ocr', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(img.name) },
      body,
    });
  } catch (e) {
    throw new Error('请求未发出：' + (e.message || e));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && data.error) || ('接口返回 HTTP ' + res.status));
  }
  return data;
}

async function ocrOne(img) {
  let lastErr = null;
  // 最多试 3 次：首次直接发 File；后续改用内存副本（排除文件句柄失效），
  // 每次失败后小幅退避。服务端明确报错（比如格式不支持）不重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    let body = img.file;
    if (attempt > 0) {
      if (!img.bufCache) img.bufCache = await img.file.arrayBuffer();
      if (!img.bufCache.byteLength) throw new Error('文件内容为空，无法识别');
      body = new Blob([img.bufCache], { type: 'application/octet-stream' });
    }
    try {
      const data = await postOcr(img, body);
      img.width = data.width || img.width;
      img.height = data.height || img.height;
      img.boxes = (data.boxes || []).map((b, i) => ({
        id: img.id + ':' + i,
        box: b.box,
        text: b.text,
        score: b.score,
        translated: '',
        error: '',
      }));
      return;
    } catch (e) {
      lastErr = e;
      const netErr = /^请求未发出/.test(e.message || '');
      if (!netErr) throw e;
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error((lastErr && lastErr.message ? lastErr.message : '图片识别失败') + '（已重试 3 次）');
}

async function backendAlive() {
  // 打一个不存在的页拿 404 就行：能收到任何响应就说明后端还活着
  try {
    await fetch('/api/img/ocr', { method: 'GET' });
    return true;
  } catch (e) {
    return false;
  }
}

async function ocrSelected() {
  // 已经识别过的图跳过，返回上一步再点开始时不必重跑
  const list = bs.images.filter(i => i.selected && !i.error && i.ocrState !== 'done');
  // 后端 onnxruntime 已经把 CPU 吃满，并发 3 路实测约 1.4 倍提速，再高收益递减
  const CONCURRENCY = 3;
  let idx = 0;
  let done = 0;
  let failed = 0;
  let netFails = 0;
  let aborted = false;

  const worker = async () => {
    while (true) {
      if (aborted || (bs.stop && bs.stop.stopped)) return;
      const i = idx++;
      if (i >= list.length) return;
      const img = list[i];
      img.ocrState = 'ocr';
      imgProgressSet(done, list.length, `识别 ${img.name}`);
      try {
        await ocrOne(img);
        img.ocrState = 'done';
        netFails = 0;
      } catch (e) {
        img.ocrState = 'fail';
        img.error = e.message || '识别失败';
        failed++;
        if (/^请求未发出/.test(img.error)) {
          netFails++;
          if (!(await backendAlive())) {
            img.error += ' → 后端已无响应，请重启应用后再试';
            aborted = true;
          } else if (netFails >= 3) {
            img.error += ' → 连续网络失败，已停止剩余图片';
            aborted = true;
          }
        }
      }
      done++;
      imgProgressSet(done, list.length, failed ? `失败 ${failed}` : '');
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return { failed };
}

/* ---------------- 翻译 ---------------- */

function flattenUnits() {
  const units = [];
  for (const img of bs.images) {
    if (img.ocrState !== 'done') continue;
    for (const b of img.boxes) {
      if (!b.text) continue;
      // 已有译文的带上，translateUnits 会跳过，避免重复请求
      units.push({ ref: b, original: b.text, translated: b.translated || '', error: '' });
    }
  }
  return units;
}

async function translateAll() {
  const units = flattenUnits();
  if (!units.length) return { failed: 0, empty: true };
  let failed = 0;
  await translateUnits(units, store.state.settings, (d, t, f) => {
    failed = f;
    imgProgressSet(d, t, f ? `失败 ${f}` : '');
  }, bs.stop);
  units.forEach(u => {
    u.ref.translated = u.translated || '';
    u.ref.error = u.error || '';
    u.ref.unchanged = !!u.unchanged;
  });
  return { failed, empty: false };
}

/* ---------------- 图片位图读取 ---------------- */

/** 读出图片位图；句柄失效时读成内存副本再试（文件夹拖入的 File 常见） */
async function bitmapOf(img) {
  try {
    return await createImageBitmap(img.file);
  } catch (e) {
    const buf = await img.file.arrayBuffer();
    if (!buf.byteLength) throw new Error('文件内容为空');
    return await createImageBitmap(new Blob([buf]));
  }
}

/* ---------------- 覆盖图放大预览（点缩略图进，返回按钮出） ---------------- */

let overlayUrl = null;

function updateOverlayUi() {
  const on = !!bs.previewId;
  const wrap = $('#imgOverlayWrap');
  if (wrap) wrap.hidden = !on;
  const rows = $('#imgRows');
  if (rows) rows.hidden = on;
  const meta = $('#imgRowsMeta');
  if (meta) meta.hidden = on;
}

async function showOverlay(imgId) {
  const img = bs.images.find(i => i.id === imgId);
  if (!img) return;
  bs.previewId = imgId;
  updateOverlayUi();
  $('#imgOverlayMeta').textContent = '正在生成覆盖图…';
  try {
    const blob = await renderOverlay(img);
    if (!blob) throw new Error('合成结果为空');
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    overlayUrl = URL.createObjectURL(blob);
    $('#imgOverlayImg').src = overlayUrl;
    $('#imgOverlayMeta').textContent = `${img.relPath} · ${img.boxes.length} 处文字 · 点击空白处返回`;
  } catch (e) {
    $('#imgOverlayMeta').textContent = '覆盖图生成失败：' + (e.message || e);
  }
}

function hideOverlay() {
  bs.previewId = null;
  if (overlayUrl) {
    URL.revokeObjectURL(overlayUrl);
    overlayUrl = null;
  }
  const im = $('#imgOverlayImg');
  if (im) im.removeAttribute('src');
  const meta = $('#imgOverlayMeta');
  if (meta) meta.textContent = '';
  updateOverlayUi();
}

/* ---------------- 阶段 3：平铺结果列表 ---------------- */

function flattenRows() {
  const rows = [];
  for (const img of bs.images) {
    if (img.ocrState !== 'done') continue;
    let seen = false;
    for (const b of img.boxes) {
      if (!b.text) continue;
      // first 标记用于“每条文本只带一次缩略图 + 文件名”；
      // 不能用下标判断，首条文本可能为空被跳过
      rows.push({ img, b, first: !seen });
      seen = true;
    }
  }
  return rows;
}

function renderRows() {
  const el = $('#imgRows');
  const rows = flattenRows();
  el.dataset.view = bs.view;

  // 编辑态：逐条渲染成可改块。缩略图和文件路径只在该图首条显示，
  // 同一张图的后续文本靠缩进对齐。
  if (bs.editing) {
    el.classList.add('is-editing');
    const shown = rows.slice(0, MAX_ROWS);
    bs.editRows = shown;
    el.innerHTML = shown.length
      ? shown.map((r, i) => editBlockHtml({
          index: i,
          original: r.b.text,
          translated: r.b.translated || '',
          thumb: r.first ? r.img.thumb : '',
          meta: r.first ? escapeHtml(r.img.relPath) : '',
        })).join('')
      : '<p class="ut-empty-small">没有被选图片的识别结果。返回上一步重新选择图片。</p>';
    snapshotBases(el);
    renderMeta();
    return;
  }

  el.classList.remove('is-editing');
  bs.editRows = [];
  if (!rows.length) {
    el.innerHTML = '<p class="ut-empty-small">没有被选图片的识别结果。返回上一步重新选择图片。</p>';
    renderMeta();
    return;
  }
  const shown = rows.slice(0, MAX_ROWS);
  el.innerHTML = shown.map(({ img, b, first }) => {
    const err = b.error ? `<span class="ut-imgrow__err">${escapeHtml(b.error)}</span>` : '';
    return `<div class="ut-imgrow" data-img="${img.id}">
      ${first
        ? `<img class="ut-imgrow__thumb" src="${img.thumb}" alt="" title="点击预览 · ${escapeHtml(img.relPath)}">`
        : '<span class="ut-imgrow__thumb ut-imgrow__thumb--empty"></span>'}
      <div class="ut-imgrow__body">
        ${first ? `<span class="ut-imgrow__file">${escapeHtml(img.relPath)}</span>` : ''}
        <span class="ut-imgrow__src">${escapeHtml(b.text)}</span>
        <span class="ut-imgrow__dst">${escapeHtml(b.translated || '')}${err}</span>
      </div>
    </div>`;
  }).join('');
  renderMeta();
}

function setImgEditing(on) {
  bs.editing = on;
  // 编辑在列表里做，从覆盖图预览进来时先退回列表
  if (on && bs.previewId) hideOverlay();
  const btn = $('#imgEditToggle');
  if (btn) btn.textContent = on ? '完成' : '编辑';
  renderRows();
}

/** 状态行与失败详情：每次都整体重算，不累加（否则多次运行会把旧数字攒在一起） */
function renderMeta() {
  const rows = flattenRows();
  const doneImgs = bs.images.filter(i => i.ocrState === 'done');
  const emptyImgs = doneImgs.filter(i => !i.boxes.length);
  const failImgs = bs.images.filter(i => i.ocrState === 'fail');
  const failUnits = rows.filter(r => r.b.error).length;

  const parts = [];
  if (rows.length) parts.push(`共 ${rows.length} 条文本`);
  if (doneImgs.length) parts.push(`${doneImgs.length} 张图片`);
  if (emptyImgs.length) parts.push(`${emptyImgs.length} 张未识别到文字`);
  const unchanged = rows.filter(r => r.b.unchanged).length;
  if (unchanged) parts.push(`${unchanged} 条原文已是目标语言`);
  if (failImgs.length) parts.push(`识别失败 ${failImgs.length} 张`);
  if (failUnits) parts.push(`翻译失败 ${failUnits} 条`);
  const pending = bs.images.filter(i => i.selected && !i.error && i.ocrState === 'idle').length;
  if (pending) parts.push(`未处理 ${pending} 张`);
  if (rows.length > MAX_ROWS) parts.push(`仅显示前 ${MAX_ROWS} 条，导出不受影响`);
  $('#imgRowsMeta').textContent = parts.join(' · ');

  const box = $('#imgFailList');
  const lines = [];
  for (const img of failImgs) {
    lines.push(`${img.relPath}：${img.error || '识别失败'}`);
  }
  for (const img of emptyImgs) {
    lines.push(`${img.relPath}：未识别到文字`);
  }
  if (lines.length) {
    box.innerHTML = lines.slice(0, 20).map(l => `<span>${escapeHtml(l)}</span>`).join('');
    if (lines.length > 20) box.innerHTML += `<span>…另有 ${lines.length - 20} 张</span>`;
    box.hidden = false;
  } else {
    box.innerHTML = '';
    box.hidden = true;
  }
}

function syncViewButtons() {
  $$('#imgViewSwitch .ut-seg__item').forEach(b => b.classList.toggle('is-active', b.dataset.view === bs.view));
  const el = $('#imgRows');
  if (el) el.dataset.view = bs.view;
}

/* ---------------- 覆盖译文图渲染 ---------------- */

function wrapByWidth(ctx, text, maxW) {
  const out = [];
  let cur = '';
  for (const ch of String(text || '')) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** 二分字号：找到能把这段文字塞进 w×h 的最大字号 */
function layoutText(ctx, text, w, h) {
  const maxW = Math.max(12, w - 6);
  const capLines = Math.max(1, Math.min(20, Math.ceil(h / 6)));
  let lo = 7;
  let hi = Math.max(7, Math.floor(h / 1.15));
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    ctx.font = `bold ${mid}px "Microsoft YaHei", sans-serif`;
    const lines = wrapByWidth(ctx, text, maxW);
    if (lines.length * mid * 1.25 <= h && lines.length <= capLines) {
      best = { lines, fs: mid };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  // 最小字号仍放不下：截断加省略号
  const fs = 7;
  ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
  let lines = wrapByWidth(ctx, text, maxW);
  const maxLines = Math.max(1, Math.floor(h / (fs * 1.25)));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '') + '…';
  }
  return { lines, fs };
}

/** 把译文画进框内（白底盖原文 + 写字）。没译文时保留原文，避免丢内容 */
function drawBoxTranslated(ctx, b) {
  const [x1, y1, x2, y2] = b.box || [];
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 2 && h > 2)) return;
  const text = b.translated || b.text || '';
  if (!text) return;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fillRect(x1, y1, w, h);
  const { lines, fs } = layoutText(ctx, text, w, h);
  ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lineH = fs * 1.25;
  let y = y1 + (h - lineH * lines.length) / 2 + lineH / 2;
  for (const ln of lines) {
    ctx.fillText(ln, x1 + 3, y);
    y += lineH;
  }
}

async function renderOverlay(img) {
  const bmp = await bitmapOf(img);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  for (const b of img.boxes) drawBoxTranslated(ctx, b);
  return new Promise(res => c.toBlob(res, 'image/png'));
}

/* ---------------- 文本对照 ---------------- */

function buildMarkdown() {
  const lines = ['# 图片文字翻译', ''];
  for (const img of bs.images) {
    if (img.ocrState !== 'done' || !img.boxes.length) continue;
    lines.push(`## ${img.relPath}`, '');
    for (const b of img.boxes) {
      if (!b.text) continue;
      lines.push(`- **原文**：${b.text}`);
      lines.push(`- **译文**：${b.translated || '（未翻译）'}`);
      if (b.error) lines.push(`  - 失败：${b.error}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------- 流程入口 ---------------- */

async function startPipeline() {
  const sel = bs.images.filter(i => i.selected && !i.error);
  if (!sel.length) return;
  const btn = $('#imgStartBtn');
  btn.disabled = true;
  bs.stop = { stopped: false };
  imgShowStage('view');
  bs.view = 'bilingual';
  bs.editing = false;   // 新一批流程从只读列表开始
  if (bs.previewId) hideOverlay();
  const eb = $('#imgEditToggle');
  if (eb) eb.textContent = '编辑';
  syncViewButtons();
  renderRows();

  try {
    imgProgressShow('准备识别…');
    await ocrSelected();
    if (bs.stop.stopped) {
      renderRows();
      return;
    }
    await translateAll();
    renderRows();
  } catch (e) {
    alert('处理失败：' + e.message);
  } finally {
    imgProgressHide();
    btn.disabled = false;
    syncExportUi();
  }
}

function syncExportUi() {
  const n = bs.images.filter(i => i.ocrState === 'done' && i.boxes.length).length;
  ['imgExportZip', 'imgExportFiles'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = n === 0;
  });
}

/* ---------------- 导出 ---------------- */

async function exportResult() {
  const targets = bs.images.filter(i => i.ocrState === 'done' && i.boxes.length);
  if (!targets.length) return;
  const withText = $('#imgWithText').checked;
  const btn = $('#imgExportZip');
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const defaultName = `图片翻译_${ts}.zip`;
  // 点击瞬间先弹保存框：WebView2 里 a[download] 会被静默吞掉，必须走文件句柄写入
  const pick = await pickSaveFile(defaultName);
  if (pick.cancelled) return;
  btn.disabled = true;
  bs.stop = { stopped: false };
  imgProgressShow('正在合成覆盖图…');
  try {
    const zip = new window.JSZip();
    const used = new Set();
    let done = 0;
    let skipped = 0;
    for (const img of targets) {
      if (bs.stop.stopped) break;
      let blob = null;
      try {
        blob = await renderOverlay(img);
      } catch (e) {
        console.warn('覆盖图合成失败:', img.relPath, e);
      }
      if (blob) {
        // 平铺命名：子目录压成下划线，同名自动加序号
        const base = img.relPath.replace(/\.[^.]+$/, '').replace(/[\\/]+/g, '_');
        let fname = `${base}_译文.png`;
        let k = 2;
        while (used.has(fname)) fname = `${base}_${k++}_译文.png`;
        used.add(fname);
        zip.file(fname, blob);
      } else {
        skipped++;
      }
      done++;
      imgProgressSet(done, targets.length, img.name);
    }
    if (withText) zip.file('文本对照.md', buildMarkdown());
    const out = await zip.generateAsync({ type: 'blob' });
    if (pick.ok) {
      await writeSaveHandle(pick.handle, out);
    } else {
      downloadBlob(out, defaultName);
      alert('系统保存对话框不可用，已改用浏览器下载；若找不到文件，请重试或换用系统另存对话框。');
    }
    if (skipped) alert(`有 ${skipped} 张图片合成失败，已跳过（原因见下方清单或控制台）`);
  } catch (e) {
    alert('导出失败：' + e.message);
  } finally {
    imgProgressHide();
    btn.disabled = false;
  }
}

/** 导出多图：选一个文件夹，逐张写入覆盖图 */
async function exportFiles() {
  const targets = bs.images.filter(i => i.ocrState === 'done' && i.boxes.length);
  if (!targets.length) return;
  const withText = $('#imgWithText').checked;
  const dirPick = await pickDirectory();
  if (dirPick.cancelled) return;
  if (!dirPick.ok) { alert('无法选择保存目录，导出已取消'); return; }
  const btn = $('#imgExportFiles');
  btn.disabled = true;
  bs.stop = { stopped: false };
  imgProgressShow('正在合成覆盖图…');
  try {
    const used = new Set();
    let done = 0;
    let skipped = 0;
    for (const img of targets) {
      if (bs.stop.stopped) break;
      let blob = null;
      try {
        blob = await renderOverlay(img);
      } catch (e) {
        console.warn('覆盖图合成失败:', img.relPath, e);
      }
      if (blob) {
        const base = img.relPath.replace(/\.[^.]+$/, '').replace(/[\\/]+/g, '_');
        let fname = `${base}_译文.png`;
        let k = 2;
        while (used.has(fname)) fname = `${base}_${k++}_译文.png`;
        used.add(fname);
        await writeDirFile(dirPick.handle, fname, blob);
      } else {
        skipped++;
      }
      done++;
      imgProgressSet(done, targets.length, img.name);
    }
    if (withText) {
      await writeDirFile(dirPick.handle, '文本对照.md',
        new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    }
    if (skipped) alert(`有 ${skipped} 张图片合成失败，已跳过`);
  } catch (e) {
    alert('导出失败：' + e.message);
  } finally {
    imgProgressHide();
    btn.disabled = false;
  }
}

/* ---------------- 初始化 ---------------- */

export function initImgWorkbench() {
  const dropzone = $('#imgDropzone');

  // 点击：选图片（多选）
  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.accept = '.png,.jpg,.jpeg,.webp,.bmp';
  imgInput.multiple = true;
  imgInput.addEventListener('change', async () => {
    const files = imgInput.files ? Array.from(imgInput.files) : [];
    imgInput.value = '';
    if (!files.length) return;
    await addImageList(files.filter(f => IMG_EXT.has(extOf(f.name))).map(f => ({ file: f, relPath: f.name })));
  });
  dropzone.addEventListener('click', () => imgInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.target.closest('button')) return;   // 框内按钮自己处理键盘
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imgInput.click(); }
  });

  // 选文件夹入口（和选图片同在拖拽框内，两个按钮都阻止冒泡，否则会连带弹出图片选择框）
  const dirInput = document.createElement('input');
  dirInput.type = 'file';
  dirInput.webkitdirectory = true;
  dirInput.addEventListener('change', async () => {
    const files = dirInput.files ? Array.from(dirInput.files) : [];
    dirInput.value = '';
    if (!files.length) return;
    await addImageList(files
      .filter(f => IMG_EXT.has(extOf(f.name)))
      .map(f => ({ file: f, relPath: f.webkitRelativePath || f.name })));
  });
  $('#imgPickImages').addEventListener('click', e => { e.stopPropagation(); imgInput.click(); });
  $('#imgPickDir').addEventListener('click', e => { e.stopPropagation(); dirInput.click(); });

  // 拖拽
  ['dragover', 'dragenter'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('is-dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('is-dragover'); }));
  dropzone.addEventListener('drop', async e => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const list = await collectFromDataTransfer(dt, isImage);
    await addImageList(list);
  });

  // 阶段 2
  $('#imgBackBtn').addEventListener('click', imgReset);
  $('#imgFileList').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const img = bs.images.find(i => i.id === cb.dataset.id);
    if (img) img.selected = cb.checked;
    syncSelectHead();
  });
  $('#imgCheckAll').addEventListener('change', e => {
    const on = e.target.checked;
    bs.images.forEach(i => { if (!i.error) i.selected = on; });
    renderSelect();
  });
  $('#imgStartBtn').addEventListener('click', startPipeline);

  // 阶段 3
  $('#imgViewBackBtn').addEventListener('click', () => {
    imgProgressHide();
    bs.editing = false;
    if (bs.previewId) hideOverlay();
    const eb = $('#imgEditToggle');
    if (eb) eb.textContent = '编辑';
    renderSelect();
    imgShowStage('select');
  });
  $('#imgViewSwitch').addEventListener('click', e => {
    const b = e.target.closest('.ut-seg__item');
    if (!b) return;
    bs.view = b.dataset.view;
    if (bs.editing) {
      setImgEditing(false);
    } else {
      syncViewButtons();
    }
  });
  $('#imgEditToggle').addEventListener('click', () => setImgEditing(!bs.editing));

  // 编辑写回：直接改 box 的 text / translated，导出覆盖图时自然用新译文
  bindEditables($('#imgRows'), {
    getUnits: () => bs.editRows,
    getField: (r, f) => (f === 'original' ? (r.b.text || '') : (r.b.translated || '')),
    setField: (r, f, v) => {
      if (f === 'original') r.b.text = v;
      else r.b.translated = v;
    },
  });

  // 点缩略图 → 放大看该图的覆盖图；点图片以外的空白处返回列表
  $('#imgRows').addEventListener('click', e => {
    const thumb = e.target.closest('.ut-imgrow__thumb');
    if (!thumb) return;
    const row = thumb.closest('.ut-imgrow');
    if (row && row.dataset.img) showOverlay(row.dataset.img);
  });
  $('#imgOverlayWrap').addEventListener('click', e => {
    if (e.target.closest('#imgOverlayImg')) return;   // 点图片本身不退出
    hideOverlay();
  });

  $('#imgStopBtn').addEventListener('click', () => { if (bs.stop) bs.stop.stopped = true; });
  $('#imgStopBtnS').addEventListener('click', () => { if (bs.stop) bs.stop.stopped = true; });
  $('#imgWithText').addEventListener('change', () => {
    const on = $('#imgWithText').checked;
    $('#imgExportZip').title = on ? '打包为 ZIP（含文本对照）' : '打包为 ZIP';
    $('#imgExportFiles').title = on ? '选一个文件夹，逐张写入覆盖图（含文本对照）' : '选一个文件夹，逐张写入覆盖图';
  });
  $('#imgExportZip').addEventListener('click', exportResult);
  $('#imgExportFiles').addEventListener('click', exportFiles);
}