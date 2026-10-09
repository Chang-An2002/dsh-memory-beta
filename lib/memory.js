/**
 * 长期记忆的存储层：人类可读的 Markdown 条目 + 可选来源标注。
 *
 * # 为什么不用数据库
 *
 * 记忆系统最怕的不是"存不下"，而是"模型偷偷记错了，还一路传下去"。所以本插件的记忆载体
 * 被刻意设计成**用户能直接打开、读懂、改掉**的 Markdown：用户不需要工具、不需要 SQL，
 * 用记事本就能纠正一条错误记忆。同时它天然进 git，团队可以共享项目级记忆。
 *
 * # 文件格式
 *
 * ```markdown
 * <!-- dsh-memory:user v1 -->
 * # 长期记忆
 *
 * 这里记录跨会话稳定成立的事实。可以直接手工编辑；读取时以此文件为准。
 *
 * - `称呼` 用户希望被称为「长安」。 <!-- @2026-10-09 src=human -->
 * - `技术栈` 主力语言是 Python 与 TypeScript。 <!-- @2026-10-09 src=model -->
 * ```
 *
 * 事实本身就是**条目文本**，人来读；结构化只体现为两点：
 * - 行首的 `` `键` `` 是条目的稳定标识（`主题.字段`），重复写入同一键即为更新而非新增；
 * - 行尾的 `<!-- @日期 src=来源 -->` 是元数据注释，渲染时不显示，缺失也能正常工作。
 *
 * 这样做的取舍是明确的：**结构信息全部可选**。用户随手写一行 `- 别用 emoji`（没有键、
 * 没有元数据）也能被读成一条记忆，键由内容派生。宁可结构松散，也不能因为格式严格而让
 * 用户手写的记忆"读不进来"。
 */

import fs from 'node:fs';
import path from 'node:path';

import { memoryRoot, userMemoryFile, projectMemoryFile } from './paths.js';

/** 文件头标记，用于未来做格式迁移；缺失时按 v1 处理。 */
export const MEMORY_FILE_MARKER = '<!-- dsh-memory:';

/** 说明段落的起始标记：插件自己生成，解析时整块跳过。 */
export const SCOPE_NOTE_MARKER = '<!-- scope-note -->';

/** 用户保留内容的起始标记。 */
export const RETAINED_MARKER = '<!-- user-notes -->';

/** 条目元数据注释：`<!-- @2026-10-09 src=model -->`。 */
const META_PATTERN = /<!--\s*@([\d-]+)(?:\s+src=([A-Za-z0-9_-]+))?(?:\s+ref=([^\s>]+))?\s*-->\s*$/;

