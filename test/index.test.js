import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_EXTENSIONS,
  shouldIndexFile,
  walkWorkspace,
  readIndexableFile,
} from '../lib/walk.js';
import { WorkspaceIndex, buildIndex, INDEX_VERSION } from '../lib/workspace-index.js';
import { createSparseRetriever, search, searchWithEvidence } from '../lib/search.js';

/** 建一个隔离的临时工作区。 */
function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** 建一个隔离的 DSH 家目录。 */
function dshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-home-'));
}

/* ------------------------------------------------------------- 文件发现 */

test('shouldIndexFile：按扩展名白名单筛选', () => {
  assert.equal(shouldIndexFile('docs/readme.md'), true);
  assert.equal(shouldIndexFile('src/index.js'), true);
  assert.equal(shouldIndexFile('a/b/config.yaml'), true);
  assert.equal(shouldIndexFile('image.png'), false);
  assert.equal(shouldIndexFile('archive.zip'), false);
  assert.equal(shouldIndexFile('binary.exe'), false);
  assert.ok(DEFAULT_EXTENSIONS.includes('.md'));
});

test('shouldIndexFile：跳过构建目录与锁文件', () => {
  assert.equal(shouldIndexFile('node_modules/pkg/readme.md'), false);
  assert.equal(shouldIndexFile('.git/config'), false);
  assert.equal(shouldIndexFile('dist/bundle.js'), false);
  assert.equal(shouldIndexFile('pnpm-lock.yaml'), false);
  assert.equal(shouldIndexFile('a/b/.venv/lib/x.py'), false);
});

test('shouldIndexFile：工作区内的共享记忆目录不参与检索', () => {
  assert.equal(shouldIndexFile('.dsh-memory/project.md'), false);
});

test('walkWorkspace：递归发现并排序，跳过目录被计入 skipped', () => {
  const root = workspace({
    'a.md': '# a',
    'docs/b.md': '# b',
    'docs/deep/c.txt': 'c',
    'node_modules/x/y.md': 'should be skipped',
    'image.png': 'not text',
  });
  const { files, skipped } = walkWorkspace(root);
  assert.deepEqual(files, ['a.md', 'docs/b.md', 'docs/deep/c.txt']);
  assert.ok(skipped >= 2, '跳过目录与非文本文件应被计数');
});

test('walkWorkspace：不跟随符号链接（避免索引到工作区之外）', () => {
  const outside = workspace({ 'secret.md': '# 外部机密' });
  const root = workspace({ 'inside.md': '# 内部' });
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  } catch {
    return; // 无权限创建软链时跳过该断言（例如未开发者模式的 Windows）
  }
  const { files } = walkWorkspace(root);
  assert.ok(!files.includes('link.md'), '软链不应被索引');
  assert.deepEqual(files, ['inside.md']);
});

test('walkWorkspace：maxFiles 上限会标记 truncated', () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`f${i}.md`] = `# ${i}`;
  const root = workspace(files);
  const { files: got, truncated } = walkWorkspace(root, { maxFiles: 3 });
  assert.equal(got.length, 3);
  assert.equal(truncated, true);
});

/* ------------------------------------------------------------- 文件读取 */

test('readIndexableFile：正常读取并给出内容指纹', () => {
  const root = workspace({ 'a.md': '# 标题\n\n正文' });
  const read = readIndexableFile(path.join(root, 'a.md'));
  assert.ok(read);
  assert.match(read.fingerprint, /^\d+-[0-9a-f]{16}$/);
  assert.equal(read.content.includes('正文'), true);
});

test('readIndexableFile：内容相同则指纹相同，内容变化则指纹变化', () => {
  const root = workspace({ 'a.md': '内容 A' });
  const abs = path.join(root, 'a.md');
  const first = readIndexableFile(abs);
  const again = readIndexableFile(abs);
  assert.equal(first.fingerprint, again.fingerprint);

  fs.writeFileSync(abs, '内容 B', 'utf8');
  const second = readIndexableFile(abs);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('readIndexableFile：跳过二进制文件与超大文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-binary-'));
  const bin = path.join(root, 'a.bin');
  fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
  assert.equal(readIndexableFile(bin), null, '含 NUL 字节应被视为二进制');

  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(2000), 'utf8');
  assert.equal(readIndexableFile(big, { maxBytes: 100 }), null, '超过上限应跳过');
});

