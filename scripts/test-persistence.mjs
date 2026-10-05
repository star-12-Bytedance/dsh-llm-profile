/**
 * 持久化与范围语义的回归测试。
 *
 * 这些行为是契约自检（check.mjs）覆盖不到的：check.mjs 只证明插件能装配、
 * 空数据不炸，证明不了「重启后读得回历史」「内存有界」「坏行不致命」。
 *
 * 运行方式（必须通过包装脚本设置隔离的 HOME，否则会污染真实的 ~/.dsh）：
 *   node scripts/test-persistence.mjs
 * 脚本会自己建临时 HOME 并把它传给子进程，所以直接跑也是安全的。
 *
 * 退出码：0 全部通过，1 有失败。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// 由 `--child <tmpHome>` 标记进入子进程模式；否则本进程就是包装器。
const childIndex = process.argv.indexOf('--child');
if (childIndex === -1) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-llmprof-'));
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', fakeHome], {
      stdio: 'inherit',
      env: { ...process.env, TEST_FAKE_HOME: fakeHome, USERPROFILE: fakeHome, HOME: fakeHome },
    });
    p.on('exit', (c) => resolve(c ?? 1));
  });
  await rm(fakeHome, { recursive: true, force: true });
  process.exit(code);
}

const fakeHome = process.argv[childIndex + 1];
if (!fakeHome) {
  console.error('缺少临时 HOME 参数');
  process.exit(1);
}

const mod = await import(new URL('../index.js', import.meta.url).href);

let failures = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => {
  failures += 1;
  console.error(`  \u2717 ${m}`);
};

const makeCtx = () => {
  const state = { tool: undefined, hook: undefined };
  return {
    state,
    ctx: {
      tools: { register: (def) => { state.tool = def; } },
      on: (event, fn) => { if (event === 'llm/stream') state.hook = fn; return () => {}; },
    },
  };
};

const config = { persist: true, keepInMemory: 3, recordMessageSizes: true, rotateBytes: 0, keepArchives: 2 };

/** Drive one simulated model call through the hook and let its accounting settle. */
async function simulateCall(state, { sessionId, inputTokens, outputTokens, cacheRead }) {
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId,
    messages: [{ role: 'user', content: 'x'.repeat(10) }],
    tools: [{ name: 'a' }],
    system: 'sys',
  };
  const chunks = [
    { type: 'tool-call-delta', id: 'c1', name: 'grep' },
    { type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens: cacheRead } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  const stream = state.hook(options, () => (async function* () {
    for (const c of chunks) yield c;
  })());
  let seen = 0;
  for await (const _ of stream) seen += 1;
  // Distinct `at` per call, otherwise the de-duplication key merges them — which is
  // correct behaviour but makes these assertions meaningless.
  await new Promise((r) => setTimeout(r, 5));
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 300));

console.log('持久化与范围语义\n');

// ---- 1. 写入并落盘 ----
console.log('实例 1：产生并落盘');
const a = makeCtx();
mod.apply(a.ctx, config);
for (const n of [1, 2, 3]) {
  await simulateCall(a.state, { sessionId: 'sess-A', inputTokens: 100 * n, outputTokens: 10 * n, cacheRead: 1000 * n });
}
await settle();
const r1 = await a.state.tool.execute({ scope: 'session' });
r1.totals.calls === 3 ? ok('scope=session 计到 3 次') : bad(`scope=session 应为 3，实际 ${r1.totals.calls}`);
r1.totals.inputTokens === 600 ? ok('输入合计 600') : bad(`输入应为 600，实际 ${r1.totals.inputTokens}`);

const { readFile, writeFile } = await import('node:fs/promises');
const logPath = join(fakeHome, '.dsh', 'llm-profile', 'calls.jsonl');
const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l !== '');
lines.length === 3 ? ok('calls.jsonl 落了 3 行') : bad(`应为 3 行，实际 ${lines.length}`);
lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })
  ? ok('每行都是合法 JSON')
  : bad('存在非法 JSON 行');

// ---- 2. 新实例读回历史（模拟重启）----
console.log('\n实例 2：新实例读回历史');
const b = makeCtx();
mod.apply(b.ctx, config);
const r2s = await b.state.tool.execute({ scope: 'session' });
r2s.totals.calls === 0 ? ok('scope=session 不读盘') : bad(`scope=session 应为 0，实际 ${r2s.totals.calls}`);
const r2t = await b.state.tool.execute({ scope: 'today' });
r2t.totals.calls === 3 ? ok('scope=today 读回 3 次历史') : bad(`scope=today 应为 3，实际 ${r2t.totals.calls}`);
r2t.totals.inputTokens === 600 ? ok('历史输入合计 600') : bad(`历史输入应为 600，实际 ${r2t.totals.inputTokens}`);
r2t.coverage.persistedRows === 3 ? ok('coverage 报告 3 条磁盘记录') : bad(`persistedRows 应为 3，实际 ${r2t.coverage.persistedRows}`);

// ---- 3. 内存 + 历史不重复计数 ----
console.log('\n实例 2：内存与历史合并，不重复计数');
await simulateCall(b.state, { sessionId: 'sess-B', inputTokens: 50, outputTokens: 5, cacheRead: 500 });
await settle();
const r2m = await b.state.tool.execute({ scope: 'today' });
r2m.totals.calls === 4 ? ok('内存 1 + 历史 3 = 4，无重复') : bad(`应为 4，实际 ${r2m.totals.calls}`);
r2m.totals.inputTokens === 650 ? ok('输入 600+50=650') : bad(`输入应为 650，实际 ${r2m.totals.inputTokens}`);

// ---- 4. 环缓冲有界，保留最新 ----
console.log('\n环缓冲（keepInMemory=3，写 5 次各不相同）');
const c = makeCtx();
mod.apply(c.ctx, config);
for (let i = 1; i <= 5; i += 1) {
  await simulateCall(c.state, { sessionId: 'sess-C', inputTokens: 10 * i, outputTokens: i, cacheRead: 0 });
}
const r3 = await c.state.tool.execute({ scope: 'session' });
r3.totals.calls === 3 ? ok('内存只留 3 条') : bad(`内存应留 3 条，实际 ${r3.totals.calls}`);
r3.totals.inputTokens === 30 + 40 + 50 ? ok('保留的是最新 3 条（120）') : bad(`应留最新 3 条=120，实际 ${r3.totals.inputTokens}`);
r3.coverage.evictedFromMemory === 2 ? ok('淘汰计数 2') : bad(`淘汰计数应为 2，实际 ${r3.coverage.evictedFromMemory}`);

// ---- 5. 坏行与半行不致命 ----
console.log('\n容错：坏行与半行');
const d = makeCtx();
mod.apply(d.ctx, config);
await writeFile(
  logPath,
  '{"at":1,"sessionId":"x","model":"m","purpose":"main","inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"reasoningTokens":0,"ms":1}\n' +
    'NOT JSON\n{"at":2,"partial',
  'utf8',
);
const r4 = await d.state.tool.execute({ scope: 'all' });
r4.totals.calls === 1 ? ok('坏行与半行被跳过，读到 1 条好记录') : bad(`应读到 1 条，实际 ${r4.totals.calls}`);
// 缺字段的历史行不能让渲染抛错
const rendered = d.state.tool.output.render({}, r4);
rendered[0]?.text?.length > 0 ? ok('缺字段的记录渲染不抛错') : bad('渲染失败');

console.log(failures === 0 ? '\n结果：全部通过' : `\n结果：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
