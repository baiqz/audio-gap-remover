/* ============================================================
 * 无浏览器验证 index.html：
 *   Step 1 抽取内联脚本做语法检查
 *   Step 2 校验脚本引用的 DOM id 是否都存在
 *   Step 3 DOM 桩启动整页脚本，跑通「投文件 → 解码 → 检测 → 拼接 → 编码 → 出 MP3」主流程
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');          // 源码目录（engine.js / vendor/）
const TARGET = process.argv[2] || 'src/index.html';
const HTML = fs.readFileSync(path.join(ROOT, TARGET), 'utf8');
const LOG = [];
const say = (...a) => LOG.push(a.map(String).join(' '));
const REPORT = path.join(__dirname, 'report-ui.txt');
const flush = () => { try { fs.writeFileSync(REPORT, LOG.join('\n') + '\n', 'utf8'); } catch (e) {} };
process.on('exit', flush);
process.on('uncaughtException', e => { say('UNCAUGHT: ' + (e && e.stack || e)); flush(); process.exit(1); });

let fail = 0;
function ok(cond, label, extra) {
  if (cond) say('  PASS  ' + label);
  else { fail++; say('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------------- Step 1：内联脚本语法检查 ---------------- */
say('=== Step 1 内联脚本语法检查：' + TARGET + ' ===');
const inlineRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, idx = 0, inlineCodes = [];
while ((m = inlineRe.exec(HTML))) { inlineCodes.push(m[1]); }
say('  内联 <script> 个数 =', inlineCodes.length);
inlineCodes.forEach((code, i) => {
  const p = path.join(__dirname, '..', '_scratch', 'inline' + i + '.js');
  fs.writeFileSync(p, code, 'utf8');
  try { vm.compileFunction(code, [], { filename: 'inline-' + i + '.js' }); say('  inline' + i + ' 语法 OK (' + code.length + ' 字符)'); }
  catch (e) { fail++; say('  inline' + i + ' 语法错误: ' + e.message); }
});
const appCode = inlineCodes.filter(c => c.indexOf('function readOpts') >= 0)[0];
ok(!!appCode, '找到应用主脚本');
const external = (HTML.match(/<script\s+src="([^"]+)"/g) || []);
say('  外链脚本 =', external.length ? external.join(', ') : '（无，单文件自包含）');
external.forEach(tag => {
  const f = tag.replace(/.*src="/, '').replace(/".*/, '');
  ok(fs.existsSync(path.join(SRC, f)), '外链脚本存在: ' + f);
});