test('readIndexableFile：不存在的文件返回 null 而不抛错', () => {
  assert.equal(readIndexableFile(path.join(os.tmpdir(), 'definitely-missing-xyz.md')), null);
});

/* --------------------------------------------------------------- 索引 */

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
  'docs/deploy.md': [
    '# 部署',
    '',
    '## 安装',
    '',
    '插件通过 pnpm 安装到 profile 目录，安装后需要重启客户端。',
  ].join('\n'),
  'notes/misc.md': '# 杂记\n\n今天天气不错，顺便记录一下。\n',
};

test('buildIndex：首次构建收录全部可索引文件', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const { index, changes, stats } = buildIndex(root, { dshHome: home });

  assert.equal(changes.added.length, 3);
  assert.equal(changes.updated.length, 0);
  assert.equal(changes.removed.length, 0);
  assert.equal(stats.files, 3);
  assert.ok(stats.chunks >= 3, `应切出多个片段，实际 ${stats.chunks}`);
  assert.equal(index.documents['docs/architecture.md'].chunks >= 2, true);
});

test('buildIndex：片段保留标题路径与行号', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const storage = index.chunks.find((c) => c.headingPath?.includes('存储选型'));
  assert.ok(storage, '应存在属于「存储选型」章节的片段');
  assert.match(storage.text, /^【docs\/architecture\.md/);
  assert.ok(Number.isFinite(storage.startLine) && storage.startLine > 1, '起始行应是正文行而不是 1');
});

test('buildIndex：索引可落盘并原样读回', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const { index } = buildIndex(root, { dshHome: home });
  const file = index.save(root, { dshHome: home });
  assert.equal(fs.existsSync(file), true);

  const loaded = WorkspaceIndex.load(root, { dshHome: home });
  assert.equal(loaded.version, INDEX_VERSION);
  assert.equal(loaded.documentCount, index.documentCount);
  assert.equal(loaded.chunkCount, index.chunkCount);
});

test('WorkspaceIndex.load：缺失/损坏/版本不符时返回空索引而不抛错', () => {
  const root = workspace({ 'a.md': '# a' });
  const home = dshHome();
  assert.equal(WorkspaceIndex.load(root, { dshHome: home }).chunkCount, 0);

  const { index } = buildIndex(root, { dshHome: home });
  const file = index.save(root, { dshHome: home });

  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  assert.equal(WorkspaceIndex.load(root, { dshHome: home }).chunkCount, 0, '损坏的索引应被判定为空');

  fs.writeFileSync(file, JSON.stringify({ version: 999, chunks: [{ id: 'x' }] }), 'utf8');
  assert.equal(WorkspaceIndex.load(root, { dshHome: home }).chunkCount, 0, '版本不符应要求重建');
});

test('buildIndex：未变更的文件被复用，不重新切分（增量生效）', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const first = buildIndex(root, { dshHome: home });

  const second = buildIndex(root, { dshHome: home, previous: first.index });
  assert.equal(second.changes.unchanged, 3, '三个文件都未变');
  assert.deepEqual(second.changes.added, []);
  assert.deepEqual(second.changes.updated, []);
  // 片段对象应被复用（同一批引用），证明没有重新切分
  assert.equal(second.index.chunks[0], first.index.chunks[0]);
});

test('buildIndex：只重新切分改动过的文件', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const first = buildIndex(root, { dshHome: home });

  fs.appendFileSync(path.join(root, 'docs/deploy.md'), '\n\n## 卸载\n\n删除 profile 中的 bundle 条目即可。\n', 'utf8');

  const second = buildIndex(root, { dshHome: home, previous: first.index });
  assert.deepEqual(second.changes.updated, ['docs/deploy.md']);
  assert.equal(second.changes.unchanged, 2);
  assert.deepEqual(second.changes.added, []);
  assert.ok(second.index.chunks.some((c) => c.text.includes('卸载')), '新内容应被索引');
});

