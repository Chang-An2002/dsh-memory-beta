/**
 * 证据组装：把召回结果变成「能引用、可判断是否可信」的上下文。
 *
 * 这是本插件区别于普通 grep 的关键，也是参考实现里"防幻觉"落在**检索侧**的那一半。
 * 核心判断是：**可靠性不该靠生成阶段纠错，而该靠检索阶段的证据质量。** 具体三条：
 *
 * 1. **每条证据都带可定位的来源**（`路径:起始行-结束行`）。模型引用时能落到具体行，
 *    用户能自己点开核对。没有来源的"知识"和模型编的没有区别。
 * 2. **证据不足时明确说不足**，而不是把弱相关片段塞给模型让它自由发挥。参考实现的
 *    真机测试反复踩过这一类问题：把不相关的内容当成依据，回答看起来有理有据却是错的。
 * 3. **不要用绝对分数当阈值**。BM25 分数的量级取决于语料规模与查询长度，跨查询不可比；
 *    同一个 5.0 在一份小文档里是强匹配，在十万片段的语料里可能什么都不是。因此本模块
 *    只用**相对信号**（有没有命中、分布是否陡峭、两路是否一致）来判定充分性。
 *
 * 参考实现在 `pipeline.py` 里用 `BM25_FLOOR = 5.0` 这类绝对阈值，是在**单份固定语料**上
 * 标定出来的；移植到一个每个人的语料都不同的插件里，那套数字不再成立，这是刻意不照搬的部分。
 */

/** 证据充分性等级。 */
export const SUFFICIENCY = Object.freeze({
  /** 完全没有命中。 */
  NONE: 'none',
  /** 有命中但明显偏弱：只共享少量词、或分数分布平坦。 */
  WEAK: 'weak',
  /** 有可信命中，可以据此回答。 */
  OK: 'ok',
});

/** 默认的证据预算。 */
export const DEFAULT_EVIDENCE_BUDGET = Object.freeze({
  /** 最多纳入的片段数。 */
  maxPassages: 6,
  /** 纳入片段的近似 token 总预算。 */
  maxTokens: 1800,
  /** 单个片段保留的最大字符数，超出则截断。 */
  maxCharsPerPassage: 1200,
  /** 同一文档最多贡献几个片段（避免整段证据来自一个文件）。 */
  maxPerDocument: 2,
});

/**
 * 判定证据充分性。
 *
 * 只看相对信号：
 * - 一条命中都没有 → `none`；
 * - 命中数少于 2，或最高分与中位数接近（分布平坦，说明"到处都是弱匹配"而不是"有一处强匹配"）
 *   → `weak`；
 * - 其余 → `ok`。
 *
 * 另外会检查"多路一致性"：如果同时提供了稀疏与稠密两路，而**只有一路**给出命中，
 * 会降级为 `weak` 并说明原因——单路命中往往意味着另一路在说"语义上并不相关"。
 *
 * @param {{ fused?: { score: number }[], routes?: { route: string, hits: unknown[] }[] }} input - 融合结果与各路命中。
 * @returns {{ level: string, reasons: string[] }} 判定结果与理由（理由会原样交给模型，便于它自己判断）。
 */
export function assessSufficiency(input) {
  const fused = Array.isArray(input?.fused) ? input.fused : [];
  const routes = Array.isArray(input?.routes) ? input.routes : [];
  const reasons = [];

  if (fused.length === 0) {
    return { level: SUFFICIENCY.NONE, reasons: ['检索没有返回任何片段。'] };
  }

  const scores = fused.map((hit) => hit.score).filter((s) => Number.isFinite(s));
  const top = scores[0] ?? 0;
  const median = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0;

  if (fused.length < 2) {
    reasons.push('只召回到一个片段，无法交叉印证。');
  }

  // 分布平坦：最高分并不比中位数突出多少，说明命中普遍很弱。
  // 用 1.15 这个宽松倍数而不是精确阈值：RRF 分数本身是 1/(k+rank) 的和，量级很小，
  // 这里只关心"是否存在一个明显突出的领先者"。
  if (fused.length >= 3 && median > 0 && top < median * 1.15) {
    reasons.push('命中分数分布平坦，缺乏明显突出的片段，可能是普遍弱匹配而非精确命中。');
  }

  // 多路一致性：只在提供了多路时检查。
  const nonEmptyRoutes = routes.filter((r) => Array.isArray(r.hits) && r.hits.length > 0);
  if (routes.length >= 2 && nonEmptyRoutes.length === 1) {
    reasons.push(`只有 ${nonEmptyRoutes[0].route} 一路给出命中，另一路没有，说明匹配可能只停留在字面而非语义。`);
  }

  const level = reasons.length > 0 ? SUFFICIENCY.WEAK : SUFFICIENCY.OK;
  return { level, reasons };
}

