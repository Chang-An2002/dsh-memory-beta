/**
 * 融合排序：Reciprocal Rank Fusion（RRF）。
 *
 * 移植自参考实现（arkseek/src/fusion.py）。核心特点是**只看名次、不看原始分数**：
 *
 *   score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * 这天然解决了 BM25 分数与余弦相似度量纲不一致的问题（前者的量级取决于语料与查询长度，
 * 后者固定在 [-1,1]），因此无需为两路召回做分数归一化或调参。k 取 60（Elasticsearch 默认）。
 */

/** RRF 平滑常数默认值。 */
export const DEFAULT_RRF_K = 60;

/**
 * 一路召回结果中的一条命中。
 * @typedef {object} RankedHit
 * @property {string} id - 文档标识。
 * @property {number} [score] - 该路的原始分数；RRF 不使用它，仅作透传/调试。
 * @property {number} [rank] - 该路名次，从 1 开始；省略时按数组顺序推断。
 */

/**
 * 一条融合结果。
 * @typedef {object} FusedHit
 * @property {string} id - 文档标识。
 * @property {number} score - RRF 融合分数。
 * @property {number} rank - 融合后名次，从 1 开始。
 * @property {{ route: string, rank: number, score: number | undefined }[]} contributions - 该文档在各路中的贡献明细，用于解释「为什么它排在这」。
 */

/**
 * 融合多路召回。
 *
 * @param {{ route: string, hits: readonly RankedHit[] }[]} rankings - 各路召回结果，每路已按自身分数降序。
 * @param {{ k?: number, topK?: number }} [options] - k 默认 60；topK 省略时返回全部融合结果。
 * @returns {FusedHit[]} 融合结果，按分数降序（同分按 id 升序，保证确定性）。
 */
export function reciprocalRankFusion(rankings, options = {}) {
  if (!Array.isArray(rankings)) throw new TypeError('rankings must be an array');
  const k = options.k ?? DEFAULT_RRF_K;

  /** @type {Map<string, { score: number, contributions: { route: string, rank: number, score: number | undefined }[] }>} */
  const fused = new Map();

  for (const ranking of rankings) {
    if (ranking === null || typeof ranking !== 'object' || !Array.isArray(ranking.hits)) {
      throw new TypeError('each ranking must be { route, hits }');
    }
    const route = ranking.route;

    ranking.hits.forEach((hit, index) => {
      const rank = typeof hit.rank === 'number' && hit.rank > 0 ? hit.rank : index + 1;
      const entry = fused.get(hit.id) ?? { score: 0, contributions: [] };
      entry.score += 1 / (k + rank);
      entry.contributions.push({ route, rank, score: hit.score });
      fused.set(hit.id, entry);
    });
  }

  /** @type {FusedHit[]} */
  const out = [];
  for (const [id, entry] of fused) {
    out.push({ id, score: entry.score, rank: 0, contributions: entry.contributions });
  }
  out.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const limited = options.topK === undefined ? out : out.slice(0, options.topK);
  limited.forEach((hit, index) => { hit.rank = index + 1; });
  return limited;
}