test('buildIndex：识别新增与删除的文件', () => {
  const root = workspace(SAMPLE);
  const home = dshHome();
  const first = buildIndex(root, { dshHome: home });

  fs.writeFileSync(path.join(root, 'docs/new.md'), '# 新文档\n\n新增的内容在这里。\n', 'utf8');
  fs.rmSync(path.join(root, 'notes/misc.md'));

  const second = buildIndex(root, { dshHome: home, previous: first.index });
  assert.deepEqual(second.changes.added, ['docs/new.md']);
  assert.deepEqual(second.changes.removed, ['notes/misc.md']);
  assert.equal(second.index.documents['notes/misc.md'], undefined, '被删除文件的片段不应残留');
  assert.ok(!second.index.chunks.some((c) => c.docId === 'notes/misc.md'));
});

/* --------------------------------------------------------------- 检索 */

test('search：相关片段排在前面，且带来源行号', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const result = search({ index, query: '存储选型为什么不用数据库' });

  assert.ok(result.passages.length >= 1);
  const top = result.passages[0];
  assert.equal(top.docId, 'docs/architecture.md');
  assert.ok(Number.isFinite(top.startLine));
  assert.equal(typeof top.fusedScore, 'number');
});

test('search：完全不相关的问题没有命中（置信度兜底的第一道闸）', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const result = search({ index, query: '量子纠缠的贝尔不等式验证' });
  assert.equal(result.passages.length, 0);
  assert.equal(result.sufficiency.level, 'none');
});

test('search：把检索器换成多路时，融合层无需改动', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const sparse = createSparseRetriever(index.chunks);

  // 造一个假的第二路：把稀疏结果顺序反转，模拟"另一路给出不同排序"
  const reversed = {
    route: 'fake-dense',
    search(query, options = {}) {
      return sparse.search(query, options).slice().reverse();
    },
  };

  const result = search({ index, query: '存储选型', options: { retrievers: [sparse, reversed] } });
  assert.equal(result.routes.length, 2);
  assert.deepEqual(result.routes.map((r) => r.route), ['bm25', 'fake-dense']);
  // 两路都出现的片段，其贡献明细里应有两条
  assert.equal(result.passages[0].contributions.length, 2);
});

test('searchWithEvidence：输出带编号与 file:line 的来源清单', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const out = searchWithEvidence({ index, query: '插件怎么安装' });

  assert.match(out.text, /检索：插件怎么安装/);
  assert.ok(out.sources.length >= 1);
  assert.match(out.sources[0].location, /^docs\/deploy\.md:\d+/);
  assert.match(out.text, /\[1\] docs\/deploy\.md:/);
});

test('searchWithEvidence：无命中时给出"没找到"而不是空文本', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const out = searchWithEvidence({ index, query: '完全无关的主题内容xyz' });
  assert.equal(out.sufficiency.level, 'none');
  assert.match(out.text, /没有找到与查询相关的内容/);
  assert.deepEqual(out.sources, []);
});

test('search：空索引安全', () => {
  const empty = new WorkspaceIndex({});
  const result = search({ index: empty, query: '任意问题' });
  assert.deepEqual(result.passages, []);
  assert.equal(result.sufficiency.level, 'none');
});

test('search：端到端引用可落到真实文件行（能核对）', () => {
  const root = workspace(SAMPLE);
  const { index } = buildIndex(root, { dshHome: dshHome() });
  const out = searchWithEvidence({ index, query: 'RRF 融合' });

  assert.ok(out.sources.length >= 1);
  const src = out.sources[0];
  const abs = path.join(root, src.docId);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const snippet = lines.slice(src.startLine - 1, src.endLine).join('\n');
  assert.match(snippet, /RRF/, `引用行号必须指向真实内容，实际取到：${snippet}`);
});
