# 0.1.4 更新说明（2026-11-04）

> 主题：**让"量产"这件事能连续跑，而不是跑一条就有人盯着改一句。**
> 验证：10 个模拟脚本 103 项断言全过 + 修复同学真机 24 秒片跑通 + 五条离线准入全绿。

---

## 一、新增功能（14 项）

### A. 画面一致性

| # | 功能 | 入口 | 解决什么 |
|---|---|---|---|
| 1 | **风格锁写进提示词** | `styleBlock()` / 所有 `shot_check` | 风格锁以前只存在项目里，提示词一个字都没有 → 每段豆包自由发挥 |
| 2 | 风格锁**三档强度** | `styleBlockMode`: `soft`/`strict`/`off` | 不是所有片子都需要"不得改变" |
| 3 | 风格锁**自定义**：标题 / `extra` 字段 / `custom` 自由文本 / `forbidden` 数组 | `doubao_style_lock` | 做水墨、国潮、真人题材时不能被写死的话术绑住 |
| 4 | **人物比例锁** `characterScale` + 自动防变形 | `doubao_style_lock` | 真机出现人物被压扁、头身比忽大忽小 |
| 5 | **构图** `framing` | `doubao_style_lock` | 人物居中偏左/视线方向这类要求以前没地方写 |
| 6 | **审计闸**：设了比例却没写「人物比例：」→ 打回 | `doubao_prompt_audit` | 光记在插件里没用，平台只认提示词 |
| 7 | **关键帧回拉**：第 5 段起强制带第 1 段尾帧 | `doubao_shot_check` | 长片人物越飘越远 |

### B. 剪辑

| # | 功能 | 入口 |
|---|---|---|
| 8 | **转场** `transition` / `transitionMs`（fade / dissolve / wipeleft / slideleft / … 全 xfade 类型） | `doubao_concat` |
| 9 | **去重叠** `overlapMs`（默认 40ms）—— 上一段尾帧=下一段首帧，硬拼会重复一帧 | `doubao_concat` |
| 10 | **按段粗剪** `cuts`（start / trimEnd），也可写进 `clip.trimStart/trimEnd` | `doubao_concat` |
| 11 | **16:9 横屏**：`resolveWH` 支持 16:9 / 9:16 / 1:1 / 4:3 / 3:4，提示词+拼接同步 | `style_lock` / `concat` |
| 12 | **集号命名** `episode` → `<项目>-EP<集>-<WxH>.mp4` | `doubao_concat` |
| 13 | 允许缺段 `allowPartial` | `doubao_concat` |

### C. 后期

| # | 功能 | 入口 |
|---|---|---|
| 14 | **按节奏配音** `doubao_dub`：时间轴按脚本每段时长+分镜顺序累计；`mode=replace`（TTS 重配+ BGM）/ `mode=keep`（沿用豆包原声，只加 BGM+字幕） | 新工具 |
| 15 | **BGM 归档** `doubao_bgm`：用户在 QQ 发音频 → `qq_save_attachment` 收下 → `doubao_bgm(add)` 归档 → `doubao_dub(bgm:"雨夜")` 按名字引用 | 新工具 |
| 16 | **批量出图** `doubao_image_batch`：一次 N 段提示词、串行出图、落 `assets/images/img-01.png` | 新工具 |

### D. 工程

| # | 功能 | 入口 |
|---|---|---|
| 17 | **重试闸**：自动重试 1 次，之后必须本人说「确定重试」 | `doubao_browser_send` |
| 18 | **片段元数据 sidecar**：登记时写 `<名>.json`（模型/提示词/参数/重试/hash） | `doubao_clip_register` |
| 19 | **断点续跑指引**：`status` 显示「断点：第 N 段已发送」+ 下一步命令 | `doubao_status` |
| 20 | **片段去重**：同项目内 hash 相同 → `E_CLIP_DUPLICATE` | `doubao_clip_register` |
| 21 | **开机自检**：`status` 顶部显示 Node / ffmpeg / Playwright 状态 | `doubao_status` |

---

## 二、修复的 bug（9 个）

| # | bug | 后果 | 来源 |
|---|---|---|---|
| 1 | `doubao_concat` 传 `episode` 时 TDZ：`Cannot access 'width' before initialization` | 一传集号就崩 | 修复同学真机 |
| 2 | `doubao_tts` 必崩：`slug is not defined`（只解构了 `c`） | 语音工具完全不可用 | 修复同学真机 |
| 3 | TTS 写文件前没建 `audio/` 目录 → ENOENT 被吞、误报 `E_TTS_UNREACHABLE` | 把"写文件失败"误诊成"网络不通" | 修复同学真机 |
| 4 | concat（转场分支）输出 **yuv444p** `High 4:4:4 Predictive` | 手机/微信/部分播放器**直接放不出来** | 修复同学真机 |
| 5 | `style_lock` 收了 `characterScale` 却**没存进锁** | 比例锁从来没生效过 | 内部发现 |
| 6 | `writeFileSync` 未导入 | 元数据写盘静默失败 | 内部发现 |
| 7 | 风格块用 `【】` 撞审计 `E_PLACEHOLDER` | 全流程卡死 | 内部发现 |
| 8 | 批量替换把 `styleBlockMode` 误插 5 处（3 处在 `checkVideo` 里） | 运行时会炸 | 内部发现 |
| 9 | `-shortest` 按最短音轨截断 → 10 秒片配两条 1 秒配音变成 4.3 秒 | 成片被截短 | 内部发现 |

---

## 三、验收口径

```powershell
node scripts/gate-all.mjs        # 五条离线准入
node scripts/release-check.mjs   # 8 项发布体检
```

模拟矩阵（103 项）：

```
cut-16x9-sim 13 · transition-sim 8 · style-flex-sim 10 · scale-sim 10
retry-sim 6 · three-sim 11 · dub-sim 11 · bgm-sim 10 · pixfmt-sim 6 · flow-sim 18
```

真机（修复同学 2026-11-04）：

```
3 段 × 8 秒 = 24 秒片，G0→G7 全 PASS，attempts 为空
产物：film25-EP1-1080x1920.mp4（转场/集号/元数据/字幕全正常）
```

---

## 四、已知未覆盖

| 项 | 状态 |
|---|---|
| 转场 xfade 真机 | 只有模拟证据（`transition-sim` 8/8），真机跑的时候没用上 |
| `readyNoMedia`（豆包说生成好了但页面无媒体） | 代码已加，未触发 |
| BGM QQ 收歌链路 | 桥接已加端点+工具，**需重启桥接验证** |
| 端口 / 会员模型切换 | 依赖豆包侧，无法离线验证 |
