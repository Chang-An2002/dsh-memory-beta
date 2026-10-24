import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSynonymGroups,
  expandQuery,
  loadSynonymGroups,
  clearSynonymCache,
  MAX_VARIANTS,
} from '../lib/synonyms.js';
import { synonymsFile } from '../lib/paths.js';
import { reciprocalRankFusion } from '../lib/fusion.js';
import { createTools } from '../lib/index.js';

function dshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-syn-home-'));
}

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-syn-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function writeSynonyms(home, groups) {
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(synonymsFile({ dshHome: home }), JSON.stringify({ groups }), 'utf8');
  clearSynonymCache();
}

/* --------------------------------------------------------------- 解析 */

test('parseSynonymGroups：接受合法分组，忽略重复与超长项', () => {
  const { groups, warnings } = parseSynonymGroups(JSON.stringify({
    groups: [
      ['实验设计', '研究方法', '实验设计'],
      ['缓存', 'cache'],
      ['只有一个'],
      ['a'.repeat(80), '短词'],
      'not-an-array',
    ],
  }));

  assert.deepEqual(groups, [['实验设计', '研究方法'], ['缓存', 'cache']]);
  assert.ok(warnings.some((w) => w.includes('groups[2]')), '单词组应被提示');
  assert.ok(warnings.some((w) => w.includes('groups[4]')), '非数组应被提示');
});

test('parseSynonymGroups：坏输入返回空表而不是抛错', () => {
  assert.deepEqual(parseSynonymGroups('{oops').groups, []);
  assert.deepEqual(parseSynonymGroups('{}').groups, []);
  assert.deepEqual(parseSynonymGroups('[]').groups, []);
  assert.deepEqual(parseSynonymGroups('').groups, []);
  assert.ok(parseSynonymGroups('{oops').warnings.length > 0, '必须说明为什么没生效');
});

/* --------------------------------------------------------------- 扩展 */

test('expandQuery：命中组内某个说法时，把同组其它说法追加成额外问法', () => {
  const groups = [['实验设计', '技术方案', '研究方法']];
  const variants = expandQuery('这个课题的实验设计怎么做', groups);

  assert.equal(variants.length, 1);
  assert.match(variants[0], /^这个课题的实验设计怎么做（/);
  assert.match(variants[0], /技术方案/);
  assert.match(variants[0], /研究方法/);
});

test('expandQuery：没命中、问法已说全、表为空时都不生成额外问法', () => {
  assert.deepEqual(expandQuery('随便问一句', [['缓存', 'cache']]), []);
  assert.deepEqual(expandQuery('缓存和 cache 有什么区别', [['缓存', 'cache']]), [], '组内说法都在问法里，无可扩展');
  assert.deepEqual(expandQuery('实验设计', []), []);
  assert.deepEqual(expandQuery('', [['实验设计', '研究方法']]), []);
});

test('expandQuery：英文不区分大小写', () => {
  const variants = expandQuery('How does the CACHE work', [['cache', '快取']]);
  assert.equal(variants.length, 1);
  assert.match(variants[0], /快取/);
});

test('expandQuery：最多生成 MAX_VARIANTS 个额外问法', () => {
  const groups = [['甲', '甲乙'], ['乙', '乙丙'], ['丙', '丙丁']];
  const variants = expandQuery('甲 乙 丙', groups);
  assert.equal(variants.length, MAX_VARIANTS);
});

/* --------------------------------------------------------- 读取与缓存 */

test('loadSynonymGroups：没有文件时返回空表，不抛错', () => {
  assert.deepEqual(loadSynonymGroups({ dshHome: dshHome() }), []);
});

test('loadSynonymGroups：改表后立即生效（按 mtime 失效缓存）', () => {
  const home = dshHome();
  writeSynonyms(home, [['缓存', 'cache']]);
  assert.equal(loadSynonymGroups({ dshHome: home }).length, 1);

  writeSynonyms(home, [['缓存', 'cache'], ['部署', '上线']]);
  assert.equal(loadSynonymGroups({ dshHome: home }).length, 2, '改过表必须重新读');
});

test('loadSynonymGroups：表格式错误时退回空表，并通过回调报一次原因', () => {
  const home = dshHome();
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(synonymsFile({ dshHome: home }), '{不是数组}', 'utf8');
  clearSynonymCache();

  const messages = [];
  const groups = loadSynonymGroups({ dshHome: home }, (m) => messages.push(m));
  assert.deepEqual(groups, []);
  assert.ok(messages.some((m) => m.includes('JSON')), `应说明原因，实际：${messages.join(' / ')}`);
});

/* ------------------------------------------------------------- 融合权重 */

test('reciprocalRankFusion：低权重的一路排在等权重的后面', () => {
  // 两路各有一条不同的首位命中：等权时同分（再按 id 升序），加权后原查询必须在前
  const fused = reciprocalRankFusion([
    { route: 'bm25', hits: [{ id: 'a', rank: 1 }] },
    { route: 'bm25（同义扩展 1）', weight: 0.5, hits: [{ id: 'b', rank: 1 }] },
  ]);
  assert.deepEqual(fused.map((h) => h.id), ['a', 'b']);

  const tie = reciprocalRankFusion([
    { route: 'bm25', hits: [{ id: 'a', rank: 1 }] },
    { route: 'bm25（同义扩展 1）', hits: [{ id: 'b', rank: 1 }] },
  ]);
  assert.equal(tie[0].score, tie[1].score, '不加权时两者同分（这正是要避免的）');
});

/* ------------------------------------------- 集成：同义表真的救回一次漏召回 */

const KB = {
  '开题报告.md': '# 开题报告\n\n## 2.2 拟采取的研究方法\n\n本课题采用 CRISPR 筛选与流式验证。\n',
};

test('kb_search：同义表能把「换一种说法」的问法救回来（复现 ArkSeek 的结论）', async () => {
  const root = workspace(KB);
  const home = dshHome();
  const tools = createTools({ workspace: root, dshHome: home });
  await tools.find((t) => t.name === 'kb_index').execute({});

  const search = (q) => tools.find((t) => t.name === 'kb_search').execute({ query: q });

  // 问法用口语"实验设计"，文档写的是"拟采取的研究方法"，两者没有共同词
  const before = await search('实验设计怎么做');
  assert.doesNotMatch(before, /CRISPR/, '没有同义表时应当召不回——这正是要解决的问题');

  // 加上同义表后，同一个问法应能命中
  writeSynonyms(home, [['实验设计', '技术方案', '拟采取的研究方法']]);
  const after = await search('实验设计怎么做');
  assert.match(after, /CRISPR/, '同义表应把这一路救回来');
  assert.match(after, /开题报告\.md/, '命中要带来源');
});

test('kb_search：同义表写坏时检索照常工作（不能让扩展失败拖垮检索）', async () => {
  const root = workspace(KB);
  const home = dshHome();
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(synonymsFile({ dshHome: home }), '这不是 JSON', 'utf8');
  clearSynonymCache();

  // 坏表会（正确地）往 stderr 报一次原因；测试里接管掉，避免污染输出
  const original = console.error;
  const warnings = [];
  console.error = (...args) => { warnings.push(args.join(' ')); };
  try {
    const tools = createTools({ workspace: root, dshHome: home });
    const out = await tools.find((t) => t.name === 'kb_search').execute({ query: 'CRISPR 筛选' });
    assert.match(out, /CRISPR/, '原查询的召回不受影响');
  } finally {
    console.error = original;
  }
  assert.ok(warnings.some((m) => m.includes('JSON')), '坏表必须留下可见的原因，不能静默忽略');
});