/** 条目行：`- \`键\` 内容  <!-- 元数据 -->`。 */
const ENTRY_WITH_KEY = /^\s*[-*]\s+`([^`]+)`\s*(.*)$/;

/** 无键条目行：`- 内容`。 */
const ENTRY_BARE = /^\s*[-*]\s+(.*)$/;

/** 记忆来源。 */
export const SOURCE = Object.freeze({
  /** 用户自己说的或手写的；可信度最高。 */
  HUMAN: 'human',
  /** 模型通过工具写入的。 */
  MODEL: 'model',
});

/**
 * 一条记忆条目。
 * @typedef {object} MemoryEntry
 * @property {string} key - 稳定标识，形如 `主题.字段`（已规范化，用于匹配与去重）；无键条目由内容派生。
 * @property {string} [displayKey] - 用户书写时的键原文，仅当与规范化结果不同才存在，用于写回文件时不篡改大小写。
 * @property {string} text - 事实内容（不含键与元数据）。
 * @property {string} [updatedAt] - ISO 日期（`YYYY-MM-DD`）。
 * @property {string} [source] - `human` 或 `model`。
 * @property {string} [ref] - 可选的来源引用（文件路径、会话 id 等）。
 * @property {boolean} [derived] - 键是否由内容派生（原文件没有显式键）。
 */

/**
 * 解析一份记忆文件的内容。
 *
 * 文件由**结构化块**组成，解析器不需要猜测哪段是谁写的：
 *
 * ```markdown
 * <!-- dsh-memory:user v1 -->     ← 标记块（插件生成，跳过）
 * # 用户长期记忆                   ← 标题（插件生成，跳过）
 * <!-- scope-note -->             ← 说明块起点（插件生成，整块跳过）
 * …说明文字…
 * <!-- user-notes -->             ← 用户保留区起点（**原样保留**）
 * …用户手写的内容…
 * - `键` 条目 <!-- 元数据 -->      ← 条目行，键与元数据都可选
 * ```
 *
 * 早期版本靠"非条目行就是用户内容"来切分，结果插件自己写的说明段落被当成用户内容抄进
 * 保留区，第二次写入文件就翻倍——这个 bug 单靠"用户文字还在吗"的断言抓不到。
 *
 * 反过来，块结构也不能变成"块外内容一律丢弃"：用户很可能随手把一行备注写在条目中间。
 * 因此块外的非条目行会被收进 `loose`，由渲染方补上保留区标记后原样写回，**不丢用户输入**。
 *
 * @param {string} content - 文件原文。
 * @returns {{ preamble: string, loose: string, entries: MemoryEntry[] }} 保留区内容、块外散落内容与条目列表。
 */
export function parseMemory(content) {
  const text = typeof content === 'string' ? content : '';
  const lines = text.split('\n');

  const userLines = [];
  const looseLines = [];
  const entries = [];
  let inScopeNote = false;
  let inRetained = false;
  let sawTitle = false;
  /** 头部块已结束（用户内容与条目都可以从这里开始）。 */
  let headerDone = false;
  /** 已经离开"头部之后的空行区"，后续空行属于用户排版，必须保留。 */
  let inBody = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1) 文件标记：插件生成，跳过。
    if (trimmed.startsWith(MEMORY_FILE_MARKER)) {
      inScopeNote = false;
      headerDone = true;
      continue;
    }

    // 2) 说明块：插件生成，整块跳过。
    if (trimmed === SCOPE_NOTE_MARKER) {
      inScopeNote = true;
      inRetained = false;
      headerDone = true;
      continue;
    }

    // 3) 用户保留区起点。
    if (trimmed === RETAINED_MARKER) {
      inRetained = true;
      inScopeNote = false;
      headerDone = true;
      continue;
    }

    if (inScopeNote) {
      // 说明块由"紧跟标题的一段文字 + 一个空行"构成。空行即结束。
      // 额外的健壮性：一旦遇到条目或块标记也立即结束——格式要求说明文字必须是单行段落，
      // 但用户手工编辑时可能删掉那个空行，这时不能把后面整份文件都吞掉。
      const looksLikeContent = /^\s*[-*]\s+/.test(line)
        || trimmed.startsWith(MEMORY_FILE_MARKER)
        || trimmed === SCOPE_NOTE_MARKER
        || trimmed === RETAINED_MARKER;
      if (trimmed === '' || looksLikeContent) {
        inScopeNote = false;
        if (trimmed === '') continue;
      } else {
        continue;
      }
    }

    // 4) 标记块之后的第一个 `#` 行是插件写的标题；其余 `#` 行归用户。
    if (!inRetained && !sawTitle && /^#\s/.test(trimmed)) {
      sawTitle = true;
      headerDone = true;
      continue;
    }

    // 5) 标题之后、内容之前的空行属于插件排版，丢弃；之后的空行是用户排版，保留。
    if (!inRetained && !inBody && trimmed === '') continue;

    if (inRetained) {
      if (trimmed !== '') userLines.push(line);
      continue;
    }

    // 6) 条目行：必须在这里判定，不能等循环结束再说，否则"条目之间"的位置无从判断。
    if (/^\s*[-*]\s+/.test(line)) {
      inBody = true;
      const parsed = parseEntryLine(line);
      if (parsed) entries.push(parsed);
      continue;
    }

    // 7) 块外的非空内容：用户随手写在条目之间的东西，交给 loose 保留。
    if (trimmed !== '') {
      inBody = true;
      looseLines.push(line);
    } else if (headerDone && inBody) {
      looseLines.push(line);
    }
  }

  const normalize = (arr) => arr.join('\n').replace(/^[\s\n]+|[\s\n]+$/g, '');
  return {
    preamble: normalize(userLines),
    loose: normalize(looseLines),
    entries: dedupeByKey(entries),
  };
}

