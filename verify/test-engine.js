/* 引擎单元测试：合成已知结构的音频，验证检测/剪切/编码正确性 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('../src/engine.js');

const LOG = [];
const say = (...a) => LOG.push(a.map(String).join(' '));
const REPORT = path.join(__dirname, 'test-engine.txt');
process.on('exit', () => { try { fs.writeFileSync(REPORT, LOG.join('\n') + '\n', 'utf8'); } catch (e) {} });
process.on('uncaughtException', e => { say('UNCAUGHT: ' + (e && e.stack || e)); try { fs.writeFileSync(REPORT, LOG.join('\n') + '\n', 'utf8'); } catch (x) {} process.exit(1); });

let fail = 0;
function ok(cond, label, extra) {
  if (cond) say('  PASS  ' + label);
  else { fail++; say('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 合成：440/660/880Hz 三段音，夹着静音 */
const SR = 44100;
const segs = [
  { type: 'sil', dur: 0.6 },
  { type: 'tone', dur: 1.0, f: 440 },
  { type: 'sil', dur: 0.9 },
  { type: 'tone', dur: 1.2, f: 660 },
  { type: 'sil', dur: 1.5 },
  { type: 'tone', dur: 0.8, f: 880 },
  { type: 'sil', dur: 0.7 }
];
const total = segs.reduce((a, s) => a + s.dur, 0);
const N = Math.round(total * SR);
const L = new Float32Array(N), R = new Float32Array(N);
let p = 0;
segs.forEach(s => {
  const n = Math.round(s.dur * SR);
  for (let i = 0; i < n; i++) {
    if (s.type === 'tone') {
      const v = 0.5 * Math.sin(2 * Math.PI * s.f * i / SR);
      L[p + i] = v; R[p + i] = v * 0.9;
    }
  }
  p += n;
});

say('=== 1. 自动阈值 ===');
const a = E.analyze([L, R], SR, { minSilenceSec: 0.35, targetGapSec: 0.15, fadeMs: 20 });
say('  阈值 =', a.thresholdDb, 'dBFS  (p05=' + a.auto.p05.toFixed(1), 'p90=' + a.auto.p90.toFixed(1) + ')');
say('  时长 =', a.duration.toFixed(3), 's  检测到静音段 =', a.silences.length);
a.silences.forEach(s => say('    [' + s.start.toFixed(3) + ', ' + s.end.toFixed(3) + ']  ' + s.dur.toFixed(3) + 's'));

ok(a.silences.length === 4, '4 段静音全部识别', a.silences.length);
ok(a.thresholdDb > -60 && a.thresholdDb < -20, '阈值落在合理区间', a.thresholdDb);
ok(Math.abs(a.silences[0].start - 0) < 0.02 && Math.abs(a.silences[0].end - 0.6) < 0.04, '首段静音边界准确（开头静音要算上）');
ok(Math.abs(a.silences[1].start - 1.6) < 0.04 && Math.abs(a.silences[1].end - 2.5) < 0.04, '中段静音边界准确');

say('');
say('=== 2. 剪切计划 ===');
say('  剪切段 =', a.cuts.length, ' 预计输出时长 =', a.outDuration.toFixed(3) + 's');
a.cuts.forEach(c => say('    cut [' + c.start.toFixed(3) + ', ' + c.end.toFixed(3) + '] = ' + c.dur.toFixed(3) + 's'));
// 6.7s - (0.45+0.75+1.35+0.55) = 3.60s
ok(a.cuts.length === 4, '生成 4 个剪切点', a.cuts.length);
ok(Math.abs(a.outDuration - 3.60) < 0.05, '预计输出 3.60s', a.outDuration.toFixed(3));

say('');
say('=== 3. 拼接渲染 ===');
const r = E.render(a.channels, SR, a.cuts, { fadeMs: 20, normalize: false });
say('  实际输出 =', r.duration.toFixed(3) + 's  峰值 =', r.peak.toFixed(4));
ok(Math.abs(r.duration - 3.60) < 0.05, '渲染时长 ≈ 3.60s', r.duration.toFixed(3));
ok(Math.abs(r.duration - a.outDuration) < 0.005, '渲染时长与计划一致');

