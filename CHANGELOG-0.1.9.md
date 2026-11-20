# 0.1.9 更新说明（2026-11-20）

> 主题：**环境适配**——让"换一台机器也能跑"。
> 修复同学实测发现：本机全绿，但在别人的机器上第一台就卡住。

## 一、三项环境适配（都是用户真实踩到的）

### ① ffmpeg 能力探测（最重要）

**现象**：用户机器是 ffmpeg 4.1（2018），没有 xfade。转场直接失败，用户看到的是一段英文原文：
`
[Parsed_xfade_18] const_values array too small for transition
Not yet implemented in FFmpeg, patches welcome
`

**现在**：
- doubao_selfcheck 多一行 **「ffmpeg 转场能力」**：xfade 可用 / 缺 xfade
- concatCut 前置拦截，返回 E_FFMPEG_NO_XFADE + 中文提示：
  「两条路：① 升级 ffmpeg 到 4.3+；② 把 transition 设为 none（全片硬切，其余功能不受影响）」

### ② 浏览器：Edge → Chrome 都找

**现象**：rowser.mjs 只硬编码 Edge 的三个路径；换台只有 Chrome 的机器，9333 没监听就起不来。

**现在**：新增 chromePath() + rowserPath()（Edge 优先、Chrome 兜底），都找不到才报错。

### ③ ASR 解释器优先级

**现象**：系统 Python 常常是干净的（只有 pip），而 DSH 运行时自带的 Python 往往已装 faster-whisper，插件没优先用它。

**现在**：候选顺序明确「DSH 运行时优先，系统 Python 兜底」。

### ④ 上传口懒挂载（真机新发现）

**现象**：页面停在首页 https://www.doubao.com/chat（没进会话）时，input[type=file] 数量是 **0**，
rowser_stage 直接等 30 秒超时 —— **新用户第一次用必踩**。

**修法**：
1. 先点输入框触发挂载
2. 等 ttached（最长 60s，不再是默认 30s）
3. 还不行就点「＋」再等一轮
4. 仍失败时给**可执行提示**：\先手动点进任意一个对话，再重跑本工具\

**selfcheck 同步**：首页时「页面指纹」只提示不判 ❌（上传口本来就不该在首页存在）。

### ⑤ 空白片检测 E_CLIP_BLANK（真机新发现）

**现象**：豆包会返回**整段全黑、只剩水印**的片子（303 KB / 10.08s / YAVG 16）。
以前插件只验时长和文件存在 → clip_register 报 ✅，黑片直接进成片，还会污染下一段首帧。

**现在两道拦截**：
1. capture 落盘后立刻判 —— 黑就删文件、返回 E_CLIP_BLANK，提示"直接重试本段"
2. clip_register 再判一次 —— 手工登记黑片也会被拒

**判据**：lackdetect 累计黑时长占比 ≥70%，或平均亮度 YAVG < 25。

实测：全黑片 blank=true（黑 9.96s / YAVG 16）；正常片 blank=false（YAVG 126）。

### ⑥ 相邻重复字幕合并（真机新发现）

**现象**：同一句被 ASR 切成 2–3 条、时间首尾相接，播起来像角色结巴：
`
4.6–6.4 你给我把话说清楚 / 6.3–7.7 你给我摆清楚 / 7.7–9.4 你给我把话清楚
`

**修法**：mergeSimilarCues() —— 时间相接（间隔 ≤0.4s）+ 文本相似（二元组 ≥0.4）→ 合成一条，
时间取首尾、文本取更完整的那句。

实测：4 条 → **2 条**（4.6–9.4 / 17.6–19.7），合并掉 2 条。

## 二、验证

`
五条准入        全绿
sim-run-017     25/25
其余 4 套模拟    0 失败
selfcheck       38/38
实测            hasFilter('xfade')=true、browserPath() 能认出 Edge
`

## 三、0.1.8 已确认可用的（本版没动）

脚本确认码（4 位码，一次性）· 对话单角色拒绝 · 外部图 external 闸 · TTS 端口可配 · 三视图一致性清单 · README 安装章节