/**
 * 解析单个条目行。
 * @param {string} line - 形如 `- \`键\` 内容 <!-- @日期 src=来源 -->`。
 * @returns {MemoryEntry | null} 解析结果，无法识别时返回 null。
 */
function parseEntryLine(line) {
  let body = line;
  let updatedAt;
  let source;
  let ref;
  const meta = META_PATTERN.exec(body);
  if (meta) {
    body = body.slice(0, meta.index);
    updatedAt = meta[1];
    source = meta[2];
    ref = meta[3];
  }

  const withKey = ENTRY_WITH_KEY.exec(body);
  let key;
  let displayKey;
  let text;
  let derived = false;

  if (withKey) {
    const raw = withKey[1].trim();
    key = normalizeKey(raw);
    // 保留用户书写时的原始形态，用于写回文件。规范化键只用于匹配与去重，
    // 若把规范化结果当成显示值，用户写的 `决定.砍掉L2` 会在一次往返后变成 `决定.砍掉l2`。
    displayKey = raw === key ? undefined : raw;
    text = withKey[2].trim();
  } else {
    const bare = ENTRY_BARE.exec(body);
    if (!bare) return null;
    text = bare[1].trim();
    key = deriveKey(text);
    derived = true;
  }

  if (text === '' && key === '') return null;
  return { key, displayKey, text, updatedAt, source, ref, derived };
}

/**
 * 为无键条目派生一个稳定键。
 *
 * 用内容本身的摘要，保证同一行内容重复出现时解析出同一个键，从而幂等；用户之后若给它
 * 补上显式键，就把派生键换掉。
 *
 * @param {string} text - 条目内容。
 * @returns {string} 派生键。
 */
export function deriveKey(text) {
  const normalized = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return `auto-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 同键去重，后者覆盖前者（文件里靠后的定义生效，符合"后来的写入更新旧值"的直觉）。
 * @param {MemoryEntry[]} entries - 条目列表。
 * @returns {MemoryEntry[]} 去重后的列表，保持首次出现的顺序。
 */
function dedupeByKey(entries) {
  /** @type {Map<string, MemoryEntry>} */
  const byKey = new Map();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    byKey.set(entry.key, existing ? { ...existing, ...entry } : entry);
  }
  return [...byKey.values()];
}

/**
 * 渲染记忆文件内容。
 *
 * @param {{ preamble?: string, entries: MemoryEntry[], title: string, scopeNote?: string, marker: string }} options - 渲染参数。
 * @returns {string} 完整的 Markdown 文本。
 */
export function renderMemory(options) {
  const { entries, title, scopeNote, marker, preamble, loose } = options;
  const head = [`${MEMORY_FILE_MARKER}${marker} -->`, `# ${title}`, ''];
  // scopeNote 只在首次创建时写入一次，并且带显式块标记，让解析器能整块跳过。
  if (scopeNote) head.push(SCOPE_NOTE_MARKER, scopeNote, '');
  const body = entries.map(renderEntry);
  // 保留区内容 = 原有保留区 + 块外散落内容。两者都在重写时原样带上，用户输入永不丢失。
  const retained = [preamble, loose].filter((part) => part && part.trim() !== '').join('\n\n');
  const tail = retained ? ['', RETAINED_MARKER, retained, ''] : [''];
  return [...head, ...body, ...tail].join('\n').replace(/\n{3,}$/, '\n');
}

