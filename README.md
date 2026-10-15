# 音频去缝器 · Audio Gap Remover

一键剪掉录音里多余的停顿和空白间隙，输出紧凑连贯的 MP3。

**在线使用（免安装，打开就能用）：<https://baiqz.github.io/audio-gap-remover/>**

全程在浏览器本地运行 —— 音频不上传、不落服务器，断网也能用。

## 怎么用

1. 打开上面的链接（或双击本仓库根目录的 `index.html`）
2. 把音频文件拖进页面 —— 松手即开始处理，不用点按钮
3. 每张卡片上：灰色波形是原声，**橙色色带**是判定要剪掉的静音；下方青色波形是成品
4. 想调就调参数，点「用当前参数重跑」；满意后点「下载 MP3」

支持 MP3 / WAV / M4A / AAC / OGG / FLAC / MP4 音轨，可一次拖多个文件批量处理。

## 四个参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 最短停顿 | 0.35s | 短于它的空隙不剪，用来保住自然换气 |
| 保留间隙 | 0.15s | 剪完每句之间保留多久，设 0 就是彻底贴死 |
| 静音阈值 | 自动 | 低于这条线的算静音，也可手动指定 |
| 切点淡化 | 20ms | 剪接处做淡入淡出，防止咔哒声 |

另有四个预设：口播/配音、播客/访谈、网课/会议、狠一点。

## 它在做什么

分帧算音量 → 自动定出一条静音线 → 找出连续低于该线且足够长的段落 → 切掉中间、两端各留一半目标间隙 →
拼接处做 20ms 淡化 → lamejs 编码成 MP3。

两个安全阀：连续音乐（动态范围 < 8dB）直接不剪；切点落在静音里，所以淡化不会啃到字头。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | **构建产物 + 站点入口**：自包含单文件（engine 与 lamejs 已内联） |
| `src/index.html` | 界面源码（外链 engine.js 与 vendor） |
| `src/engine.js` | 纯逻辑引擎，UMD 写法，浏览器与 Node 共用同一份 |
| `src/vendor/lame.min.js` | MP3 编码器（已打补丁，见下） |
| `tools/build.js` | 打包脚本：`src/` → 根 `index.html` |
| `tools/patch-lame.js` | 给 lamejs 打补丁（幂等） |
| `verify/` | 三套验证脚本 |

> GitHub Pages 直接伺服仓库文件、没有 CI 构建步骤，所以产物 `index.html` 需要提交进仓库。
> **改完 `src/` 后必须重跑 `node tools/build.js`，否则线上还是旧版。**

## 开发与验证

```bash
node tools/build.js              # 打包（改完 src/ 必跑）

node verify/test-engine.js       # 1/3 引擎单测（含带底噪录音、连续素材等真实场景）
node verify/verify-ui.js         # 2/3 DOM 桩跑整页主流程（默认 src/index.html）
node verify/verify-ui.js index.html   #    再对打包产物跑一遍
node verify/edge-selftest.js     # 3/3 无头 Edge 真机端到端 + 截图
```

第三套会在页面里合成音频跑完整流水线，再把产出的 MP3 解回来复检「空隙是否真的没了」，
并截一张图供目检版式。

## 给 lamejs 打的两处补丁

1. `quality=3 → 9`：LAME 在 quality=9 时会关闭心理声学噪声整形，编码速度从约 3.7 倍速提到约 8 倍速，CBR 体积不变
2. `STEREO → JOINT_STEREO`：中低码率下更省带宽

另外修了它 MP3 帧解析表里 Layer III / Layer II 混用的一处错（原版会把帧数少数到约 1/3）。

## 许可

MIT，见 [LICENSE](LICENSE)。
