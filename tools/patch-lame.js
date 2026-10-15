/* 给 vendor/lame.min.js 打两处补丁（幂等）：
 * 1) q.quality=3 → 9 ：LAME 在 quality=9 时关闭 psychoacoustic noise shaping，
 *    实测编码速度从 ~3.7 倍速提到 ~8 倍速，CBR 体积不变。
 * 2) q.mode=la.STEREO → JOINT_STEREO ：联合立体声在中低码率下更省带宽、更耐听。
 */
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'src', 'vendor', 'lame.min.js');
let s = fs.readFileSync(P, 'utf8');
const before = s;

if (s.includes('q.quality=3')) s = s.replace('q.quality=3', 'q.quality=9');
else if (!s.includes('q.quality=9')) throw new Error('找不到 quality 赋值点，lamejs 版本可能变了');
if (s.includes('q.mode=la.STEREO')) s = s.replace('q.mode=la.STEREO', 'q.mode=la.JOINT_STEREO');
else if (!s.includes('q.mode=la.JOINT_STEREO')) throw new Error('找不到 mode 赋值点');

fs.writeFileSync(P, s, 'utf8');
console.log('lame.min.js patch:', before === s ? 'already patched' : 'applied',
  '| quality=9 :', s.includes('q.quality=9'), '| joint stereo :', s.includes('q.mode=la.JOINT_STEREO'));