/**
 * 按预算挑选要纳入上下文的片段。
 *
 * 两个约束同时生效：
 * - **token 预算**：总长度受控，避免把上下文撑爆；
 * - **文档多样性**：同一文档最多贡献 `maxPerDocument` 个片段。没有这一条时，一个文档
 *   若在检索里占满前排，证据会全来自它，模型看不到别的来源是否也支持同一结论。
 *
 * @param {{ id: string, docId: string, text: string, startLine?: number, endLine?: number, tokens?: number, headingPath?: string }[]} passages - 已按相关性排序的片段。
 * @param {{ maxPassages?: number, maxTokens?: number, maxCharsPerPassage?: number, maxPerDocument?: number }} [budget] - 预算覆盖。
 * @returns {{ selected: object[], dropped: object[], tokensUsed: number }} 选中片段、因预算被丢弃的片段与用量。
 */
export function selectPassages(passages, budget = {}) {
  const {
    maxPassages = DEFAULT_EVIDENCE_BUDGET.maxPassages,
    maxTokens = DEFAULT_EVIDENCE_BUDGET.maxTokens,
    maxCharsPerPassage = DEFAULT_EVIDENCE_BUDGET.maxCharsPerPassage,
    maxPerDocument = DEFAULT_EVIDENCE_BUDGET.maxPerDocument,
  } = budget;

  const selected = [];
  const dropped = [];
  const perDocument = new Map();
  let tokensUsed = 0;

  for (const passage of passages) {
    if (selected.length >= maxPassages) {
      dropped.push({ ...passage, reason: 'count' });
      continue;
    }
    const used = perDocument.get(passage.docId) ?? 0;
    if (used >= maxPerDocument) {
      dropped.push({ ...passage, reason: 'document-diversity' });
      continue;
    }
    const cost = estimateCost(passage.text, maxCharsPerPassage);
    if (tokensUsed + cost > maxTokens && selected.length > 0) {
      dropped.push({ ...passage, reason: 'token-budget' });
      continue;
    }
    selected.push({ ...passage, truncated: passage.text.length > maxCharsPerPassage });
    perDocument.set(passage.docId, used + 1);
    tokensUsed += cost;
  }

  return { selected, dropped, tokensUsed };
}

/**
 * 估算一个片段纳入上下文后的 token 开销。
 *
 * 与切分共用同一套近似口径（中文按字、英文按词），只为预算服务，不追求精确分词。
 *
 * @param {string} text - 片段正文。
 * @param {number} maxChars - 截断上限。
 * @returns {number} 近似 token 数。
 */
