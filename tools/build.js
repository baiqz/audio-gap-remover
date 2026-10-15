/* 把 src/index.html + src/engine.js + src/vendor/lame.min.js 打包成一个自包含单文件 HTML。
 *
 * 输出到仓库根的 index.html —— 这个文件同时是：
 *   1) GitHub Pages 的站点入口（线上打开即用）
 *   2) 离线交付物（双击即用，不需要任何服务器/外链）
 *
 * 因为 Pages 是直接伺服仓库文件、没有 CI 构建步骤，所以产物 index.html 需要提交进仓库。
 * 改完 src/ 里的源码后必须重跑本脚本，否则线上还是旧版。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'index.html');

function inline(file) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  if (code.indexOf('</script') >= 0) throw new Error(file + ' 里出现了 </script，需要转义');
  return '<script>\n' + code + '\n</script>';
}

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

const pairs = [
  ['<script src="engine.js"></script>', inline('engine.js')],
  ['<script src="vendor/lame.min.js"></script>', inline('vendor/lame.min.js')]
];
pairs.forEach(([tag, code]) => {
  if (html.indexOf(tag) < 0) throw new Error('找不到待替换的标签: ' + tag);
  html = html.replace(tag, () => code);
});
if (/<script\s+src=/.test(html)) throw new Error('还有没被内联的外链脚本');
// Pages 把站点挂在 /<repo>/ 子路径下，任何前导斜杠的绝对资源路径都会 404
if (/(?:src|href)\s*=\s*["']\//.test(html)) throw new Error('出现前导斜杠的绝对路径，Pages 子路径下会 404');

fs.writeFileSync(OUT, html, 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log('打包完成 ->', path.relative(ROOT, OUT), kb + ' KB');
console.log('内联脚本数 =', (html.match(/<script>/g) || []).length, '| 外链脚本 =', (html.match(/<script\s+src=/g) || []).length);
