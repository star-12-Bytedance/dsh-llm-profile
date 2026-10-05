/**
 * @lenovo/dsh-llm-profile — 逐次模型调用的 token 归因。
 *
 * 现有的 cost-meter 只给总数；这个插件回答「钱花在哪一步」：
 *   - 每次调用携带多大的上下文（消息数、字符数、工具数、系统提示长度）
 *   - cache 命中比例（cached input 是否真的在省钱）
 *   - 哪一次调用最贵（按 inputTokens 排序）
 *   - 按用途拆分：正文 / 会话标题 / 压缩 —— 内部请求占了多少
 *
 * 实现：包住 `llm/stream` 瀑布钩子，**原样透传**上游流（只读不改），
 * 在旁边统计 chunk 里的 usage / tool-call 并计时。钩子必须返回可迭代对象，
 * 否则会破坏模型调用本身。
 *
 * 落盘：仅追加的 JSONL（~/.dsh/llm-profile/calls.jsonl），不是工作区，
 * 避免 OneDrive 同步churn。写入失败绝不影响模型调用。
 *
 * 必须以命名导出暴露 apply/inject：Loader 的 unwrapExports 会折叠 `export default`
 * 并静默丢掉 inject，导致插件无声失效。
 * @module @lenovo/dsh-llm-profile
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Plugin name shown in the loader tree. */
const name = 'llm-profile';

/** Hard dependencies: the tool registry this plugin contributes to. */
const inject = ['tools'];

/** Deployment configuration, editable from the Settings UI. */
const Config = z.object({
  persist: z
    .boolean()
    .default(true)
    .description('把每次调用的统计追加到 ~/.dsh/llm-profile/calls.jsonl，便于跨进程回溯。'),
  keepInMemory: z
    .number()
    .default(2000)
    .description('内存中保留的最近调用记录条数上限（按会话聚合后的原始行）。'),
  recordMessageSizes: z
    .boolean()
    .default(true)
    .description('是否统计请求大小（消息数/字符数）。关掉可略微降低每次调用的开销。'),
});

/** One recorded model call, with only sizes retained (never message content). */
/**
 * @typedef {object} CallRecord
 * @property {number} at - epoch ms when the call started.
 * @property {number} ms - wall-clock duration.
 * @property {string} sessionId
 * @property {string} provider
 * @property {string} model
 * @property {string} purpose - 'main' | 'session-title' | 'compaction'
 * @property {number} messages
 * @property {number} chars
 * @property {number} tools
 * @property {number} systemChars
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} reasoningTokens
 * @property {number} toolCalls
 * @property {string} finish - finish reason kind
 */

/**
 * Measure a request without retaining any of its content: only counts and sizes.
 * @param options - the frozen GenerateOptions for this call.
 * @param recordSizes - whether to walk the message list at all.
 * @returns the size metrics.
 */
function measureRequest(options, recordSizes) {
  if (!recordSizes) return { messages: 0, chars: 0, tools: 0, systemChars: 0 };
  let chars = 0;
  const messages = Array.isArray(options.messages) ? options.messages : [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (typeof block.text === 'string') chars += block.text.length;
        else if (typeof block.arguments === 'string') chars += block.arguments.length;
      }
    }
  }
  return {
    messages: messages.length,
    chars,
    tools: Array.isArray(options.tools) ? options.tools.length : 0,
    systemChars: typeof options.system === 'string' ? options.system.length : 0,
  };
}

/**
 * Register the `llm_cost_breakdown` tool and install the observation hook.
 * @param ctx - registrant context carrying `tools` and event subscription.
 * @param config - resolved deployment configuration.
 */
