/**
 * 稀疏检索：标准 Okapi BM25。
 *
 * 移植自参考实现（arkseek/src/sparse_retriever.py）的 `BM25Index`，参数与公式逐项保持一致，
 * 以便把两边的检索结果直接对照（同一份语料、同一个查询，两边 top-k 应当一致）。
 *
 * 公式：
 *   idf(t) = ln( (N - n_t + 0.5) / (n_t + 0.5) + 1 )      // BM25+ 平滑，保证非负
 *   score(q,d) = Σ_{t∈q} idf(t) * ( f(t,d) * (k1+1) ) / ( f(t,d) + k1 * (1 - b + b*|d|/avgdl) )
 *
 * k1=1.5、b=0.75 是行业常用默认值，与参考实现一致。
 */

import { tokenize } from './tokenize.js';

/** BM25 词频饱和参数。 */
export const DEFAULT_K1 = 1.5;
/** BM25 文档长度归一化参数。 */
export const DEFAULT_B = 0.75;

/**
 * 一个可检索文档（知识库片段）。
 * @typedef {object} Bm25Document
 * @property {string} id - 稳定标识（引用来源时要回传，不能只给下标）。
 * @property {string} text - 参与检索的正文。
 */

/**
 * 一条检索命中。
 * @typedef {object} Bm25Hit
 * @property {string} id - 文档标识。
 * @property {number} score - BM25 分数（未归一化，跨查询不可比）。
 * @property {number} rank - 名次，从 1 开始。
 */

/**
 * 内存 BM25 索引。构建是 O(总 token 数)，检索是 O(文档数)；对个人知识库规模足够，
 * 且换取了零依赖与完全确定的行为。
 */
export class Bm25Index {
  /**
   * @param {readonly Bm25Document[]} documents - 待索引文档。
   * @param {{ k1?: number, b?: number }} [options] - 覆盖默认 BM25 参数。
   */
  constructor(documents, options = {}) {
    if (!Array.isArray(documents)) throw new TypeError('documents must be an array');
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;

    /** @type {readonly Bm25Document[]} */
    this.documents = documents;
    /** @type {Map<string, number>[]} 每个文档的词频。 */
    this.termFreqs = documents.map((doc) => {
      const freqs = new Map();
      for (const token of tokenize(doc.text)) freqs.set(token, (freqs.get(token) ?? 0) + 1);
      return freqs;
    });
    /** @type {number[]} 每个文档的 token 数。 */
    this.docLens = this.termFreqs.map((freqs) => {
      let total = 0;
      for (const count of freqs.values()) total += count;
      return total;
    });
    this.avgDocLen = this.docLens.length > 0
      ? this.docLens.reduce((sum, len) => sum + len, 0) / this.docLens.length
      : 0;
    /** @type {number} 文档总数。 */
    this.nDocs = documents.length;

    /** @type {Map<string, number>} 文档频率：词出现在多少个文档里。 */
    this.docFreq = new Map();
    for (const freqs of this.termFreqs) {
      for (const term of freqs.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
  }

  /**
   * 逆文档频率（BM25+ 平滑）。
   * @param {string} term - 查询词。
   * @returns {number} 非负 idf。
   */
  idf(term) {
    const nT = this.docFreq.get(term) ?? 0;
    return Math.log((this.nDocs - nT + 0.5) / (nT + 0.5) + 1);
  }

  /**
   * 单个文档对查询的 BM25 分数。
   * @param {string[]} queryTokens - 已分词的查询。
   * @param {number} docIndex - 文档下标。
   * @returns {number} BM25 分数。
   */
  scoreTokens(queryTokens, docIndex) {
    const freqs = this.termFreqs[docIndex];
    if (freqs === undefined) return 0;

    const dl = this.docLens[docIndex];
    const avg = this.avgDocLen || 1;
    let score = 0;

    for (const term of queryTokens) {
      const f = freqs.get(term);
      if (f === undefined) continue;
      const numerator = f * (this.k1 + 1);
      const denominator = f + this.k1 * (1 - this.b + (this.b * dl) / avg);
      score += this.idf(term) * (numerator / denominator);
    }

    return score;
  }

  /**
   * 检索 top-k。
   *
   * 排序是确定性的：分数降序，同分按下标升序（参考实现的 `sort(key=score, reverse=True)` 对
   * 同分不做保证，这里收紧为稳定顺序，便于测试与复现）。
   *
   * @param {string} query - 原始查询文本。
   * @param {{ topK?: number, minScore?: number }} [options] - topK 默认 10；minScore 过滤低于该分的命中。
   * @returns {Bm25Hit[]} 命中列表，已按名次升序。
   */
  search(query, options = {}) {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;
    const queryTokens = tokenize(query);

    /** @type {Bm25Hit[]} */
    const scored = [];
    for (let i = 0; i < this.nDocs; i += 1) {
      const score = this.scoreTokens(queryTokens, i);
      if (score > minScore) scored.push({ id: this.documents[i].id, score, rank: 0 });
    }

    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const hits = scored.slice(0, topK);
    hits.forEach((hit, index) => { hit.rank = index + 1; });
    return hits;
  }
}
