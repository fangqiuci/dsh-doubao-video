# lib/ 只放源码

这个目录里**只允许放 `*.mjs` 源码**，而且每个文件都必须是能 `node --check` 通过的 UTF-8。

**不要在这里留**：

- `*.corrupt` / `*.broken-时间戳` / `*.rebuilt`（2026-10-31 曾在这里堆过 3 份损坏副本，已清理）
- `*.restored.mjs` 这类临时副本 —— 后缀是 `.mjs`，有可能被误 import
- 任何 `.bak` / `.tmp`

备份请放 `../_backup/<文件名>-<yyyyMMdd-HHmm>.mjs`。

> 2026-10-31 事故：PowerShell 用默认 ANSI 编码读写中文源码 → 双重编码 → `index.mjs` 语法损坏。
> 完整记录与恢复办法见仓库根目录的 `RECOVERY-2026-10-31.md`。
