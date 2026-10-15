/* ============================================================
 * 音频去缝器 · 核心引擎 (engine.js)
 * ------------------------------------------------------------
 * 纯逻辑，无 DOM 依赖：浏览器里挂到 window.GapEngine，
 * Node 里 module.exports，两边共用同一份代码（便于自动化测试）。
 *
 * 流程：解码后的 PCM → 分帧 RMS 包络 → 静音判定 → 计划剪切点
 *       → 拼接成 Int16（含切点淡入淡出）→ lamejs 编码 MP3
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GapEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* lamejs 支持的采样率；其它采样率需要重采样后再编码 */
  var LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  var DEFAULTS = {
    frameMs: 20,        // 分析窗口长度
    hopMs: 10,          // 分析帧步进
    minSilenceSec: 0.35, // 短于这个长度的停顿不算“空隙”
    targetGapSec: 0.15,  // 剪切后保留的间隙（0 = 完全删除）
    fadeMs: 20,          // 切点淡入淡出，防爆音
    bitrate: 128,
    thresholdDb: null,   // null = 自动
    normalize: false,
    minCutSec: 0.02      // 小于这个长度的剪切没意义，跳过
  };

  var EPS = 1e-10;
  function toDb(x) { return 20 * Math.log10(x + EPS); }

  /* ---------- 1. 下混为单声道（仅用于分析） ---------- */
  function mixToMono(channels) {
    var n = channels[0].length;
    if (channels.length === 1) return channels[0];
    var out = new Float32Array(n), c, i, g = 1 / channels.length;
    for (c = 0; c < channels.length; c++) {
      var a = channels[c];
      for (i = 0; i < n; i++) out[i] += a[i];
    }
    for (i = 0; i < n; i++) out[i] *= g;
    return out;
  }

  /* ---------- 2. 分帧 RMS 包络（dBFS） ---------- */
  function rmsEnvelope(mono, sampleRate, frameMs, hopMs) {
    var win = Math.max(1, Math.round(sampleRate * frameMs / 1000));
    var hop = Math.max(1, Math.round(sampleRate * hopMs / 1000));
    var n = mono.length;
    if (!n) return { env: new Float32Array(0), hop: hop, win: win };
    var count = Math.max(1, Math.floor((n - win) / hop) + 1);
    if (count < 1) count = 1;
    // 前缀和加速平方和
    var pre = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) { var v = mono[i]; pre[i + 1] = pre[i] + v * v; }
    var env = new Float32Array(count);
    for (var k = 0; k < count; k++) {
      var s = k * hop, e = Math.min(n, s + win);
      var mean2 = (pre[e] - pre[s]) / Math.max(1, e - s);
      env[k] = toDb(Math.sqrt(mean2));
    }
    return { env: env, hop: hop, win: win };
  }

  function dbPercentile(env, p) {
    if (!env.length) return -100;
    var a = Float32Array.from(env);
    a.sort();
    var idx = Math.round((a.length - 1) * p);
    return a[Math.max(0, Math.min(a.length - 1, idx))];
  }

  /* ---------- 3. 自动阈值 ----------
   * 思路：p05 视作底噪，p90 视作人声电平，阈值取两者之间的下三分之一，
   * 并夹在 [-55, -30] dBFS 之间，避免把气声/齿音一起削掉。 */
  function autoThresholdDb(env) {
    var p05 = dbPercentile(env, 0.05);
    var p50 = dbPercentile(env, 0.50);
    var p90 = dbPercentile(env, 0.90);
    var range = p90 - p05;
    var info = { p05: p05, p50: p50, p90: p90, range: range, lowDynamics: false };
    if (range < 8) { // 几乎没有动态（连续音乐/持续噪声）→ 不敢乱切
      info.lowDynamics = true;
      info.threshold = -90;
      return info;
    }
    var thr = p05 + 0.35 * range;
    if (thr < -55) thr = -55;
    if (thr > -30) thr = -30;
    // 再保险一层：阈值不能高到接近人声电平
    if (thr > p90 - 10) thr = p90 - 10;
    info.threshold = Math.round(thr * 10) / 10;
    return info;
  }

  /* ---------- 4. 静音段检测 ---------- */
  function detectSilences(env, hopSamples, winSamples, sampleRate, durationSec, thresholdDb, minSilenceSec) {
    var N = env.length, hop = hopSamples / sampleRate, win = winSamples / sampleRate;
    var runs = [], i = 0;
    while (i < N) {
      if (env[i] < thresholdDb) {
        var j = i;
        while (j < N && env[j] < thresholdDb) j++;
        var start = i === 0 ? 0 : i * hop;
        // 走到最后一帧 → 说明静音一直持续到文件结尾
        var end = j >= N ? durationSec : (j - 1) * hop + win;
        if (end > durationSec) end = durationSec;
        if (end > start) runs.push({ start: start, end: end, dur: end - start });
        i = j;
      } else i++;
    }
    return runs.filter(function (r) { return r.dur >= minSilenceSec - 1e-6; });
  }

  /* ---------- 5. 计划剪切点 ----------
   * 每段静音 [s,e] 切掉中间部分，两头各留 targetGap/2，
   * 于是听众听到的停顿长度正好是 targetGap。
   * 开头/结尾的静音同样处理 → 首尾各留一半。 */
  function planCuts(durationSec, silences, targetGapSec, minCutSec) {
    var half = Math.max(0, targetGapSec) / 2;
    var cuts = [], i;
    for (i = 0; i < silences.length; i++) {
      var s = silences[i], a, b;
      var atHead = s.start <= 1e-3;
      var atTail = s.end >= durationSec - 1e-3;
      a = atHead ? Math.min(half, s.end) : s.start + half;
      b = atTail ? Math.max(durationSec - half, a) : s.end - half;
      if (b - a >= minCutSec) cuts.push({ start: a, end: b, dur: b - a });
    }
    // 相邻剪切点重叠时合并（极端阈值下可能出现）
    var merged = [];
    for (i = 0; i < cuts.length; i++) {
      var last = merged[merged.length - 1];
      if (last && cuts[i].start <= last.end + 1e-6) last.end = Math.max(last.end, cuts[i].end);
      else merged.push({ start: cuts[i].start, end: cuts[i].end });
    }
    for (i = 0; i < merged.length; i++) merged[i].dur = merged[i].end - merged[i].start;

    // 取剪切点的补集 = 要保留的段落
    var keeps = [], cur = 0;
    for (i = 0; i < merged.length; i++) {
      if (merged[i].start > cur + 1e-6) keeps.push({ start: cur, end: merged[i].start });
      cur = Math.max(cur, merged[i].end);
    }
    if (cur < durationSec - 1e-6) keeps.push({ start: cur, end: durationSec });
    var removed = 0;
    for (i = 0; i < merged.length; i++) removed += merged[i].dur;
    return { cuts: merged, keeps: keeps, removedSec: Math.max(0, durationSec - (durationSec - removed)), keptSec: durationSec - removed };
  }

  /* ---------- 6. 拼接 + 转 Int16（供 MP3 编码器直接吃） ---------- */
  function spliceToInt16(channels, sampleRate, keeps, fadeSec) {
    var chCount = channels.length;
    var i, c, len, total = 0, segLens = [];
    for (i = 0; i < keeps.length; i++) {
      len = Math.max(0, Math.round((keeps[i].end - keeps[i].start) * sampleRate));
      segLens.push(len); total += len;
    }
    var out = [];
    for (c = 0; c < chCount; c++) out.push(new Int16Array(total));
    var F = Math.max(0, Math.round((fadeSec || 0) * sampleRate));
    var peak = 0, w = 0, ki, k;

    // 输出波形包络（给界面画图用，不占大内存）
    var bucket = Math.max(1, Math.ceil(total / 1200) || 1);
    var envOut = new Float32Array(Math.max(1, Math.ceil(total / bucket)));
    var envIdx = 0, envMax = 0, envCount = 0;

    for (ki = 0; ki < keeps.length; ki++) {
      var kk = keeps[ki];
      if (segLens[ki] <= 0) continue;
      var s0 = Math.max(0, Math.round(kk.start * sampleRate));
      var e0 = Math.min(channels[0].length, s0 + segLens[ki]);
      len = e0 - s0;
      if (len <= 0) continue;
      var fin = Math.min(F, len >> 1);
      var fout = Math.min(F, len >> 1);

      for (c = 0; c < chCount; c++) {
        var src = channels[c], dst = out[c], p = w;
        if (!fin && !fout) {
          for (i = 0; i < len; i++) {
            var v0 = src[s0 + i];
            var av0 = v0 < 0 ? -v0 : v0;
            if (av0 > peak) peak = av0;
            dst[p + i] = v0 < 0 ? (v0 * 32768 | 0) : (v0 * 32767 | 0);
          }
        } else {
          for (i = 0; i < len; i++) {
            var v = src[s0 + i], g = 1;
            if (i < fin) g *= i / fin;
            if (fout > 0 && i >= len - fout) g *= (len - i) / fout;
            v *= g;
            var av = v < 0 ? -v : v;
            if (av > peak) peak = av;
            if (v > 1) v = 1; else if (v < -1) v = -1;
            dst[p + i] = v < 0 ? (v * 32768 | 0) : (v * 32767 | 0);
          }
        }
      }
      // 包络（按桶取峰值）
      for (i = 0; i < len; i++) {
        var s = out[0][w + i] / 32768;
        if (s < 0) s = -s;
        if (s > envMax) envMax = s;
        envCount++;
        if (envCount >= bucket) {
          envOut[envIdx++] = envMax; envMax = 0; envCount = 0;
        }
      }
      w += len;
    }
    if (envCount > 0) envOut[envIdx++] = envMax;
    return { channels: out, length: w, peak: peak, envelope: envOut.subarray(0, envIdx) };
  }

  /* 从任意 PCM 通道算画图用的包络 */
  function peakEnvelope(channels, buckets) {
    var n = channels[0].length;
    buckets = Math.max(1, Math.min(buckets || 1200, n));
    var bs = Math.max(1, Math.ceil(n / buckets));
    var out = new Float32Array(Math.ceil(n / bs));
    var k = 0, mx = 0, cnt = 0, ch, i, v;
    for (i = 0; i < n; i++) {
      var m = 0;
      for (ch = 0; ch < channels.length; ch++) {
        v = channels[ch][i]; if (v < 0) v = -v;
        if (v > m) m = v;
      }
      if (m > mx) mx = m;
      cnt++;
      if (cnt >= bs) { out[k++] = mx; mx = 0; cnt = 0; }
    }
    if (cnt > 0) out[k++] = mx;
    return out.subarray(0, k);
  }

  /* 峰值归一化到 -1 dBFS（第二遍，直接改 Int16） */
  function applyGain(channels, gain) {
    if (!gain || Math.abs(gain - 1) < 1e-6) return;
    for (var c = 0; c < channels.length; c++) {
      var a = channels[c];
      for (var i = 0; i < a.length; i++) {
        var v = a[i] * gain;
        a[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : (v | 0));
      }
    }
  }

  /* ---------- 7. 立体声/多声道整理 ---------- */
  function normalizeChannelCount(channels) {
    if (channels.length === 1) return [channels[0]];
    if (channels.length === 2) return [channels[0], channels[1]];
    // >2 声道：奇偶下混成左右
    var n = channels[0].length, L = new Float32Array(n), R = new Float32Array(n);
    var lc = 0, rc = 0, c, i;
    for (c = 0; c < channels.length; c += 2) lc++;
    for (c = 1; c < channels.length; c += 2) rc++;
    for (c = 0; c < channels.length; c++) {
      var a = channels[c], isL = (c % 2 === 0);
      var g = 1 / (isL ? lc : Math.max(1, rc));
      for (i = 0; i < n; i++) { if (isL) L[i] += a[i] * g; else R[i] += a[i] * g; }
    }
    return [L, R];
  }

  /* ---------- 8. MP3 编码（分块让出主线程，带进度） ---------- */
  function clampBitrate(kbps, sampleRate) {
    // MPEG-1(32k+)最高 320，MPEG-2(16~24k)最高 160，MPEG-2.5(<16k)最高 64
    var max = sampleRate >= 32000 ? 320 : (sampleRate >= 16000 ? 160 : 64);
    var list = [64, 96, 128, 160, 192, 224, 256, 320].filter(function (b) { return b <= max; });
    var best = list[0];
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - kbps) < Math.abs(best - kbps)) best = list[i];
    if (kbps > max) best = max;
    return best;
  }

  function encodeMp3(lame, int16Channels, sampleRate, kbps, onProgress, yielder) {
    kbps = clampBitrate(kbps, sampleRate);
    var channels = int16Channels.length;
    var enc = new lame.Mp3Encoder(channels, sampleRate, kbps);
    var left = int16Channels[0];
    var right = channels > 1 ? int16Channels[1] : null;
    var total = left.length;
    var block = 1152;
    var chunks = [];
    var done = 0;
    var yieldFn = yielder || function () { return new Promise(function (r) { setTimeout(r, 0); }); };

    function step() {
      // 按时间预算让出主线程：每轮干活 ~45ms，保证界面还能响应
      var t0 = Date.now();
      do {
        var end = Math.min(total, done + block);
        var l = left.subarray(done, end);
        var buf;
        if (right) buf = enc.encodeBuffer(l, right.subarray(done, end));
        else buf = enc.encodeBuffer(l);
        if (buf.length) chunks.push(buf);
        done = end;
      } while (done < total && Date.now() - t0 < 45);
      if (onProgress) onProgress(done / total);
      if (done < total) return yieldFn().then(step);
      var tail = enc.flush();
      if (tail.length) chunks.push(tail);
      var size = 0, i;
      for (i = 0; i < chunks.length; i++) size += chunks[i].length;
      var out = new Uint8Array(size), off = 0;
      for (i = 0; i < chunks.length; i++) { out.set(new Uint8Array(chunks[i].buffer, chunks[i].byteOffset, chunks[i].length), off); off += chunks[i].length; }
      return Promise.resolve(out);
    }
    return Promise.resolve().then(step);
  }

  /* ---------- 9. 一次性跑完整条流水线（浏览器/Node 通用） ---------- */
  function analyze(channelsRaw, sampleRate, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var channels = normalizeChannelCount(channelsRaw);
    var duration = channels[0].length / sampleRate;
    var mono = mixToMono(channels);
    var e = rmsEnvelope(mono, sampleRate, opts.frameMs, opts.hopMs);
    var auto = autoThresholdDb(e.env);
    var thr = (opts.thresholdDb === null || opts.thresholdDb === undefined || opts.thresholdDb === '')
      ? auto.threshold : Number(opts.thresholdDb);
    var silences = detectSilences(e.env, e.hop, e.win, sampleRate, duration, thr, opts.minSilenceSec);
    var plan = planCuts(duration, silences, opts.targetGapSec, opts.minCutSec);
    var totalSilence = 0;
    for (var i = 0; i < silences.length; i++) totalSilence += silences[i].dur;
    return {
      channels: channels, sampleRate: sampleRate, duration: duration,
      envelope: peakEnvelope(channels, 1200),
      auto: auto, thresholdDb: thr, silences: silences,
      cuts: plan.cuts, keeps: plan.keeps,
      totalSilence: totalSilence, outDuration: plan.keptSec
    };
  }

  function render(channels, sampleRate, cuts, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var keeps = [];
    var cur = 0, i;
    for (i = 0; i < cuts.length; i++) {
      if (cuts[i].start > cur + 1e-6) keeps.push({ start: cur, end: cuts[i].start });
      cur = Math.max(cur, cuts[i].end);
    }
    var duration = channels[0].length / sampleRate;
    if (cur < duration - 1e-6) keeps.push({ start: cur, end: duration });
    var spliced = spliceToInt16(channels, sampleRate, keeps, opts.fadeMs / 1000);
    if (opts.normalize && spliced.peak > 0) {
      var target = Math.pow(10, -1 / 20); // -1 dBFS
      applyGain(spliced.channels, target / spliced.peak);
      spliced.peak = target;
    }
    return {
      channels: spliced.channels, length: spliced.length, peaks: spliced.envelope,
      duration: spliced.length / sampleRate, peak: spliced.peak, keeps: keeps
    };
  }

  /* WAV（16bit PCM）合成，仅用于自测 */
  function encodeWav(channels, sampleRate) {
    var ch = channels.length, n = channels[0].length;
    var dataLen = n * ch * 2;
    var buf = new ArrayBuffer(44 + dataLen);
    var dv = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, ch, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true);
    dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, dataLen, true);
    var off = 44, i, c;
    for (i = 0; i < n; i++) {
      for (c = 0; c < ch; c++) {
        var v = channels[c][i];
        v = v > 1 ? 1 : (v < -1 ? -1 : v);
        dv.setInt16(off, v < 0 ? v * 32768 : v * 32767, true); off += 2;
      }
    }
    return new Uint8Array(buf);
  }

  /* MP3 帧校验：数出同步头数量，估算时长 */
  function inspectMp3(bytes) {
    var frames = 0, off = 0, totalSamples = 0, i, sr = null, br = null, ch = null;
    // Layer III 码率表（注意：不是 Layer II 的表，写错会导致帧长算错、解析跑飞）
    var BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    var BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    var SR = [44100, 48000, 32000];
    while (off + 4 <= bytes.length) {
      if (bytes[off] === 0xFF && (bytes[off + 1] & 0xE0) === 0xE0) {
        var h1 = bytes[off + 1], h2 = bytes[off + 2], h3 = bytes[off + 3];
        var ver = (h1 >> 3) & 3;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        var layer = (h1 >> 1) & 3;    // 1 = Layer III
        var brIdx = (h2 >> 4) & 15;
        var srIdx = (h2 >> 2) & 3;
        var padding = (h2 >> 1) & 1;
        if (ver !== 1 && layer === 1 && brIdx > 0 && brIdx < 15 && srIdx < 3) {
          var isV1 = (ver === 3);
          var base = SR[srIdx];
          sr = isV1 ? base : (base / 2);
          if (ver === 0) sr = sr / 2;
          var bitrate = (isV1 ? BR1[brIdx] : BR2[brIdx]) * 1000;
          ch = ((h3 >> 6) & 3) === 3 ? 1 : 2;
          var spf = isV1 ? 1152 : 576;
          var frameLen = Math.floor((isV1 ? 144 : 72) * bitrate / sr) + padding;
          if (frameLen > 4) {
            frames++; totalSamples += spf; br = bitrate;
            off += frameLen; continue;
          }
        }
      }
      off++;
    }
    return { frames: frames, sampleRate: sr, channels: ch, bitrate: br, seconds: sr ? totalSamples / sr : 0 };
  }

  return {
    DEFAULTS: DEFAULTS,
    LAME_RATES: LAME_RATES,
    mixToMono: mixToMono,
    rmsEnvelope: rmsEnvelope,
    autoThresholdDb: autoThresholdDb,
    detectSilences: detectSilences,
    planCuts: planCuts,
    spliceToInt16: spliceToInt16,
    peakEnvelope: peakEnvelope,
    normalizeChannelCount: normalizeChannelCount,
    clampBitrate: clampBitrate,
    encodeMp3: encodeMp3,
    analyze: analyze,
    render: render,
    encodeWav: encodeWav,
    inspectMp3: inspectMp3
  };
});
