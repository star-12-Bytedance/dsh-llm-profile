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
 * @module @star-12-bytedance/dsh-llm-profile
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFile, mkdir, readFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Plugin name shown in the loader tree. */
const name = 'llm-profile';

/** Hard dependencies: the tool registry this plugin contributes to. */
const inject = ['tools'];

/** Local-time `YYYY-MM-DD` key, used to decide whether a record falls on today. */
function localDay(ms) {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Format a possibly-missing counter.
 *
 * Records read back from disk may predate a field, or omit it when size recording was
 * off, so rendering must tolerate `undefined` instead of throwing on `.toLocaleString`.
 * @param value - the counter, or anything non-numeric.
 * @returns a localized number, or `?` when the value is not a usable number.
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '?';
}

/** Deployment configuration, editable from the Settings UI. */
const Config = z.object({
  persist: z
    .boolean()
    .default(true)
    .description('把每次调用的统计追加到 ~/.dsh/llm-profile/calls.jsonl，便于跨进程回溯。'),
  keepInMemory: z
    .number()
    .default(2000)
    .description('内存中保留的最近调用记录条数上限。'),
  recordMessageSizes: z
    .boolean()
    .default(true)
    .description('是否统计请求大小（消息数/字符数）。关掉可避免每次调用遍历消息列表。'),
  rotateBytes: z
    .number()
    .default(10 * 1024 * 1024)
    .description('calls.jsonl 超过该字节数时轮转归档，避免无限增长。0 表示不轮转。'),
  keepArchives: z
    .number()
    .default(5)
    .description('最多保留多少个轮转归档文件，超出的从最旧的开始删除。'),
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
  const rotateBytes = config.rotateBytes ?? 10 * 1024 * 1024;
  const keepArchives = config.keepArchives ?? 5;

  const dir = join(homedir(), '.dsh', 'llm-profile');
  const logPath = join(dir, 'calls.jsonl');
  const archivePrefix = 'calls-';
  let dirReady = false;

  // Bounded ring buffer. Never `splice`: that is O(n) per call, and this sits on
  // the hot path of every model call. Written slots hold records; unread ones stay
  // null, and `buffered` bounds the traversal.
  /** @type {(CallRecord|null)[]} */
  const ring = new Array(Math.max(1, keepInMemory)).fill(null);
  let ringCursor = 0;
  let buffered = 0;
  /** If the process wrote more records than the ring holds, the oldest are gone. */
  let evicted = 0;

  /** Oldest-first snapshot of the in-memory records. */
  function bufferedRecords() {
    const out = [];
    if (buffered < ring.length) {
      for (let i = 0; i < buffered; i++) out.push(ring[i]);
      return out;
    }
    for (let i = 0; i < ring.length; i++) out.push(ring[(ringCursor + i) % ring.length]);
    return out;
  }

  /**
   * Historical records read back from disk.
   *
   * Read once and cached; a later call re-reads only the bytes appended since, so
   * the cost is proportional to new data rather than to the whole log. This is what
   * lets the tool answer "where did this week's tokens go" across restarts, which an
   * in-memory-only counter cannot.
   */
  /** @type {CallRecord[]} */
  let history = [];
  let historyLoaded = false;
  let historyBytes = 0;
  let historyDay = null;

  function parseLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const record = JSON.parse(line);
        if (record !== null && typeof record === 'object' && typeof record.at === 'number') out.push(record);
      } catch {
        // A torn final line (crash mid-append) is expected; skip it.
      }
    }
    return out;
  }

  /** Drop history older than today plus the previous day, so memory stays bounded. */
  function trimHistory() {
    if (history.length === 0) return;
    const today = localDay(Date.now());
    const yesterday = localDay(Date.now() - 86_400_000);
    if (historyDay === today && history.length > 0) {
      const firstKept = history.findIndex((r) => {
        const d = localDay(r.at);
        return d === today || d === yesterday;
      });
      // -1 means every record is older than the window.
      history = firstKept === -1 ? [] : history.slice(firstKept);
      historyDay = today;
    }
  }

  /** Append newly written bytes to the cached history. Best-effort: never throws. */
  async function loadHistory() {
    try {
      const info = await stat(logPath);
      if (info.size < historyBytes) {
        // The log was rotated or truncated under us: start over from empty.
        history = [];
        historyBytes = 0;
      }
      if (info.size === historyBytes) return;
      const text = await readFile(logPath, 'utf8');
      // Parse only the portion we have not read yet; keep the trailing partial
      // line unparsed so a concurrent append is not misread as corrupt.
      const fresh = text.slice(historyBytes);
      const lastNewline = fresh.lastIndexOf('\n');
      if (lastNewline >= 0) {
        history.push(...parseLines(fresh.slice(0, lastNewline)));
        historyBytes += lastNewline + 1;
      }
      historyLoaded = true;
      trimHistory();
      if (historyDay === null) historyDay = localDay(Date.now());
    } catch {
      // Missing log (nothing persisted yet) or an unreadable one: history stays as is.
      historyLoaded = true;
    }
  }

  /** Rotate the log once it exceeds `rotateBytes`, keeping the newest archives. */
  async function rotateIfNeeded() {
    if (rotateBytes <= 0) return;
    try {
      const info = await stat(logPath);
      if (info.size < rotateBytes) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await rename(logPath, join(dir, `${archivePrefix}${stamp}.jsonl`));
      history = [];
      historyBytes = 0;
      const archives = (await readdir(dir))
        .filter((f) => f.startsWith(archivePrefix) && f.endsWith('.jsonl'))
        .sort();
      for (const stale of archives.slice(0, Math.max(0, archives.length - keepArchives))) {
        await unlink(join(dir, stale));
      }
    } catch {
      // Rotation is housekeeping; a failure must not affect the observation path.
    }
  }

  /** Append one record to the observation log; failures are never allowed to surface. */
  const persistRecord = (record) => {
    if (!persist) return;
    void (async () => {
      try {
        if (!dirReady) {
          await mkdir(dir, { recursive: true });
          dirReady = true;
        }
        await rotateIfNeeded();
        await appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
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
          // O(1) insert; the oldest slot is overwritten once the ring is full.
          if (buffered === ring.length) evicted += 1;
          ring[ringCursor] = record;
          ringCursor = (ringCursor + 1) % ring.length;
          if (buffered < ring.length) buffered += 1;
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
          description: '只看最近 N 分钟内的调用。留空为全部。',
        },
        scope: {
          type: 'string',
          enum: ['session', 'today', 'all'],
          description:
            '统计范围。session=仅本次进程（默认）；today=本次进程 + 今天已落盘的历史；all=本次进程 + 所有仍可读的历史记录。跨天或跨重启的问题要用 today/all。',
        },
        sessionId: {
          type: 'string',
          description: '只统计某个 DSH 会话的调用。留空为全部会话。',
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
            coverage: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                scope: { type: 'string', required: true },
                inMemory: { type: 'integer', required: true },
                persistedRows: { type: 'integer', required: true },
                evictedFromMemory: { type: 'integer', required: true },
                note: { type: 'string', required: true },
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
                text:
                  `范围内没有观察到模型调用（scope=${value.coverage.scope}）。\n` +
                  `${value.coverage.note}`,
              },
            ];
          }
          lines.push(
            `范围 ${value.coverage.scope}（内存 ${value.coverage.inMemory} 条 + 磁盘 ${value.coverage.persistedRows} 条）`,
          );
          lines.push(`模型调用 ${num(t.calls)} 次 · 输入 ${num(t.inputTokens)} · 输出 ${num(t.outputTokens)}`);
          const hitPct = typeof t.cacheHitPct === 'number' ? t.cacheHitPct.toFixed(1) : '0.0';
          const seconds = (typeof t.ms === 'number' ? t.ms / 1000 : 0).toFixed(1);
          lines.push(
            `cache 命中率 ${hitPct}%（复用 ${num(t.cacheReadTokens)} / 新增 ${num(t.inputTokens)}） · 推理 ${num(t.reasoningTokens)} · 耗时 ${seconds}s`,
          );
          if (value.byPurpose.length > 1) {
            lines.push('按用途：');
            for (const p of value.byPurpose) {
              lines.push(`  ${p.purpose}: ${num(p.calls)} 次 · 输入 ${num(p.inputTokens)} · 输出 ${num(p.outputTokens)}`);
            }
          }
          if (value.byModel.length > 1) {
            lines.push('按模型：');
            for (const m of value.byModel) {
              lines.push(`  ${m.model}: ${num(m.calls)} 次 · 输入 ${num(m.inputTokens)} · 输出 ${num(m.outputTokens)}`);
            }
          }
          lines.push(`最贵的 ${value.top.length} 次调用：`);
          for (const c of value.top) {
            // Historical rows can predate a field (or omit it when recordMessageSizes
            // was off), so every optional metric gets a fallback: a missing counter
            // must not turn the whole report into a TypeError.
            const ctxParts = [];
            if (typeof c.messages === 'number') ctxParts.push(`${c.messages} 条`);
            if (typeof c.chars === 'number') ctxParts.push(`${c.chars.toLocaleString()} 字符`);
            if (typeof c.tools === 'number') ctxParts.push(`${c.tools} 工具`);
            // Divide the RAW number: num() returns a display string with thousands
            // separators, and arithmetic on it yields NaN.
            const callSeconds = typeof c.ms === 'number' ? (c.ms / 1000).toFixed(1) : '?';
            lines.push(
              `  ${c.at} ${c.model} [${c.purpose}] in ${num(c.inputTokens)} / out ${num(c.outputTokens)}` +
                ` · cache ${num(c.cacheReadTokens)}` +
                (ctxParts.length > 0 ? ` · 上下文 ${ctxParts.join(' ')}` : '') +
                ` · ${callSeconds}s · ${c.finish ?? 'unknown'}`,
            );
          }
          if (value.intervalGrowth !== undefined && value.intervalGrowth.length > 1) {
            lines.push('上下文增长（main 调用，按时间）：');
            for (const g of value.intervalGrowth) {
              const size = typeof g.chars === 'number' ? `${g.chars.toLocaleString()} 字符` : '字符数未知';
              const count = typeof g.messages === 'number' ? `${g.messages} 条` : '条数未知';
              lines.push(
                `  ${g.at} ${count} ${size} → in ${num(g.inputTokens)} (cache ${num(g.cacheReadTokens)})`,
              );
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
        const scope = typeof args.scope === 'string' ? args.scope : 'session';

        // session = this process only (what the ring holds).
        // today   = ring merged with today's persisted rows.
        // all     = ring merged with every persisted row still readable.
        const merged = [...bufferedRecords()];
        let historyUsed = false;
        let historyRows = 0;
        if (scope !== 'session' && persist) {
          await loadHistory();
          historyUsed = true;
          const todayKey = localDay(Date.now());
          for (const row of history) {
            if (scope === 'today' && localDay(row.at) !== todayKey) continue;
            merged.push(row);
            historyRows += 1;
          }
        }

        const wantSession = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : '';

        // The ring may contain a row the log also has (written this process); de-duplicate
        // so `today`/`all` do not double count the same call.
        const seen = new Set();
        const rows = merged.filter((call) => {
          const key = `${call.at}\u0000${call.sessionId}\u0000${call.model}\u0000${call.inputTokens}\u0000${call.outputTokens}`;
          if (seen.has(key)) return false;
          seen.add(key);
          if (cutoff !== 0 && call.at < cutoff) return false;
          if (wantPurpose !== 'all' && call.purpose !== wantPurpose) return false;
          if (wantProvider !== '' && call.provider !== wantProvider) return false;
          if (wantSession !== '' && call.sessionId !== wantSession) return false;
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
          coverage: {
            scope,
            inMemory: buffered,
            persistedRows: historyRows,
            evictedFromMemory: evicted,
            note:
              scope === 'session'
                ? '仅统计本次进程内的调用；用 scope=today 或 all 可以看到跨天/跨重启的历史。'
                : historyUsed
                  ? `已合入磁盘历史（${historyRows} 条）；写入失败或超出归档保留期的记录不在其中。`
                  : 'persist 已关闭，只能统计本次进程内的调用。',
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
