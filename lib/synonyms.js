/**
 * 同义说法表：查询扩展。
 *
 * ## 这个模块存在的理由（有实测数字）
 *
 * 词面匹配最典型的失败不是"排得不好"，而是"根本没有共同词"。参考实现（ArkSeek）在
 * 课题报告上的记录：问"这个课题的实验设计"查不到，因为报告里写的是"拟采取的研究方法/
 * 技术路线/试验方案"——用户用口语问，文档用栏目名写。
 *
 * 它的 A/B 结果是所有尝试里单点收益最大的：固定集过门槛 7/15 → **14/15**（`query_synonyms.py`）。
 * 同轮还试过"只加章节标题路径"，那一项单独用反而降到 4/15。所以按证据排序，
 * 这一项应当优先于其它召回改动（见 `MIGRATION.md` 第 4 节）。
 *
 * ## 为什么是"查询扩展"而不是"改索引"
 *
 * 索引是事实源的投影，改索引意味着每次改表都要重建。而查询扩展只在一次检索里多跑一路，
 * 改表立即生效、随时可删。代价是每次检索多一点计算——在 BM25 上是毫秒级。
 *
 * ## 表是人维护的，不是自动学的
 *
 * 同义词表最大的风险是"猜错"：自动学出来的关联词一旦错了，检索会静默给出不相关的结果。
 * 人工维护的表结果确定、可审阅、可以随领域演进——这与本项目"记忆必须可人工审阅"是同一个判断。
 *
 * ## 文件格式
 *
 * `$DSH_HOME/memory/synonyms.json`：
 *
 * ```json
 * {
 *   "groups": [
 *     ["实验设计", "技术方案", "研究方法", "试验方案"],
 *     ["缓存", "快取", "cache"]
 *   ]
 * }
 * ```
 *
 * 一个数组就是一组"说的是一回事"的说法。问法里出现组内任何一个，就把组内**其它**说法
 * 追加成额外问法。没有这个文件、格式不对、读不出来，都当作"没有同义词表"处理——
 * 这条路径永远不能影响检索本身。
 */

import fs from 'node:fs';

import { synonymsFile } from './paths.js';

/** 一组最多多少个说法（防止单个组把查询撑爆）。 */
const MAX_TERMS_PER_GROUP = 20;

/** 一个说法最长多少字符（同义词不该是句子）。 */
const MAX_TERM_LENGTH = 40;

/** 默认最多生成几个额外问法（与参考实现的 MAX_VARIANTS 一致：2）。 */
export const MAX_VARIANTS = 2;

/** 每个额外问法最多追加几个说法。 */
const MAX_APPENDED_TERMS = 6;

/**
 * 解析同义词表的内容。
 *
 * 校验从宽、失败给原因：表是给人手写的，写错一个字符不该让整个检索失效。
 * 不合法的组会被跳过，而不是让整张表作废。
 *
 * @param {string} raw - 文件内容。
 * @returns {{ groups: string[][], warnings: string[] }} 合法分组与告警。
 */
export function parseSynonymGroups(raw) {
  const warnings = [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { groups: [], warnings: [`同义词表不是合法 JSON：${error.message}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) {
    return { groups: [], warnings: ['同义词表缺少 groups 数组'] };
  }

  const groups = [];
  parsed.groups.forEach((group, index) => {
    if (!Array.isArray(group)) {
      warnings.push(`groups[${index}] 不是数组，已跳过`);
      return;
    }
    const terms = [];
    for (const term of group) {
      if (typeof term !== 'string') {
        warnings.push(`groups[${index}] 含非字符串项，已跳过`);
        continue;
      }
      const trimmed = term.trim();
      if (trimmed === '' || trimmed.length > MAX_TERM_LENGTH) continue;
      if (!terms.includes(trimmed)) terms.push(trimmed);
    }
    if (terms.length >= 2) groups.push(terms.slice(0, MAX_TERMS_PER_GROUP));
    else if (terms.length === 1) warnings.push(`groups[${index}] 只有一个有效说法，无法构成同义组`);
  });

  return { groups, warnings };
}

/**
 * 读取同义词表（带缓存）。
 *
 * 缓存以文件 `mtimeMs + size` 为版本戳：改过表就重新读，没改过就不重复解析。
 * 同一个版本的解析告警只报一次，避免每次检索都刷屏。
 *
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - 家目录覆盖。
 * @param {(message: string) => void} [report] - 告警回调（默认写 stderr）。
 * @returns {string[][]} 同义组；没有表或表不可用时为空数组。
 */
export function loadSynonymGroups(options = {}, report) {
  const file = synonymsFile(options);

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    CACHE.delete(file);
    return [];
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = CACHE.get(file);
  if (cached !== undefined && cached.stamp === stamp) return cached.groups;

  const { groups, warnings } = parseSynonymGroups(safeRead(file));
  if (warnings.length > 0) {
    const notify = report ?? ((message) => {
      try {
        // eslint-disable-next-line no-console
        console.error(`[dsh-memory] ${message}`);
      } catch { /* 日志失败不影响检索 */ }
    });
    for (const warning of warnings) notify(warning);
  }
  CACHE.set(file, { stamp, groups });
  return groups;
}

/** 读文件；失败返回空串（解析后会变成"没有表"）。 */
function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 文件版本 → 解析结果。 */
const CACHE = new Map();

/** 清空缓存（仅测试与"用户刚改完表"的场景需要）。 */
export function clearSynonymCache() {
  CACHE.clear();
}

/**
 * 用同义词表把一个问题扩展成若干个额外问法。
 *
 * 追加而不是替换：原问题始终保留，扩展问法只作为一个**额外的召回通道**参与 RRF 融合。
 * 所以同义词表写错的最坏后果是"多了一路没用甚至略偏的召回"，而不是"把原来的好结果挤掉"——
 * 融合只看名次，一路偏了不会让另一路消失。
 *
 * @param {string} query - 原始问法。
 * @param {string[][]} groups - 同义组。
 * @param {{ maxVariants?: number }} [options] - 最多几个额外问法。
 * @returns {string[]} 额外问法；没有命中任何组时为空数组。
 */
export function expandQuery(query, groups, options = {}) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const maxVariants = options.maxVariants ?? MAX_VARIANTS;
  const lowerQuery = query.toLowerCase();
  const variants = [];

  for (const group of groups) {
    // 组内任何一个说法出现在问法里，这一组就算命中。
    // 英文比较用大小写无关，中文本来就是同样的字符。
    const hit = group.some((term) => lowerQuery.includes(term.toLowerCase()));
    if (!hit) continue;

    const extra = group
      .filter((term) => !lowerQuery.includes(term.toLowerCase()))
      .slice(0, MAX_APPENDED_TERMS);
    // 问法里已经把这一组说全了，就没有可扩展的东西
    if (extra.length === 0) continue;

    variants.push(`${query}（${extra.join(' ')}）`);
    if (variants.length >= maxVariants) break;
  }

  return variants;
}
