# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-05

### Added

- **跨重启统计**：落盘的调用记录现在会被读回，工具新增 `scope` 参数
  （`session` / `today` / `all`），可以回答「今天/这周花在哪」，而不只是当前进程。
- 新增 `coverage` 输出字段：每次都交代结果的覆盖范围（内存多少条、磁盘多少条、
  被淘汰多少条），避免一个局部数字被误读成全局。
- 新增 `sessionId` 参数：只统计某个会话。
- 新增 `rotateBytes` / `keepArchives` 配置：日志轮转与归档清理，不再无限增长。
- 新增 `scripts/test-persistence.mjs`（`npm test`）：持久化与范围语义的回归测试，
  自带隔离的临时 HOME，不污染真实 `~/.dsh`。

### Changed

- 内存记录从数组 `push` + `splice`（每次调用 O(n)）改为有界环缓冲（插入 O(1)）。
  这落在每次模型调用的热路径上，原写法随记录数增长而变慢。
- 磁盘日志改为**增量读取**：只在首次查询时整读，之后只解析新增字节，并按
  「今天 + 昨天」裁剪内存中的历史。代价与新增数据成正比，而非与日志总大小成正比。
- `sinceMinutes` 的描述不再声称「本次进程启动以来」——它现在与其他过滤条件一致地
  作用于所选范围。

### Fixed

- **`render` 在历史记录缺字段时崩溃**：从磁盘读回的旧记录可能没有 `chars` / `tools`
  等字段，`c.chars.toLocaleString()` 会抛 `TypeError` 使整个报告渲染失败。
  现在所有可选指标都有兜底（缺失显示 `?`）。
- JSDoc 里的 `@module` 名称仍是旧的 `@lenovo/`，已更正为实际包名。

## [0.1.0] - 2026-10-05

### Added

- 首个版本。
- 挂载 `llm/stream` 瀑布钩子，逐次记录模型调用的形状，**原样透传**上游流。
- 注册 `llm_cost_breakdown` 工具，支持按 `top` / `purpose` / `provider` / `sinceMinutes` 查询。
- token 归因：新增输入、输出、cache 复用、推理 token 分列。
- 缓存命中率：明确区分「复用的 prompt」与「新增的 prompt」。
- 内部调用拆分：`session-title` / `compaction` 与正文调用分开统计。
- 最贵调用排序与上下文增长曲线。
- 仅追加 JSONL 落盘到 `~/.dsh/llm-profile/calls.jsonl`，不写工作区。
- `scripts/check.mjs` 契约自检，覆盖四个静默失败点。

[Unreleased]: https://github.com/star-12-Bytedance/dsh-llm-profile/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/star-12-Bytedance/dsh-llm-profile/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/star-12-Bytedance/dsh-llm-profile/releases/tag/v0.1.0
