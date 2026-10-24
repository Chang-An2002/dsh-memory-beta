import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  name,
  inject,
  Config,
  resolveConfig,
  resolveWorkspace,
  createTools,
  renderMemoryPrompt,
  rankMemoryEntries,
  recentConversationQuery,
  messageText,
  toRegistrableTools,
  compileParameterSchema,
  summarizeStale,
  listStale,
  apply,
  MEMORY_VARIABLE,
  MEMORY_SECTION,
} from '../lib/index.js';
import { projectMemoryFile, workspaceIndexFile } from '../lib/paths.js';

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
  assert.equal(name, 'dsh-memory-beta');
  assert.equal(typeof apply, 'function');
  assert.ok(Array.isArray(inject));
});

test('Config 必须是标准 schema：Cordis 会调用 Config["~standard"].validate', () => {
  // 这一条是真机踩坑的回归测试。原先 Config 是普通默认值对象，
  // Cordis 的 resolveConfig 直接读 Config["~standard"].validate，
  // 抛 TypeError → 整条插件 fiber 卸载 → 工具与提示词段落全部消失，
  // 而宿主只在 stderr 打一行 "entry did not activate"。
  const standard = Config['~standard'];
  assert.ok(standard, 'Config 必须带 ~standard（普通默认值对象会让插件无法激活）');
  assert.equal(typeof standard.validate, 'function');

  const ok = standard.validate({});
  assert.equal(ok.issues, undefined, '空配置必须通过校验');
  assert.equal(ok.value.maxPassages, 6);
  assert.equal(ok.value.injectMemory, true);
  assert.equal(ok.value.maxInjectedEntries, 40);
  assert.equal(ok.value.maxInjectedChars, 3000);

  const custom = standard.validate({ maxPassages: 3, injectMemory: false });
  assert.equal(custom.value.maxPassages, 3);
  assert.equal(custom.value.injectMemory, false);

  const bad = standard.validate({ maxPassages: 'x' });
  assert.ok(Array.isArray(bad.issues) && bad.issues.length === 1, '类型错误必须报 issue');
  assert.deepEqual(bad.issues[0].path, ['maxPassages']);

  const notObject = standard.validate('nope');
  assert.ok(Array.isArray(notObject.issues));

  // patch 里只写 id/name 时，Cordis 传进来的是 undefined：必须当成「全默认」而不是报错
  const omitted = standard.validate(undefined);
  assert.equal(omitted.issues, undefined, 'undefined 是合法输入（patch 未写 config）');
  assert.equal(omitted.value.maxPassages, 6);
  assert.equal(omitted.value.injectMemory, true);
});

