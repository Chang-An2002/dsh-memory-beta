/**
 * 路径与工作区标识。
 *
 * 落盘位置遵循 DSH 插件的既有约定（参考 `dsh-whale-widget` 的做法）：数据一律放在
 * `$DSH_HOME` 下，**不放 `node_modules`**。原因是插件目录可能被包管理器清理或在升级时
 * 重建，把用户数据放进去等于随时可能丢。
 *
 * ```
 * $DSH_HOME/memory/
 *   user.longterm.md              用户级长期记忆（跨所有工作区）
 *   projects/<工作区键>.longterm.md 项目级长期记忆
 *   index/<工作区键>.json          该工作区的知识库索引（可随时重建）
 * ```
 *
 * 工作区键由**规范化后的绝对路径**派生，而不是直接用路径当文件名：路径里有盘符、冒号、
 * 反斜杠、中文和空格，直接当文件名在 Windows 上会失败，跨平台也不可靠。
 */

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 记忆数据的根目录名（位于 `$DSH_HOME` 之下）。 */
export const MEMORY_DIR_NAME = 'memory';

/**
 * 解析 DSH 家目录。
 *
 * 与官方插件的做法一致：优先读 `DSH_HOME` 环境变量，未设置时退回 `~/.dsh`。
 * 不在这里创建目录——创建是写入方的职责，读路径不应产生副作用。
 *
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源，便于测试注入。
 * @returns {string} DSH 家目录绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 记忆数据根目录。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 可显式覆盖家目录。
 * @returns {string} 记忆根目录绝对路径。
 */
export function memoryRoot(options = {}) {
  const home = options.dshHome ?? resolveDshHome(options.env ?? process.env);
  return path.join(home, MEMORY_DIR_NAME);
}

/**
 * 把工作区路径规范化为稳定标识，用作文件名。
 *
 * 规范化步骤：转绝对路径 → 统一分隔符为 `/` → Windows 盘符转小写 → 去掉尾部分隔符。
 * 大小写只对盘符做归一，**不对整条路径做小写**：Windows 路径大小写不敏感、Linux 敏感，
 * 统一小写会在 Linux 上把两个不同目录合并成一个，那是静默的数据串台。
 *
 * @param {string} workspacePath - 工作区路径。
 * @returns {string} 规范化后的工作区标识。
 */
export function normalizeWorkspacePath(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    throw new TypeError('workspacePath must be a non-empty string');
  }
  let resolved = path.resolve(workspacePath).replace(/\\/g, '/');
  // Windows 盘符归一为小写：`C:/Users/x` 与 `c:/Users/x` 是同一个目录。
  resolved = resolved.replace(/^([A-Za-z]):\//, (_m, drive) => `${drive.toLowerCase()}:/`);
  if (resolved.length > 1 && resolved.endsWith('/')) resolved = resolved.slice(0, -1);
  return resolved;
}

/**
 * 由工作区路径派生的稳定短键，用作文件名。
 *
 * 形如 `my-project--eb75bda7`：前缀是人类可读的路径摘要（便于用户在 `memory/projects/`
 * 下认出哪个文件属于哪个项目），后缀是短哈希（保证唯一且与长度无关）。
 *
 * **可读部分会剥掉用户家目录前缀**：`C:\Users\somebody\secret-project` 若直接取末两段，
 * 键里就会出现用户名 `somebody`，而键会成为记忆文件名——那是把用户名写进插件数据目录，
 * 属于不必要的隐私暴露。剥掉家目录后只剩 `secret-project`。
 *
 * @param {string} workspacePath - 工作区路径。
 * @param {{ home?: string }} [options] - 家目录覆盖，便于测试。
 * @returns {string} 文件名安全的键。
 */
export function workspaceKey(workspacePath, options = {}) {
  const normalized = normalizeWorkspacePath(workspacePath);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);

  // 先剥掉家目录前缀（若确实位于家目录之下），避免把用户名带进文件名。
  const home = normalizeWorkspacePath(options.home ?? os.homedir());
  let relative = normalized;
  if (home !== '/' && (normalized === home || normalized.startsWith(`${home}/`))) {
    relative = normalized.slice(home.length).replace(/^\//, '');
  }

  const segments = relative.split('/').filter(Boolean);
  // 家目录之外的路径取末两段；家目录之内剥完后通常只剩项目名本身。
  const tail = relative === normalized ? segments.slice(-2) : segments;
  const readable = tail
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  return readable === '' ? digest : `${readable}--${digest}`;
}

/**
 * 用户级长期记忆文件路径。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {string} 绝对路径。
 */
export function userMemoryFile(options = {}) {
  return path.join(memoryRoot(options), 'user.longterm.md');
}

/**
 * 项目级长期记忆文件路径。
 * @param {string} workspacePath - 工作区路径。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {string} 绝对路径。
 */
export function projectMemoryFile(workspacePath, options = {}) {
  return path.join(memoryRoot(options), 'projects', `${workspaceKey(workspacePath)}.longterm.md`);
}

/**
 * 工作区索引文件路径。
 * @param {string} workspacePath - 工作区路径。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {string} 绝对路径。
 */
export function workspaceIndexFile(workspacePath, options = {}) {
  return path.join(memoryRoot(options), 'index', `${workspaceKey(workspacePath)}.json`);
}

/**
 * 同义词表路径（用户级，所有工作区共用）。
 *
 * 不做成项目级：同义说法（"实验设计 / 研究方法"）跨项目通用，而项目级文件若随仓库提交，
 * 每个项目各维护一份会立刻失同步。用户级一份、手改即生效。
 *
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @returns {string} 绝对路径。
 */
export function synonymsFile(options = {}) {
  return path.join(memoryRoot(options), 'synonyms.json');
}

/**
 * 校验一个路径确实位于给定根目录之内。
 *
 * 用于"模型给了个相对路径，要去读工作区里的文件"这条链路：`../../.ssh/id_rsa` 这类
 * 越界输入必须被挡住，否则一个检索工具就变成了任意文件读取工具。
 *
 * @param {string} root - 允许的根目录（绝对路径）。
 * @param {string} candidate - 待校验路径（绝对或相对 root）。
 * @returns {string} 规范化后的绝对路径。
 * @throws {Error} 当候选路径逃出根目录时。
 */
export function assertInside(root, candidate) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, candidate);
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === '') return targetAbs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace root: ${candidate}`);
  }
  return targetAbs;
}