function apply(ctx, config) {
  const persist = config.persist ?? true;
  const keepInMemory = config.keepInMemory ?? 2000;
  const recordSizes = config.recordMessageSizes ?? true;

  /** @type {CallRecord[]} */
  const calls = [];
  const dir = join(homedir(), '.dsh', 'llm-profile');
  let dirReady = false;

  /** Append one record to the observation log; failures are never allowed to surface. */
  const persistRecord = (record) => {
    if (!persist) return;
    void (async () => {
      try {
        if (!dirReady) {
          await mkdir(dir, { recursive: true });
          dirReady = true;
        }
        await appendFile(join(dir, 'calls.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      } catch {
        // Observability must never break the call path it observes.
      }
    })();
  };

  ctx.on(
    'llm/stream',
    (options, next) => {
      const startedAt = Date.now();
      const sizes = measureRequest(options, recordSizes);
      const purpose = typeof options.purpose === 'string' ? options.purpose : 'main';
      const sessionId = options.sessionId === undefined ? '' : String(options.sessionId);

      // Return our own generator that forwards every upstream chunk unchanged.
      // Never buffer or reorder: this sits on the hot path of every model call.
      const wrapped = async function* () {
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let reasoningTokens = 0;
        let toolCalls = 0;
        let finish = 'unknown';
        try {
          for await (const chunk of next()) {
            if (chunk !== null && typeof chunk === 'object') {
              if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
                inputTokens = chunk.usage.inputTokens ?? inputTokens;
                outputTokens = chunk.usage.outputTokens ?? outputTokens;
                cacheReadTokens = chunk.usage.cacheReadTokens ?? cacheReadTokens;
                reasoningTokens = chunk.usage.reasoningTokens ?? reasoningTokens;
              } else if (chunk.type === 'tool-call-delta') {
                // Count distinct tool calls, not deltas.
                if (chunk.name !== undefined) toolCalls += 1;
              } else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object') {
                finish = String(chunk.reason.kind ?? 'unknown');
              }
            }
            yield chunk;
          }
        } finally {
          const record = {
            at: startedAt,
            ms: Date.now() - startedAt,
            sessionId,
            provider: String(options.provider ?? ''),
            model: String(options.model ?? ''),
            purpose,
            messages: sizes.messages,
            chars: sizes.chars,
            tools: sizes.tools,
            systemChars: sizes.systemChars,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            reasoningTokens,
            toolCalls,
            finish,
          };
          calls.push(record);
          if (calls.length > keepInMemory) calls.splice(0, calls.length - keepInMemory);
          persistRecord(record);
        }
      };

      return wrapped();
    },
    { global: true },
  );

  ctx.tools.register(
    defineTool({
      name: 'llm_cost_breakdown',
      description:
        'Show where the model tokens and time actually went, per call: context size (messages/chars/tools/system), input & output tokens, cache-read share, reasoning tokens, tool-call count, duration and finish reason. ' +
        'Answers "which step burned the tokens" — the question a total-cost meter cannot. ' +
        'Marks internal calls (session-title, compaction) separately from main turns so you can see how much overhead they add. ' +
        'Read-only observation: it never alters a request or a response. ' +
        '逐次模型调用的 token 归因（上下文规模/cache 命中/内部请求占比/最贵的调用）。',
      parameters: {
        top: {
          type: 'number',
          description: '返回最贵的 N 次调用，按 inputTokens 排序。默认 10。',
        },
        purpose: {
          type: 'string',
          enum: ['main', 'session-title', 'compaction', 'all'],
          description: '只看某一类调用；all 为默认。',
        },
        provider: {
          type: 'string',
          description: '只看某个 provider（例如 deepseek-official）。留空为全部。',
        },
        sinceMinutes: {
          type: 'number',
          description: '只看最近 N 分钟内的调用。留空为本次进程启动以来的全部。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            totals: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                calls: { type: 'integer', required: true },
                inputTokens: { type: 'integer', required: true },
                outputTokens: { type: 'integer', required: true },
                cacheReadTokens: { type: 'integer', required: true },
                reasoningTokens: { type: 'integer', required: true },
                cacheHitPct: { type: 'number', required: true },
                ms: { type: 'integer', required: true },
              },
            },
            byPurpose: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  purpose: { type: 'string', required: true },
                  calls: { type: 'integer', required: true },
                  inputTokens: { type: 'integer', required: true },
                  outputTokens: { type: 'integer', required: true },
                },
              },
            },
            byModel: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  model: { type: 'string', required: true },
                  calls: { type: 'integer', required: true },
                  inputTokens: { type: 'integer', required: true },
                  outputTokens: { type: 'integer', required: true },
                },
              },
            },
            top: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'string', required: true },
                  model: { type: 'string', required: true },
                  purpose: { type: 'string', required: true },
                  inputTokens: { type: 'integer', required: true },
                  outputTokens: { type: 'integer', required: true },
                  cacheReadTokens: { type: 'integer', required: true },
                  reasoningTokens: { type: 'integer', required: true },
                  messages: { type: 'integer', required: true },
                  chars: { type: 'integer', required: true },
                  tools: { type: 'integer', required: true },
                  toolCalls: { type: 'integer', required: true },
                  ms: { type: 'integer', required: true },
                  finish: { type: 'string', required: true },
                },
              },
            },
            intervalGrowth: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'string', required: true },
                  messages: { type: 'integer', required: true },
                  chars: { type: 'integer', required: true },
                  inputTokens: { type: 'integer', required: true },
                  cacheReadTokens: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const t = value.totals;
          const lines = [];
          if (t.calls === 0) {
            return [
              {
                type: 'text',
                text: '本次进程内还没有观察到模型调用。若刚装好插件，先进行一轮对话再查询。',
              },
            ];
          }
          lines.push(`模型调用 ${t.calls} 次 · 输入 ${t.inputTokens.toLocaleString()} · 输出 ${t.outputTokens.toLocaleString()}`);
          lines.push(
            `cache 命中率 ${t.cacheHitPct.toFixed(1)}%（复用 ${t.cacheReadTokens.toLocaleString()} / 新增 ${t.inputTokens.toLocaleString()}） · 推理 ${t.reasoningTokens.toLocaleString()} · 耗时 ${(t.ms / 1000).toFixed(1)}s`,
          );
          if (value.byPurpose.length > 1) {
            lines.push('按用途：');
            for (const p of value.byPurpose) {
              lines.push(`  ${p.purpose}: ${p.calls} 次 · 输入 ${p.inputTokens.toLocaleString()} · 输出 ${p.outputTokens.toLocaleString()}`);
            }
          }
          if (value.byModel.length > 1) {
            lines.push('按模型：');
            for (const m of value.byModel) {
              lines.push(`  ${m.model}: ${m.calls} 次 · 输入 ${m.inputTokens.toLocaleString()} · 输出 ${m.outputTokens.toLocaleString()}`);
            }
          }
          lines.push(`最贵的 ${value.top.length} 次调用：`);
          for (const c of value.top) {
            lines.push(
              `  ${c.at} ${c.model} [${c.purpose}] in ${c.inputTokens.toLocaleString()} / out ${c.outputTokens.toLocaleString()} · cache ${c.cacheReadTokens.toLocaleString()} · 上下文 ${c.messages} 条 ${c.chars.toLocaleString()} 字符 · ${c.tools} 工具 · ${(c.ms / 1000).toFixed(1)}s · ${c.finish}`,
            );
          }
          if (value.intervalGrowth !== undefined && value.intervalGrowth.length > 1) {
            lines.push('上下文增长（main 调用，按时间）：');
            for (const g of value.intervalGrowth) {
              lines.push(`  ${g.at} ${g.messages} 条 ${g.chars.toLocaleString()} 字符 → in ${g.inputTokens.toLocaleString()} (cache ${g.cacheReadTokens.toLocaleString()})`);
            }
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const cutoff =
          Number.isFinite(args.sinceMinutes) && args.sinceMinutes > 0
            ? Date.now() - args.sinceMinutes * 60_000
            : 0;
        const wantPurpose = typeof args.purpose === 'string' ? args.purpose : 'all';
        const wantProvider = typeof args.provider === 'string' ? args.provider : '';

        const rows = calls.filter((call) => {
          if (cutoff !== 0 && call.at < cutoff) return false;
          if (wantPurpose !== 'all' && call.purpose !== wantPurpose) return false;
          if (wantProvider !== '' && call.provider !== wantProvider) return false;
          return true;
        });

        const sum = (list, key) => list.reduce((acc, row) => acc + (row[key] ?? 0), 0);

        const totalInput = sum(rows, 'inputTokens');
        const totalCache = sum(rows, 'cacheReadTokens');

        const group = (key) => {
          const map = new Map();
          for (const row of rows) {
            const name = row[key] === '' ? '(unknown)' : row[key];
            const entry = map.get(name) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
            entry.calls += 1;
            entry.inputTokens += row.inputTokens;
            entry.outputTokens += row.outputTokens;
            map.set(name, entry);
          }
          return [...map.entries()]
            .map(([name, value]) => ({ [key]: name, ...value }))
            .sort((a, b) => b.inputTokens - a.inputTokens);
        };

        const topNumber = Number.isFinite(args.top) && args.top > 0 ? Math.floor(args.top) : 10;

        const result = {
          totals: {
            calls: rows.length,
            inputTokens: totalInput,
            outputTokens: sum(rows, 'outputTokens'),
            cacheReadTokens: totalCache,
            reasoningTokens: sum(rows, 'reasoningTokens'),
            // cacheReadTokens are the reused prompt tokens and inputTokens the fresh
            // ones, so together they are the whole prompt: this ratio is the share of
            // the prompt served from cache, i.e. the cache hit rate.
            cacheHitPct: totalInput + totalCache === 0 ? 0 : (totalCache / (totalInput + totalCache)) * 100,
            ms: sum(rows, 'ms'),
          },
          byPurpose: group('purpose'),
          byModel: group('model'),
          top: [...rows]
            .sort((a, b) => b.inputTokens - a.inputTokens)
            .slice(0, topNumber)
            .map((row) => ({
              at: new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false }),
              model: row.model,
              purpose: row.purpose,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              reasoningTokens: row.reasoningTokens,
              messages: row.messages,
              chars: row.chars,
              tools: row.tools,
              toolCalls: row.toolCalls,
              ms: row.ms,
              finish: row.finish,
            })),
        };

        const mains = rows.filter((row) => row.purpose === 'main');
        if (mains.length > 1) {
          result.intervalGrowth = mains.slice(-12).map((row) => ({
            at: new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false }),
            messages: row.messages,
            chars: row.chars,
            inputTokens: row.inputTokens,
            cacheReadTokens: row.cacheReadTokens,
          }));
        }

        return result;
      },
      presentCall: () => ({
        card: 'generic',
        title: 'llm_cost_breakdown',
        kind: 'read',
        rawInput: '',
      }),
    }),
  );
}

// Loader 读的是命名导出；apply 必须以具名方式导出，否则插件不会装配（且没有任何报错）。
export { Config, apply, inject, name };
