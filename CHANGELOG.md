# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/star-12-Bytedance/dsh-llm-profile/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/star-12-Bytedance/dsh-llm-profile/releases/tag/v0.1.0