// 拼接后：三段音频应当完好，段间停顿被压到目标间隙（0.15s）左右
const env = E.rmsEnvelope(E.mixToMono(r.channels.map(c => {
  const f = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) f[i] = c[i] / 32768;
  return f;
})), SR, 20, 10);
const sil = E.detectSilences(env.env, env.hop, env.win, SR, r.duration, a.thresholdDb, 0.08);
sil.forEach(s => say('    停顿 [' + s.start.toFixed(3) + ', ' + s.end.toFixed(3) + '] = ' + s.dur.toFixed(3) + 's'));
const internal = sil.filter(s => s.start > 0.04 && s.end < r.duration - 0.04);
const active = internal.length + 1;
let maxGap = 0, minGap = 1e9; sil.forEach(s => { if (s.dur > maxGap) maxGap = s.dur; if (s.dur < minGap) minGap = s.dur; });
say('  剩余停顿 =', sil.length, ' 其中段间 =', internal.length, ' 区间 =', minGap.toFixed(3) + '~' + maxGap.toFixed(3) + 's');
ok(internal.length === 2, '段间只剩 2 处停顿', internal.length);
ok(active === 3, '三段音频段都还在', active);
ok(sil[0].start < 0.001, '开头留有引子静音（未被剃光）', sil[0].start.toFixed(3));
ok(sil[sil.length - 1].end > r.duration - 0.001, '结尾留有收尾静音', sil[sil.length - 1].end.toFixed(3));
ok(maxGap <= 0.19, '最长停顿 <= 0.19s（目标 0.15 + 边界误差）', maxGap.toFixed(3));
ok(minGap >= 0.12, '最短停顿 >= 0.12s（没有把气口切得过分）', minGap.toFixed(3));

// 音量不能被切丢：有声段峰值应接近 0.5
let pk = 0, c0 = r.channels[0];
for (let i = 0; i < c0.length; i++) { const v = Math.abs(c0[i]) / 32768; if (v > pk) pk = v; }
ok(pk > 0.45 && pk <= 0.52, '保留段峰值未被削（≈0.5）', pk.toFixed(4));

// 归一化验证
const r2 = E.render(a.channels, SR, a.cuts, { fadeMs: 20, normalize: true });
ok(Math.abs(r2.peak - 0.891) < 0.02, '归一化后峰值 ≈ -1dBFS(0.891)', r2.peak.toFixed(4));