test('resolveConfig：补齐默认值并允许覆盖', () => {
  const defaults = resolveConfig();
  assert.equal(defaults.maxPassages, 6);
  assert.equal(defaults.injectMemory, true);
  assert.equal(defaults.maxInjectedEntries, 40);
  assert.equal(defaults.maxInjectedChars, 3000);

  const custom = resolveConfig({ maxPassages: 3, injectMemory: false, maxInjectedChars: 100 });
  assert.equal(custom.maxPassages, 3);
  assert.equal(custom.injectMemory, false);
  assert.equal(custom.maxInjectedChars, 100);
  assert.equal(custom.maxInjectedEntries, 40, '未覆盖项应保留默认');

  // 非法值回退到默认值，而不是抛错
  const bogus = resolveConfig({ maxPassages: 'x', maxInjectedEntries: null });
  assert.equal(bogus.maxPassages, 6);
  assert.equal(bogus.maxInjectedEntries, 40);
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

test('toRegistrableTools：把隐式参数表编译成根为 object 的 JSON Schema', () => {
  // 真机踩坑 #2：DSH 的 defineTool 会把 { 名: {type, required?} } 编译成
  // { type:'object', properties, required }，然后 tools.register() 原样交给模型。
  // 本插件不 import defineTool，所以必须自己编译，否则模型收到的是
  // {query: {type:'string'}} 这种没有 object 根的怪 schema。
  const raw = createTools({ workspace: os.tmpdir(), dshHome: dshHome() });
  const registrable = toRegistrableTools(raw);

  assert.equal(registrable.length, raw.length);
  for (const t of registrable) {
    assert.equal(t.parameters.type, 'object', `${t.name}.parameters 必须有 object 根`);
    assert.equal(typeof t.parameters.properties, 'object');
    for (const [key, spec] of Object.entries(t.parameters.properties)) {
      assert.equal(spec.required, undefined, `${t.name}.${key} 里不能残留 required（它属于根）`);
      assert.equal(typeof spec.type, 'string', `${t.name}.${key} 缺 type`);
    }
    // render 必须在
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 output.render`);
  }

  const search = registrable.find((t) => t.name === 'kb_search');
  assert.deepEqual(search.parameters.required, ['query'], 'query 是必填，应提升到根 required');
  assert.equal(search.parameters.properties.query.description.length > 0, true);

  const memory = registrable.find((t) => t.name === 'memory');
  assert.deepEqual(memory.parameters.required, ['action']);
  assert.deepEqual(memory.parameters.properties.action.enum, ['read', 'write', 'forget']);

  // 没有必填项的工具不应出现 required 键（空数组也是噪声）
  const index = registrable.find((t) => t.name === 'kb_index');
  assert.equal(index.parameters.required, undefined);
  assert.deepEqual(index.parameters.properties, {});
});

test('compileParameterSchema：属性上的 required 提升到根，其余键原样保留', () => {
  const schema = compileParameterSchema({
    a: { type: 'string', required: true, description: '甲' },
    b: { type: 'number', enum: [1, 2] },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      a: { type: 'string', description: '甲' },
      b: { type: 'number', enum: [1, 2] },
    },
    required: ['a'],
  });

  assert.deepEqual(compileParameterSchema({}), { type: 'object', properties: {} });
  assert.deepEqual(compileParameterSchema(undefined), { type: 'object', properties: {} });
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

test('kb_search：未建索引时自动建立后再回答（而不是要求用户先跑 kb_index）', async () => {
  const root = workspace(SAMPLE);
  const tools = createTools({ workspace: root, dshHome: dshHome() });
  const out = await tool(tools, 'kb_search').execute({ query: '存储选型' });

  // 没有索引时不说"自上次索引后有变化"（没有"上次"），直接报重建了什么
  assert.doesNotMatch(out, /自上次索引后有变化/);
  assert.match(out, /已自动重新索引（新增 \d+ 个）后再回答/, '必须说明它替用户重建了索引、并说清变动了什么');
  assert.doesNotMatch(out, /先调用 kb_index/, '不该再要求用户手动建索引');
});

test('kb_search：工作区里确实没有可索引内容时，指向"文档位置"而不是让人去建索引', async () => {
  // 空工作区里叫用户去 kb_index 是误导 —— 那只会建出一个空索引，
  // 真正的问题通常是"文档是不是放错地方了"或"扩展名不在白名单里"。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-ws-'));
  const tools = createTools({ workspace: root, dshHome: dshHome() });
  const out = await tool(tools, 'kb_search').execute({ query: '任意问题' });
  assert.match(out, /没有可索引的内容/);
  assert.doesNotMatch(out, /调用 kb_index/, '工作区为空时不该叫人建索引');
});

test('kb_search：索引过期时自动重建，并如实告知改动了什么', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });

  await tool(tools, 'kb_index').execute({});

  // 改了文档却没重新索引——这正是 §9 那条「静默答错」的场景
  fs.writeFileSync(
    path.join(root, 'docs/deploy.md'),
    '# 部署\n\n## 安装\n\n安装方式已经改成完全不同的内容：从 GitHub 直接装。\n',
    'utf8',
  );

  const out = await tool(tools, 'kb_search').execute({ query: '插件怎么安装' });
  assert.match(out, /工作区自上次索引后有变化/);
  assert.match(out, /已自动重新索引/);
  assert.match(out, /docs\/deploy\.md/, '应点名是哪个文件变了');
  assert.match(out, /GitHub 直接装/, '答案必须来自变更后的内容，而不是旧索引');
});

test('kb_search：只动了 mtime、内容没变时保持安静（不打扰用户）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});

  const old = new Date('2020-01-01T00:00:00Z');
  for (const rel of Object.keys(SAMPLE)) fs.utimesSync(path.join(root, rel), old, old);

  const out = await tool(tools, 'kb_search').execute({ query: '存储选型' });
  assert.doesNotMatch(out, /自上次索引后有变化/, 'git checkout / 格式化保存这类操作不该触发重建');
  assert.doesNotMatch(out, /已自动重新索引/);
});

test('kb_search：autoReindex=false 时只提醒、不擅自重建', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home, config: { autoReindex: false } });
  await tool(tools, 'kb_index').execute({});

  fs.appendFileSync(path.join(root, 'docs/architecture.md'), '\n新增一句关于缓存的说明。\n', 'utf8');

  const out = await tool(tools, 'kb_search').execute({ query: '存储选型' });
  assert.doesNotMatch(out, /已自动重新索引/, '关掉之后不许动索引');
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

test('summarizeStale / listStale：把变化压成可读的一句', () => {
  assert.equal(summarizeStale([]), '');
  assert.equal(listStale([]), '');
  assert.equal(
    summarizeStale([
      { docId: 'a', kind: 'added' },
      { docId: 'b', kind: 'modified' },
      { docId: 'c', kind: 'removed' },
    ]),
    '新增 1 个，改动 1 个，删除 1 个',
  );
  assert.equal(listStale([{ docId: 'a.md', kind: 'added' }]), 'a.md');
  // 超过 8 个时截断，但要报出总数
  const many = Array.from({ length: 12 }, (_v, i) => ({ docId: `f${i}.md`, kind: 'modified' }));
  assert.match(listStale(many), /等 12 个文件/);
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

test('kb_stats：从未索引过时不说「自上次索引后有变化」（真机暴露的措辞 bug）', async () => {
  // 场景来自真机：在一个没有索引的工作区里 kb_stats 会说
  //   「工作区自上次索引后有变化（新增 N 个）…下面报告的是索引里的旧数据。还没有索引。」
  // 「自上次索引后」+「还没有索引」是自相矛盾的——没有"上次"，也没有"旧数据"。
  const root = workspace(SAMPLE);
  const tools = createTools({ workspace: root, dshHome: dshHome() });

  const out = await tool(tools, 'kb_stats').execute({});
  assert.doesNotMatch(out, /自上次索引后有变化/, '没索引时不该说"自上次索引后"');
  assert.doesNotMatch(out, /旧数据/, '没索引时没有"旧数据"可言');
  assert.match(out, /还没有索引/);
  assert.match(out, /\d+ 个文件/, '应告诉用户工作区里有多少可索引的文件');
});

test('kb_stats：真的过期时仍然说「旧数据」', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});

  fs.appendFileSync(path.join(root, 'docs/deploy.md'), '\n补充。\n', 'utf8');

  const out = await tool(tools, 'kb_stats').execute({});
  assert.match(out, /自上次索引后有变化/, '有索引且过期时，警告措辞必须保留');
  assert.match(out, /旧数据/);
});

test('kb_stats：索引过期时如实报告，但**不**擅自重建（只读工具）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});

  const indexFile = workspaceIndexFile(root, { dshHome: home });
  const before = fs.readFileSync(indexFile, 'utf8');

  fs.appendFileSync(path.join(root, 'docs/deploy.md'), '\n新增一段关于回滚的说明。\n', 'utf8');

  const stats = await tool(tools, 'kb_stats').execute({});
  assert.match(stats, /工作区自上次索引后有变化/, '必须报告过期');
  assert.match(stats, /docs\/deploy\.md/, '必须点名哪个文件变了');
  assert.match(stats, /旧数据/, '必须说明报的是旧数据');
  assert.doesNotMatch(stats, /已自动重新索引/, 'kb_stats 不该重建索引');

  // 索引文件必须原封不动——用户是拿 kb_stats 来"核对依据"的
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before, 'kb_stats 不得改写索引文件');
});

test('kb_search 与 kb_stats 对「索引是否过期」给出一致结论', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'kb_index').execute({});

  // 一致（都不过期）
  assert.doesNotMatch(await tool(tools, 'kb_stats').execute({}), /自上次索引后有变化/);
  assert.doesNotMatch(await tool(tools, 'kb_search').execute({ query: '存储选型' }), /自上次索引后有变化/);

  fs.writeFileSync(path.join(root, 'docs/architecture.md'), '# 架构\n\n全部重写。\n', 'utf8');

  // 一致（都过期）——注意 kb_stats 先跑、且它不重建，所以这里检测的是同一个"过期"事实
  assert.match(await tool(tools, 'kb_stats').execute({}), /自上次索引后有变化/);
  assert.match(await tool(tools, 'kb_search').execute({ query: '存储选型' }), /自上次索引后有变化/);

  // kb_search 重建之后，两边都应恢复"不过期"
  assert.doesNotMatch(await tool(tools, 'kb_stats').execute({}), /自上次索引后有变化/);
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

test('memory 工具：不传 scope 时 read 两个作用域（否则会像写入失败）', async () => {
  // 这是真机跑出来的陷阱：先 write scope=user、再 read（不传 scope），旧实现默认只读 project，
  // 于是返回"project 记忆目前是空的"——看起来像写没成功，而 memory_search 的默认却是 both。
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');

  await memory.execute({ action: 'write', scope: 'user', key: '称呼', text: '叫长安' });

  const both = await memory.execute({ action: 'read' });
  assert.match(both, /叫长安/, 'user 作用域的条目必须出现在不传 scope 的 read 里');
  assert.match(both, /project/, '两个作用域都要列出来');
  assert.match(both, /user/);

  // 显式传 scope 时仍然只读那一个
  const onlyProject = await memory.execute({ action: 'read', scope: 'project' });
  assert.doesNotMatch(onlyProject, /长安/);
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

test('renderMemoryPrompt：超预算时不静默丢弃，而是列出**未展开的键名**', async () => {
  // 改动前的措辞是"另有 5 条未列出，可用 memory_search 查询"——模型不知道那 5 条是什么，
  // 所以没有理由去查。现在必须把键名列出来，模型才知道"存在一条关于 X 的记忆"。
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');
  for (let i = 0; i < 8; i += 1) {
    await memory.execute({ action: 'write', key: `k${i}`, text: `第 ${i} 条内容` });
  }

  const text = renderMemoryPrompt({ workspace: root, dshHome: home, config: { maxInjectedEntries: 3 } });
  assert.match(text, /另有 5 条未展开/);
  assert.match(text, /memory_search/);
  // 三个展开 + 五个未展开，键名必须都在
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(text.includes(`k${i}`), `键名 k${i} 应当出现在注入文本里`);
  }
  // 未展开的那些不能带正文
  assert.doesNotMatch(text, /第 7 条内容/);
});

test('renderMemoryPrompt：有查询时把相关条目排到前面（超预算才看得出差别）', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');
  const topics = ['部署偏好', '命名规范', '数据库选型', '缓存策略', '日志格式', '回滚流程'];
  for (const [i, topic] of topics.entries()) {
    await memory.execute({ action: 'write', key: topic, text: `关于${topic}的说明，第 ${i} 条。` });
  }

  const config = { maxInjectedEntries: 2 };
  const plain = renderMemoryPrompt({ workspace: root, dshHome: home, config });
  const ranked = renderMemoryPrompt({ workspace: root, dshHome: home, config, query: '数据库选型和缓存策略哪个优先' });

  // 无查询：按记录顺序，前两条展开
  assert.match(plain, /- `部署偏好`/);
  assert.doesNotMatch(plain, /- `数据库选型` [^\n]*\n- `缓存策略`/, '无查询时不该把这两条排到最前');

  // 有查询：命中的两条必须排到最前，并因此被展开
  const rankedLines = ranked.split('\n');
  assert.ok(rankedLines.some((line) => line.startsWith('- `数据库选型`')), '数据库选型应被展开');
  assert.ok(rankedLines.some((line) => line.startsWith('- `缓存策略`')), '缓存策略应被展开');
  assert.doesNotMatch(ranked, /- `部署偏好`/, '不相干的条目应被挤到未展开清单里');
  assert.match(ranked, /未展开[\s\S]*部署偏好/, '被挤掉的条目要出现在键名清单里');
});

test('renderMemoryPrompt：没有查询时保持记录顺序，不做任何重排', async () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const memory = tool(tools, 'memory');
  for (const key of ['甲', '乙', '丙']) {
    await memory.execute({ action: 'write', key, text: `内容${key}` });
  }
  const text = renderMemoryPrompt({ workspace: root, dshHome: home });
  assert.ok(text.indexOf('`甲`') < text.indexOf('`乙`'));
  assert.ok(text.indexOf('`乙`') < text.indexOf('`丙`'));
});

test('rankMemoryEntries：查询为空或条目不足两条时原样返回', () => {
  const entries = [{ key: 'a', text: '甲' }, { key: 'b', text: '乙' }];
  assert.equal(rankMemoryEntries(entries, ''), entries);
  assert.equal(rankMemoryEntries(entries, '   '), entries);
  const single = [entries[0]];
  assert.equal(rankMemoryEntries(single, '甲'), single, '只有一条时无从排序，原样返回');
});

test('messageText：兼容字符串与内容块两种消息形态', () => {
  assert.equal(messageText({ content: '纯文本' }), '纯文本');
  assert.equal(messageText({ content: [{ type: 'text', text: '块一' }, { type: 'text', text: '块二' }] }), '块一\n块二');
  assert.equal(messageText({ content: [{ type: 'tool-call' }] }), '', '非文本块不该混进来');
  assert.equal(messageText({}), '');
  assert.equal(messageText(undefined), '');
});

test('recentConversationQuery：取最近几条消息的文本，取不到时返回空串', () => {
  const withSession = (messages) => ({ session: { deriveMessages: () => messages } });

  assert.equal(
    recentConversationQuery(withSession([
      { content: '第一轮问题' },
      { content: '第一轮回答' },
      { content: '第二轮问题' },
    ])),
    '第一轮回答\n第二轮问题',
    '默认取最近两条',
  );

  assert.equal(recentConversationQuery(undefined), '', '没有 agent 时为空串');
  assert.equal(recentConversationQuery({}), '', '没有 session 时为空串');
  assert.equal(recentConversationQuery(withSession([])), '', '空对话时为空串');
  assert.equal(
    recentConversationQuery({ session: { deriveMessages: () => { throw new Error('boom'); } } }),
    '',
    'deriveMessages 抛错时必须吞掉',
  );
  assert.ok(recentConversationQuery(withSession([{ content: '长'.repeat(5000) }])).length <= 600, '必须截断');
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

test('apply：注册 5 个工具，并以占位段落 + 变量注入记忆', () => {
  const home = dshHome();

  const registered = [];
  const variables = new Map();
  const sections = [];
  // 注意：**故意不给 ctx.agent**。真机里插件挂载在根上下文，根上下文没有 agent，
  // 而且 Cordis 的上下文代理会因未 inject 而直接抛 cannot get property "agent"。
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    systemPrompt: {
      variable: (n, r) => variables.set(n, r),
      section: (s) => sections.push(s),
      getSectionOrder: () => undefined,
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
  // 官方没有给这个段落排位置时，必须落在一个合法的有限数上（undefined 会被 systemPrompt.section 拒绝）
  assert.equal(sections[0].order, 2500);
  assert.ok(variables.has(MEMORY_VARIABLE));
});

test('apply：官方给了段落 order 时用官方值', () => {
  const sections = [];
  const ctx = {
    tools: { register: () => {} },
    systemPrompt: {
      variable: () => {},
      section: (s) => sections.push(s),
      getSectionOrder: (key) => (key === 'LONG_TERM_MEMORY' ? 7 : undefined),
    },
  };
  apply(ctx, { dshHome: dshHome() });
  assert.equal(sections[0].order, 7);
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
  // 真机里组装上下文长这样：{ agent, scope: agent }，变量 provider 收到它再取 cwd
  const assembly = { agent: { session: { header: { cwd: root } } } };

  const variables = new Map();
  const sections = [];
  const ctx = {
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
  assert.equal(resolve(assembly), '', '没有记忆时解析为空串（空段落会被组装丢弃）');

  // 写入记忆后，同一个 resolver 立刻能看到——这正是动态注入的意义
  const tools = createTools({ workspace: root, dshHome: home });
  await tool(tools, 'memory').execute({ action: 'write', key: '称呼', text: '叫长安' });
  assert.match(resolve(assembly), /叫长安/, '新写入的记忆必须在下次组装时可见');
});

test('apply：工作区取自组装上下文的 agent，而不是插件加载时的 cwd', async () => {
  const rootA = workspace(SAMPLE);
  const rootB = workspace(SAMPLE);
  const home = dshHome();

  // 先在 A 工作区写一条项目记忆
  const tools = createTools({ workspace: rootA, dshHome: home });
  await tool(tools, 'memory').execute({ action: 'write', scope: 'project', key: '甲', text: 'A 工作区的记忆' });

  const variables = new Map();
  const ctx = {
    tools: { register: () => {} },
    systemPrompt: { variable: (n, r) => variables.set(n, r), section: () => {} },
  };
  apply(ctx, { dshHome: home });
  const resolve = variables.get(MEMORY_VARIABLE);

  // 同一个插件实例，两个 agent（两个会话）→ 各读各的工作区
  assert.match(resolve({ agent: { session: { header: { cwd: rootA } } } }), /A 工作区的记忆/);
  assert.equal(resolve({ agent: { session: { header: { cwd: rootB } } } }), '', 'B 工作区不该看到 A 的记忆');
});

test('apply：变量 resolver 在记忆文件损坏时返回空串而不是抛错', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const assembly = { agent: { session: { header: { cwd: root } } } };

  const variables = new Map();
  const ctx = {
    tools: { register: () => {} },
    systemPrompt: { variable: (n, r) => variables.set(n, r), section: () => {} },
  };
  apply(ctx, { dshHome: home });

  // 造一个"目录占住文件路径"的损坏状态，使读取必然失败
  const file = projectMemoryFile(root, { dshHome: home });
  fs.mkdirSync(file, { recursive: true });

  // 按 DSH 契约，未解析的变量会让整个提示词组装失败，因此 resolver 必须吞掉异常返回空串
  assert.doesNotThrow(() => variables.get(MEMORY_VARIABLE)(assembly));
  assert.equal(variables.get(MEMORY_VARIABLE)(assembly), '');
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
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => sections.push(s) },
  };
  apply(ctx, { dshHome: dshHome(), injectMemory: false });
  assert.equal(registered.length, 5);
  assert.equal(sections.length, 0);
});

test('apply：注册出去的工具必须是「编译过参数表 + 带 render」的形状', () => {
  const registered = [];
  const ctx = { tools: { register: (t) => registered.push(t) } };
  apply(ctx, { dshHome: dshHome() });

  assert.equal(registered.length, 5);
  for (const t of registered) {
    assert.equal(t.parameters.type, 'object', `${t.name} 的参数表没被编译`);
    assert.equal(typeof t.parameters.properties, 'object');
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 output.render`);
    assert.deepEqual(t.output.render({}, 'x'), [{ type: 'text', text: 'x' }]);
  }
});

/* ------------------------------------------------- 与别的插件共存时的降级 */

/** 临时接管 console.error，返回收集到的日志与恢复函数。 */
function captureErrors() {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.join(' ')); };
  return { messages, restore: () => { console.error = original; } };
}

