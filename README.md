# dsh-llm-profile

> DeepSeek Harness (DSH) 插件的**逐次模型调用 token 归因**。
> 费用统计告诉你**花了多少**；这个插件告诉你**花在哪一步**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)

---

## 它解决什么问题

`dsh-cost-meter` 这类插件给你一个总数：这次会话 0.42 元。但当你看到这个数字时，你无法回答：

- 是**上下文太胖**（每次都携带几十万 token 的 prompt），还是**输出太多**？
- **cache 命中率**到底多少？我的 prompt 复用策略真的在省钱吗？
- 有多少钱花在**你根本没要求的调用**上（会话标题生成、上下文压缩）？
- 哪一次调用是异常贵的？是它把上下文撑爆的吗？

`dsh-llm-profile` 挂住 `llm/stream` 瀑布钩子，记录**每一次**模型调用的形状，然后回答上面每一问。

## 真实观测示例

在一次普通对话里调用 `llm_cost_breakdown`，得到的就是这种数据：

```
模型调用 1 次 · 输入 814 · 输出 452
cache 命中率 99.6%（复用 208,000 / 新增 814） · 推理 0 · 耗时 3.8s
最贵的 1 次调用：
  21:18:33 deepseek-flash [main] in 814 / out 452 · cache 208,000
  · 上下文 237 条消息 693,421 字符 · 60 工具 · 3.8s · finish: tool-calls
```

一眼可见的三件事：

1. **新增输入只有 814 token，但 prompt 实际有 20.8 万** —— 你看到的 `inputTokens` 是不含缓存的新增部分，不是上下文大小。只看它会把成本模型理解错。
2. **上下文 69 万字符 / 237 条消息 / 60 个工具定义** —— 这才是真正驱动缓存读取和延迟的东西。
3. **99.6% 命中率** —— 缓存策略工作得很好，钱确实省下来了。

这种「分布」而非「总数」的信息，是费用计量器给不了的。

## 功能

| 能力 | 说明 |
| --- | --- |
| 逐次调用记录 | 上下文消息数 / 字符数 / 工具数 / 系统提示长度 |
| token 归因 | 新增输入、输出、cache 复用、推理 token 分列 |
| 缓存命中率 | 明确区分「复用的 prompt」与「新增的 prompt」 |
| 内部调用拆分 | `session-title` / `compaction` 与正文调用分开统计，看清内部开销占比 |
| 最贵调用排序 | 按输入 token 排序，直接定位异常调用 |
| 上下文增长曲线 | 按时间顺序看上下文如何膨胀 |
| **跨重启统计** | 记录落盘并可读回，`scope=today/all` 能回答「今天/这周花在哪」，而不是只看当前进程 |
| **统计范围自述** | 每次结果都带 `coverage`，明确告诉你这个数字覆盖了内存多少条、磁盘多少条、是否被淘汰过 |
| 完全只读 | 原样透传上游流，**从不修改请求或响应** |
| 本地落盘 | 只追加 JSONL 写到 `~/.dsh/llm-profile/calls.jsonl`，**不写工作区**（避免云盘同步churn） |
| 日志轮转 | 超过 `rotateBytes` 自动归档并清理旧归档，不会无限增长 |

## 安装

```bash
dsh plugin --profile <你的profile> add @star-12-bytedance/dsh-llm-profile
```

或从本地目录安装（开发用）：

```bash
dsh plugin --profile <你的profile> add /absolute/path/to/dsh-llm-profile
```

装完**先核对配置层再启动**，否则容易把「没挂载」误判成「插件有 bug」：

```bash
dsh --profile <你的profile> --dump-config   # 确认能看到 llm-profile 这一行
dsh --profile <你的profile>
```

## 使用

插件注册一个工具 `llm_cost_breakdown`，直接让模型调用即可，参数全部可选：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `top` | number | 返回最贵的 N 次调用，按输入 token 排序，默认 10 |
| `purpose` | string | `main` / `session-title` / `compaction` / `all`（默认） |
| `provider` | string | 只看某个 provider，例如 `deepseek-official` |
| `sinceMinutes` | number | 只看最近 N 分钟 |
| `scope` | string | `session`（默认，仅本次进程）/ `today`（+ 今天已落盘历史）/ `all`（+ 所有仍可读历史） |
| `sessionId` | string | 只统计某个 DSH 会话 |

### 关于 `scope`——这个参数很重要

默认的 `session` **只统计当前进程**，因为内存里的计数最快也最准。但「今天花了多少」「这周花在哪」这类问题跨天、跨重启，必须用 `today` 或 `all`：

