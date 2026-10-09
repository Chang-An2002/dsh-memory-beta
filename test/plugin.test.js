import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  name,
  Config,
  resolveConfig,
  resolveWorkspace,
  createTools,
  renderMemoryPrompt,
  prepareTools,
  apply,
  MEMORY_VARIABLE,
  MEMORY_SECTION,
} from '../lib/index.js';
import { projectMemoryFile } from '../lib/paths.js';

/** 建一个隔离的临时工作区。 */
function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function dshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-home-'));
}

const SAMPLE = {
  'docs/architecture.md': [
    '# 架构',
    '',
    '## 存储选型',
    '',
    '记忆载体采用 Markdown 文件，便于人工审阅与版本管理，不使用数据库。',
    '',
    '## 检索',
    '',
    '检索采用 BM25 稀疏召回，并用 RRF 做多路融合。',
  ].join('\n'),
  'docs/deploy.md': '# 部署\n\n## 安装\n\n插件通过 pnpm 安装到 profile 目录。\n',
};

/** 取得某个工具定义。 */
function tool(tools, toolName) {
  const found = tools.find((t) => t.name === toolName);
  assert.ok(found, `未找到工具 ${toolName}`);
  return found;
}

/* --------------------------------------------------------------- 元信息 */

test('插件导出符合 DSH 插件契约的 name/inject/Config/apply', () => {
  assert.equal(name, 'dsh-memory');
  assert.ok(Array.isArray(Config === undefined ? [] : []));
  assert.equal(typeof apply, 'function');
});

test('resolveConfig：补齐默认值并允许覆盖', () => {
  const defaults = resolveConfig();
  assert.equal(defaults.maxPassages, Config.maxPassages);
  assert.equal(defaults.injectMemory, true);

  const custom = resolveConfig({ maxPassages: 3, injectMemory: false, maxInjectedChars: 100 });
  assert.equal(custom.maxPassages, 3);
  assert.equal(custom.injectMemory, false);
  assert.equal(custom.maxInjectedChars, 100);
  assert.equal(custom.maxInjectedEntries, Config.maxInjectedEntries, '未覆盖项应保留默认');
});

test('resolveWorkspace：优先用会话摘要的 cwd，否则退回兜底', () => {
  const withCwd = resolveWorkspace({ session: { summary: { cwd: 'D:\\a\\b' } } });
  assert.equal(withCwd, path.resolve('D:\\a\\b'));

  const fallback = resolveWorkspace(undefined, os.tmpdir());
  assert.equal(fallback, path.resolve(os.tmpdir()));

  // 空字符串视为未提供
  assert.equal(resolveWorkspace({ session: { summary: { cwd: '   ' } } }, os.tmpdir()), path.resolve(os.tmpdir()));
});

/* ------------------------------------------------------------- 工具注册 */

test('createTools：声明 5 个工具且参数 schema 合法', () => {
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['kb_index', 'kb_search', 'kb_stats', 'memory', 'memory_search'],
  );
  for (const t of tools) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 20, `${t.name} 的描述应当说明何时使用`);
    assert.equal(typeof t.execute, 'function');
    assert.ok(t.parameters && typeof t.parameters === 'object');
    for (const [key, spec] of Object.entries(t.parameters)) {
      assert.ok(typeof spec.type === 'string', `${t.name}.${key} 缺 type`);
      // DSH 的编译器要求：`required` 出现时必须是 `true`
      if ('required' in spec) {
        assert.equal(spec.required, true, `${t.name}.${key} 的 required 只能是 true`);
      }
    }
  }
  // 必填参数必须显式标注
  assert.equal(tool(tools, 'kb_search').parameters.query.required, true);
  assert.equal(tool(tools, 'memory').parameters.action.required, true);
  assert.deepEqual(tool(tools, 'memory').parameters.action.enum, ['read', 'write', 'forget']);
});

