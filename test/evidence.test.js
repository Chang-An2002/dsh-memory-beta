import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUFFICIENCY,
  assessSufficiency,
  selectPassages,
  formatEvidence,
  formatLocation,
  truncateSnippet,
  buildEvidenceBlock,
} from '../lib/evidence.js';

/** 造一个片段。 */
function passage(id, docId, text, extra = {}) {
  return { id, docId, text, startLine: 1, endLine: 1, ...extra };
}

/* --------------------------------------------------------- 充分性判定 */

test('assessSufficiency：没有命中 → none', () => {
  const r = assessSufficiency({ fused: [], routes: [] });
  assert.equal(r.level, SUFFICIENCY.NONE);
  assert.equal(r.reasons.length, 1);
});

test('assessSufficiency：单条命中 → weak（无法交叉印证）', () => {
  const r = assessSufficiency({ fused: [{ score: 0.03 }] });
  assert.equal(r.level, SUFFICIENCY.WEAK);
  assert.match(r.reasons.join(' '), /只召回到一个片段/);
});

test('assessSufficiency：分数陡峭且命中充足 → ok', () => {
  const r = assessSufficiency({
    fused: [{ score: 0.03 }, { score: 0.016 }, { score: 0.0155 }, { score: 0.015 }],
  });
  assert.equal(r.level, SUFFICIENCY.OK);
  assert.deepEqual(r.reasons, []);
});

test('assessSufficiency：分数分布平坦 → weak（普遍弱匹配）', () => {
  const r = assessSufficiency({
    fused: [{ score: 0.0161 }, { score: 0.016 }, { score: 0.0159 }, { score: 0.0158 }],
  });
  assert.equal(r.level, SUFFICIENCY.WEAK);
  assert.match(r.reasons.join(' '), /分布平坦/);
});

test('assessSufficiency：多路里只有一路命中 → weak 并指出原因', () => {
  const r = assessSufficiency({
    fused: [{ score: 0.03 }, { score: 0.015 }],
    routes: [
      { route: 'bm25', hits: [{ id: 'a' }, { id: 'b' }] },
      { route: 'dense', hits: [] },
    ],
  });
  assert.equal(r.level, SUFFICIENCY.WEAK);
  assert.match(r.reasons.join(' '), /只有 bm25 一路给出命中/);
});

test('assessSufficiency：两路都有命中则不因路数降级', () => {
  const r = assessSufficiency({
    fused: [{ score: 0.03 }, { score: 0.015 }],
    routes: [
      { route: 'bm25', hits: [{ id: 'a' }] },
      { route: 'dense', hits: [{ id: 'b' }] },
    ],
  });
  assert.equal(r.level, SUFFICIENCY.OK);
});

test('assessSufficiency：两路命中数都为空时按 none 处理', () => {
  const r = assessSufficiency({ fused: [], routes: [{ route: 'bm25', hits: [] }] });
  assert.equal(r.level, SUFFICIENCY.NONE);
});

/* --------------------------------------------------------- 预算与多样性 */

test('selectPassages：token 预算生效，超出的被丢弃并标注原因', () => {
  const long = '甲'.repeat(500);
  const passages = [
    passage('1', 'a.md', long),
    passage('2', 'b.md', long),
    passage('3', 'c.md', long),
  ];
  const { selected, dropped, tokensUsed } = selectPassages(passages, { maxTokens: 600 });
  assert.equal(selected.length, 1, '第二片就会超出 600 token 预算');
  assert.equal(dropped[0].reason, 'token-budget');
  assert.ok(tokensUsed <= 600);
});

test('selectPassages：同文档片段数受限，保证证据多样性', () => {
  const passages = [
    passage('1', 'same.md', '内容一'),
    passage('2', 'same.md', '内容二'),
    passage('3', 'same.md', '内容三'),
    passage('4', 'other.md', '内容四'),
  ];
  const { selected, dropped } = selectPassages(passages, { maxPerDocument: 2 });
  assert.deepEqual(selected.map((p) => p.id), ['1', '2', '4']);
  assert.equal(dropped[0].reason, 'document-diversity');
});

test('selectPassages：片段数上限生效', () => {
  const passages = Array.from({ length: 10 }, (_, i) => passage(String(i), `d${i}.md`, '内容'));
  const { selected, dropped } = selectPassages(passages, { maxPassages: 3, maxPerDocument: 5 });
  assert.equal(selected.length, 3);
  assert.ok(dropped.every((d) => d.reason === 'count'));
});