/**
 * 渲染单个条目行。
 * @param {MemoryEntry} entry - 条目。
 * @returns {string} Markdown 行。
 */
export function renderEntry(entry) {
  const shownKey = entry.displayKey ?? entry.key;
  const keyPart = entry.derived ? '' : `\`${shownKey}\` `;
  const meta = [];
  if (entry.updatedAt) meta.push(`@${entry.updatedAt}`);
  if (entry.source) meta.push(`src=${entry.source}`);
  if (entry.ref) meta.push(`ref=${entry.ref}`);
  const metaPart = meta.length > 0 ? ` <!-- ${meta.join(' ')} -->` : '';
  return `- ${keyPart}${entry.text}${metaPart}`;
}

/**
 * 读取一份记忆文件。
 *
 * @param {string} file - 文件绝对路径。
 * @returns {{ exists: boolean, preamble: string, loose: string, entries: MemoryEntry[] }} 读取结果；文件不存在时返回空结构而非抛错。
 */
export function readMemoryFile(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { exists: true, ...parseMemory(content) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, preamble: '', loose: '', entries: [] };
    throw err;
  }
}

/**
 * 原子写入文本文件。
 *
 * 先写同目录临时文件再 `rename`：`rename` 在同一文件系统内是原子的，因此读者要么看到旧
 * 内容、要么看到新内容，不会被截断的半个文件误导。记忆文件被用户手工编辑时尤其重要。
 *
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 文件内容。
 * @returns {void}
 */
export function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw err;
  }
}

/**
 * 记忆库：绑定一个具体文件，提供增删查改。
 *
 * 每次写入都是"读取当前文件 → 应用变更 → 原子写回"，因此：
 * - 与用户的手工编辑天然共存（不会用内存里的旧快照覆盖用户刚改的内容）；
 * - 幂等：同一键重复写入只是更新那一行。
 */
export class MemoryStore {
  /**
   * @param {string} file - 记忆文件绝对路径。
   * @param {{ title: string, scopeNote: string, marker: string }} [meta] - 文件的标题与说明。
   */
  constructor(file, meta = {}) {
    this.file = file;
    this.title = meta.title ?? '长期记忆';
    this.scopeNote = meta.scopeNote ?? '这里记录跨会话稳定成立的事实。可以直接手工编辑。';
    this.marker = meta.marker ?? 'memory';
  }

  /**
   * 读取全部条目。
   * @returns {{ exists: boolean, preamble: string, loose: string, entries: MemoryEntry[] }} 读取结果。
   */
  read() {
    return readMemoryFile(this.file);
  }

  /**
   * 写入或更新一条记忆。
   *
   * @param {{ key: string, text: string, source?: string, ref?: string, date?: string }} input - 条目内容。
   * @returns {{ entry: MemoryEntry, created: boolean }} 写入结果。
   */
  remember(input) {
    const rawKey = String(input.key ?? '').trim();
    const key = normalizeKey(rawKey);
    const text = String(input.text ?? '').trim();
    if (key === '') throw new Error('memory key must not be empty');
    if (text === '') throw new Error('memory text must not be empty');

    const current = this.read();
    const today = input.date ?? new Date().toISOString().slice(0, 10);
    const entry = {
      key,
      // 保留调用方书写的大小写，写回文件时按原样呈现。
      ...(rawKey !== key ? { displayKey: rawKey } : {}),
      text,
      updatedAt: today,
      source: input.source ?? SOURCE.MODEL,
      ...(input.ref ? { ref: input.ref } : {}),
    };

    const index = current.entries.findIndex((e) => e.key === key);
    const created = index < 0;
    const entries = [...current.entries];
    if (created) entries.push(entry);
    else entries[index] = { ...entries[index], ...entry, derived: false };

    // scopeNote 只在文件尚不存在（首次创建）时写入，避免每次重写堆积重复段落。
    this.#persist(current.preamble, entries, !current.exists, current.loose);
    return { entry, created };
  }

