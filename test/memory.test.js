import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveDshHome,
  memoryRoot,
  normalizeWorkspacePath,
  workspaceKey,
  userMemoryFile,
  projectMemoryFile,
  workspaceIndexFile,
  assertInside,
} from '../lib/paths.js';

import {
  parseMemory,
  renderMemory,
  renderEntry,
  deriveKey,
  normalizeKey,
  MemoryStore,
  openUserMemory,
  openProjectMemory,
  SOURCE,
} from '../lib/memory.js';

/** 建一个隔离的临时目录，避免测试写进真实的 ~/.dsh。 */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-memory-${label}-`));
}

/* ------------------------------------------------------------------ paths */

test('resolveDshHome：优先 DSH_HOME，否则退回 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\custom\\home' }), path.resolve('D:\\custom\\home'));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'));
});

test('memoryRoot：位于 DSH_HOME 之下', () => {
  const home = tempDir('home');
  assert.equal(memoryRoot({ dshHome: home }), path.join(home, 'memory'));
});

test('normalizeWorkspacePath：统一分隔符、只把盘符转小写', () => {
  assert.equal(normalizeWorkspacePath('D:\\Desktop\\Proj\\'), 'd:/Desktop/Proj');
  assert.equal(normalizeWorkspacePath('d:/Desktop/Proj'), 'd:/Desktop/Proj');
  if (process.platform !== 'win32') {
    // POSIX 下才谈得上"绝对路径不以盘符开头"；Windows 上 path.resolve('/x') 会补上当前盘符，
    // 这属于平台语义差异，不是本函数的问题。
    assert.equal(normalizeWorkspacePath('/home/User/Proj/'), '/home/User/Proj');
  }
});

test('normalizeWorkspacePath：拒绝空输入', () => {
  assert.throws(() => normalizeWorkspacePath(''), TypeError);
  // @ts-expect-error 故意传非法类型
  assert.throws(() => normalizeWorkspacePath(null), TypeError);
});

test('workspaceKey：同路径稳定、异路径不同、且文件名安全', () => {
  const a1 = workspaceKey('D:\\Desktop\\mihoyo\\dsh_memory');
  const a2 = workspaceKey('d:/Desktop/mihoyo/dsh_memory/');
  assert.equal(a1, a2, '同一目录的不同写法必须得到同一个键');

  const b = workspaceKey('D:\\Desktop\\mihoyo\\other_project');
  assert.notEqual(a1, b);

  // 不能含盘符、冒号、反斜杠、空格等文件名非法字符
  for (const key of [a1, b]) {
    assert.doesNotMatch(key, /[:\\\s]/, `键含非法字符: ${key}`);
  }
  assert.match(a1, /^[a-z0-9\u4e00-\u9fff-]+--[0-9a-f]{8}$/);
});

test('workspaceKey：不泄露用户目录名', () => {
  const fakeHome = path.join(os.tmpdir(), 'fakehome', 'somebody');
  const key = workspaceKey('C:\\Users\\somebody\\secret-project', { home: 'C:\\Users\\somebody' });
  assert.equal(key.startsWith('secret-project--'), true, `应剥掉家目录: ${key}`);
  assert.ok(!key.includes('somebody'), `键不应包含用户目录名: ${key}`);
  // 家目录之下的多层子路径也应完整保留，便于区分同名子目录
  const nested = workspaceKey('C:\\Users\\somebody\\work\\alpha', { home: 'C:\\Users\\somebody' });
  assert.equal(nested.startsWith('work-alpha--'), true, `应保留家目录之下的结构: ${nested}`);
  void fakeHome;
});

test('三个文件路径都落在 memory 目录下', () => {
  const home = tempDir('layout');
  const ws = 'D:\\proj\\alpha';
  const root = memoryRoot({ dshHome: home });
  assert.ok(userMemoryFile({ dshHome: home }).startsWith(root));
  assert.ok(projectMemoryFile(ws, { dshHome: home }).startsWith(path.join(root, 'projects')));
  assert.ok(workspaceIndexFile(ws, { dshHome: home }).startsWith(path.join(root, 'index')));
});

test('assertInside：挡住越界路径，放行内部路径', () => {
  const root = path.resolve('D:\\proj\\alpha');
  assert.equal(assertInside(root, 'docs/readme.md'), path.join(root, 'docs', 'readme.md'));
  assert.equal(assertInside(root, '.'), root);
  assert.throws(() => assertInside(root, '../secrets.txt'), /escapes/);
  assert.throws(() => assertInside(root, '../../.ssh/id_rsa'), /escapes/);
  assert.throws(() => assertInside(root, 'D:\\other\\file.txt'), /escapes/);
});

/* ----------------------------------------------------------------- memory */

test('parseMemory：解析带键、无键与元数据的混合文件', () => {
  const content = [
    '<!-- dsh-memory:user v1 -->',
    '# 长期记忆',
    '',
    '说明文字应当被保留。',
    '',
    '- `称呼` 用户希望被称为「长安」。 <!-- @2026-10-09 src=human -->',
    '- 别在回复里用 emoji',
    '- `技术栈` 主力语言是 Python 与 TypeScript。 <!-- @2026-10-09 src=model ref=session-1 -->',
  ].join('\n');

  const { loose, entries } = parseMemory(content);
  assert.equal(entries.length, 3);

  assert.equal(entries[0].key, '称呼');
  assert.equal(entries[0].text, '用户希望被称为「长安」。');
  assert.equal(entries[0].updatedAt, '2026-10-09');
  assert.equal(entries[0].source, SOURCE.HUMAN);
  assert.equal(entries[0].derived, false);

  // 无键条目也必须能读进来，键由内容派生
  assert.equal(entries[1].derived, true);
  assert.match(entries[1].key, /^auto-[0-9a-f]{8}$/);
  assert.equal(entries[1].text, '别在回复里用 emoji');

  assert.equal(entries[2].ref, 'session-1');
  // 无标记文件的标题之后那段文字，按"块外内容"处理并保留，绝不能丢。
  assert.ok(loose.includes('说明文字应当被保留'));
});

test('parseMemory：用户手写的裸条目不会丢', () => {
  const { entries } = parseMemory('- 普通一行\n* 另一种符号\n  - 缩进的也算');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.text), ['普通一行', '另一种符号', '缩进的也算']);
});

test('parseMemory：同键后者覆盖前者且保持顺序', () => {
  const { entries } = parseMemory(['- `a` 旧值', '- `b` 另一个', '- `a` 新值'].join('\n'));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.key), ['a', 'b']);
  assert.equal(entries[0].text, '新值');
});

test('deriveKey：内容相同则键相同（幂等），内容不同则键不同', () => {
  assert.equal(deriveKey('别用 emoji'), deriveKey('  别用   emoji  '));
  assert.equal(deriveKey('别用 emoji'), deriveKey('别用 EMOJI'));
  assert.notEqual(deriveKey('别用 emoji'), deriveKey('可以用 emoji'));
});

test('normalizeKey：空白与点号收敛', () => {
  assert.equal(normalizeKey('  技术栈 . 语言 '), '技术栈.语言');
  assert.equal(normalizeKey('A.B'), 'a.b');
  assert.equal(normalizeKey('..x..'), 'x');
});

test('renderEntry / renderMemory：渲染后能被重新解析（往返一致）', () => {
  const entries = [
    { key: '称呼', text: '用户希望被称为「长安」。', updatedAt: '2026-10-09', source: SOURCE.HUMAN },
    { key: 'auto-1a2b3c4d', text: '别用 emoji', updatedAt: '2026-10-09', source: SOURCE.MODEL, derived: true },
  ];
  const rendered = renderMemory({
    entries,
    title: '用户长期记忆',
    scopeNote: '说明',
    marker: 'user v1',
  });
  const parsed = parseMemory(rendered);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].key, '称呼');
  assert.equal(parsed.entries[0].text, '用户希望被称为「长安」。');
  assert.equal(parsed.entries[0].source, SOURCE.HUMAN);
  assert.equal(parsed.entries[1].derived, true, '派生键条目不应写出显式键');
  assert.equal(parsed.entries[1].text, '别用 emoji');
});

test('parseMemory：块外的用户手写内容进入 loose 而不是被丢弃', () => {
  const content = [
    '<!-- dsh-memory:user v1 -->',
    '# 标题',
    '<!-- scope-note -->',
    '这是插件写的说明，应当被丢弃。',
    '',
    '- `a` 条目一',
    '我随手写在条目之间的一行备注。',
    '- `b` 条目二',
  ].join('\n');

  const { entries, loose, preamble } = parseMemory(content);
  assert.deepEqual(entries.map((e) => e.key), ['a', 'b']);
  assert.equal(preamble, '');
  assert.match(loose, /我随手写在条目之间的一行备注/);
  assert.doesNotMatch(loose, /插件写的说明/, '插件说明不得进入用户内容');
  assert.doesNotMatch(loose, /# 标题/, '插件标题不得进入用户内容');
});

test('parseMemory：说明块后缺少空行时也不吞掉后续条目（手工编辑的容错）', () => {
  const content = [
    '<!-- dsh-memory:user v1 -->',
    '<!-- scope-note -->',
    '说明段落',
    '- `a` 条目一',
    '- `b` 条目二',
  ].join('\n');
  const { entries } = parseMemory(content);
  assert.deepEqual(entries.map((e) => e.key), ['a', 'b']);
});

test('parseMemory：说明块与标题块都被跳过，用户保留区原样保留', () => {
  const rendered = renderMemory({
    entries: [{ key: 'a', text: '内容', updatedAt: '2026-10-09', source: SOURCE.MODEL }],
    title: '标题',
    scopeNote: '说明文字',
    marker: 'user v1',
    preamble: '用户自己的备注',
  });
  const parsed = parseMemory(rendered);
  assert.equal(parsed.preamble, '用户自己的备注');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.loose, '');
});

test('MemoryStore：remember 新增然后更新同一键（幂等）', () => {
  const dir = tempDir('store');
  const store = new MemoryStore(path.join(dir, 'm.md'), { title: 't' });

  const first = store.remember({ key: '称呼', text: '叫长安', source: SOURCE.HUMAN, date: '2026-10-09' });
  assert.equal(first.created, true);

  const second = store.remember({ key: '称呼', text: '叫长安老师', date: '2026-10-10' });
  assert.equal(second.created, false);

  const { entries } = store.read();
  assert.equal(entries.length, 1, '同键应为更新而不是新增');
  assert.equal(entries[0].text, '叫长安老师');
  assert.equal(entries[0].updatedAt, '2026-10-10');
});

test('MemoryStore：键大小写与空格不同视为同一条', () => {
  const dir = tempDir('normkey');
  const store = new MemoryStore(path.join(dir, 'm.md'), {});
  store.remember({ key: 'Tech.Stack', text: 'TypeScript' });
  store.remember({ key: 'tech . stack', text: 'Python' });
  const { entries } = store.read();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Python');
});

test('MemoryStore：forget 支持按键与按内容，并回报删了什么', () => {
  const dir = tempDir('forget');
  const store = new MemoryStore(path.join(dir, 'm.md'), {});
  store.remember({ key: 'a', text: '第一条' });
  store.remember({ key: 'b', text: '关于配色偏好的第二条' });

  const byKey = store.forget({ key: 'a' });
  assert.deepEqual(byKey.removed.map((e) => e.key), ['a']);

  const byQuery = store.forget({ query: '配色偏好' });
  assert.deepEqual(byQuery.removed.map((e) => e.key), ['b']);

  assert.equal(store.read().entries.length, 0);
});

test('MemoryStore：forget 无匹配时不改动文件', () => {
  const dir = tempDir('noop');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, {});
  store.remember({ key: 'a', text: '内容' });
  const before = fs.readFileSync(file, 'utf8');

  const result = store.forget({ key: '不存在的键' });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '无匹配时不应重写文件');
});

test('MemoryStore：forget 缺参数时报错而不是清空', () => {
  const dir = tempDir('guard');
  const store = new MemoryStore(path.join(dir, 'm.md'), {});
  store.remember({ key: 'a', text: '内容' });
  assert.throws(() => store.forget({}), /requires either key or query/);
  assert.equal(store.read().entries.length, 1, '参数错误不得清空记忆');
});

test('MemoryStore：search 要求所有词都命中', () => {
  const dir = tempDir('search');
  const store = new MemoryStore(path.join(dir, 'm.md'), {});
  store.remember({ key: '配色', text: '偏好深色主题' });
  store.remember({ key: '字体', text: '偏好等宽字体' });

  assert.equal(store.search('深色').length, 1);
  assert.equal(store.search('偏好').length, 2);
  assert.equal(store.search('偏好 深色').length, 1);
  assert.equal(store.search('偏好 不存在').length, 0);
  assert.deepEqual(store.search('  '), []);
});

test('MemoryStore：键的原始大小写会被保留，不被规范化改写', () => {
  const dir = tempDir('keycase');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, {});
  store.remember({ key: '决定.砍掉L2', text: '不移植情景记忆层' });

  // 规范化键用于匹配
  assert.equal(store.read().entries[0].key, '决定.砍掉l2');
  // 文件里必须保留用户写的原始形态
  assert.match(fs.readFileSync(file, 'utf8'), /`决定\.砍掉L2`/);

  // 再次写入（触发一次完整往返）后仍然保留
  store.remember({ key: '其它', text: '内容' });
  assert.match(fs.readFileSync(file, 'utf8'), /`决定\.砍掉L2`/);
  // 用不同大小写写入同一键仍然是更新
  store.remember({ key: '决定.砍掉l2', text: '不移植情景记忆层（已确认）' });
  assert.equal(store.read().entries.filter((e) => e.key === '决定.砍掉l2').length, 1);
});

test('MemoryStore：文件不存在时读取为空而不抛错', () => {
  const dir = tempDir('missing');
  const store = new MemoryStore(path.join(dir, 'nope.md'), {});
  const result = store.read();
  assert.deepEqual(result, { exists: false, preamble: '', loose: '', entries: [] });
});

/* ------------------------------------------- 与用户手工编辑共存（关键行为） */

test('用户手改的记忆会被原样保留，工具的写入不会覆盖它', () => {
  const dir = tempDir('handedit');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, {});

  store.remember({ key: 'a', text: '工具写的' });

  // 模拟用户手工打开文件：加一条自己的记忆，并在末尾写一段自己的备注
  const edited = fs.readFileSync(file, 'utf8') + '\n这是我自己加的一句话。\n';
  fs.writeFileSync(file, edited, 'utf8');

  // 工具再写一次，不得抹掉用户的内容
  store.remember({ key: 'b', text: '工具又写的' });

  const { entries, loose, preamble } = store.read();
  const keys = entries.map((e) => e.key);
  assert.ok(keys.includes('a'), '原有条目应保留');
  assert.ok(keys.includes('b'), '新条目应写入');
  // 用户那段随手写的文字无论被归入保留区还是块外内容，都必须在文件里留存下来。
  assert.match(`${preamble}\n${loose}`, /这是我自己加的一句话/);
});

test('用户手工新增的条目会被读进来，并在下一次写入后仍然存在', () => {
  const dir = tempDir('handAdd');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, { title: 't' });
  store.remember({ key: 'a', text: '工具写的' });

  // 用户手工按格式追加一条
  fs.appendFileSync(file, '- `手工键` 这是我手动加的 <!-- @2026-10-01 src=human -->\n', 'utf8');
  let keys = store.read().entries.map((e) => e.key);
  assert.ok(keys.includes('手工键'), '手工新增的条目必须能读进来');
  assert.equal(store.read().entries.find((e) => e.key === '手工键').source, 'human');

  // 工具再写，手工条目不能消失
  store.remember({ key: 'b', text: '工具又写的' });
  keys = store.read().entries.map((e) => e.key);
  assert.deepEqual(keys.sort(), ['a', 'b', '手工键']);
});

test('记忆文件确实是人类可读的 Markdown', () => {
  const dir = tempDir('readable');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, { title: '用户长期记忆', marker: 'user v1' });
  store.remember({ key: '称呼', text: '叫长安', source: SOURCE.HUMAN, date: '2026-10-09' });

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^<!-- dsh-memory:user v1 -->/);
  assert.match(content, /^# 用户长期记忆$/m);
  assert.match(content, /^- `称呼` 叫长安 <!-- @2026-10-09 src=human -->$/m);
});

/* -------------------------------------------------- 重复写入不得让文件膨胀 */

/** 数一段文本里出现某个模式的次数。 */
function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

test('反复写入不会复制文件内容（回归：前言把旧头部当成用户内容抄回去）', () => {
  const dir = tempDir('noGrowth');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, { title: '用户长期记忆', marker: 'user v1' });

  for (let i = 0; i < 5; i += 1) {
    store.remember({ key: `键${i}`, text: `第 ${i} 条内容`, date: '2026-10-09' });
  }
  store.remember({ key: '键0', text: '第 0 条内容（已更新）', date: '2026-10-10' });

  const content = fs.readFileSync(file, 'utf8');
  assert.equal(countMatches(content, /<!-- dsh-memory:user v1 -->/g), 1, '文件标记只应出现一次');
  assert.equal(countMatches(content, /^# 用户长期记忆$/gm), 1, '标题只应出现一次');
  assert.equal(countMatches(content, /说明|这里记录/g), 0, '没有用户内容时不该出现说明块');
  assert.equal(countMatches(content, /以下内容由用户保留|user-notes/g), 0, '没有用户内容时不该出现保留区');
  assert.equal(countMatches(content, /^- `键\d`/gm), 5, '恰好 5 条条目行');
  assert.equal(store.read().entries.length, 5, '键0 是更新，不应变成 6 条');
});

test('反复写入时文件长度收敛而不是持续增长', () => {
  const dir = tempDir('converge');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, { title: 't', scopeNote: '说明段落' });

  store.remember({ key: 'a', text: '内容 A' });
  const afterFirst = fs.readFileSync(file, 'utf8');

  // 第一次之后写入的稳定形态是"无说明段落"的形态，因此以第二次为准比较后续是否漂移。
  store.remember({ key: 'a', text: '内容 A' });
  const afterSecond = fs.readFileSync(file, 'utf8');
  assert.notEqual(afterSecond, afterFirst, '首次写入带说明段落，第二次起不再重复写入');

  for (let i = 0; i < 10; i += 1) store.remember({ key: 'a', text: '内容 A' });
  assert.equal(fs.readFileSync(file, 'utf8'), afterSecond, '重复写入必须收敛到完全一致的字节');
  assert.equal(countMatches(afterSecond, /说明段落/g), 0, '说明段落不得被搬进用户保留区');
});

test('用户手写的说明只保留一份，且不会被下一次写入再抄一遍', () => {
  const dir = tempDir('userNote');
  const file = path.join(dir, 'm.md');
  const store = new MemoryStore(file, { title: 't' });
  store.remember({ key: 'a', text: '内容' });

  // 用户在文件末尾手写一段说明
  fs.appendFileSync(file, '\n我自己写的备注：别用 emoji。\n', 'utf8');
  store.remember({ key: 'b', text: '又一条' });

  let content = fs.readFileSync(file, 'utf8');
  assert.equal(countMatches(content, /我自己写的备注/g), 1, '用户备注应恰好出现一次');

  // 再写两次，仍然只有一份
  store.remember({ key: 'c', text: '第三条' });
  store.remember({ key: 'd', text: '第四条' });
  content = fs.readFileSync(file, 'utf8');
  assert.equal(countMatches(content, /我自己写的备注/g), 1, '多次写入后用户备注仍只有一份');
  // 用户的备注必须真的还在
  assert.ok(content.includes('别用 emoji'));
  assert.equal(store.read().entries.length, 4);
});

test('openUserMemory / openProjectMemory：落盘位置正确且不互相串', () => {
  const home = tempDir('open');
  const ws = 'D:\\proj\\alpha';

  const user = openUserMemory({ dshHome: home });
  const project = openProjectMemory(ws, { dshHome: home });

  user.remember({ key: '称呼', text: '叫长安' });
  project.remember({ key: '技术栈', text: 'TypeScript' });

  assert.equal(user.read().entries.length, 1);
  assert.equal(project.read().entries.length, 1);
  assert.equal(user.read().entries[0].key, '称呼');
  assert.equal(project.read().entries[0].key, '技术栈');

  // 另一个工作区的项目记忆必须与 alpha 完全隔离
  const other = openProjectMemory('D:\\proj\\beta', { dshHome: home });
  assert.deepEqual(other.read().entries, []);
});
