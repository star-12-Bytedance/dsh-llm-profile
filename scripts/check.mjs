/**
 * 契约自检：把这四个 DSH 插件的静默失败点钉死。
 *
 * 这些错误的共同点是**不报错**——插件看上去装好了，实际什么都没做：
 *   1. 只用 `export default` → Loader 的 unwrapExports 折叠它并丢掉 `inject`
 *   2. 漏掉命名导出 → apply 从未被调用
 *   3. 工具参数规格无法被 defineTool 规范化
 *   4. 空数据下 execute / render 抛错 → 第一次真实调用才炸
 *
 * 前两项不需要任何依赖即可验证，因此这个脚本在 CI 里也能跑。
 * 靠后的装配检查在能解析 `@deepseek-ai/*` 时才执行（本地已安装 DSH 时）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'index.js');

let failures = 0;
const pass = (msg) => console.log(`  \u2713 ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};

console.log('DSH 插件契约自检\n');

// ---- 1. 静态检查：导出形态 ----------------------------------------------
// 先做纯文本检查，这样即使依赖解析不了也能拦住最常见的错误。
console.log('静态检查');

/**
 * 去掉注释后再做文本匹配。这个检查脚本自己就会在文档里提到
 * `export default` 这个词，不剥离注释会把自己判成违规。
 * @param text - 源码全文。
 * @returns 注释被替换成空白的源码，保留原有换行以便定位。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

const source = await readFile(entry, 'utf8');
const code = stripComments(source);

if (/export\s+default\b/.test(code)) {
  fail('发现 `export default` —— Loader 会折叠它并静默丢掉 inject');
} else {
  pass('没有 export default');
}

const exportStatement = /export\s*\{([^}]*)\}/.exec(code);
const exportedNames = exportStatement === null
  ? []
  : exportStatement[1].split(',').map((name) => name.trim()).filter((name) => name !== '');

for (const required of ['apply', 'inject', 'name']) {
  if (exportedNames.includes(required)) pass(`命名导出包含 ${required}`);
  else fail(`命名导出缺少 ${required} —— 插件不会装配`);
}

// ---- 2. 运行时检查：真实加载 ---------------------------------------------
console.log('\n运行时检查');
let mod;
try {
  mod = await import(new URL('../index.js', import.meta.url).href);
} catch (error) {
  fail(`模块无法加载：${error.code ?? ''} ${error.message.split('\n')[0]}`);
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      '    → 裸导入解析不到。本地开发时在插件目录建一个指向 DSH node_modules 的软链：\n' +
        '      mklink /J node_modules "<DSH>/resources/app/dsh/node_modules"   (Windows)\n' +
        '      ln -s "<DSH>/resources/app/dsh/node_modules" node_modules      (macOS/Linux)',
    );
  }
  console.error(`\n结果：${failures} 项失败`);
  process.exit(1);
}

if (typeof mod.apply === 'function') pass('apply 是可调用的函数');
else fail(`apply 类型为 ${typeof mod.apply}，应为 function`);

if (Array.isArray(mod.inject)) pass(`inject 是数组：${JSON.stringify(mod.inject)}`);
else fail('inject 不是数组');

if (mod.name === undefined || mod.name === '') fail('name 为空');
else pass(`name = ${mod.name}`);

if (mod.default === undefined) pass('运行时无 default 导出');
else fail('运行时存在 default 导出');

// ---- 3. 装配检查：注册工具 + 空态执行 ------------------------------------
console.log('\n装配检查');
let tool;
let hooked = false;
try {
  mod.apply(
    {
      tools: { register: (definition) => { tool = definition; } },
      on: (event) => { if (event === 'llm/stream') hooked = true; return () => {}; },
    },
    { persist: false, keepInMemory: 10, recordMessageSizes: true },
  );
  pass('apply 执行无异常');
} catch (error) {
  fail(`apply 抛错：${error.message}`);
}

if (hooked) pass('llm/stream 钩子已挂载');
else fail('未挂载 llm/stream 钩子');

if (tool !== undefined) {
  pass(`工具已注册：${tool.name}`);

  const properties = tool.output?.schema?.properties;
  if (properties !== undefined && Object.keys(properties).length > 0) {
    pass(`输出 schema 有 ${Object.keys(properties).length} 个字段`);
  } else {
    fail('输出 schema 为空 —— 模型拿不到结构化结果');
  }

  try {
    const empty = await tool.execute({});
    pass(`空数据 execute 正常：calls=${empty?.totals?.calls}`);
    const rendered = tool.output.render({}, empty);
    if (typeof rendered?.[0]?.text === 'string' && rendered[0].text !== '') {
      pass('空数据 render 返回了文本');
    } else {
      fail('空数据 render 未返回文本');
    }
  } catch (error) {
    fail(`空数据 execute/render 抛错：${error.message}`);
  }
} else {
  fail('未注册任何工具');
}

console.log(failures === 0 ? '\n结果：全部通过' : `\n结果：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
