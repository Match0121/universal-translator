// store.js — 全局状态（极简事件订阅）

const state = {
  theme: 'light',           // 默认浅色；用户切换后存 localStorage 保留偏好
  view: 'bilingual',          // original | bilingual | translated
  editing: false,             // 浏览阶段是否处于逐条编辑态
  filter: 'all',              // all | untranslated | translated
  search: '',
  game: null,                 // exe 解析结果
  rootHandle: null,           // 授权目录句柄
  files: [],                  // 扫描到的文件
  selected: new Set(),        // 勾选的 path
  activeFile: null,           // 文件内容视图当前查看的文件
  units: [],                  // 翻译单元
  extracting: false,
  translating: false,
  settings: {
    provider: 'mymemory',
    apiKey: '',
    baiduAppid: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    targetLang: 'zh-CN',
    concurrency: 3,
    maxSizeMB: 8,
  },
};

const listeners = new Map();

function emit(key, val) {
  (listeners.get(key) || []).forEach(fn => { try { fn(val, state); } catch (e) { console.error(e); } });
}

export const store = {
  state,
  set(key, val) {
    state[key] = val;
    if (key === 'theme') {
      // 主题偏好持久化 + 即时生效
      try { localStorage.setItem('ut.theme', val); } catch (e) { /* ignore */ }
      try { document.body.dataset.theme = val; } catch (e) { /* ignore */ }
    }
    emit(key, val);
  },
  patchSettings(p) {
    Object.assign(state.settings, p);
    try { localStorage.setItem('ut.settings', JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
    emit('settings', state.settings);
  },
  on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
  },
  load() {
    try {
      const s = JSON.parse(localStorage.getItem('ut.settings') || '{}');
      Object.assign(state.settings, s);
    } catch (e) { /* ignore */ }
    try {
      const t = localStorage.getItem('ut.theme');
      if (t === 'light' || t === 'dark') state.theme = t;
    } catch (e) { /* ignore */ }
    try { document.body.dataset.theme = state.theme; } catch (e) { /* ignore */ }
  },
};
