import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  approxTokens,
  detectLang,
  detectHeading,
  chunkDocument,
  chunkBySections,
} from '../lib/chunking.js';

/* ---------------------------------------------------------------- 基础度量 */

test('approxTokens：中文按字、英文按词、数字按串', () => {
  assert.equal(approxTokens('中文四个字'), 5);
  assert.equal(approxTokens(''), 0);
  // 两个英文单词 → 2 * 1.3，一个数字串 → 1
  assert.equal(approxTokens('variant calling 123'), 2 * 1.3 + 1);
});

test('detectLang：CJK 不少于英文单词即为中文', () => {
  assert.equal(detectLang('这是中文内容'), 'zh');
  assert.equal(detectLang('this is english content'), 'en');
  assert.equal(detectLang('混合 hybrid 内容'), 'zh');
});

/* ---------------------------------------------------------------- 标题识别 */

test('detectHeading：识别编号式与中文序数式标题', () => {
  assert.deepEqual(detectHeading('1. 为什么做这个项目'), { level: 1, title: '1. 为什么做这个项目' });
  assert.deepEqual(detectHeading('2.2.3 试验方案'), { level: 3, title: '2.2.3 试验方案' });
  assert.deepEqual(detectHeading('一、总体思路'), { level: 1, title: '一、总体思路' });
  assert.deepEqual(detectHeading('（二）具体做法'), { level: 2, title: '（二）具体做法' });
});

test('detectHeading：识别 Markdown ATX 标题并取层级', () => {
  assert.deepEqual(detectHeading('## 3. 存储选型'), { level: 2, title: '3. 存储选型' });
  assert.deepEqual(detectHeading('###### 深层标题'), { level: 6, title: '深层标题' });
  assert.deepEqual(detectHeading('## 带尾井号 ##'), { level: 2, title: '带尾井号' });
});

test('detectHeading：正文句子、过长行、目录行都不算标题', () => {
  assert.equal(detectHeading('这是一个包含句号的正文句子。'), null);
  // 超过 62 字符的行不算标题，避免把长正文行当成章节
  const longLine = `${'内容'.repeat(40)}`;
  assert.equal(detectHeading(longLine), null);
  assert.equal(detectHeading(''), null);
  assert.equal(detectHeading('普通正文一行'), null);
  // 带句号的长行同样被排除
  assert.equal(detectHeading(`1. ${longLine}。`), null);
});

/* ------------------------------------------------------------ 无结构切分 */

test('chunkDocument：按 token 预算成片，且不产生空片段', () => {
  const text = Array.from({ length: 30 }, (_, i) => `第${i}段内容，用于填充 token 预算。`).join('\n\n');
  const parts = chunkDocument(text, { maxTokens: 60, overlapTokens: 10 });
  assert.ok(parts.length > 1, '应当切成多片');
  for (const part of parts) {
    assert.ok(part.text.trim().length > 0, '不应有空片段');
    assert.ok(part.tokens > 0);
  }
});

test('chunkDocument：相邻片段之间有重叠（逐字相同的一整句）', () => {
  const text = Array.from({ length: 20 }, (_, i) => `句子编号${i}，内容足够长以便触发切分。`).join('\n\n');
  const parts = chunkDocument(text, { maxTokens: 50, overlapTokens: 30 });
  assert.ok(parts.length >= 2);
  // 重叠是按整句重放的：上一片的最后一个非空行应当逐字等于下一片的第一行。
  const lastLine = parts[0].text.trim().split('\n').pop();
  const firstLine = parts[1].text.split('\n')[0];
  assert.equal(firstLine, lastLine, `后一片首行应重放上一片末行：${firstLine} vs ${lastLine}`);
});

test('chunkDocument：token 估算失效时仍受字符数硬约束（回归：纯符号长串）', () => {
  // `xxxx…` 会被英文单词规则当成一个单词，token 估算只有 1.3，长度预算完全失效；
  // 早期版本因此产出过一个 2002 字符的巨片。
  const blob = 'x'.repeat(2000);
  assert.ok(approxTokens(blob) < 5, '前提：token 估算对该内容几乎失效');
  const parts = chunkDocument(blob, { maxTokens: 100 });
  assert.ok(parts.length > 1, '应被字符兜底切开');
  for (const part of parts) {
    // 上界 = 单元上限 1200 + 段落连接符 2 + 重叠上限 300
    assert.ok(part.text.length <= 1502, `片段过长: ${part.text.length}`);
  }
  // 不丢内容：重叠会重复少量字符，因此只断言总量不少于原文长度。
  const total = parts.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
  assert.ok(total >= blob.length, `内容疑似丢失: ${total} < ${blob.length}`);
});

test('chunkDocument：空输入安全', () => {
  assert.deepEqual(chunkDocument(''), []);
  assert.deepEqual(chunkDocument('   \n\n  '), []);
});

