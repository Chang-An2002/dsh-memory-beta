/**
 * 检索编排：索引 → 稀疏召回 → RRF 融合 → 证据组装。
 *
 * 这一层是整个插件对外的主入口。它刻意保持"多路召回 + RRF 融合"的形状，**即使当前只有
 * BM25 一路**。原因是加入稠密召回时应该是"多一路输入"，而不是重写编排逻辑——这正是 RRF
 * 只看名次、不看原始分数的工程价值。
 *
 * 检索器接口（`{ route, search(query, options) }`）就是为这件事预留的：将来接入 embedding
 * 只需实现同一个接口并放进 `retrievers` 数组，融合、充分性判定、证据组装都不用改。
 */

import { Bm25Index } from './bm25.js';
import { reciprocalRankFusion } from './fusion.js';
import {
  assessSufficiency,
  selectPassages,
  buildEvidenceBlock,
  formatLocation,
} from './evidence.js';

/** 默认召回深度：每路取多少个候选进入融合。 */
export const DEFAULT_TOP_K = 20;

/** 最终返回给上层处理的片段数上限（在预算裁剪之前）。 */
export const DEFAULT_MAX_PASSAGES = 12;

/**
 * 用索引里的片段构造 BM25 稀疏检索器。
 *
 * 构造时会建一张 `id → 片段` 的表。这一步不能省：早先的实现是在每次命中时
 * `chunks.find(...)`，命中 20 条、片段 8 万条时就是 160 万次比较；更要紧的是
 * **BM25 索引本身**（对全部片段分词）在每次检索都要重做一遍——所以调用方应当缓存返回的
 * 检索器，而不是每次新建。工具层已经这么做了（见 `index.js` 的 `retrieverFor`）。
 *
 * @param {{ id: string, text: string }[]} chunks - 片段列表。
 * @returns {{ route: string, search: (query: string, options?: object) => object[] }} 检索器。
 */
export function createSparseRetriever(chunks) {
  const index = new Bm25Index(chunks);
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return {
    route: 'bm25',
    search(query, options = {}) {
      const topK = options.topK ?? DEFAULT_TOP_K;
      const hits = index.search(query, { topK });
      return hits.map((hit) => {
        const chunk = byId.get(hit.id);
        return {
          id: hit.id,
          score: hit.score,
          rank: hit.rank,
          docId: chunk?.docId ?? hit.id,
          text: chunk?.text ?? '',
          startLine: chunk?.startLine,
          endLine: chunk?.endLine,
          headingPath: chunk?.headingPath,
        };
      });
    },
  };
}

/** 同义扩展问法的融合权重。半权：它能参与投票，但压不过同名的原查询结果。 */
export const SYNONYM_ROUTE_WEIGHT = 0.5;

/**
 * 一次完整的检索。
 *
 * `options.queryVariants` 用来接同义说法表：每个额外问法都作为**独立的一路召回**参与融合。
 * 这样做而不是"把同义词拼进原查询"，有两个好处：原查询的排序不被改写；某一路扩展偏了
 * 也不会把原查询的好结果挤掉（RRF 只看名次，多一路只是多一份投票）。
 *
 * 扩展路的权重是原查询的一半（见 `SYNONYM_ROUTE_WEIGHT`）：同义表是人手写的，写错一组
 * 不该让一个不相关片段拿到与原查询首位相同的分数。
 *
 * @param {object} input - 输入。
 * @param {import('./index.js').WorkspaceIndex} input.index - 工作区索引。
 * @param {string} input.query - 查询文本。
 * @param {{ retrievers?: object[], topK?: number, maxPassages?: number, evidenceBudget?: object, queryVariants?: string[] }} [input.options] - 选项。
 * @returns {{ query: string, fused: object[], passages: object[], sufficiency: { level: string, reasons: string[] }, dropped: object[], routes: { route: string, count: number }[] }} 检索结果。
 */
export function search({ index, query, options = {} }) {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const maxPassages = options.maxPassages ?? DEFAULT_MAX_PASSAGES;

  // 默认只有稀疏一路；调用方传入 retrievers 即可加入更多路（例如将来的 embedding）。
  const retrievers = options.retrievers ?? [createSparseRetriever(index.chunks)];

  // 原查询 + 同义扩展问法。每个问法 × 每个检索器 = 一路；只有一路时行为与从前完全一致。
  const queries = [query, ...(Array.isArray(options.queryVariants) ? options.queryVariants : [])];
  const routeResults = [];
  for (const [queryIndex, variant] of queries.entries()) {
    for (const retriever of retrievers) {
      routeResults.push({
        // 名字要让人一眼看懂：它会出现在"只有某一路给出命中"这类诊断里
        route: queryIndex === 0 ? retriever.route : `${retriever.route}（同义扩展 ${queryIndex}）`,
        weight: queryIndex === 0 ? 1 : SYNONYM_ROUTE_WEIGHT,
        hits: retriever.search(variant, { topK }),
      });
    }
  }

  const fusedHits = reciprocalRankFusion(routeResults, { topK: maxPassages });

  // 融合结果只带回 id 与分数，这里补齐片段正文与来源位置。
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
  const passages = fusedHits
    .map((hit) => {
      const chunk = byId.get(hit.id);
      if (!chunk) return null;
      return {
        id: chunk.id,
        docId: chunk.docId,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        headingPath: chunk.headingPath,
        fusedScore: hit.score,
        contributions: hit.contributions,
      };
    })
    .filter(Boolean);

  const sufficiency = assessSufficiency({ fused: fusedHits, routes: routeResults });
  const { selected, dropped } = selectPassages(passages, options.evidenceBudget);

  return {
    query,
    fused: fusedHits,
    passages: selected,
    sufficiency,
    dropped,
    routes: routeResults.map((r) => ({ route: r.route, count: r.hits.length })),
  };
}

/**
 * 检索并直接产出交给模型的证据文本。
 *
 * @param {object} input - 输入。
 * @param {import('./index.js').WorkspaceIndex} input.index - 工作区索引。
 * @param {string} input.query - 查询文本。
 * @param {object} [input.options] - 传给 `search` 的选项。
 * @returns {{ text: string, sufficiency: { level: string, reasons: string[] }, sources: { location: string, docId: string, startLine?: number, endLine?: number, score: number }[] }} 证据文本、充分性与来源清单。
 */
export function searchWithEvidence({ index, query, options = {} }) {
  const result = search({ index, query, options });
  const text = buildEvidenceBlock({
    sufficiency: result.sufficiency,
    passages: result.passages,
    query,
  });
  const sources = result.passages.map((passage) => ({
    location: formatLocation(passage),
    docId: passage.docId,
    startLine: passage.startLine,
    endLine: passage.endLine,
    score: passage.fusedScore,
  }));
  return { text, sufficiency: result.sufficiency, sources, passages: result.passages };
}
