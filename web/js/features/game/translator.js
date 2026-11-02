// translator.js — 翻译引擎（provider 插件 + 并发队列 + IndexedDB 缓存）

import { hashStr, sleep } from '../../utils.js';

/* ---------------- MD5（百度翻译签名用，基于 UTF-8 字节） ---------------- */

function md5Bytes(bytes) {
  const RotateLeft = (lValue, iShiftBits) => (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  const AddUnsigned = (lX, lY) => {
    const lX4 = lX & 0x40000000, lY4 = lY & 0x40000000, lX8 = lX & 0x80000000, lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
    if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
    if (lX4 | lY4) { if (lResult & 0x40000000) return (lResult ^ 0xC0000000 ^ lX8 ^ lY8); return (lResult ^ 0x40000000 ^ lX8 ^ lY8); }
    return (lResult ^ lX8 ^ lY8);
  };
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => (x ^ y ^ z);
  const I = (x, y, z) => (y ^ (x | ~z));
  const FF = (a, b, c, d, x, s, ac) => { a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); };
  const GG = (a, b, c, d, x, s, ac) => { a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); };
  const HH = (a, b, c, d, x, s, ac) => { a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); };
  const II = (a, b, c, d, x, s, ac) => { a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); };
  const ConvertToWordArray = (string) => {
    const lMessageLength = string.length;
    const lNumberOfWords_temp1 = lMessageLength + 8;
    const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
    const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
    const lWordArray = new Array(lNumberOfWords - 1);
    let lBytePosition = 0, lByteCount = 0;
    while (lByteCount < lMessageLength) {
      const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition));
      lByteCount++;
    }
    const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  };
  const WordToHex = (lValue) => {
    let WordToHexValue = '', WordToHexValue_temp = '';
    for (let lCount = 0; lCount <= 3; lCount++) {
      const lByte = (lValue >>> (lCount * 8)) & 255;
      WordToHexValue_temp = '0' + lByte.toString(16);
      WordToHexValue = WordToHexValue + WordToHexValue_temp.substr(WordToHexValue_temp.length - 2, 2);
    }
    return WordToHexValue;
  };
  const x = ConvertToWordArray(bytes);
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22, S21 = 5, S22 = 9, S23 = 14, S24 = 20, S31 = 4, S32 = 11, S33 = 16, S34 = 23, S41 = 6, S42 = 10, S43 = 15, S44 = 21;
  let k, AA, BB, CC, DD, a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  for (k = 0; k < x.length; k += 16) {
    AA = a; BB = b; CC = c; DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478); d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756); c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB); b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF); d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A); c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8); d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF); c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1); b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122); d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193); c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E); b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562); d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340); c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51); b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D); d = GG(d, a, b, c, x[k + 10], S22, 0x02441453); c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681); b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6); d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6); c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87); b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905); d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8); c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9); b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
    a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681); c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122); b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44); d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9); c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60); b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6); d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA); c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085); b = HH(b, c, d, a, x[k + 6], S34, 0x04881D05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039); d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5); c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8); b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xF4292244); d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97); c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7); b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3); d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92); c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D); b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F); d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0); c = II(c, d, a, b, x[k + 6], S43, 0xA3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82); d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235); c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB); b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391);
    a = AddUnsigned(a, AA); b = AddUnsigned(b, BB); c = AddUnsigned(c, CC); d = AddUnsigned(d, DD);
  }
  return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

const md5 = s => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return md5Bytes(bin);
};

/* ---------------- Provider 插件 ---------------- */

const LANG_NAME = { 'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英语', ja: '日语' };

const PROVIDERS = {
  mymemory: {
    label: 'MyMemory（免费）',
    needsKey: false,
    async translate(texts, cfg) {
      const target = cfg.targetLang === 'zh-CN' ? 'zh-CN' : cfg.targetLang;
      const out = [];
      for (const t of texts) {
        const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(t) + '&langpair=Autodetect|' + target;
        const res = await fetch(url);
        if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
        const data = await res.json();
        const txt = data && data.responseData && data.responseData.translatedText;
        out.push(typeof txt === 'string' ? txt : '');
        await sleep(120);
      }
      return out;
    },
  },

  google: {
    label: 'Google（免费，可能不稳定）',
    needsKey: false,
    async translate(texts, cfg) {
      const out = [];
      for (const t of texts) {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + cfg.targetLang + '&dt=t&q=' + encodeURIComponent(t);
        const res = await fetch(url);
        if (!res.ok) throw new Error('Google HTTP ' + res.status);
        const data = await res.json();
        const txt = (data && data[0] || []).map(x => (x && x[0]) || '').join('');
        out.push(txt);
        await sleep(150);
      }
      return out;
    },
  },

  deepl: {
    label: 'DeepL（需 API Key · 走本地代理）',
    needsKey: true,
    async translate(texts, cfg) {
      return viaProxy('deepl', texts, cfg);
    },
  },

  openai: {
    label: 'OpenAI 兼容接口（本地 / 云端 LLM）',
    needsKey: false,
    needsModel: true,
    async translate(texts, cfg) {
      const base = (cfg.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
      const lang = LANG_NAME[cfg.targetLang] || cfg.targetLang;
      const out = [];
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const numbered = batch.map((t, j) => `[${j}] ${t}`).join('\n');
        const prompt = `你是专业的游戏文本译者。把下面每一行翻译成${lang}，保持原意、语气与风格，保留 [序号] 前缀，逐行输出，行数与输入一致，不要添加任何解释或额外内容。\n\n${numbered}`;
        const res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'system', content: prompt }],
            temperature: 0.3,
          }),
        });
        if (!res.ok) throw new Error('LLM HTTP ' + res.status);
        const data = await res.json();
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        const map = new Map();
        for (const l of content.split('\n')) {
          const m = /^\[\s*(\d+)\s*\]\s*(.*)$/.exec(l.trim());
          if (m) map.set(+m[1], m[2].trim());
        }
        for (let j = 0; j < batch.length; j++) out.push(map.get(j) || '');
      }
      return out;
    },
  },

  baidu: {
    label: '百度翻译（国内稳定 · 免费额度，需 APP ID + 密钥）',
    needsKey: true,
    needsAppid: true,
    async translate(texts, cfg) {
      return viaProxy('baidu', texts, cfg);
    },
  },
};

