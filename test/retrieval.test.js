import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, ZH_STOPWORDS, EN_STOPWORDS } from '../lib/tokenize.js';
import { Bm25Index } from '../lib/bm25.js';
import { reciprocalRankFusion } from '../lib/fusion.js';

test('tokenize：中文切二元组、英文按词切并小写', () => {
  const tokens = tokenize('变异检测variant calling');
  assert.deepEqual(tokens, ['variant', 'calling', '变异', '异检', '检测']);
});

test('tokenize：CJK 二元组跨标点与空白组合（保留参考实现的既有行为）', () => {
  assert.deepEqual(tokenize('基因。组'), ['基因', '因组']);
  assert.deepEqual(tokenize('基因 组'), ['基因', '因组']);
});

test('tokenize：中文不产出单字 token', () => {
  for (const token of tokenize('变异检测')) {
    assert.ok([...token].length === 2, `unexpected single-char token: ${token}`);
  }
});

test('tokenize：停用词被过滤', () => {
  const tokens = tokenize('the genome is 基因组');
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('is'));
  assert.ok(tokens.includes('genome'));
  assert.ok(ZH_STOPWORDS.has('什么'));
  assert.ok(EN_STOPWORDS.has('the'));
});

test('tokenize：空输入与非法输入不抛错', () => {
  assert.deepEqual(tokenize(''), []);
  // @ts-expect-error 故意传非法类型
  assert.deepEqual(tokenize(null), []);
  // @ts-expect-error 故意传非法类型
  assert.deepEqual(tokenize(42), []);
});

test('BM25：相关文档排在无关文档之前', () => {
  const docs = [
    { id: 'a', text: '变异检测常用 GATK 与 bcftools 完成，流程包括比对与去重。' },
    { id: 'b', text: '本次实验的样本来自三个不同批次，用于评估批次效应。' },
    { id: 'c', text: '变异检测结果的过滤阈值需要根据测序深度调整。' },
  ];
  const index = new Bm25Index(docs);
  const hits = index.search('变异检测用什么工具', { topK: 3 });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].score > 0);
  assert.equal(hits[0].rank, 1);
  // 完全不共享任何 token 的文档不应得分
  assert.ok(!hits.some((hit) => hit.id === 'b'));
});

test('BM25：idf 恒为非负（BM25+ 平滑）', () => {
  const index = new Bm25Index([{ id: 'a', text: '重复词 重复词 重复词' }]);
  assert.ok(index.idf('重复') >= 0);
  assert.ok(index.idf('从未出现过') >= 0);
});

test('BM25：停用词无法单独构成命中（回归：IDF 稀有度误判）', () => {
  // 参考实现在真实语料上踩过的坑：查询里的「什么」「的」等词在长文档中稀有，
  // 被 IDF 当成强信号而召回完全不相关的内容。
  const irrelevant = { id: 'x', text: '这是一段与查询毫无关系的中文说明文字。' };
  const relevant = { id: 'y', text: '米哈游游戏运营岗位需要数据分析与用户洞察能力。' };
  const index = new Bm25Index([irrelevant, relevant]);
  const hits = index.search('什么', { topK: 5 });
  assert.deepEqual(hits, [], '纯停用词查询不应产生任何命中');
});

test('BM25：同分时按 id 升序，结果确定可复现', () => {
  const docs = [
    { id: 'z', text: '完全相同的文本内容在这里' },
    { id: 'a', text: '完全相同的文本内容在这里' },
  ];
  const index = new Bm25Index(docs);
  const first = index.search('文本内容', { topK: 2 });
  const second = index.search('文本内容', { topK: 2 });
  assert.deepEqual(first.map((h) => h.id), second.map((h) => h.id));
  assert.deepEqual(first.map((h) => h.id), ['a', 'z']);
});

test('BM25：空索引与空查询是安全的', () => {
  const empty = new Bm25Index([]);
  assert.deepEqual(empty.search('任意查询'), []);
  const index = new Bm25Index([{ id: 'a', text: '内容' }]);
  assert.deepEqual(index.search(''), []);
});

test('RRF：两路都出现的文档高于只在一路出现的文档，名次越靠前分越高', () => {
  const fused = reciprocalRankFusion([
    { route: 'bm25', hits: [{ id: '0', score: 11.7 }, { id: '1', score: 8.9 }, { id: '2', score: 8.8 }] },
    { route: 'dense', hits: [{ id: '2', score: 0.4 }, { id: '0', score: 0.3 }, { id: '3', score: 0.2 }] },
  ]);

  // 0 = bm25#1 + dense#2 = 1/61 + 1/62
  // 2 = bm25#3 + dense#1 = 1/63 + 1/61
  // 1 = bm25#2 仅一路；3 = dense#3 仅一路
  assert.deepEqual(fused.map((h) => h.id), ['0', '2', '1', '3']);
  assert.ok(fused[0].score > fused[1].score, '0 的次名次(2)优于 2 的次名次(3)，因此 0 更高');
  assert.ok(fused[1].score > fused[2].score, '两路命中的 2 高于单路命中的 1');
  assert.ok(fused[1].score > fused[3].score, '两路命中的 2 高于单路命中的 3');
  assert.equal(fused[0].contributions.length, 2);
  assert.equal(fused[2].contributions.length, 1);
  assert.equal(fused[0].score, 1 / 61 + 1 / 62);
  assert.equal(fused[1].score, 1 / 63 + 1 / 61);
});

test('RRF：公式数值与手算一致（k=60）', () => {
  const fused = reciprocalRankFusion([{ route: 'bm25', hits: [{ id: 'x' }, { id: 'y' }] }], { k: 60 });
  assert.equal(fused[0].score, 1 / 61);
  assert.equal(fused[1].score, 1 / 62);
});

test('RRF：贡献明细可解释名次来源', () => {
  const fused = reciprocalRankFusion([
    { route: 'bm25', hits: [{ id: 'a', score: 5 }] },
    { route: 'dense', hits: [{ id: 'a', score: 0.9 }] },
  ]);
  assert.equal(fused[0].contributions.length, 2);
  assert.deepEqual(fused[0].contributions.map((c) => c.route), ['bm25', 'dense']);
  assert.equal(fused[0].score, 1 / 61 + 1 / 61);
});

test('RRF：topK 截断后名次仍然连续', () => {
  const fused = reciprocalRankFusion([
    { route: 'bm25', hits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  ], { topK: 2 });
  assert.equal(fused.length, 2);
  assert.deepEqual(fused.map((h) => h.rank), [1, 2]);
});

test('RRF：非法输入快速失败', () => {
  // @ts-expect-error 故意传非法类型
  assert.throws(() => reciprocalRankFusion(null), TypeError);
  assert.throws(() => reciprocalRankFusion([{ route: 'bm25' }]), TypeError);
});