function estimateCost(text, maxChars) {
  const body = text.length > maxChars ? text.slice(0, maxChars) : text;
  const cjk = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = (body.match(/[A-Za-z][A-Za-z0-9'\-]*/g) ?? []).length;
  const numbers = (body.match(/\d+/g) ?? []).length;
  return Math.ceil(cjk + 1.3 * words + numbers);
}

/**
 * 把片段列表渲染成带来源标注的证据块。
 *
 * 输出格式刻意做成"每条证据都有编号与可定位来源"，因为模型需要能引用编号、用户需要能点开核对。
 *
 * @param {{ id: string, docId: string, text: string, startLine?: number, endLine?: number, headingPath?: string }[]} passages - 片段列表。
 * @param {{ maxCharsPerPassage?: number }} [options] - 单片段截断上限。
 * @returns {string} 证据块文本。
 */
export function formatEvidence(passages, options = {}) {
  const maxChars = options.maxCharsPerPassage ?? DEFAULT_EVIDENCE_BUDGET.maxCharsPerPassage;
  const lines = [];

  passages.forEach((passage, index) => {
    const location = formatLocation(passage);
    lines.push(`[${index + 1}] ${location}`);
    if (passage.headingPath) lines.push(`    章节：${passage.headingPath}`);
    const body = truncateSnippet(passage.text, maxChars);
    for (const line of body.split('\n')) lines.push(`    ${line}`);
    lines.push('');
  });

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * 渲染 `路径:起始行-结束行` 形式的来源定位。
 *
 * 行号是必须的：只有文件名时，模型无法在长文档里指出依据在哪一段，用户也无法核对。
 *
 * @param {{ docId: string, startLine?: number, endLine?: number }} passage - 片段。
 * @returns {string} 来源标签。
 */
export function formatLocation(passage) {
  if (!Number.isFinite(passage.startLine)) return passage.docId;
  const start = passage.startLine;
  const end = Number.isFinite(passage.endLine) ? passage.endLine : start;
  return end > start ? `${passage.docId}:${start}-${end}` : `${passage.docId}:${start}`;
}

/**
 * 截断片段正文，并**避免把围栏代码块切一半**。
 *
 * 截断到代码块中间会产生语法不完整的片段，模型读到半截代码容易给出错误结论；
 * 因此若截断点落在未闭合的围栏内，就回退到该围栏开始之前。
 *
 * @param {string} text - 片段正文。
 * @param {number} maxChars - 字符上限。
 * @returns {string} 截断后的正文（未截断时原样返回）。
 */
export function truncateSnippet(text, maxChars) {
  if (text.length <= maxChars) return text;

  const cut = text.slice(0, maxChars);
  const lines = cut.split('\n');
  let fences = 0;
  let lastFenceLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fences += 1;
      lastFenceLine = i;
    }
  }
  // 奇数个围栏说明截断点落在代码块内部，回退到最后一个围栏之前。
  const safeLines = fences % 2 === 1 && lastFenceLine > 0
    ? lines.slice(0, lastFenceLine)
    : lines;

  return `${safeLines.join('\n')}\n…（片段已截断，完整内容见来源）`;
}

/**
 * 组装交给模型的完整证据段。
 *
 * 三种情况分别给出不同措辞，这是"置信度兜底"的落地点：
 * - `none`：明确说没有找到，并**指示模型不要凭训练知识作答**；
 * - `weak`：给出片段，但同时说明为什么它可能不可靠，让模型自己决定是否采信；
 * - `ok`：直接给出证据。
 *
 * @param {{ sufficiency: { level: string, reasons: string[] }, passages: object[], query?: string }} input - 判定结果与片段。
 * @returns {string} 交给模型的文本。
 */
export function buildEvidenceBlock(input) {
  const { sufficiency, passages, query } = input;
  const head = query ? `检索：${query}` : '检索结果';

  if (sufficiency.level === SUFFICIENCY.NONE) {
    return [
      `${head}`,
      '',
      '结果：工作区知识库里没有找到与查询相关的内容。',
      '',
      '请直接告诉用户"在你给我的资料里没找到"，并说明你检索的是什么范围。',
      '不要用你自己的训练知识把这个空缺补上——用户此刻要的是他资料的答案，不是通用知识。',
    ].join('\n');
  }

  const body = formatEvidence(passages);
  if (sufficiency.level === SUFFICIENCY.WEAK) {
    return [
      `${head}`,
      '',
      '结果：只找到可能相关的片段，**可信度不足**。',
      ...sufficiency.reasons.map((r) => `- ${r}`),
      '',
      '使用这些片段时请说明把握程度，不要把它们当作确定结论。若无法回答问题，如实说明。',
      '',
      '--- 片段 ---',
      body,
    ].join('\n');
  }

  return [
    `${head}`,
    '',
    '结果：找到以下相关片段。回答时请标注引用的来源（形如 `路径:行号`）。',
    '',
    '--- 片段 ---',
    body,
  ].join('\n');
}