/** 通过本地代理（serve.py）调用需要服务端签名的引擎，绕开浏览器 CORS */
async function viaProxy(provider, texts, cfg) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, texts, settings: cfg }),
  });
  if (!res.ok) {
    // http.server 等不支持代理的服务会对 POST 返回 404/501 的 HTML 错误页
    if (res.status === 404 || res.status === 501) {
      throw new Error('该引擎需要本地代理：请改用 python serve.py 启动网站（代替 python -m http.server）');
    }
    throw new Error('代理 HTTP ' + res.status);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('代理返回异常，请确认已用 python serve.py 启动网站');
  }
  if (!data.ok) throw new Error(data.error || '翻译失败');
  if (!Array.isArray(data.results) || data.results.length !== texts.length) throw new Error('代理返回异常');
  return data.results;
}

export { PROVIDERS };

/* ---------------- IndexedDB 缓存 ----------------
 * 值格式：{ t: 译文, ts: 写入时间戳 }（兼容旧版纯字符串值）
 * 上限：超过 MAX_CACHE_ITEMS 条时自动删除最早的（LRU 裁剪） */

const MAX_CACHE_ITEMS = 20000;
const TRIM_TO = 15000;

let _db = null;
function openDb() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open('ut-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function cacheValue(v) {
  if (!v) return '';
  return typeof v === 'string' ? v : (v.t || '');
}

async function cacheGet(k) {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => res(cacheValue(r.result));
      r.onerror = () => rej(r.error);
    });
  } catch { return ''; }
}

async function cacheSet(k, v) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ t: v, ts: Date.now() }, k);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    void trimIfNeeded(db);
  } catch { /* ignore */ }
}

/** 超出上限时删除最早的条目（LRU） */
async function trimIfNeeded(db) {
  try {
    const count = await new Promise((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (count <= MAX_CACHE_ITEMS) return;
    const toDelete = count - TRIM_TO;
    await new Promise((res, rej) => {
      const entries = [];
      const tx = db.transaction('kv', 'readonly');
      const cur = tx.objectStore('kv').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          entries.push({ key: c.key, ts: (c.value && c.value.ts) || 0 });
          c.continue();
        }
      };
      tx.oncomplete = () => {
        entries.sort((a, b) => a.ts - b.ts);
        const del = entries.slice(0, toDelete);
        const tx2 = db.transaction('kv', 'readwrite');
        const st2 = tx2.objectStore('kv');
        del.forEach(d => st2.delete(d.key));
        tx2.oncomplete = res;
        tx2.onerror = () => rej(tx2.error);
      };
    });
  } catch { /* ignore */ }
}

/** 清空翻译缓存（设置界面按钮调用） */
export async function clearCache() {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch { return false; }
}

/* ---------------- 译文有效性校验 ---------------- */

const BAD_RESULT = /PLEASE SELECT|QUERY LIMIT|MYMEMORY WARNING|INVALID REQUEST|TOO MANY/i;

/* ---------------- 语言判断：原文是否已是目标语言 ---------------- */