test('apply：某个工具名被别的插件占用时，只有它失败，其余四个仍可用', () => {
  // `memory` 是个通用名字，与另一个记忆插件同时装上就会撞名。DSH 对重名注册是**抛错**的，
  // 整批包一个 try 会让第一个失败就吞掉后面全部——那就是"装了两个插件，两个都用不了"。
  const registered = [];
  const captured = captureErrors();
  try {
    const ctx = {
      tools: {
        register: (t) => {
          if (t.name === 'memory') throw new Error('tool "memory" is already registered');
          registered.push(t);
        },
      },
    };
    assert.doesNotThrow(() => apply(ctx, { dshHome: dshHome(), injectMemory: false }));
  } finally {
    captured.restore();
  }

  assert.equal(registered.length, 4, '另外四个必须还在');
  assert.ok(!registered.some((t) => t.name === 'memory'));
  assert.ok(
    captured.messages.some((m) => m.includes('memory') && m.includes('注册失败')),
    '被吞掉的失败必须留下一条可见日志，不能静默',
  );
});

test('apply：提示词段落重名时降级为「不注入」，而不是让整条插件消失', () => {
  // 段落名 `long-term-memory` 若与另一个插件撞名，DSH 也会抛错。
  // 一旦冒出 apply，Cordis 会卸载整条 fiber，五个工具跟着一起没。
  const registered = [];
  const captured = captureErrors();
  try {
    const ctx = {
      tools: { register: (t) => registered.push(t) },
      systemPrompt: {
        variable: () => {},
        section: () => { throw new Error('prompt section "long-term-memory" is already registered'); },
      },
    };
    assert.doesNotThrow(() => apply(ctx, { dshHome: dshHome() }));
  } finally {
    captured.restore();
  }

  assert.equal(registered.length, 5, '工具必须全部还在');
  assert.ok(captured.messages.some((m) => m.includes('段落') && m.includes('注册失败')));
});

