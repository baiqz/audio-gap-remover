/* ============================================================
 * 真浏览器验证（无头 Edge + CDP，真实时钟）：
 *   1) 打开 dist 单文件页（?selftest=1），等页内自检把报告写进 #selftestOut
 *   2) 断言自检结果
 *   3) 顺手截一张整页 PNG，用来目检版式
 * 为什么不用 --virtual-time-budget：虚拟时钟与 decodeAudioData 的后台线程冲突，
 * 页面经常在解码回调回来之前就被 dump 掉了（实测非确定性失败）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET = process.argv[2] || path.join(ROOT, 'index.html');
const PORT = 9333 + (Number(process.argv[3]) || 0);
const SHOT = path.join(__dirname, 'selftest-shot.png');
const LOG = [];
const say = (...a) => LOG.push(a.map(String).join(' '));
const REPORT = path.join(__dirname, 'report-edge.txt');
const flush = () => { try { fs.writeFileSync(REPORT, LOG.join('\n') + '\n', 'utf8'); } catch (e) {} };
process.on('exit', flush);
process.on('uncaughtException', e => { say('UNCAUGHT: ' + (e && e.stack || e)); flush(); process.exit(1); });

let fail = 0;
function ok(cond, label, extra) {
  if (cond) say('  PASS  ' + label);
  else { fail++; say('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

async function main() {
  const url = toUrl(TARGET) + '?selftest=1';
  say('=== 无头 Edge 真机验证 ===');
  say('  目标 =', url);
  const userDir = path.join(require('os').tmpdir(), 'edge-gapremover-' + PORT);
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', '--no-first-run',
    '--disable-extensions', '--window-size=1400,2400',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, url
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const arr = await r.json();
      const pg = arr.filter(t => t.type === 'page' && t.url.indexOf('gap-remover') >= 0)[0] || arr.filter(t => t.type === 'page')[0];
      if (pg && pg.webSocketDebuggerUrl) { list = pg; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!list) { child.kill(); say('  无法连上调试端口，Edge 可能没起来'); return finish(); }
  say('  已连上页面:', list.url.slice(0, 80));

  const ws = new WebSocket(list.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  const send = (method, params) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text };
    return { value: r.result && r.result.result ? r.result.result.value : undefined, err: r.result && r.result.exceptionDetails };
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // 等页内自检报告
  let rep = null;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = await evaluate("(document.getElementById('selftestOut')||{}).textContent || ''");
    const raw = r.value;
    if (raw) {
      try { const j = JSON.parse(raw); if (j.done) { rep = j; break; } } catch (e) { }
    }
  }
  const titleR = await evaluate("document.title");
  say('  页面 title =', titleR.value || '(空)');
  if (!rep) {
    const partial = await evaluate("(document.getElementById('selftestOut')||{}).textContent || ''");
    say('  自检未完成，半成品报告 =', String(partial.value).slice(0, 800));
    const st = await evaluate("(document.querySelector('.st')||{}).textContent || ''");
    say('  卡片状态 =', st.value);
    await shoot(send, SHOT);
    ws.close(); child.kill();
    return finish();
  }

  say('  自检步骤：');
  (rep.steps || []).forEach(s => say('    ' + s));
  say('  报告：orig=' + rep.origDuration + 's out=' + rep.outDuration + 's cuts=' + rep.cuts +
    ' mp3=' + rep.mp3Bytes + 'B frames=' + rep.mp3Frames + ' br=' + rep.mp3Kbps + ' decoded=' + rep.decodedDuration + 's');
  ok(!rep.error, '自检无异常', rep.error);
  ok(rep.cuts === 4, '浏览器里识别出 4 段静音', rep.cuts);
  ok(Math.abs(rep.outDuration - 3.6) < 0.15, '输出时长 ≈3.6s', rep.outDuration);
  ok(rep.mp3Kbps === 128000, 'MP3 码率 128kbps', rep.mp3Kbps);
  ok(rep.mp3Frames > 120, 'MP3 帧数正常', rep.mp3Frames);
  ok(rep.decodedDuration > 3.35 && rep.decodedDuration < 3.95, '成品 MP3 解回来的时长 ≈3.6s', rep.decodedDuration);
  ok(rep.recheckInternal === 2, '成品里只剩 2 处段间停顿', rep.recheckInternal);
  ok(rep.badGaps === 0, '没有 >=0.25s 的残留长停顿', rep.badGaps);
  ok(rep.recheckMaxGap < 0.2, '最长停顿 <0.2s', rep.recheckMaxGap);
  ok(rep.ok === true, '页面自检总判定 PASS');
  ok(rep.ok1 === true, '阶段1 无损 WAV 往返 PASS', rep.ok1);
  ok(rep.ok2 === true, '阶段2 有底噪 MP3 输入 PASS', rep.ok2);
  if (rep.mp3inCuts !== undefined) {
    ok(rep.mp3inCuts === 3, 'MP3 输入里 3 段空隙都找到', rep.mp3inCuts);
    ok(Math.abs(rep.mp3inOut - 2.65) < 0.12, 'MP3 输入输出 ≈2.65s', rep.mp3inOut);
  } else {
    fail++; say('  FAIL  MP3 输入阶段没有产出数据（阶段2 未跑完）');
  }

  // 顺手确认卡片 UI 状态
  const st = await evaluate("(document.querySelector('.st')||{}).textContent || ''");
  const meta = await evaluate("((document.querySelector('.meta')||{}).innerText)||''");
  const dlDis = await evaluate("((document.querySelector('.b-dl')||{}).disabled)");
  const canv = await evaluate("[].map.call(document.querySelectorAll('canvas'), c=>c.width+'x'+c.height).join(',')");
  say('  卡片状态 =', st.value);
  say('  卡片摘要 =', String(meta.value).replace(/\s+/g, ' '));
  say('  canvas 尺寸 =', canv.value);
  ok(st.value === '完成', '卡片显示「完成」', st.value);
  ok(dlDis.value === false, '下载按钮可用', dlDis.value);
  ok(/0:03\.6/.test(String(meta.value)), '摘要里输出时长 0:03.6', String(meta.value).slice(0, 60));
  const canvList = String(canv.value).split(',').filter(Boolean);
  const canvOk = canvList.filter(s => /^[1-9]\d*x[1-9]\d*$/.test(s)).length;
  ok(canvList.length >= 2 && canvOk === canvList.length, '所有波形 canvas 都画上了尺寸（' + canvList.length + ' 块）', canv.value);

  // 顺便验证一下「原始音频」播放器真的指向文件
  const srcs = await evaluate("[].map.call(document.querySelectorAll('audio'), a=>a.getAttribute('src')).join(' | ')");
  ok(String(srcs.value).indexOf('blob:') === 0, '两个 <audio> 都挂上了 blob 源', String(srcs.value).slice(0, 60));

  await shoot(send, SHOT);
  ws.close();
  child.kill();
  await sleep(300);
  return finish();
}

async function shoot(send, file) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    say('  截图已保存:', path.relative(ROOT, file), (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  } else {
    say('  截图失败:', JSON.stringify(shot).slice(0, 200));
  }
}

function finish() {
  say('');
  say(fail === 0 ? '>>> 全部通过' : '>>> 失败 ' + fail + ' 项');
  flush();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { say('ERROR ' + (e && e.stack || e)); finish(); });