```
llm_cost_breakdown(scope="today")   # 今天的全部调用，含重启前的
llm_cost_breakdown(scope="all")     # 所有仍可读的历史
```

每次返回都带一个 `coverage` 字段，如实交代这个数字的来源：

```
coverage: {
  scope: "today",
  inMemory: 12,          // 本次进程内记录
  persistedRows: 347,    // 从磁盘读回的历史
  evictedFromMemory: 0,  // 因内存上限被丢弃的条数
  note: "已合入磁盘历史（347 条）；写入失败或超出归档保留期的记录不在其中。"
}
```

**为什么要有这个字段**：一个成本数字如果不说明覆盖范围，就容易被误读成「全部」。宁可啰嗦，也不让你拿着半份数据做判断。

也可以直接问模型，例如：

- 「帮我看看这个会话的 token 都花在哪了」
- 「今天一共花了多少？和昨天比呢？」（会走 `scope=today`）
- 「哪几次调用最贵？」
- 「cache 命中率怎么样？」
- 「会话标题生成花了多少开销？」

## 配置

在 DSH 设置界面或 profile patch 里可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `persist` | `true` | 是否把统计追加到 `~/.dsh/llm-profile/calls.jsonl`。关掉后 `scope=today/all` 会退化成本次进程 |
| `keepInMemory` | `2000` | 内存中保留的最近记录条数（有界环缓冲，超出即淘汰最旧） |
| `recordMessageSizes` | `true` | 是否统计请求大小；关掉可避免每次调用遍历消息列表 |
| `rotateBytes` | `10485760` | 日志超过该字节数时轮转归档；`0` 表示不轮转 |
| `keepArchives` | `5` | 最多保留多少个归档文件，超出从最旧删除 |

## 设计取舍

- **只观测，不干预。** 钩子返回自己的生成器，逐块透传上游 chunk，不缓冲、不重排、不修改。它坐在每次模型调用的热路径上，任何额外开销都必须是常数级。
- **内存有界且插入 O(1)。** 用环缓冲而不是数组 `push` + `splice`——后者每次调用都是 O(n)，而这里每次模型调用都会走一遍。
- **历史增量读取。** 磁盘日志只在首次查询时读一次，之后只解析**新增的字节**，并按「今天 + 昨天」裁剪内存中的历史。代价与新增数据成正比，而不是与日志总大小成正比。
- **不保留对话内容。** 只记录计数与尺寸（消息数、字符数、工具数），不落盘任何消息正文。
- **观测失败不能影响被观测者。** 落盘、轮转、读回全部吞掉异常——统计出问题绝不能让模型调用失败。
- **坏行不致命。** 崩溃时写到一半的最后一行、以及外部改坏的日志，都会被跳过而不是抛错；跨版本缺字段的旧记录在渲染时走 `?` 兜底。
- **`inputTokens` 语义。** 上游报告的是**不含缓存的新增**输入，缓存复用单列在 `cacheReadTokens`。因此命中率的分母是两者之和。

## 兼容性

- 需要 DSH 的 `tools` 服务（`inject: ['tools']`）。
- 依赖 `llm/stream` 瀑布事件，该事件在 DSH `0.2.0-rc.2` 上验证可用。
- 纯 ESM，无运行时依赖（peer 依赖由 DSH 提供）。

## 开发

```bash
git clone https://github.com/star-12-Bytedance/dsh-llm-profile.git
cd dsh-llm-profile
npm run check        # 插件契约与装配（四个静默失败点）
npm test             # 持久化与范围语义的回归测试
npm run pack:check   # 检查将要发布的文件清单
```

### `npm run check` 验证的四件事

这四件都是 DSH 插件的**静默失败点**——错了不报错，只是插件无声失效：

1. `apply` / `inject` / `Config` / `name` 以**命名导出**暴露（`export default` 会被 Loader 的 `unwrapExports` 折叠并静默丢掉 `inject`）
2. 没有 `export default`
3. 工具能注册，参数规格能规范化
4. 空数据下 `execute` 与 `render` 不抛错

### `npm test` 验证的行为

契约自检覆盖不到「重启后读得回历史」这类行为，所以单列了这个测试：

1. 调用能落盘，且每行都是合法 JSON
2. 新实例（模拟重启）能用 `scope=today` 读回历史
3. `scope=session` 不读盘
4. 内存与历史合并不重复计数
5. 环缓冲有界且保留最新
6. 坏行、半行、缺字段记录不会导致抛错

测试自己创建隔离的临时 `HOME` 并传给子进程，**不会污染真实的 `~/.dsh`**。

## License

[MIT](LICENSE) © 2026 star-12-Bytedance
