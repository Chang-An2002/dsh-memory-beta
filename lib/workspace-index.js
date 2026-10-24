/**
 * 工作区索引：把文件切分并持久化，供检索使用。
 *
 * 三条设计约束：
 *
 * 1. **索引不是事实源。** 原始文档在工作区里，索引只是它的可检索投影。删掉索引不丢任何
 *    信息，只是下次检索前需要重建。这与参考实现"SQLite 是原记录、Chroma 是可重建索引"
 *    的判断一致。
 * 2. **增量更新按内容指纹。** 指纹 = 字节数 + 内容 SHA-256。只改动过的文件重新切分，
 *    其余直接复用旧片段——这决定了在一份大仓库上执行 `kb_index` 是"瞬间完成"还是"每次
 *    都从头算"。
 * 3. **索引文件是纯 JSON。** 不上数据库、不上原生模块：用户可以直接打开看它索引了什么，
 *    也可以随时删掉。
 */

import fs from 'node:fs';
import path from 'node:path';

import { workspaceIndexFile } from './paths.js';
import { writeFileAtomic } from './memory.js';
import { walkWorkspace, readIndexableFile, DEFAULT_MAX_FILE_BYTES } from './walk.js';
import { chunkBySections } from './chunking.js';

/**
 * 索引格式版本。格式变化时递增，旧索引会被判定为不可用并重建。
 *
 * v2：文档条目新增 `mtimeMs`（过期检测的快筛字段）。v1 索引会被自动丢弃重建一次，
 * 用户无感——索引本来就只是可重建的投影。
 */
export const INDEX_VERSION = 2;

/**
 * 索引中的一个文档条目。
 * @typedef {object} IndexedDocument
 * @property {string} docId - 相对工作区的路径。
 * @property {string} fingerprint - 内容指纹。
 * @property {number} bytes - 字节数。
 * @property {number} mtimeMs - 建索引时的修改时间（毫秒）。只用于**快筛**，不作为事实依据。
 * @property {number} chunks - 片段数。
 */

/**
 * 工作区索引。
 *
 * 内存中的形态是为检索优化的：一个扁平的片段数组 + 并行的文档元数据表。
 */
export class WorkspaceIndex {
  /**
   * @param {{ version?: number, workspace?: string, builtAt?: string, documents?: Record<string, IndexedDocument>, chunks?: object[] }} [data] - 初始数据。
   */
  constructor(data = {}) {
    this.version = data.version ?? INDEX_VERSION;
    this.workspace = data.workspace ?? '';
    this.builtAt = data.builtAt ?? '';
    /** @type {Record<string, IndexedDocument>} */
    this.documents = data.documents ?? {};
    /** @type {import('./chunking.js').Chunk[]} */
    this.chunks = data.chunks ?? [];
  }

  /** 已索引的文档数。 */
  get documentCount() {
    return Object.keys(this.documents).length;
  }

  /** 已索引的片段数。 */
  get chunkCount() {
    return this.chunks.length;
  }

  /**
   * 从磁盘读取索引。
   *
   * 版本不匹配或文件损坏时返回空索引而不是抛错：索引是可重建的派生物，
   * 遇到坏文件应当重建，而不是让工具调用失败。
   *
   * @param {string} workspacePath - 工作区路径。
   * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
   * @returns {WorkspaceIndex} 索引实例（可能是空的）。
   */
  static load(workspacePath, options = {}) {
    const file = workspaceIndexFile(workspacePath, options);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return new WorkspaceIndex({ workspace: workspacePath });
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== INDEX_VERSION) return new WorkspaceIndex({ workspace: workspacePath });
      return new WorkspaceIndex(parsed);
    } catch {
      return new WorkspaceIndex({ workspace: workspacePath });
    }
  }

  /**
   * 写回磁盘。
   * @param {string} workspacePath - 工作区路径。
   * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
   * @returns {string} 写入的索引文件路径。
   */
  save(workspacePath, options = {}) {
    const file = workspaceIndexFile(workspacePath, options);
    this.workspace = workspacePath;
    writeFileAtomic(file, JSON.stringify({
      version: INDEX_VERSION,
      workspace: this.workspace,
      builtAt: this.builtAt,
      documents: this.documents,
      chunks: this.chunks,
    }));
    return file;
  }

  /**
   * 按片段 id 查片段。
   * @param {string} id - 片段 id。
   * @returns {object | undefined} 片段。
   */
  chunkById(id) {
    return this.chunks.find((chunk) => chunk.id === id);
  }
}

/**
 * 索引构建结果。
 * @typedef {object} IndexResult
 * @property {WorkspaceIndex} index - 构建后的索引。
 * @property {{ added: string[], updated: string[], removed: string[], unchanged: number }} changes - 变更明细。
 * @property {{ files: number, chunks: number, truncated: boolean, skipped: number }} stats - 统计。
 */

/**
 * 构建或增量更新工作区索引。
 *
 * @param {string} workspacePath - 工作区绝对路径。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string, maxBytes?: number, maxFiles?: number, signal?: AbortSignal, previous?: WorkspaceIndex }} [options] - 构建选项。
 * @returns {IndexResult} 构建结果。
 */
