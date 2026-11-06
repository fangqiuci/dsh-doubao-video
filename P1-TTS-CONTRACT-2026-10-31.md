# P1 交接文档 v2：TTS 适配器接口约定（已定稿）

> v1 的 5 处与实测不符已按 `P1-CONTRACT-REVIEW-2026-10-31.md` 全部修正，另加 2 条主作者补充。
> 状态：**定稿**。三方照此实现，不再口头对齐。
> 日期：2026-10-31 · 主作者签

---

## 一、已定的事

| 项 | 决定 |
|---|---|
| TTS 插件 | `@memef1f1y/dsh-plugin-tts` 0.6.7，隔离目录 + junction + patch entry |
| P1 音色 | `zh-CN-XiaoyiNeural`（Edge TTS），`provisional: true` |
| 辞辞模型 | 在 A 电脑，本机不可用 → 先 Edge 占位 |
| 混音默认 | `replace`（音效必须按脚本「音效」字段后期补） |
| 字幕排轴 | ffprobe 实测 wav 时长，`end = min(start+dur+0.30, nextStart-0.08)` |

---

## 二、上游接口（实测，不是猜的）

**两步链路**：

```
① POST {BASE}/dsh-tts-api/speak
   body: { text, provider:"edge-tts", voice, prosody:{ rate:"+0%" } }
   → 200 { "url": "/dsh-tts-audio/<id>", "cached"?: true }

② GET {BASE}/dsh-tts-audio/<id>
   → 200  MP3 · 24kHz · 单声道
```

**BASE 端口不许硬编码**：实测当前是 `127.0.0.1:53055`，但本次会话中曾出现 58097。
适配器按顺序取：`DSH_WEB_PORT` 环境变量 → 探活 `53055` / `58097` → 都失败报 `E_TTS_UNREACHABLE`。

**字段规则（踩过的坑）**：

- `prosody` 只接受**带符号百分比字符串**：`"+10%"` ✅；`1` ❌ → 500 `SSML is invalid`
- 顶层没有 `rate`，写了会被**静默忽略**（还返回 `cached:true`，容易被骗）
- `/dsh-tts-api/*` 与 `/dsh-tts-audio/*` 在 loopback **不需要鉴权**
- 同一 `text+voice+prosody` 命中缓存；改顶层 `rate` 不会 miss

---

## 三、adapter 对外接口

```js
await synth({ text, voice?, rate?, trimSilence?, out })
// → { ok, path, durationSec, trimmedSec, bytes } | { ok:false, code, message }

await probeAudio(path)  // → { ok, durationSec, sampleRate, channels, lufs }
await health()          // → { ok, edge, rvc, base }
```

**后处理必须做**（顺序固定）：
1. GET 下来的 MP3
2. `silenceremove=start_periods=1:start_threshold=-40dB:stop_periods=1:stop_threshold=-40dB`
3. `-ar 48000 -ac 1` → wav
4. 量**裁静音后**的时长

**主作者补充 ①**：`trimSilence` 默认 `true`，但允许关——有些台词需要开头留气口，一刀切会把表演感裁掉。

**主作者补充 ②**：**不 import 它的包**，只走 HTTP。它升级/卸载都不影响我们。

---

## 四、产物与命名

```
~/.dsh/doubao-video/audio/<项目>-seg<N>-voice.wav
~/.dsh/doubao-video/audio/<项目>-seg<N>-fx.wav      (P2)
~/.dsh/doubao-video/audio/<项目>-bgm.wav            (P2)
~/.dsh/doubao-video/subtitles/<项目>.srt            (P2)
```

一律 48kHz 单声道；**不覆盖豆包原始 clip**，混音另存 `<项目>-seg<N>-mixed.mp4`。

> 重采样只是统一规格，**不是提升音质**，文档里不许写成"提升"。

---

## 五、时长门槛（量裁静音后的）

```
≤ 9.70s        → 通过
9.70–10.00s    → 通过 + warn（贴边，混音可能被切）
> 10.00s       → ❌ E_VOICE_TOO_LONG，要求改台词或提速（rate 最多 +10%）
绝不静默截断。
```

---

## 六、`voices.json`

```json
{ "辞辞": { "engine": "edge", "voice": "zh-CN-XiaoyiNeural",
            "provisional": true,
            "note": "RVC 模型在 A 电脑，本机先用统一 Edge 音色占位",
            "since": "2026-10-31" } }
```

升级到 RVC 只改 `engine` / 加 `endpoint`/`model`/`index`，**调用方一行不改**。

---

## 七、验收（v1 自相矛盾，已拆开）

| 类型 | 内容 | 归属 |
|---|---|---|
| **离线**（进 gate-all） | ffmpeg 造 15s wav → 走时长校验纯逻辑 → 必须报 `E_VOICE_TOO_LONG`；再造 3s wav 验证 `silenceremove` 生效 | `scripts/audio-selftest.mjs` |
| **真机**（人工，发版前） | 真合成一句 3 秒台词、听一遍、记时长与是否命中缓存 | 写进 `RECOVERY` 真机表 |

**理由**：Edge 断网/插件没起时，离线准入线不能红一片。

---

## 八、待办（v1 里两条已完成，划掉）

- ~~修复同学：准入线加第 6 条~~ → **已完成**：`gate-all` 里有 `audio-selftest` 槽位，文件不存在就跳过，一出现自动生效
- ~~修复同学：`_backup` 覆盖 `lib/tts.mjs`~~ → **已完成**：`make-manifest` 已扩到 `lib/`+`scripts/` 共 15 个文件

**剩**：

| 谁 | 待办 |
|---|---|
| 我 | `lib/tts.mjs` + `doubao_tts` 工具 + `voices.json` 初始化 |
| 助手 3 | 确认 client 半是否注入（GUI 上有没有朗读按钮/语音设置页） |
| 修复同学 | `audio-selftest.mjs` 的离线两条 |

---

## 九、确认栏

- **主作者**：✅ 同意 v2 全部内容，按此实现。 2026-10-31
- **助手 3**：______
- **修复同学**：✅ 已复核（实测出处见 `P1-CONTRACT-REVIEW-2026-10-31.md`）· 2026-10-31 14:58
