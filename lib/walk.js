/**
 * 工作区文件发现。
 *
 * 决定"知识库包含哪些文件"。这不是纯技术细节，而是会影响用户信任的边界：
 * 索引范围必须**可预测、可解释**，用户要能回答"它到底读了什么"。
 * 因此这里的规则是白名单扩展名 + 明确的跳过目录，而不是花哨的启发式。
 *
 * 刻意**不跟随符号链接**：一个指向仓库外的软链会把工作区之外的文件悄悄纳入索引，
 * 那是用户无法预期的越界读取。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 默认参与索引的扩展名。纯文本与代码/文档格式，不做二进制解析。 */
export const DEFAULT_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.mdx',
  '.txt', '.text', '.rst', '.adoc',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql', '.graphql', '.proto',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
]);

/** 默认跳过的目录名（任意层级）。 */
export const DEFAULT_SKIP_DIRS = Object.freeze([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', '.idea', '.vscode', '.DS_Store',
]);

/** 默认跳过的文件名/后缀（构建产物、锁文件、压缩包）。 */
export const DEFAULT_SKIP_FILES = Object.freeze([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'poetry.lock',
  'composer.lock', 'Gemfile.lock',
]);

/** 单个文件的大小上限（字节）。超过则跳过——通常是数据文件或压缩产物，不是文档。 */
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** 遍历文件时的默认上限，防止在超大仓库里耗尽内存。 */
export const DEFAULT_MAX_FILES = 5000;

/**
 * 判断一个相对路径是否应当被索引。
 *
 * @param {string} relPath - 相对工作区的路径（使用 `/` 分隔）。
 * @param {{ extensions?: readonly string[], skipDirs?: readonly string[], skipFiles?: readonly string[] }} [options] - 规则覆盖。
 * @returns {boolean} 是否参与索引。
 */
export function shouldIndexFile(relPath, options = {}) {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set(options.skipFiles ?? DEFAULT_SKIP_FILES);

  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  // 任一目录段命中跳过名单即整体跳过
  for (const segment of segments.slice(0, -1)) {
    if (skipDirs.has(segment)) return false;
  }

  const base = segments[segments.length - 1];
  if (skipFiles.has(base)) return false;

  // 我们的记忆文件放在工作区时（团队共享场景）也不参与检索，避免"记忆污染知识库"
  if (segments[0] === '.dsh-memory') return false;

  const ext = path.extname(base).toLowerCase();
  return extensions.includes(ext);
}

/**
 * 递归遍历工作区，返回可索引文件的相对路径列表。
 *
 * @param {string} root - 工作区绝对路径。
 * @param {{ extensions?: readonly string[], skipDirs?: readonly string[], skipFiles?: readonly string[], maxFiles?: number, signal?: AbortSignal }} [options] - 遍历选项。
 * @returns {{ files: string[], truncated: boolean, skipped: number }} 文件列表（已排序，保证顺序确定）、是否因上限截断、被跳过的条目数。
 */
export function walkWorkspace(root, options = {}) {
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = [];
  let truncated = false;
  let skipped = 0;

  /** @type {string[]} */
  const queue = [''];
  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const rel = queue.shift();
    const abs = rel === '' ? root : path.join(root, rel);

    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      // 权限不足或目录消失：跳过而不是让整次索引失败
      skipped += 1;
      continue;
    }

    for (const entry of entries) {
      if (options.signal?.aborted) break;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        // 不跟随软链：避免把工作区之外的内容纳入索引
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          skipped += 1;
          continue;
        }
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      // 扩展名不符也算 skipped：用户排查"我的文件为什么没被索引"时，这个计数是唯一线索。
      if (!shouldIndexFile(childRel, options)) {
        skipped += 1;
        continue;
      }

      if (files.length >= maxFiles) {
        truncated = true;
        skipped += 1;
        continue;
      }
      files.push(childRel);
    }
  }

  files.sort();
  return { files, truncated, skipped };
}

/**
 * 读取一个文件并返回其内容与指纹。
 *
 * 指纹 = 字节长度 + 内容 SHA-256。**基于内容而不是修改时间**：`mtime` 在复制、检出、
 * 切换分支时会变化但内容不变，用它会触发无谓的重建；反过来，内容被改写但 `mtime` 被
 * 刻意保留（或时间分辨率不足）时会漏掉更新。内容哈希两边都不会错。
 *
 * @param {string} absPath - 文件绝对路径。
 * @param {{ maxBytes?: number }} [options] - 大小上限。
 * @returns {{ content: string, fingerprint: string, bytes: number } | null} 读取结果；过大或不可读时返回 null。
 */
export function readIndexableFile(absPath, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return null;
  }

  // 二进制探测：出现 NUL 字节就当作二进制内容，跳过而不是把乱码塞进索引。
  if (buffer.includes(0)) return null;

  const content = buffer.toString('utf8');
  // 替换字符过多说明不是有效 UTF-8
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  if (content.length > 0 && replacementCount / content.length > 0.01) return null;

  return { content, fingerprint: fingerprintOf(buffer), bytes: buffer.length };
}

/**
 * 计算内容指纹。
 * @param {Buffer} buffer - 文件内容。
 * @returns {string} 形如 `<字节数>-<sha256 前 16 位>`。
 */
export function fingerprintOf(buffer) {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  return `${buffer.length}-${hash}`;
}