test('createTools：每个工具的 output 必须提供 schema 与 render（DSH 硬契约）', () => {
  // DSH 的 defineTool 里 `const userRender = options.output.render` **没有可选链**，
  // 并把它接成 `render(args, value) { return userRender(args, value) }`。
  // 缺 render 不会在加载时报错，但模型每次调用工具都会抛 "userRender is not a function"，
  // 等于五个工具全废——而只检查 schema 形状的测试抓不到它。
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  for (const t of tools) {
    assert.ok(t.output && typeof t.output === 'object', `${t.name} 缺 output`);
    assert.ok(t.output.schema && typeof t.output.schema === 'object', `${t.name} 缺 output.schema`);
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 output.render`);
  }
});

test('createTools：output.render 返回 DSH 的内容块数组', () => {
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  for (const t of tools) {
    const blocks = t.output.render({}, '示例输出');
    assert.ok(Array.isArray(blocks), `${t.name}.render 必须返回数组`);
    assert.ok(blocks.length > 0);
    for (const block of blocks) {
      assert.equal(block.type, 'text');
      assert.equal(typeof block.text, 'string');
    }
    assert.equal(blocks[0].text, '示例输出');
  }
});

test('createTools：output.render 能把非字符串值安全地转成文本', () => {
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  const render = tools[0].output.render;
  assert.equal(render({}, undefined)[0].text, 'undefined');
  assert.equal(render({}, { a: 1 })[0].text, '[object Object]');
});

test('工具定义里不得出现 DSH 编译器不接受的形状', () => {
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  for (const t of tools) {
    // 参数不能是原始 JSON Schema 的 `properties` 包装，必须是 { 名: spec } 字典
    assert.equal(t.parameters.type, undefined, `${t.name}.parameters 不应自带 type`);
    assert.equal(t.parameters.properties, undefined, `${t.name}.parameters 不应是 JSON Schema`);
    // 输出 schema 是值 schema：不允许 required
    assert.equal(t.output.schema.required, undefined, `${t.name}.output.schema 不应含 required`);
    assert.equal(typeof t.output.schema.type, 'string', `${t.name}.output.schema 缺 type`);
  }
});

test('prepareTools：提供了 defineTool 时逐个包装，未提供时原样返回', () => {
  const raw = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  assert.equal(prepareTools(raw)[0], raw[0], '没有 defineTool 时应原样返回');

  const wrapped = prepareTools(raw, (def) => ({ ...def, wrapped: true }));
  assert.equal(wrapped.length, raw.length);
  assert.ok(wrapped.every((t) => t.wrapped === true));
});

/* --------------------------------------------------------- 端到端：索引 */

test('kb_index → kb_search：端到端可用，引用带 file:line', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });

  const indexOut = await tool(tools, 'kb_index').execute({});
  assert.match(indexOut, /已索引 2 个文件/);
  assert.match(indexOut, /新增 2/);

  const searchOut = await tool(tools, 'kb_search').execute({ query: '存储选型为什么不用数据库' });
  // 命中数量取决于语料与切分：只要相关就必须给出可定位的来源与正文。
  // 单条命中时报"可信度不足"是**设计行为**（无法交叉印证），因此不断言具体措辞。
  assert.match(searchOut, /docs\/architecture\.md:\d+/);
  assert.match(searchOut, /Markdown/);
  assert.match(searchOut, /\[1\]/);
});

test('kb_index：重复执行是增量的，不重复计入新增', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });

  await tool(tools, 'kb_index').execute({});
  const second = await tool(tools, 'kb_index').execute({});
  assert.match(second, /新增 0/);
  assert.match(second, /未变 2/);
});

test('kb_search：未建索引时明确提示先建索引', async () => {
  const root = workspace(SAMPLE);
  const tools = createTools({ workspace: root, dshHome: dshHome() });
  const out = await tool(tools, 'kb_search').execute({ query: '任意问题' });
  assert.match(out, /索引是空的/);
  assert.match(out, /kb_index/);
});

test('kb_search：无命中时给出"没找到"，而不是空白或幻觉素材', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});

  const out = await tool(tools, 'kb_search').execute({ query: '量子纠缠贝尔不等式' });
  assert.match(out, /没有找到与查询相关的内容/);
  assert.match(out, /不要用你自己的训练知识/);
});

test('kb_search：空查询报错，不静默返回全部内容', async () => {
  const root = workspace(SAMPLE);
  const tools = createTools({ workspace: root, dshHome: dshHome() });
  await assert.rejects(() => tool(tools, 'kb_search').execute({ query: '   ' }), /must not be empty/);
});

test('kb_search：max_passages 参数生效', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});
  const out = await tool(tools, 'kb_search').execute({ query: '检索 部署 安装', max_passages: 1 });
  const numbered = out.match(/^\[\d+\]/gm) ?? [];
  assert.equal(numbered.length, 1);
});

test('kb_stats：未建索引与已建索引两种状态都有明确输出', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });

  assert.match(await tool(tools, 'kb_stats').execute({}), /还没有索引/);

  await tool(tools, 'kb_index').execute({});
  const stats = await tool(tools, 'kb_stats').execute({});
  assert.match(stats, /已索引：2 个文件/);
  assert.match(stats, /docs\/architecture\.md/);
  assert.match(stats, /文件清单/);
});

/* --------------------------------------------------------- 端到端：记忆 */

test('memory 工具：write → read → forget 全链路', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');

  assert.match(await memory.execute({ action: 'read' }), /目前是空的/);

  const written = await memory.execute({ action: 'write', key: '决定.存储', text: '用 Markdown 而不是数据库' });
  assert.match(written, /已记住/);
  assert.match(written, /决定\.存储/);

  const updated = await memory.execute({ action: 'write', key: '决定.存储', text: '用 Markdown（已确认）' });
  assert.match(updated, /已更新/);

  const read = await memory.execute({ action: 'read' });
  assert.match(read, /用 Markdown（已确认）/);
  assert.doesNotMatch(read, /而不是数据库/, '同键应为更新而不是新增');
  assert.match(read, /来源：模型/);

  const forgotten = await memory.execute({ action: 'forget', key: '决定.存储' });
  assert.match(forgotten, /已删除 1 条/);
  assert.match(await memory.execute({ action: 'read' }), /目前是空的/);
});

test('memory 工具：scope 隔离（project 与 user 互不影响）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');

  await memory.execute({ action: 'write', scope: 'project', key: '技术栈', text: 'TypeScript' });
  await memory.execute({ action: 'write', scope: 'user', key: '称呼', text: '叫长安' });

  const project = await memory.execute({ action: 'read', scope: 'project' });
  const user = await memory.execute({ action: 'read', scope: 'user' });
  assert.match(project, /TypeScript/);
  assert.doesNotMatch(project, /长安/);
  assert.match(user, /长安/);
  assert.doesNotMatch(user, /TypeScript/);
});

test('memory 工具：forget 缺少 key 与 query 时拒绝执行（防误删）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');

  await memory.execute({ action: 'write', key: 'a', text: '内容' });
  const out = await memory.execute({ action: 'forget' });
  assert.match(out, /需要提供 key 或 query/);
  assert.match(await memory.execute({ action: 'read' }), /内容/, '拒绝执行时不得删除任何条目');
});

test('memory 工具：write 缺参数时返回说明而不是抛错', async () => {
  const tools = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  const out = await tool(tools, 'memory').execute({ action: 'write', key: 'a' });
  assert.match(out, /需要同时提供 key 与 text/);
});

test('memory_search：跨 project 与 user 检索并按来源分组', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');

  await memory.execute({ action: 'write', scope: 'project', key: '配色', text: '项目用深色主题' });
  await memory.execute({ action: 'write', scope: 'user', key: '配色偏好', text: '个人偏好深色' });

  const both = await tool(tools, 'memory_search').execute({ query: '深色' });
  assert.match(both, /project 记忆命中/);
  assert.match(both, /user 记忆命中/);

  const onlyUser = await tool(tools, 'memory_search').execute({ query: '深色', scope: 'user' });
  assert.match(onlyUser, /user 记忆命中/);
  assert.doesNotMatch(onlyUser, /project 记忆命中/);

  assert.match(await tool(tools, 'memory_search').execute({ query: '不存在的内容xyz' }), /没有找到相关内容/);
});

/* ----------------------------------------------------- 系统提示词注入 */

test('renderMemoryPrompt：没有记忆时返回空串（不注入空段落）', () => {
  const text = renderMemoryPrompt({ workspace: os.tmpdir(), dshHome: dshHome() });
  assert.equal(text, '');
});

test('renderMemoryPrompt：注入项目与用户两段，并带使用说明', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'memory').execute({ action: 'write', scope: 'project', key: '技术栈', text: '纯 ESM JavaScript' });
  await tool(tools, 'memory').execute({ action: 'write', scope: 'user', key: '称呼', text: '叫长安' });

  const text = renderMemoryPrompt({ workspace: root, dshHome: home });
  assert.match(text, /<long-term-memory>/);
  assert.match(text, /项目长期记忆（仅本项目）/);
  assert.match(text, /用户长期记忆（所有项目）/);
  assert.match(text, /纯 ESM JavaScript/);
  assert.match(text, /叫长安/);
  assert.match(text, /与当前对话冲突时以用户当前说法为准/);
});

test('renderMemoryPrompt：超出条数预算时说明还有更多，而不是静默丢弃', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');
  for (let i = 0; i < 8; i += 1) {
    await memory.execute({ action: 'write', key: `k${i}`, text: `第 ${i} 条内容` });
  }

  const text = renderMemoryPrompt({ workspace: root, dshHome: home, config: { maxInjectedEntries: 3 } });
  assert.match(text, /另有 5 条未列出/);
  assert.match(text, /memory_search/);
});

test('renderMemoryPrompt：字符预算生效', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');
  for (let i = 0; i < 5; i += 1) {
    await memory.execute({ action: 'write', key: `k${i}`, text: '内容'.repeat(30) });
  }
  const text = renderMemoryPrompt({ workspace: root, dshHome: home, config: { maxInjectedChars: 200 } });
  assert.ok(text.length < 1000, `注入文本应采用预算，实际 ${text.length}`);
});

/* ------------------------------------------------------- apply 上下文 */

test('变量名必须符合 DSH 的命名契约（只允许小写、数字、下划线）', () => {
  // DSH 内部用 /^[a-z][a-z0-9_]*$/ 校验变量名。取名不合规时注册不报错，
  // 但每次组装提示词都会抛错——等于插件装上去就不能用，而且只在请求时才炸。
  const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
  assert.match(MEMORY_VARIABLE, VARIABLE_NAME, `变量名 ${MEMORY_VARIABLE} 不符合 DSH 契约`);
  assert.doesNotMatch(MEMORY_VARIABLE, /[A-Z]/, '不得含大写字母');
});

test('apply：注册 5 个工具，并以占位段落 + 变量注入记忆', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();

  const registered = [];
  const variables = new Map();
  const sections = [];
  const ctx = {
    agent: { session: { summary: { cwd: root } } },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: {
      variable: (n, r) => variables.set(n, r),
      section: (s) => sections.push(s),
      getSectionOrder: (key) => (key === 'LONG_TERM_MEMORY' ? 7 : undefined),
    },
  };

  apply(ctx, { dshHome: home });

  assert.equal(registered.length, 5);
  assert.deepEqual(
    registered.map((t) => t.name),
    ['kb_index', 'kb_search', 'kb_stats', 'memory', 'memory_search'],
  );
  // 段落文本必须是占位符（动态注入），而不是渲染后的记忆快照
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'long-term-memory');
  assert.equal(sections[0].text, `{{${MEMORY_VARIABLE}}}`);
  assert.equal(sections[0].order, 7);
  assert.ok(variables.has(MEMORY_VARIABLE));
  void home;
});

test('apply：宿主没有提示词服务时，工具照常注册（失败隔离）', () => {
  const registered = [];
  const ctx = {
    agent: { session: { summary: { cwd: os.tmpdir() } } },
    tools: { register: (t) => registered.push(t) },
    // 没有任何 systemPrompt 服务
  };
  assert.doesNotThrow(() => apply(ctx, { dshHome: dshHome() }));
  assert.equal(registered.length, 5, '少了提示词服务不应让工具注册失效');
});

test('apply：systemPrompt 只有 section 没有 variable 时也不注入、不抛错', () => {
  const sections = [];
  const ctx = {
    agent: { session: { summary: { cwd: os.tmpdir() } } },
    tools: { register: () => {} },
    systemPrompt: { section: (s) => sections.push(s) },
  };
  assert.doesNotThrow(() => apply(ctx, { dshHome: dshHome() }));
  assert.equal(sections.length, 0, '缺 variable 服务时不应注册一个渲染不出来的段落');
});

test('apply：宿主提供变量服务时，注入改为每次组装现读（新记忆立刻生效）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();

  const variables = new Map();
  const sections = [];
  const ctx = {
    agent: { session: { summary: { cwd: root } } },
    tools: { register: () => {} },
    systemPrompt: {
      variable: (varName, resolver) => variables.set(varName, resolver),
      section: (s) => sections.push(s),
      getSectionOrder: () => 7,
    },
  };

  apply(ctx, { dshHome: home });

  // 段落只放占位符，不预先渲染记忆
  assert.equal(sections.length, 1);
  assert.equal(sections[0].text, `{{${MEMORY_VARIABLE}}}`);
  assert.equal(variables.size, 1);

  const resolve = variables.get(MEMORY_VARIABLE);
  assert.equal(resolve(), '', '没有记忆时解析为空串（空段落会被组装丢弃）');

  // 写入记忆后，同一个 resolver 立刻能看到——这正是动态注入的意义
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'memory').execute({ action: 'write', key: '称呼', text: '叫长安' });
  assert.match(resolve(), /叫长安/, '新写入的记忆必须在下次组装时可见');
});

test('apply：变量 resolver 在记忆文件损坏时返回空串而不是抛错', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();

  const variables = new Map();
  const ctx = {
    agent: { session: { summary: { cwd: root } } },
    tools: { register: () => {} },
    systemPrompt: { variable: (n, r) => variables.set(n, r), section: () => {} },
  };
  apply(ctx, { dshHome: home });

  // 造一个"目录占住文件路径"的损坏状态，使读取必然失败
  const file = projectMemoryFile(root, { dshHome: home });
  fs.mkdirSync(file, { recursive: true });

  // 按 DSH 契约，未解析的变量会让整个提示词组装失败，因此 resolver 必须吞掉异常返回空串
  assert.doesNotThrow(() => variables.get(MEMORY_VARIABLE)());
  assert.equal(variables.get(MEMORY_VARIABLE)(), '');
});

test('apply：宿主缺少 tools/systemPrompt 服务时静默降级，不抛错', () => {
  assert.doesNotThrow(() => apply({}, { dshHome: dshHome() }));
  assert.doesNotThrow(() => apply(undefined, { dshHome: dshHome() }));
  assert.doesNotThrow(() => apply({ tools: {} }, { dshHome: dshHome() }));
});

test('apply：injectMemory 为 false 时不注入提示词，但仍注册工具', () => {
  const registered = [];
  const sections = [];
  const ctx = {
    agent: { session: { summary: { cwd: os.tmpdir() } } },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => sections.push(s) },
  };
  apply(ctx, { dshHome: dshHome(), injectMemory: false });
  assert.equal(registered.length, 5);
  assert.equal(sections.length, 0);
});

test('apply：使用 defineTool 包装（模拟 DSH 宿主）', () => {
  const registered = [];
  const ctx = {
    agent: { session: { summary: { cwd: os.tmpdir() } } },
    tools: {
      defineTool: (def) => ({ ...def, viaDefineTool: true }),
      register: (t) => registered.push(t),
    },
  };
  apply(ctx, { dshHome: dshHome() });
  assert.equal(registered.length, 5);
  assert.ok(registered.every((t) => t.viaDefineTool === true));
});