test('apply：变量重名时不再注册段落（否则组装时会因未知变量失败）', () => {
  const sections = [];
  const captured = captureErrors();
  try {
    const ctx = {
      tools: { register: () => {} },
      systemPrompt: {
        variable: () => { throw new Error('prompt variable "dsh_memory_long_term" is already registered'); },
        section: (s) => sections.push(s),
      },
    };
    assert.doesNotThrow(() => apply(ctx, { dshHome: dshHome() }));
  } finally {
    captured.restore();
  }
  assert.equal(sections.length, 0, '变量没注册成功就不该注册引用它的段落');
});

test('注入块必须声明「是事实，不是指令」', () => {
  // 记忆条目里出现"总是用英文回答"这类句子时，它会被每轮注入 —— 那等于一条常驻指令。
  // 这一行是廉价的缓解：明确告诉模型这是记录，不是要它服从的操作要求。
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  return tool(tools, 'memory')
    .execute({ action: 'write', scope: 'user', key: '称呼', text: '叫长安' })
    .then(() => {
      const text = renderMemoryPrompt({ workspace: root, dshHome: home });
      assert.match(text, /不是对你的指令/);
    });
});

test('kb_stats：未建索引时不做切分（不产生索引文件）', async () => {
  // 这条挡的是性能退化：早先为了报"共 N 个片段"会跑整份 buildIndex，
  // 2000 个文件实测 674 ms，而只数文件只要 5 ms。
  const root = workspace(SAMPLE);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  const indexFile = workspaceIndexFile(root, { dshHome: home });

  const out = await tool(tools, 'kb_stats').execute({});
  assert.match(out, /还没有索引/);
  assert.match(out, /2 个文件/, '应给出文件数');
  assert.equal(fs.existsSync(indexFile), false, 'kb_stats 是只读的，不该顺手建出索引文件');
});
