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
| 完全只读 | 原样透传上游流，**从不修改请求或响应** |
| 本地落盘 | 只追加 JSONL 写到 `~/.dsh/llm-profile/calls.jsonl`，**不写工作区**（避免云盘同步churn） |

## 安装

```bash
dsh plugin --profile <你的profile> add @xinghe-source/dsh-llm-profile
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

也可以直接问模型，例如：

- 「帮我看看这个会话的 token 都花在哪了」
- 「哪几次调用最贵？」
- 「cache 命中率怎么样？」
- 「会话标题生成花了多少开销？」

## 配置

在 DSH 设置界面或 profile patch 里可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `persist` | `true` | 是否把统计追加到 `~/.dsh/llm-profile/calls.jsonl` |
| `keepInMemory` | `2000` | 内存中保留的最近记录条数 |
| `recordMessageSizes` | `true` | 是否统计请求大小；关掉可略微降低每次调用开销 |

## 设计取舍

- **只观测，不干预。** 钩子返回自己的生成器，逐块透传上游 chunk，不缓冲、不重排、不修改。它坐在每次模型调用的热路径上，任何额外开销都必须是常数级。
- **不保留对话内容。** 只记录计数与尺寸（消息数、字符数、工具数），不落盘任何消息正文。
- **观测失败不能影响被观测者。** 落盘异步执行且吞掉异常——统计写失败绝不能让模型调用失败。
- **`inputTokens` 语义。** 上游报告的是**不含缓存的新增**输入，缓存复用单列在 `cacheReadTokens`。因此命中率的分母是两者之和。

## 兼容性

- 需要 DSH 的 `tools` 服务（`inject: ['tools']`）。
- 依赖 `llm/stream` 瀑布事件，该事件在 DSH `0.2.0-rc.2` 上验证可用。
- 纯 ESM，无运行时依赖（peer 依赖由 DSH 提供）。

## 开发

```bash
git clone https://github.com/Xinghe-Source/dsh-llm-profile.git
cd dsh-llm-profile
npm run check        # 校验插件契约与装配
npm run pack:check   # 检查将要发布的文件清单
```

`npm run check` 会验证四件事，这四件都是 DSH 插件的**静默失败点**：

1. `apply` / `inject` / `Config` / `name` 以**命名导出**暴露（`export default` 会被 Loader 的 `unwrapExports` 折叠并静默丢掉 `inject`）
2. 没有 `export default`
3. 工具能注册，参数规格能规范化
4. 空数据下 `execute` 与 `render` 不抛错

## License

[MIT](LICENSE) © 2026 Xinghe-Source