  /**
   * 删除一条记忆。
   *
   * 支持按精确键删除，也支持按内容子串匹配（`query`），后者返回被删条目以便向用户复述
   * 到底删掉了什么——静默删除是危险的，用户需要看到删的是什么。
   *
   * @param {{ key?: string, query?: string }} target - 删除目标。
   * @returns {{ removed: MemoryEntry[] }} 被删除的条目。
   */
  forget(target) {
    const current = this.read();
    const key = target.key === undefined ? undefined : normalizeKey(target.key);
    const query = target.query === undefined ? undefined : String(target.query).trim().toLowerCase();
    if (key === undefined && (query === undefined || query === '')) {
      throw new Error('forget requires either key or query');
    }

    const removed = [];
    const entries = current.entries.filter((entry) => {
      const match = key !== undefined
        ? entry.key === key
        : entry.text.toLowerCase().includes(query);
      if (match) removed.push(entry);
      return !match;
    });

    if (removed.length > 0) this.#persist(current.preamble, entries, false, current.loose);
    return { removed };
  }

  /**
   * 在记忆里做子串检索。
   *
   * 记忆条目数量级远小于知识库，因此这里刻意不上 BM25：子串匹配的结果更容易向用户解释，
   * 也更容易预测（"我搜到什么"与"我看到什么"一致）。
   *
   * @param {string} query - 查询文本。
   * @param {{ limit?: number }} [options] - 返回上限。
   * @returns {MemoryEntry[]} 命中的条目。
   */
  search(query, options = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    if (q === '') return [];
    const limit = options.limit ?? 20;
    const terms = q.split(/\s+/).filter(Boolean);
    return this.read().entries
      .filter((entry) => {
        const haystack = `${entry.key} ${entry.text}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, limit);
  }

  /**
   * 把给定内容写回文件。
   * @param {string} preamble - 用户保留内容。
   * @param {MemoryEntry[]} entries - 条目列表。
   * @param {boolean} [withScopeNote] - 是否写入说明段落（仅首次创建时）。
   * @returns {void}
   */
  #persist(preamble, entries, withScopeNote = false, loose = '') {
    const content = renderMemory({
      entries,
      preamble,
      loose,
      title: this.title,
      scopeNote: withScopeNote ? this.scopeNote : undefined,
      marker: this.marker,
    });
    writeFileAtomic(this.file, content);
  }
}

/**
 * 规范化键：统一小写、把空白与点号序列收敛成单点，使 `技术栈.语言` 与 `技术栈 . 语言` 等价。
 * @param {string} key - 原始键。
 * @returns {string} 规范化键。
 */
export function normalizeKey(key) {
  return String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*\.\s*/g, '.')
    .replace(/[.\s]{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
}

/**
 * 打开用户级长期记忆库。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {MemoryStore} 记忆库实例。
 */
export function openUserMemory(options = {}) {
  return new MemoryStore(userMemoryFile(options), {
    title: '用户长期记忆',
    scopeNote: '这里记录**跨所有项目**都稳定成立的事实：称呼、长期偏好、工作习惯。可以直接手工编辑。',
    marker: 'user v1',
  });
}

/**
 * 打开某个工作区的项目级长期记忆库。
 * @param {string} workspacePath - 工作区路径。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {MemoryStore} 记忆库实例。
 */
export function openProjectMemory(workspacePath, options = {}) {
  return new MemoryStore(projectMemoryFile(workspacePath, options), {
    title: `项目长期记忆：${path.basename(workspacePath)}`,
    scopeNote: '这里记录**仅在本项目内**成立的既定决策、技术栈与踩过的坑。可以直接手工编辑，也建议提交进仓库与团队共享。',
    marker: 'project v1',
  });
}

export { memoryRoot };