export function buildIndex(workspacePath, options = {}) {
  const previous = options.previous ?? WorkspaceIndex.load(workspacePath, options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  const walked = walkWorkspace(workspacePath, {
    maxFiles: options.maxFiles,
    signal: options.signal,
  });

  /** @type {Record<string, IndexedDocument>} */
  const documents = {};
  /** @type {object[]} */
  const chunks = [];
  const added = [];
  const updated = [];
  let unchanged = 0;

  // 旧片段按文档分组一次，供"未变文件"复用。
  //
  // 这里早先写的是对每个未变文件遍历**全部**旧片段（`for (const chunk of previous.chunks)`），
  // 复杂度是 O(文件数 × 片段数)：实测 2000 个文件 / 8 万个片段时，单是这一步就要约 2.5 秒，
  // 而它做的事只是"把没变的片段搬过来"。分组后是 O(片段数)。
  /** @type {Map<string, object[]>} */
  const previousChunksByDoc = new Map();
  for (const chunk of previous.chunks) {
    const bucket = previousChunksByDoc.get(chunk.docId);
    if (bucket === undefined) previousChunksByDoc.set(chunk.docId, [chunk]);
    else bucket.push(chunk);
  }

  for (const docId of walked.files) {
    if (options.signal?.aborted) break;
    const abs = path.join(workspacePath, docId);
    const read = readIndexableFile(abs, { maxBytes });
    if (read === null) continue; // 二进制 / 过大 / 不可读

    const old = previous.documents[docId];
    if (old && old.fingerprint === read.fingerprint) {
      // 内容未变：复用旧片段，不重新切分。
      // 即便如此也要刷新 mtime：否则"mtime 变了但内容没变"的文件会永远被快筛判为可疑，
      // 每次都白读一遍（git checkout、格式化保存都会造成这种情况）。
      unchanged += 1;
      documents[docId] = { ...old, mtimeMs: read.mtimeMs };
      const reusable = previousChunksByDoc.get(docId);
      if (reusable !== undefined) chunks.push(...reusable);
      continue;
    }

    const produced = chunkBySections(read.content, docId);
    documents[docId] = {
      docId,
      fingerprint: read.fingerprint,
      bytes: read.bytes,
      mtimeMs: read.mtimeMs,
      chunks: produced.length,
    };
    chunks.push(...produced);
    if (old) updated.push(docId);
    else added.push(docId);
  }

  // 已消失的文件
  const removed = Object.keys(previous.documents).filter((docId) => documents[docId] === undefined);

  chunks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const index = new WorkspaceIndex({
    version: INDEX_VERSION,
    workspace: workspacePath,
    builtAt: new Date().toISOString(),
    documents,
    chunks,
  });

  return {
    index,
    changes: { added, updated, removed, unchanged },
    stats: {
      files: Object.keys(documents).length,
      chunks: chunks.length,
      truncated: walked.truncated,
      skipped: walked.skipped,
    },
  };
}

/**
 * 过期检测的结果条目。
 * @typedef {object} StaleCheck
 * @property {string} docId - 相对工作区的路径。
 * @property {'added' | 'modified' | 'removed'} kind - 变化种类。
 */

/**
 * 检查索引是否已经过期——也就是"工作区现在的样子"和"索引里记的样子"是否一致。
 *
 * ## 为什么需要它
 *
 * `kb_index` 是手动触发的，插件不监听文件变化。用户改完文档忘了重新索引，
 * `kb_search` 会**照旧内容理直气壮地回答**，而且完全不报错。这条限制的危险之处不在
 * "答得不好"，而在"错得很安静"。
 *
 * ## 怎么做到既准又快
 *
 * 两级判断（实测：55 个文件的工作区里，全量重算指纹约 5 ms，纯 stat 约 0.5 ms）：
 *
 * 1. **快筛**：比对 `mtimeMs`。大部分文件在这里就排除了，不读内容。
 * 2. **确认**：只有 `mtime` 变了的文件才重新读盘算指纹。指纹一致 → 判定为**没变**，
 *    这正是 `git checkout`、格式化保存这类"时间变了内容没变"的情况。
 *
 * 只要跳过第 2 步、直接按 `mtime` 判定，就会把上面那类操作全报成"过期"，
 * 然后触发一次没必要的大规模重建——那是拿准确性换速度，本函数不这么做。
 *
 * 新增/消失的文件顺带一起报（多一个文件往往正是用户最需要重索引的时刻）。
 *
 * @param {WorkspaceIndex} index - 已加载的索引。
 * @param {string} workspacePath - 工作区绝对路径。
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [options] - 选项。
 * @returns {StaleCheck[]} 变化的文件列表；空数组表示索引是最新的。
 */
export function checkStaleness(index, workspacePath, options = {}) {
  const stale = [];
  const seen = new Set();

  const walked = walkWorkspace(workspacePath, {
    maxFiles: options.maxFiles,
    signal: options.signal,
  });

  for (const docId of walked.files) {
    if (options.signal?.aborted) break;
    seen.add(docId);

    const known = index.documents[docId];
    if (known === undefined) {
      stale.push({ docId, kind: 'added' });
      continue;
    }

    const abs = path.join(workspacePath, docId);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      // 刚被删掉，当作 removed（下面按索引侧再兜一次）
      stale.push({ docId, kind: 'removed' });
      continue;
    }

    // 快筛：时间没动就直接认为没变，省掉一次读盘 + 哈希
    if (Number.isFinite(known.mtimeMs) && stat.mtimeMs === known.mtimeMs) continue;

    // 时间动了，用内容指纹定论
    const read = readIndexableFile(abs, { maxBytes: options.maxBytes });
    if (read === null) continue; // 现在读不了了（变大/变二进制/权限），不当作变化
    if (read.fingerprint !== known.fingerprint) stale.push({ docId, kind: 'modified' });
  }

  // 索引里有、工作区里已经没有了
  for (const docId of Object.keys(index.documents)) {
    if (seen.has(docId)) continue;
    stale.push({ docId, kind: 'removed' });
  }

  return stale;
}