/* -------------------------------------------------------------- 结构切分 */

const DOC = [
  '# 设计文档',
  '',
  '本文档描述检索方案。',
  '',
  '## 1. 背景',
  '',
  '变异检测需要从海量数据中找到可靠信息，这是本项目要解决的问题。',
  '',
  '### 1.1 动机',
  '',
  '让模型具备跨对话的上下文管理能力，是当前工程里最核心的题目。',
  '',
  '## 2. 方案',
  '',
  '## 2.1 混合召回',
  '',
  '并行召回后做融合排序，再用精排收敛候选集合。',
].join('\n');

test('chunkBySections：片段带标题路径前缀', () => {
  const chunks = chunkBySections(DOC, 'docs/设计.md');
  assert.ok(chunks.length >= 3);
  const paths = chunks.map((c) => c.headingPath);
  assert.ok(paths.includes('设计文档 › 1. 背景 › 1.1 动机'), '1.1 应带出完整父级路径');
  assert.ok(paths.includes('设计文档 › 2.1 混合召回'), '2.1 应带出父级路径');
  for (const chunk of chunks) {
    assert.match(chunk.text, /^【docs\/设计\.md › /);
    assert.ok(chunk.text.includes(chunk.headingPath), '前缀里应含标题路径');
  }
});

test('chunkBySections：章节自带正文时，父级路径单独成片', () => {
  const doc = ['## 1. 背景', '这是背景章节自己的正文内容。', '### 1.1 动机', '动机正文。'].join('\n');
  const chunks = chunkBySections(doc, 'd.md', { maxTokens: 500 });
  const paths = chunks.map((c) => c.headingPath);
  assert.ok(paths.includes('1. 背景'), '父节正文应产出属于父节的片段');
  assert.ok(paths.includes('1. 背景 › 1.1 动机'));
});

test('chunkBySections：片段不跨章节', () => {
  const chunks = chunkBySections(DOC, 'docs/设计.md');
  const motivation = chunks.find((c) => c.headingPath === '设计文档 › 1. 背景 › 1.1 动机');
  assert.ok(motivation, '应找到 1.1 动机 的片段');
  assert.ok(!motivation.text.includes('并行召回'), '片段不应混入下一章节内容');
});

test('chunkBySections：标题层级回退正确（## 2.1 视为 2. 方案 的子节）', () => {
  const chunks = chunkBySections(['## 1. 甲', '甲内容', '## 2. 乙', '## 2.1 丙', '丙内容'].join('\n'), 'a.md');
  const bing = chunks.find((c) => c.text.includes('丙内容'));
  // Markdown 的 `## 2.1` 层级是 2，与 `## 2. 乙` 同级，因此不会成为乙的子节。
  assert.equal(bing.headingPath, '2.1 丙');
});

test('chunkBySections：代码块内的 # 不被当成标题', () => {
  const text = ['## 标题', '正文', '```bash', '# 这是 shell 注释', 'echo hi', '```', '后继正文'].join('\n');
  const chunks = chunkBySections(text, 'code.md');
  assert.equal(chunks.length, 1, '整块应属于同一个章节');
  assert.ok(chunks[0].text.includes('echo hi'));
  assert.equal(chunks[0].headingPath, '标题');
});

test('chunkBySections：行号可回指原文（用于 file:line 引用）', () => {
  const chunks = chunkBySections(DOC, 'docs/设计.md');
  const lines = DOC.split('\n');
  for (const chunk of chunks) {
    assert.ok(chunk.startLine >= 1 && chunk.startLine <= lines.length, `startLine 越界: ${chunk.startLine}`);
    assert.ok(chunk.endLine >= chunk.startLine, 'endLine 应不小于 startLine');
  }
  const motivation = chunks.find((c) => c.headingPath === '设计文档 › 1. 背景 › 1.1 动机');
  // 「让模型具备跨对话…」在 DOC 的第 11 行
  assert.equal(lines[motivation.startLine - 1].includes('让模型具备'), true);
  assert.equal(motivation.startLine, 11);
  assert.equal(motivation.endLine, 11);
});

test('chunkBySections：id 稳定且唯一', () => {
  const a = chunkBySections(DOC, 'docs/设计.md');
  const b = chunkBySections(DOC, 'docs/设计.md');
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(new Set(a.map((c) => c.id)).size, a.length);
});

test('chunkBySections：无标题文档退化为一片（仍带文档前缀）', () => {
  const chunks = chunkBySections('只有一段没有标题的正文。', 'plain.txt');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].headingPath, undefined);
  assert.equal(chunks[0].text, '【plain.txt】\n只有一段没有标题的正文。');
});

test('chunkBySections：空文档返回空数组', () => {
  assert.deepEqual(chunkBySections('', 'empty.md'), []);
  assert.deepEqual(chunkBySections('   \n  \n', 'empty.md'), []);
});