/* ---------------- Step 2：DOM id 引用校验 ---------------- */
say('');
say('=== Step 2 DOM id 引用校验 ===');
const ids = new Set();
(HTML.match(/id="([^"]+)"/g) || []).forEach(s => ids.add(s.slice(4, -1)));
const used = new Set();
const idRe = /\$\('([^']+)'\)|getElementById\('([^']+)'\)/g;
while ((m = idRe.exec(HTML))) used.add(m[1] || m[2]);
const missing = [...used].filter(x => !ids.has(x));
say('  页面定义 id =', [...ids].join(', '));
say('  脚本引用 id =', [...used].join(', '));
ok(missing.length === 0, '所有引用的 id 都有定义', missing.join(','));
// 反向：定义了但没用到的（提示用，不算失败）
const unused = [...ids].filter(x => !used.has(x));
say('  （定义但脚本未直接引用：' + unused.join(', ') + '）');

/* ---------------- 最小 DOM 桩 ---------------- */
function parseAttrs(str) {
  const o = {}; let mm;
  const re = /([a-zA-Z0-9_\-:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  while ((mm = re.exec(str))) o[mm[1]] = (mm[2] !== undefined ? mm[2] : (mm[3] !== undefined ? mm[3] : (mm[4] !== undefined ? mm[4] : '')));
  return o;
}
const VOID_TAGS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source']);

function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(), _tag: String(tag).toLowerCase(),
    children: [], parentNode: null, ownerDocument: doc,
    _text: '', _html: '', _classes: new Set(), _attrs: {},
    style: {}, dataset: {}, handlers: {}, options: [], selectedIndex: 0,
    value: '', checked: false, disabled: false, hidden: false, multiple: false, accept: '',
    clientWidth: 640, clientHeight: 56, width: 0, height: 0, id: '', className: '', src: '',
    scrollTop: 0, _raf: 0
  };
  el.getAttribute = k => (k in el._attrs ? el._attrs[k] : null);
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); if (k === 'id') el.id = String(v); if (k === 'class') el.className = String(v); if (k === 'src') el.src = String(v); };
  el.removeAttribute = k => { delete el._attrs[k]; };
  el.hasAttribute = k => k in el._attrs;
  Object.defineProperty(el, 'classList', {
    get() {
      const s = el._classes;
      return {
        add: (...c) => c.forEach(x => s.add(x)),
        remove: (...c) => c.forEach(x => s.delete(x)),
        toggle: (c, force) => { const on = force === undefined ? !s.has(c) : !!force; if (on) s.add(c); else s.delete(c); return on; },
        contains: c => s.has(c),
        toString: () => [...s].join(' ')
      };
    }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text + el.children.map(c => c.textContent).join(''); },
    set(v) { el._text = String(v); el.children = []; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); el.children = parseHtml(String(v), el); el.children.forEach(c => c.parentNode = el); }
  });
  el.appendChild = c => { el.children.push(c); c.parentNode = el; return c; };
  el.removeChild = c => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; };
  el.insertBefore = (c) => el.appendChild(c);
  el.getContext = () => fakeCtx2d;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: el.clientWidth, height: el.clientHeight });
  el.addEventListener = (t, fn) => { (el.handlers[t] = el.handlers[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => { if (el.handlers[t]) el.handlers[t] = el.handlers[t].filter(f => f !== fn); };
  el.dispatchEvent = ev => { ev.target = ev.target || el; (el.handlers[ev.type] || []).forEach(fn => fn(ev)); if (el.parentNode && ev.bubbles) el.parentNode.dispatchEvent(ev); return true; };
  el.click = () => el.dispatchEvent({ type: 'click', target: el, bubbles: true, preventDefault() {}, stopPropagation() {} });
  el.closest = sel => { let n = el; while (n) { if (matchesChain(n, [sel])) return n; n = n.parentNode; } return null; };
  el.querySelector = sel => queryAll(el, sel)[0] || null;
  el.querySelectorAll = sel => queryAll(el, sel);
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.focus = () => {}; el.blur = () => {};
  el.contentWindow = null;
  return el;
}
const fakeCtx2d = {
  _calls: 0,
  setTransform() { this._calls++; }, clearRect() { this._calls++; }, fillRect() { this._calls++; },
  beginPath() { this._calls++; }, moveTo() { this._calls++; }, lineTo() { this._calls++; }, stroke() { this._calls++; },
  fillText() { this._calls++; }, save() {}, restore() {}, set fillStyle(v) {}, get fillStyle() { return ''; },
  set strokeStyle(v) {}, get strokeStyle() { return ''; }, set font(v) {}, set textAlign(v) {}, set lineWidth(v) {}
};

function parseHtml(html, parent) {
  const out = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let t;
  while ((t = re.exec(html))) {
    if (t[1]) { // 闭标签
      if (stack.length) stack.pop();
    } else if (t[2]) {
      const el = makeEl(t[2], parent ? parent.ownerDocument : null);
      const attrs = parseAttrs(t[3] || '');
      Object.keys(attrs).forEach(k => {
        el._attrs[k] = attrs[k];
        if (k === 'class') el.className = attrs[k];
        else if (k === 'id') el.id = attrs[k];
        else if (k === 'value') el.value = attrs[k];
        else if (k === 'type' || k === 'accept' || k === 'src') el[k] = attrs[k];
      });
      ['checked', 'disabled', 'hidden', 'multiple', 'selected'].forEach(k => { if (k in attrs) el[k] = true; });
      el._classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
      const cur = stack.length ? stack[stack.length - 1] : null;
      if (cur) cur.appendChild(el); else out.push(el);
      const tagl = t[2].toLowerCase();
      if (tagl === 'option' && cur && cur._tag === 'select') {
        cur.options.push(el);
        if ('selected' in attrs) cur.selectedIndex = cur.options.length - 1;
      }
      if (!VOID_TAGS.has(tagl) && !t[4]) stack.push(el);
    } else if (t[5] !== undefined) {
      const txt = t[5];
      if (txt.trim()) {
        const cur = stack.length ? stack[stack.length - 1] : null;
        if (cur) cur._text += txt;
      }
    }
  }
  return out;
}
function walk(root, fn) { root.children.forEach(c => { fn(c); walk(c, fn); }); }
function matchesChain(el, parts) {
  if (!parts.length) return true;
  const p = parts[parts.length - 1];
  if (p[0] === '#') { if (el.id !== p.slice(1)) return false; }
  else if (p[0] === '.') { if (!el._classes.has(p.slice(1))) return false; }
  else if (el.tagName !== p.toUpperCase()) return false;
  if (parts.length === 1) return true;
  // 祖先里依次找到剩下的部分
  let n = el.parentNode, rest = parts.slice(0, -1);
  while (n) {
    if (matchesChain(n, [rest[rest.length - 1]])) { rest = rest.slice(0, -1); if (!rest.length) return true; }
    n = n.parentNode;
  }
  return false;
}
function queryAll(root, sel) {
  const parts = String(sel).trim().split(/\s+/);
  const res = [];
  walk(root, el => { if (matchesChain(el, parts)) res.push(el); });
  return res;
}

/* ---------------- 组装沙箱 ---------------- */
say('');
say('=== Step 3 DOM 桩启动 + 主流程 ===');

const doc = {};
const htmlEl = makeEl('html', doc);
const bodyEl = makeEl('body', doc);
const headEl = makeEl('head', doc);
htmlEl.appendChild(headEl); htmlEl.appendChild(bodyEl);
// 从真实 HTML 里解析 body 内容（先摘掉 script 段，避免被当作 DOM 文本处理）
const bodyHtml = (HTML.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, ''])[1].replace(/<script[\s\S]*?<\/script>/g, '');
parseHtml(bodyHtml, bodyEl).forEach(c => { bodyEl.appendChild(c); });
const byId = {};
walk(bodyEl, el => { if (el.id) byId[el.id] = el; });
headEl.innerHTML = (HTML.match(/<head[^>]*>([\s\S]*)<\/head>/) || [, ''])[1].replace(/<script[\s\S]*?<\/script>/g, '');
parseHtml(headEl._html, headEl).forEach(c => headEl.appendChild(c));
// select 的初始 value：真浏览器里取 selected 选项，没有 selected 就取第一个
Object.keys(byId).forEach(id => {
  const s = byId[id];
  if (s.options && s.options.length && !s._attrs.value) {
    if (!(s.selectedIndex >= 0 && s.selectedIndex < s.options.length)) s.selectedIndex = 0;
    s.value = s.options[s.selectedIndex].value;
  }
});
say('  解析到 id =', Object.keys(byId).length, ' 个；bitrate options =', byId.bitrate ? byId.bitrate.options.length : 'N/A');

doc.getElementById = id => byId[id] || null;
doc.querySelector = sel => queryAll(bodyEl, sel)[0] || null;
doc.querySelectorAll = sel => queryAll(bodyEl, sel);
const anchors = [];
doc.createElement = tag => { const e = makeEl(tag, doc); if (String(tag).toLowerCase() === 'a') anchors.push(e); return e; };
doc.createElementNS = (ns, tag) => makeEl(tag, doc);
doc.createTextNode = txt => { const e = makeEl('#text', doc); e._text = txt; return e; };
doc.body = bodyEl; doc.head = headEl; doc.documentElement = htmlEl;
doc.title = '';
doc.addEventListener = () => {};
doc.removeEventListener = () => {};

const rafQueue = [];
const createdBlobs = [];
let lastAnchorDownload = null;
const winHandlers = {};

/* 假解码器：返回预置的合成 AudioBuffer；可切换成失败模式 */
let fakeChannels = null, fakeRate = 44100, failDecode = false;
const AudioCtxStub = function () { this.state = 'running'; this.sampleRate = fakeRate; this.destination = {}; };
AudioCtxStub.prototype.decodeAudioData = function (ab, okcb, errcb) {
  setTimeout(() => {
    if (failDecode) { errcb && errcb(new Error('boom')); return; }
    okcb({
      numberOfChannels: fakeChannels.length, sampleRate: fakeRate,
      length: fakeChannels[0].length, duration: fakeChannels[0].length / fakeRate,
      getChannelData: i => fakeChannels[i]
    });
  }, 0);
};
AudioCtxStub.prototype.close = function () { this.state = 'closed'; };

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isFinite, parseInt, parseFloat,
  Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView, Set, Map, Symbol, RegExp, encodeURIComponent, decodeURIComponent, Infinity, NaN, undefined,
  Blob, File: globalThis.File,
  document: doc,
  location: { search: '', href: 'file:///E:/workbuddyspace1/audio-gap-remover/index.html', hash: '' },
  navigator: { userAgent: 'node-stub', language: 'zh-CN' },
  devicePixelRatio: 1,
  requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  URL: { createObjectURL: b => { createdBlobs.push(b); return 'blob:stub/' + createdBlobs.length; }, revokeObjectURL: () => {} },
  AudioContext: AudioCtxStub,
  OfflineAudioContext: function () { return {}; },
  addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
  removeEventListener: () => {},
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
// 真引擎 + 真 lamejs
vm.runInContext(fs.readFileSync(path.join(SRC, 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
vm.runInContext(fs.readFileSync(path.join(SRC, 'vendor', 'lame.min.js'), 'utf8'), ctx, { filename: 'lame.min.js' });
const E = sandbox.GapEngine;
ok(!!E, 'engine.js 在桩里加载成功');
ok(!!sandbox.lamejs && !!sandbox.lamejs.Mp3Encoder, 'lamejs 在桩里加载成功');

// 启动整页脚本（必须跑在沙箱上下文里，否则 window/document 不在作用域内）
let started = true;
try { vm.runInContext(appCode, ctx, { filename: 'app-inline.js' }); }
catch (e) { started = false; say('  启动异常: ' + (e && e.stack)); }
ok(started, '整页脚本启动无异常');

say('  初始状态：runAllBtn.disabled=' + byId.runAllBtn.disabled + ' downloadAllBtn.disabled=' + byId.downloadAllBtn.disabled);
ok(byId.runAllBtn.disabled === true, '空列表时「重跑全部」是禁用的');
ok(byId.thrDb.disabled === true, '自动模式下手动阈值滑块禁用');
ok(byId.thrHint.textContent.indexOf('自动') >= 0, '提示文案随模式变化');

// 触发放大器：跑掉 rAF 队列
function pumpRaf(n) { for (let k = 0; k < (n || 3); k++) { const q = rafQueue.splice(0); q.forEach(fn => { try { fn(); } catch (e) { say('  rAF 异常: ' + e.message); } }); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* 合成 6.7s 测试音频 → File 桩 */
function synthFile(name) {
  const segs = [[0.6, 0], [1.0, 440], [0.9, 0], [1.2, 660], [1.5, 0], [0.8, 880], [0.7, 0]];
  const total = segs.reduce((a, s) => a + s[0], 0);
  const n = Math.round(total * 44100);
  const L = new Float32Array(n), R = new Float32Array(n); let p = 0;
  segs.forEach(s => { const k = Math.round(s[0] * 44100); if (s[1]) for (let i = 0; i < k; i++) { const v = 0.5 * Math.sin(2 * Math.PI * s[1] * i / 44100); L[p + i] = v; R[p + i] = v * 0.9; } p += k; });
  const wav = E.encodeWav([L, R], 44100);
  return { name: name || 'voice.wav', size: wav.length, type: 'audio/wav', arrayBuffer: async () => wav.buffer.slice(0) };
}

(async function main() {
  /* --- 场景 A：正常处理一个文件 --- */
  fakeChannels = [];
  {
    const f = synthFile('采访录音.wav');
    const ab = await f.arrayBuffer();
    // 用引擎解出真实 PCM（桩解码器直接给 Float32）
    const dv = new DataView(ab); const n = (dv.byteLength - 44) / 4;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = dv.getInt16(44 + i * 4, true) / 32768; R[i] = dv.getInt16(46 + i * 4, true) / 32768; }
    fakeChannels = [L, R];
  }
  byId.fileInput.files = [synthFile('采访录音.wav')];
  byId.fileInput.dispatchEvent({ type: 'change', target: byId.fileInput, bubbles: false });
  say('  投递 1 个文件后：卡片数 =', byId.list.children.length);
  ok(byId.list.children.length === 1, '生成 1 张卡片', byId.list.children.length);
  const card = byId.list.children[0];
  ok(card.querySelector('.name').textContent === '采访录音.wav', '卡片显示文件名', card.querySelector('.name').textContent);

  for (let i = 0; i < 400; i++) { await sleep(15); pumpRaf(2); if (card.querySelector('.st').textContent.indexOf('完成') >= 0) break; }
  pumpRaf(2);
  const stTxt = card.querySelector('.st').textContent;
  const metaHtml = card.querySelector('.meta').innerHTML;
  say('  状态 =', stTxt);
  say('  摘要 =', metaHtml.replace(/<[^>]+>/g, ''));
  ok(stTxt === '完成', '处理完成', stTxt);
  ok(metaHtml.indexOf('剪掉') >= 0, '摘要显示剪掉的时长');
  ok(/3\.6\d*/.test(metaHtml), '摘要里输出时长 ≈3.6s', metaHtml);
  ok(card.querySelector('.b-dl').disabled === false, '下载按钮已启用');
  ok(byId.downloadAllBtn.disabled === false, '「全部下载」已启用');
  ok(card.querySelector('.a-out').getAttribute('src') && card.querySelector('.a-out').getAttribute('src').indexOf('blob:stub') === 0, '成品 MP3 播放器已挂上 blob 地址');
  ok(card.querySelector('.a-orig').getAttribute('src') && card.querySelector('.a-orig').getAttribute('src').indexOf('blob:stub') === 0, '原文件播放器已挂上 blob 地址');
  ok(card.querySelector('.c-orig').width > 0 && card.querySelector('.c-out').width > 0, '两块波形都画过了（canvas 有尺寸）');

  // 取 MP3 blob 复检
  const mp3Blobs = createdBlobs.filter(b => b.type === 'audio/mpeg');
  ok(mp3Blobs.length === 1, '产出了 1 个 audio/mpeg Blob', mp3Blobs.length);
  if (mp3Blobs.length) {
    const bytes = new Uint8Array(await mp3Blobs[0].arrayBuffer());
    const info = E.inspectMp3(bytes);
    say('  MP3: bytes=' + bytes.length + ' frames=' + info.frames + ' sr=' + info.sampleRate + ' br=' + info.bitrate + ' sec=' + info.seconds.toFixed(3));
    ok(info.frames > 120, 'MP3 帧数 > 120', info.frames);
    ok(info.bitrate === 128000 && info.sampleRate === 44100, 'MP3 参数正确 (128k/44.1k)');
    ok(Math.abs(info.seconds - 3.6) < 0.15, 'MP3 时长 ≈3.6s', info.seconds.toFixed(3));
    fs.writeFileSync(path.join(__dirname, 'out-ui.mp3'), Buffer.from(bytes));
  }

  /* --- 下载按钮 --- */
  card.querySelector('.b-dl').dispatchEvent({ type: 'click', bubbles: true });
  ok(anchors.length === 1, '点下载会造一个 <a> 触发保存', anchors.length);
  ok(anchors[0] && anchors[0].download === '采访录音_去静音.mp3', '文件名规则正确', anchors[0] && anchors[0].download);
  ok(anchors[0] && String(anchors[0].href).indexOf('blob:stub') === 0, '指向成品 MP3 的 blob 地址', anchors[0] && anchors[0].href);
  ok(byId.list.children.indexOf(anchors[0]) < 0, '下载用的临时 <a> 已从 DOM 摘掉');

  /* --- 场景 B：改参数重跑（阈值手动 + 完全贴死） --- */
  byId.thrMode.value = 'manual'; byId.thrMode.dispatchEvent({ type: 'change' });
  ok(byId.thrDb.disabled === false, '切到手动模式后滑块启用');
  byId.thrDb.value = '-40'; byId.thrDb.dispatchEvent({ type: 'input' });
  byId.targetGap.value = '0'; byId.targetGap.dispatchEvent({ type: 'input' });
  ok(byId.targetGapVal.textContent === '0 秒', '保留间隙标签显示 0 秒', byId.targetGapVal.textContent);
  card.querySelector('.b-rerun').dispatchEvent({ type: 'click', bubbles: true });
  for (let i = 0; i < 400; i++) { await sleep(15); pumpRaf(2); if (card.querySelector('.st').textContent.indexOf('完成') >= 0) break; }
  const meta2 = card.querySelector('.meta').innerHTML.replace(/<[^>]+>/g, '');
  say('  重跑后摘要 =', meta2);
  ok(/0:03\.0/.test(meta2), '间隙贴死后输出 = 三段音频总长 3.0s', meta2);
  ok(createdBlobs.filter(b => b.type === 'audio/mpeg').length === 2, '重跑产出了第 2 个 MP3');

  /* --- 场景 C：解码失败要有明确报错，不能静默 --- */
  failDecode = true;
  byId.fileInput.files = [synthFile('坏文件.mp3')];
  byId.fileInput.dispatchEvent({ type: 'change', target: byId.fileInput, bubbles: false });
  const card2 = byId.list.children[1];
  for (let i = 0; i < 200; i++) { await sleep(15); pumpRaf(2); if (card2.querySelector('.st').textContent === '出错') break; }
  const errTxt = card2.querySelector('.err').textContent;
  say('  坏文件状态 =', card2.querySelector('.st').textContent, '| 报错 =', errTxt);
  ok(card2.querySelector('.st').textContent === '出错', '解码失败显示「出错」');
  ok(errTxt.length > 0, '错误信息非空', errTxt);
  ok(card2.querySelector('.b-dl').disabled === true, '出错卡片不提供下载');
  failDecode = false;

  /* --- 场景 D：文件名注入检查（静态：必须走 textContent，不能拼进 innerHTML） --- */
  ok(!/innerHTML\s*=\s*[^;]*\bit\.name\b/.test(appCode), '没有把文件名拼进 innerHTML');
  ok(/\.name\.textContent\s*=\s*it\.name/.test(appCode), '文件名通过 textContent 注入（天然转义）');
  byId.fileInput.files = [synthFile('<img src=x onerror=alert(1)>.wav')];
  byId.fileInput.dispatchEvent({ type: 'change', target: byId.fileInput, bubbles: false });
  const card3 = byId.list.children[2];
  const rawName = card3.querySelector('.name').textContent;
  say('  恶意文件名渲染结果 =', rawName);
  ok(rawName === '<img src=x onerror=alert(1)>.wav', '恶意文件名原样作为文本显示，未变成标签', rawName);

  /* --- 场景 E：清空列表 --- */
  byId.clearBtn.dispatchEvent({ type: 'click', bubbles: true });
  ok(byId.list.children.length === 0, '清空后列表为空', byId.list.children.length);
  ok(byId.runAllBtn.disabled === true && byId.clearBtn.disabled === true, '清空后按钮回到禁用');

  /* --- 场景 F：预设按钮 --- */
  const chipTight = doc.querySelectorAll('#presets .chipbtn').filter(b => b.getAttribute('data-p') === 'tight')[0];
  ok(!!chipTight, '找到「狠一点」预设按钮');
  if (chipTight) {
    chipTight.dispatchEvent({ type: 'click', bubbles: true });
    ok(String(byId.minSil.value) === '200' && String(byId.targetGap.value) === '60', '预设写入参数', byId.minSil.value + '/' + byId.targetGap.value);
    ok(chipTight.classList.contains('on'), '预设高亮切换');
  }

  say('');
  say(fail === 0 ? '>>> 全部通过' : '>>> 失败 ' + fail + ' 项');
  flush();
  process.exit(fail === 0 ? 0 : 1);
})();
