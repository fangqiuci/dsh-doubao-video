# dsh-doubao-video

把《大肥鱼豆包制作视频》那份 SOP 里**写了但没人能验**的部分，做成 DSH 里一串会真的拦人的闸门。

原来的文档全靠「必须严格遵守」「系统需要进行检验」，但没有一条能落成字段 —— 所以永远打回不了。
这个插件把每个环节要交的东西变成结构化数据，交的瞬间就判定 PASS / FAIL，并说清楚差在哪。

## 它拦什么

| Gate | 环节 | 判据（机器检查的） |
|---|---|---|
| G0 | 风格锁 | `artStyle` / `palette` 必须先在写脚本之前锁定；没有锁，脚本直接不收 |
| G1 | 脚本 | 每段 10 秒 · 每段 ≥3 分镜 · 12 字段写满 · 无「例如/XXX/【】」占位 · 表情细节 ≠ 感情细节 · 有台词就不许再铺旁白 · 相邻两段不许逐字重复 · `styleRef` 必须等于锁 |
| G2 | 角色卡 | 角色名必须在脚本里 · `kind` 必须是 `reference`（杂志设定卡直接拒）· 有文件/外貌/服装 |
| G3 | 场景卡 | 场景名不许带景别（`土屋中景` ✗）· 画面里不许有人 |
| G4 | 生成前 | 风格锁 + 该镜头所有角色参考图 + 场景卡 + 上一段尾帧齐备；齐了才吐提示词**和上传清单** |
| G4.5 | 提示词审计 | 对着**最终要粘的那段文字**查：@ 齐全、12 字段与脚本逐字一致、上传清单不缺图、无模板残留 |
| G4.6 | 生成确认 | 本人明确说「确定生成视频」**且** `auditHash` 对得上；不接受"可以了/继续" |
| G5 | 片段 | 成片 10 秒 · 尾帧取在段末 · **从确认到登记 5–10 分钟**；超 10 分钟判不正常，这段作废 |
| G6 | 重试 | 同一闸门最多 3 次，第 4 次要求本人确认 |

## 工具

- `doubao_status` —— 看进度与下一步（每次开新会话先跑）
- `doubao_style_lock` —— 锁全片美术基准（**必须先于写脚本**）
- `doubao_script_submit` —— 提交分镜 JSON，机器校验
- `doubao_role_register` —— 登记角色参考图（设定卡 / 参考图强制分开）
- `doubao_scene_register` —— 登记场景卡
- `doubao_shot_check` —— 生成前闸门，给出**上传清单**+整段可粘贴提示词，状态置为「待审计」
- `doubao_prompt_audit` —— 审计真正要粘贴的文本 + 已上传文件清单；通过才发 `auditHash`
- `doubao_generate_confirm` —— 本人说「确定生成视频」+ `auditHash` 后放行，开始计时
- `doubao_clip_register` —— 登记成片与尾帧，同时校验 5–10 分钟窗口
- `doubao_gate_table` —— 打印判定条件总表

## 安装

```powershell
# A. 走 CLI（会写进 profile 的 dsh.profile.bundles，需要重启 DSH）
D:\DeepSeek\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:$DSH_HOME\plugins\dsh-doubao-video

# B. 或者手工挂到热重载层（不用重启，但别和 A 同时做，会重复 entry）
#    在 $DSH_HOME\profiles\desktop\cordis.patch.yml 里加：
#    - id: doubao-video
#      name: dsh-doubao-video
#      config: { strict: true }
```

两种方式都需要 profile 的 `node_modules` 里能解析到 `dsh-doubao-video`（CLI 会自己建链接）。

## 状态放哪

`$DSH_HOME/doubao-video/projects/<项目名>.json` —— 一个项目一个文件，能直接看、直接改、能 diff；
同名 `.log` 里每次判定追加一行。文件坏了不会被静默清空，而是改名成 `.broken-<时间戳>` 留着。

## 自测

```powershell
node scripts/selfcheck.mjs   # 23 条规则单测
node scripts/smoke.mjs       # 端到端跑一遍：锁风格→脚本→角色→场景→生成→登记
```

## 已知边界

- 它**不生成**脚本、不调豆包、不碰图片。它只判定，以及在通过时把提示词拼好。
- 输入是「豆包按第 1 节提示词产出的成稿」，插件不替模型写内容。
- 判定是规则级（字段/时长/命名/一致性），不管"这段戏好不好看"——那是人的事。

---

## 音色：开箱即用，想换要先沟通

- **默认音色**：`zh-CN-XiaoyiNeural`（Edge TTS），无需任何配置，装完即可出片。
- **想换音色**：不是改个配置就行 —— 需要**先联系大肥鱼**，单独沟通、调试后再由本机写进 `voices.json`。
  插件里没有"上传音频自动克隆"的入口，这是刻意为之。
- 自定义音色的素材授权与合规责任，由使用者自行承担。

详见 `VOICE-POLICY-2026-10-31.md`。

## AI 生成内容标识

本插件用于生产 AI 生成视频。**成片必须带显式的 AI 生成标识**，
并遵守所在平台与地区的相关规定。本插件不代为标注，请使用者自行落实。