say('');
say('=== 3b. 真实场景鲁棒性 ===');
let seed = 987654321;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; }
/* seg: {dur, tone?, noise?} */
function build(segs, sr) {
  const total = segs.reduce((a, s) => a + s.dur, 0);
  const n = Math.round(total * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  let p = 0;
  segs.forEach(s => {
    const k = Math.round(s.dur * sr);
    for (let i = 0; i < k; i++) {
      let v = 0;
      if (s.tone) v += 0.45 * Math.sin(2 * Math.PI * s.tone * i / sr);
      if (s.am) v *= 0.85 + 0.15 * Math.sin(2 * Math.PI * s.am * i / sr);
      if (s.noise) v += 0.0025 * rnd();   // ≈ -52 dBFS 的底噪
      L[p + i] = v; R[p + i] = v * 0.95;
    }
    p += k;
  });
  return [L, R];
}
const O = { minSilenceSec: 0.35, targetGapSec: 0.15, fadeMs: 20 };

// (a) 有底噪的录音：静音段不是数字零，而是 -52dBFS 噪声
const noiseCh = build([
  { dur: 0.8, noise: 1 }, { dur: 1.2, tone: 440, noise: 1 },
  { dur: 1.0, noise: 1 }, { dur: 1.0, tone: 660, noise: 1 },
  { dur: 0.9, noise: 1 }
], SR);
const na = E.analyze(noiseCh, SR, O);
say('  底噪录音: 阈值 =', na.thresholdDb, 'dBFS (p05=' + na.auto.p05.toFixed(1) + ' p90=' + na.auto.p90.toFixed(1) + ')  静音段 =', na.silences.length, ' 输出 =', na.outDuration.toFixed(2) + 's');
ok(na.silences.length === 3, '有底噪时 3 段静音仍被找到', na.silences.length);
ok(na.thresholdDb > -52 && na.thresholdDb < -28, '阈值高于底噪、低于人声', na.thresholdDb);
ok(Math.abs(na.outDuration - 2.65) < 0.1, '输出 ≈2.65s', na.outDuration.toFixed(2));

// (b) 连续素材（几乎没有动态）：不该乱剪
const musicCh = build([{ dur: 5.0, tone: 330, am: 0.6, noise: 1 }], SR);
const ma = E.analyze(musicCh, SR, O);
say('  连续素材: 动态范围 =', ma.auto.range.toFixed(1) + 'dB  lowDynamics =', ma.auto.lowDynamics, ' 阈值 =', ma.thresholdDb, ' 剪切 =', ma.cuts.length);
ok(ma.cuts.length === 0, '连续素材一处都不剪（避免毁掉音乐）', ma.cuts.length);
ok(ma.auto.lowDynamics === true, '识别为「动态过小」并拒绝乱切');

// (c) 说话换气 0.2 秒：默认不切；调激进才切
const breath = build([{ dur: 1.0, tone: 440 }, { dur: 0.2, noise: 1 }, { dur: 1.0, tone: 660 }], SR);
const b1 = E.analyze(breath, SR, O);
const b2 = E.analyze(breath, SR, Object.assign({}, O, { minSilenceSec: 0.15 }));
say('  0.2s 换气: 默认(350ms) 剪切 =', b1.cuts.length, ' / 激进(150ms) 剪切 =', b2.cuts.length);
ok(b1.cuts.length === 0, '默认保留 0.2s 的自然换气', b1.cuts.length);
ok(b2.cuts.length === 1, '把最短停顿调到 150ms 才会切', b2.cuts.length);

// (d) 剪接点淡化：有底噪的材料在切点处不是数字零，必须从 0 淡入，否则会有咔哒声
const naCuts = na.cuts;
const rF = E.render(na.channels, SR, naCuts, { fadeMs: 20, normalize: false });
const rN = E.render(na.channels, SR, naCuts, { fadeMs: 0, normalize: false });
function segStarts(r) {
  let off = 0; const v = [];
  r.keeps.forEach((k, i) => { const len = Math.round((k.end - k.start) * SR); if (i > 0 && off < r.channels[0].length) v.push(r.channels[0][off]); off += len; });
  return v;
}
const fadeStarts = segStarts(rF), rawStarts = segStarts(rN);
say('  切点首采样: 淡化20ms =', fadeStarts.join(', '), ' / 不淡化 =', rawStarts.join(', '));
ok(fadeStarts.length > 0 && fadeStarts.every(v => v === 0), '开淡化时每个剪接点从 0 起（防爆音）', fadeStarts.join(','));
ok(rawStarts.some(v => v !== 0), '关淡化时是硬接（对照组成立）', rawStarts.join(','));

say('');
say('=== 4. MP3 编码（lamejs） ===');
const ctx = { console, setTimeout, clearTimeout, Promise, Math, Date, Int8Array, Int16Array, Int32Array, Uint8Array, Float32Array, ArrayBuffer, DataView, String, Number, Object, Array };
ctx.self = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'vendor', 'lame.min.js'), 'utf8'), ctx);
const lame = ctx.lamejs;
ok(!!lame && typeof lame.Mp3Encoder === 'function', 'lamejs 在 Node 沙箱里可加载');

const t0 = Date.now();
E.encodeMp3(lame, r.channels, SR, 128, null).then(mp3 => {
  const sec = ((Date.now() - t0) / 1000).toFixed(2);
  fs.writeFileSync(path.join(__dirname, 'out-test.mp3'), Buffer.from(mp3));
  say('  编码耗时 =', sec + 's  体积 =', mp3.length, 'bytes');
  const info = E.inspectMp3(mp3);
  say('  帧数 =', info.frames, ' 采样率 =', info.sampleRate, ' 声道 =', info.channels, ' 码率 =', info.bitrate, ' 时长 ≈', info.seconds.toFixed(3) + 's');
  ok(info.frames > 100, 'MP3 帧数合理', info.frames);
  ok(info.sampleRate === 44100, '采样率 44100', info.sampleRate);
  ok(info.channels === 2, '立体声', info.channels);
  ok(info.bitrate === 128000, '码率 128k', info.bitrate);
  ok(Math.abs(info.seconds - r.duration) < 0.15, 'MP3 时长与输入一致', info.seconds.toFixed(3) + ' vs ' + r.duration.toFixed(3));
  say('  期望体积 ≈', Math.round(r.duration * 128 * 1000 / 8), 'bytes');
  ok(Math.abs(mp3.length - r.duration * 128 * 1000 / 8) / (r.duration * 128 * 1000 / 8) < 0.05, '体积符合 CBR 预期');

  // WAV 也落一份，供 Python 端解码核对
  fs.writeFileSync(path.join(__dirname, 'in-test.wav'), Buffer.from(E.encodeWav([L, R], SR)));

  say('');
  say(fail === 0 ? '>>> 全部通过 (' + LOG.filter(l => l.includes('PASS')).length + ' 项)' : '>>> 失败 ' + fail + ' 项');
  process.exitCode = fail === 0 ? 0 : 1;
}).catch(e => { say('ENCODE ERROR: ' + (e && e.stack || e)); process.exitCode = 1; });