/** 粗判文本主要语言：zh / ja / ko / en / ''（空表示没有可用文字） */
export function guessLang(text) {
  const t = String(text || '');
  if (!t) return '';
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (t.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (t.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (t.match(/[a-zA-Z]/g) || []).length;
  const total = han + kana + hangul + latin;
  if (!total) return '';
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (han / total > 0.3) return 'zh';
  if (latin / total > 0.5) return 'en';
  return '';
}

/**
 * 判断文本是否已经是目标语言。
 * 繁体目标（zh-TW）不并进来，繁简转换仍要交给引擎处理。
 */
export function isTargetLang(text, targetLang) {
  const g = guessLang(text);
  if (!g) return false;
  const tl = String(targetLang || '').toLowerCase();
  if (g === 'zh') {
    if (!(tl.startsWith('zh') && !tl.includes('tw') && !tl.includes('hant'))) return false;
    // 目标是中文时还要区分「真中文」与「日文纯汉字词」：
    // 回復薬 / 勇者 / 薬草 这类词要翻成中文，不能当作已是目标语言跳过
    const t = String(text || '');
    if (/[\u3040-\u30ff\uff61-\uff9f]/.test(t)) return false;          // 有假名 → 日文
    if (/[，。！？；：「」“”、《》【】]/.test(t)) return true;                 // 中文标点
    if (/[的吧了是在这那吗呢和被与就都还很从到对]/.test(t)) return true;      // 中文虚词
    return (t.match(/[\u4e00-\u9fff]/g) || []).length >= 4;              // 4+ 汉字无假名
  }
  if (g === 'ja') return tl === 'ja' || tl.startsWith('ja-');
  if (g === 'ko') return tl === 'ko' || tl.startsWith('ko-');
  if (g === 'en') return tl === 'en' || tl.startsWith('en-');
  return false;
}

/** 校验译文是否有效；返回 { ok, error } */
export function validateTranslation(original, result, targetLang) {
  if (!result || !String(result).trim()) return { ok: false, error: '翻译结果为空' };
  if (BAD_RESULT.test(result)) return { ok: false, error: '引擎返回错误提示（' + String(result).slice(0, 50) + '），建议切换翻译引擎' };
  const o = String(original).trim().toLowerCase();
  const r = String(result).trim().toLowerCase();
  // 原文与译文完全相同且含文字（排除纯符号/数字/URL），通常是引擎拒译
  if (o.length >= 3 && o === r && /[a-z\u4e00-\u9fff]/.test(o)) {
    // 但原文本身就是目标语言时，返回原文是正确结果，不该算失败
    if (isTargetLang(original, targetLang)) return { ok: true, error: '' };
    return { ok: false, error: '引擎返回原文（未翻译），建议切换翻译引擎（如百度翻译）' };
  }
  return { ok: true, error: '' };
}

/* ---------------- 并发队列 ---------------- */


export async function runPool(items, n, worker, stopRef) {
  let idx = 0;
  const size = Math.max(1, Math.min(n, items.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (idx < items.length) {
      if (stopRef && stopRef.stopped) return;
      const i = idx++;
      if (stopRef && stopRef.stopped) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/**
 * 批量翻译单元（原地写 u.translated）
 * @param {Array} units 翻译单元
 * @param {Object} settings 设置
 * @param {Function} onProgress (done, total, failed)
 * @param {{stopped:boolean}|null} stopRef 传 {stopped:false} 后置 true 可停止队列
 * @returns {Promise<{failed: Array}>}
 */
export async function translateUnits(units, settings, onProgress, stopRef) {
  const provider = PROVIDERS[settings.provider];
  if (!provider) throw new Error('未知翻译引擎: ' + settings.provider);
  if (settings.provider === 'openai' && !settings.model) throw new Error('请先在设置中填写模型名称');

  // 原文已是目标语言的直接沿用：不请求引擎，也避免被校验判成“拒译”
  let done = 0;
  const failed = [];
  const todo = [];
  for (const u of units) {
    if (u.translated) continue;
    u.error = '';
    if (isTargetLang(u.original, settings.targetLang)) {
      u.translated = u.original;
      u.unchanged = true;     // 标记：原文即目标语言，未真正翻译
      done++;
      continue;
    }
    todo.push(u);
  }
  const dedupe = new Map();   // 原文 → 译文（同句只翻一次）
  const total = todo.length + done;
  if (done && onProgress) onProgress(done, total, 0);
  // 缓存 key 必须包含目标语言，否则同一原文先译成英文后，换语言仍会命中英文缓存
  const cacheKey = orig => hashStr(settings.provider + '|' + (settings.targetLang || '') + '|' + orig);

  const worker = async (u) => {
    if (stopRef && stopRef.stopped) return;
    try {
      if (!dedupe.has(u.original)) {
        let t = await cacheGet(cacheKey(u.original));
        if (!t) {
          let attempts = 0;
          while (attempts < 3) {
            try {
              t = (await provider.translate([u.original], settings))[0] || '';
              break;
            } catch (e) {
              attempts++;
              if (attempts >= 3 || e.noRetry) throw e;
              // 限流（429/403）退避更久，其余快速重试
              const isLimit = /429|403/.test(e.message || '');
              await sleep(isLimit ? 4000 * attempts : 600 * attempts);
            }
          }
          const v = validateTranslation(u.original, t, settings.targetLang);
          if (v.ok) {
            if (t) await cacheSet(cacheKey(u.original), t);
            dedupe.set(u.original, t);
          } else {
            const err = new Error(v.error);
            err.noRetry = true;
            throw err;
          }
        } else {
          dedupe.set(u.original, t);
        }
      }
      u.translated = dedupe.get(u.original);
      if (!u.translated) { u.error = '翻译结果为空'; failed.push(u); }
    } catch (e) {
      u.error = e.message || String(e);
      failed.push(u);
    } finally {
      done++;
      if (onProgress) onProgress(done, total, failed.length);
    }
  };

  await runPool(todo, settings.concurrency || 3, worker, stopRef);
  return { failed };
}