test('selectPassages：第一条片段总是被纳入，即使它自己就超预算', () => {
  const passages = [passage('1', 'a.md', '甲'.repeat(5000)), passage('2', 'b.md', '乙')];
  const { selected } = selectPassages(passages, { maxTokens: 10 });
  assert.equal(selected.length, 1, '至少给出一条证据，否则模型无从判断');
  assert.equal(selected[0].id, '1');
});

test('selectPassages：标注哪些片段被截断', () => {
  const passages = [passage('1', 'a.md', '甲'.repeat(2000))];
  const { selected } = selectPassages(passages, { maxCharsPerPassage: 100 });
  assert.equal(selected[0].truncated, true);
});

/* --------------------------------------------------------- 来源与截断 */

test('formatLocation：单行与多行区间', () => {
  assert.equal(formatLocation({ docId: 'docs/a.md', startLine: 12, endLine: 12 }), 'docs/a.md:12');
  assert.equal(formatLocation({ docId: 'docs/a.md', startLine: 12, endLine: 20 }), 'docs/a.md:12-20');
  assert.equal(formatLocation({ docId: 'docs/a.md' }), 'docs/a.md');
});

test('formatEvidence：每条证据都有编号与来源，且含章节路径', () => {
  const text = formatEvidence([
    passage('1', 'docs/a.md', '第一段正文', { startLine: 10, endLine: 12, headingPath: '一、背景' }),
    passage('2', 'docs/b.md', '第二段正文', { startLine: 3 }),
  ]);
  assert.match(text, /\[1\] docs\/a\.md:10-12/);
  assert.match(text, /章节：一、背景/);
  assert.match(text, /\[2\] docs\/b\.md:3/);
  assert.match(text, /第一段正文/);
  assert.match(text, /第二段正文/);
});

test('truncateSnippet：未超限时原样返回，不留截断提示', () => {
  assert.equal(truncateSnippet('短文本', 100), '短文本');
});

test('truncateSnippet：超限时截断并提示', () => {
  const out = truncateSnippet('甲'.repeat(50), 10);
  assert.ok(out.includes('片段已截断'));
  assert.ok(out.startsWith('甲'.repeat(10)));
});

test('truncateSnippet：不把围栏代码块切一半', () => {
  const text = [
    '正文说明。',
    '```js',
    `const a = 1; // ${'x'.repeat(200)}`,
    '```',
    '结尾。',
  ].join('\n');
  // 截断点落在代码块内部
  const out = truncateSnippet(text, 40);
  assert.ok(!out.includes('const a = 1'), '不应保留半截代码块');
  assert.ok(out.includes('正文说明'));
  assert.ok(out.includes('片段已截断'));
});

test('truncateSnippet：代码块完整闭合时正常截断，不回退', () => {
  const text = ['```js', 'const a = 1;', '```', '甲'.repeat(200)].join('\n');
  const out = truncateSnippet(text, 60);
  assert.ok(out.includes('const a = 1;'), '闭合的代码块应保留');
});

/* --------------------------------------------------------- 交给模型的文本 */

test('buildEvidenceBlock：none 时明确说没找到，并禁止凭训练知识补空缺', () => {
  const text = buildEvidenceBlock({
    sufficiency: { level: SUFFICIENCY.NONE, reasons: ['检索没有返回任何片段。'] },
    passages: [],
    query: '变异检测用什么工具',
  });
  assert.match(text, /没有找到与查询相关的内容/);
  assert.match(text, /不要用你自己的训练知识/);
});

test('buildEvidenceBlock：weak 时给出理由并要求说明把握程度', () => {
  const text = buildEvidenceBlock({
    sufficiency: { level: SUFFICIENCY.WEAK, reasons: ['命中分数分布平坦'] },
    passages: [passage('1', 'a.md', '可能相关的片段')],
    query: '某问题',
  });
  assert.match(text, /可信度不足/);
  assert.match(text, /命中分数分布平坦/);
  assert.match(text, /不要把它们当作确定结论/);
  assert.match(text, /可能相关的片段/);
});

test('buildEvidenceBlock：ok 时要求标注来源', () => {
  const text = buildEvidenceBlock({
    sufficiency: { level: SUFFICIENCY.OK, reasons: [] },
    passages: [passage('1', 'docs/a.md', '确定相关的片段', { startLine: 5 })],
    query: '某问题',
  });
  assert.match(text, /找到以下相关片段/);
  assert.match(text, /标注引用的来源/);
  assert.match(text, /docs\/a\.md:5/);
  assert.match(text, /确定相关的片段/);
});
