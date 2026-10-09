/**
 * 分词：中文按字符二元组（bigram）切分并过滤停用词，英文/数字按单词切分并过滤停用词。
 *
 * 移植自参考实现（arkseek/src/sparse_retriever.py）的 `tokenize()`。两条经验被刻意保留：
 *
 * 1. **中文不保留单字 token。** 参考实现在真实语料上踩过坑：单字和"什么"这类词在长文档里
 *    恰好只出现一两次，BM25 的 IDF 会把"语料里稀有"误当成"语言里重要"，让毫无信息量的
 *    常见字变成强匹配信号。中文最低以二元组为单位可以消掉这一整类假召回。
 * 2. **停用词表非可选。** 中文功能词与英文虚词在任意长文档里都高频，会稀释真正的关键词；
 *    只靠 IDF 压不到零。
 *
 * 不使用 jieba 等第三方分词器：一是插件要做到零运行时依赖（装完即用，不拉模型不联网），
 * 二是二元组在本项目的知识库语料上已经够用，且行为完全可预测、可单测。
 */

/** 匹配 CJK 统一表意文字（与参考实现的 `[一-鿿]` 等价区间）。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/;
/** 匹配英文与数字单词。 */
const WORD_PATTERN = /[A-Za-z0-9]+/g;

/** 中文功能词/停用词。参考实现的原表，保留原样以便回归对照。 */
export const ZH_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '都', '就',
  '而', '之', '其', '对于', '通过', '我们', '本文', '本课题', '这个',
  '那个', '什么', '怎么', '如何', '可以', '以及', '以', '为', '被',
  '把', '让', '使', '有', '无', '不', '很', '非常', '但',
  '但是', '因为', '所以', '如果', '这些', '那些', '一个', '一种',
  '进行', '具有', '存在', '属于', '由于', '由', '对', '从', '到',
  '上', '下', '中', '内', '外', '等', '着', '过', '呢', '吗', '啊',
]);

/** 英文停用词（知识库纳入英文文献后补的）。 */
export const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its',
  'we', 'our', 'they', 'their', 'which', 'what', 'how', 'who', 'whom', 'does', 'do', 'did', 'can',
  'could', 'would', 'should', 'may', 'might', 'not', 'no', 'but', 'if', 'than', 'then', 'into',
  'such', 'also', 'using', 'used', 'use', 'based', 'between', 'both', 'each', 'other', 'all',
]);

/**
 * 把一段文本切成检索 token。
 *
 * 中文部分先抽出全部 CJK 字符再两两相邻成组——注意这是**跨标点与跨空白**的：参考实现取的是
 * "所有 CJK 字符的序列"，因此 `"基因。组"` 会产出 `基因`、`因组`。这一行为被有意保留，
 * 因为改动它会同时改变既有语料上的召回表现，属于需要单独评测的变更，不应在移植时顺手"修好"。
 *
 * @param text - 任意文本；非字符串输入返回空数组。
 * @returns token 数组，顺序为「先英文单词，后中文二元组」。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const tokens = [];

  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0].toLowerCase();
    if (!EN_STOPWORDS.has(word)) tokens.push(word);
  }

  const cjkChars = [...text].filter((ch) => CJK_PATTERN.test(ch));
  for (let i = 0; i < cjkChars.length - 1; i += 1) {
    const bigram = cjkChars[i] + cjkChars[i + 1];
    if (!ZH_STOPWORDS.has(bigram)) tokens.push(bigram);
  }

  return tokens;
}
