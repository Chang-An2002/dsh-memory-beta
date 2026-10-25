/**
 * 真机验证用的探针插件。
 *
 * 它不修改被测插件，只是在真实内核里**读事实**：
 *   1. 五个工具是否真的进了 `ctx.tools`（以及参数表是否已被编译成 JSON Schema）；
 *   2. 提示词段落与变量是否登记、order 是否合法；
 *   3. 真实 `systemPrompt.assemble()` + `renderPrompt()` 能否跑完而不抛错。
 *
 * 第 3 条是最关键的一条：按 DSH 的契约，未解析的提示词变量会让**每一次请求**都失败，
 * 而那种错误不会以"插件加载失败"的形式出现。
 *
 * 结果写到 `DSH_MEMORY_PROBE_OUT`（默认 ./probe-out.md）。
 */
import fs from 'node:fs';

export const name = 'dsh-memory-probe';
export const inject = ['tools', 'systemPrompt'];

const TOOL_NAMES = ['kb_index', 'kb_search', 'kb_stats', 'memory', 'memory_search'];
const VARIABLE = 'dsh_memory_long_term';
const SECTION = 'long-term-memory';
const OUT = process.env.DSH_MEMORY_PROBE_OUT ?? 'probe-out.md';

export function apply(ctx) {
  let done = false;

  // 在 apply 期间查注册表读到的是尚未就绪的状态（别的插件可能还没挂载），
  // 所以等内核抛出第一轮插件生命周期事件之后再查。
  const run = (trigger) => {
    if (done) return;
    done = true;

    const out = ['# dsh-memory 真机探针结果', '', `查询时机：${trigger}`, ''];

    out.push('## 1. 工具注册');
    let ok = 0;
    for (const toolName of TOOL_NAMES) {
      let def;
      try {
        def = ctx.tools.get(toolName);
      } catch (error) {
        out.push(`- ${toolName}: 查询抛错 → ${error.message}`);
        continue;
      }
      if (def === undefined) {
        out.push(`- ${toolName}: 缺失`);
        continue;
      }
      ok += 1;
      const compiled = def.parameters?.type === 'object' && def.parameters.properties !== undefined;
      out.push(`- ${toolName}: 已注册 | parameters=${compiled ? 'JSON Schema（已被 defineTool 编译）' : '原始字典（未包装）'} | output.render=${typeof def.output?.render === 'function' ? '有' : '缺失'}`);
    }
    out.push(`合计 ${ok}/${TOOL_NAMES.length}`);

    out.push('', '## 2. 提示词段落');
    let section;
    try {
      section = ctx.systemPrompt.layers?.global?.sections?.get?.(SECTION);
      const variable = ctx.systemPrompt.layers?.global?.variables?.get?.(VARIABLE);
      out.push(`- 段落 ${SECTION}：${section === undefined ? '缺失' : `已登记 order=${JSON.stringify(section.order)}`}`);
      out.push(`- 变量 ${VARIABLE}：${variable === undefined ? '缺失' : `已登记（provider 为 ${typeof variable}）`}`);
    } catch (error) {
      out.push(`- 读取内部层失败（探针手段问题，不算错误）：${error.message}`);
    }

    out.push('', '## 3. 真实 assemble() 与变量求值');
    // 与真实 agent 同形状的上下文：内核里是 { agent, scope: agent }
    const fakeAgent = { session: { header: { cwd: process.cwd() } } };
    Promise.resolve()
      .then(() => ctx.systemPrompt.assemble({ agent: fakeAgent, scope: fakeAgent }))
      .then((assembly) => {
        const value = assembly.variables[VARIABLE];
        out.push(`- assemble 成功，段落数 ${assembly.sections.length}`);
        out.push(`- 变量求值：${typeof value}${typeof value === 'string' ? `，长度 ${value.length}` : ''}`);
        if (typeof value !== 'string') {
          out.push('  **必须是 string**：DSH 对 undefined 值会抛 "has no value for this assembly"');
        }
      })
      .catch((error) => {
        out.push(`- **assemble 抛错**：${error.message}`);
        out.push('  （这是最危险的失败模式：未解析变量会让每一次请求都失败）');
      })
      .finally(() => {
        out.push('', `结论：工具 ${ok === TOOL_NAMES.length ? '全部就绪' : '有缺失'}；段落 ${section === undefined ? '缺失' : '已登记'}`);
        fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
        process.stderr.write('\n[probe] 已写出探针结果\n');
      });
  };

  for (const eventName of ['agent/pre-step', 'step/start', 'internal/plugin']) {
    try {
      ctx.on(eventName, () => run(`事件 ${eventName}`));
    } catch { /* 事件名不存在就跳过 */ }
  }
  setTimeout(() => run('定时器 2.5s'), 2500);
}
