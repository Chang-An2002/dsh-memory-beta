/**
 * 结构感知切分（Chunking）。
 *
 * 参考实现（arkseek/src/chunking.py）在这件事上迭代了三代，每一代都对应一个真实故障：
 *
 * 1. `chunk_text()` —— 按空行分段 + 按**字符数**二次切分。适合连续中文散文，但英文里
 *    200 字符只有三十来个词，一篇论文会被切碎，每段都缺上下文。
 * 2. `chunk_document()` —— 改按 **token 数**切（一个中文字≈1 token，一个英文单词≈1.3），
 *    段落边界处切、过长再按句子切、相邻片段按整句重叠。解决了英文文献的问题。
 * 3. `chunk_by_sections()` —— 按**章节结构**切，片段不跨章节，并给每个片段前缀一行
 *    `【文档 › 一级标题 › 二级标题】`。触发原因是：问"这个课题的实验设计"查不到，
 *    因为报告里写的是"技术路线/试验方案"，而片段正文里一个"方案""方法"都没有——
 *    检索只看片段正文，标题里的词完全用不上。
 *
 * 第三代是收益最大的一代：**把标题路径写进片段正文，BM25 / 向量 / 精排三路都能用上
 * 标题里的词**，代价只是几个字节。这比换一个更好的 embedding 模型便宜得多，因此本移植
 * 直接以第三代为底座。
 *
 * 相对参考实现的两处扩展，都是为了适配 DSH 的语境（知识库以 Markdown 文档为主）：
 * - **支持 Markdown ATX 标题**（`#` 到 `######`），并识别围栏代码块，避免代码里的 `#`
 *   被误当成标题；
 * - **每个片段记录起止行号**，因为工具返回的引用要能落到 `file:line`，这是编码 agent
 *   场景的硬需求，参考实现的 `source_file` 标签不足以定位。
 */

/** CJK 统一表意文字。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/g;
/** 英文单词（允许内部连字符与撇号）。 */
const EN_WORD_PATTERN = /[A-Za-z][A-Za-z0-9'\-]*/g;
/** 数字串。 */
const NUMBER_PATTERN = /\d+/g;
/** 句子边界：中英句末标点后切，或英文句号后跟空格加大写/括号。 */
const SENTENCE_SPLIT = /(?<=[。！？；!?;])|(?<=\.)\s+(?=[A-Z(\[])/;
/** 单个"句子"的 token 上限；表格或无标点列表会被硬切。 */
const MAX_SENTENCE_TOKENS = 400;

/**
 * 单个切分单元的**字符数**上限，作为 token 预算的兜底。
 *
 * 必需的原因：`approxTokens()` 对既无 CJK、又无英文单词、又无数字的内容（base64 串、
 * 压缩后的代码、纯符号行）几乎返回 0，长度预算对这类内容失效——实测中 2000 个 `x`
 * 曾被整体塞进一个片段。字符数是最后一层保障。
 */
const MAX_UNIT_CHARS = 1200;

/**
 * 重叠尾巴的字符上限。
 *
 * 重叠的作用是给下一片段一点上文，几百字符足够（约一两句），因此取一个小的固定上限，
 * 保证"单元上限 + 重叠上限"构成片段长度的**可证明上界**（1200 + 2 + 300 = 1502），
 * 而不是让重叠随上一片段变长而放大。
 */
const MAX_OVERLAP_CHARS = 300;

/**
 * 切分产出的一个片段。
 * @typedef {object} Chunk
 * @property {string} id - 稳定标识，形如 `<文档标识>#<序号>`。
 * @property {string} docId - 来源文档标识（通常是相对工作区的路径）。
 * @property {string} text - 片段正文，**已包含标题路径前缀**。
 * @property {string} [headingPath] - 标题路径，如 `3. 存储选型 › 3.2 索引`。
 * @property {number} startLine - 片段正文起始行（1 基，指向前缀之后的第一行内容）。
 * @property {number} endLine - 片段正文结束行（1 基，含）。
 * @property {number} tokens - 近似 token 数。
 * @property {string} lang - `zh` 或 `en`。
 */

/**
 * 近似 token 数：一个中文字≈1，一个英文单词≈1.3，一个数字串≈1。
 *
 * 不引入真正的分词器：这里只需要一个稳定的**长度预算单位**，而不是精确计数。参考实现
 * 用同一公式在真实语料上调出了 320/50 这两个默认值，沿用即可保持行为可比。
 *
 * @param {string} text - 任意文本。
 * @returns {number} 近似 token 数（非整数）。
 */
export function approxTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const words = (text.match(EN_WORD_PATTERN) ?? []).length;
  const numbers = (text.match(NUMBER_PATTERN) ?? []).length;
  return cjk + 1.3 * words + numbers;
}

/**
 * 判定文本语种：CJK 字符数不少于英文单词数即为中文。
 * @param {string} text - 任意文本。
 * @returns {'zh' | 'en'} 语种标签。
 */
export function detectLang(text) {
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const words = (text.match(EN_WORD_PATTERN) ?? []).length;
  return cjk >= words ? 'zh' : 'en';
}

/**
 * 把段落切成句子；过长的"句子"（表格行、无标点列表、base64 串）按字符数硬切。
 * @param {string} paragraph - 一个段落。
 * @returns {string[]} 句子数组。
 */
function sentences(paragraph) {
  const parts = String(paragraph).split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let sent of parts) {
    while (approxTokens(sent) > MAX_SENTENCE_TOKENS || sent.length > MAX_UNIT_CHARS) {
      const tooManyTokens = approxTokens(sent) > MAX_SENTENCE_TOKENS;
      const cut = tooManyTokens
        ? Math.max(Math.floor(sent.length / 2), 1)
        : MAX_UNIT_CHARS;
      out.push(sent.slice(0, cut));
      sent = sent.slice(cut);
    }
    if (sent) out.push(sent);
  }
  return out;
}

/**
 * 按 token 预算切分一段**无标题结构**的正文。
 *
 * 行为与参考实现的 `chunk_document()` 对齐：按段落累加到 `maxTokens` 左右成片；单个段落
 * 超长则先按句子拆开；相邻片段之间按**整句**保留约 `overlapTokens` 的重叠，避免一句话被
 * 切成两半后两边都读不懂。
 *
 * @param {string} text - 正文。
 * @param {{ maxTokens?: number, overlapTokens?: number, startLine?: number }} [options] - 预算参数；`startLine` 用于把行号基准传递进来。
 * @returns {{ text: string, startLine: number, endLine: number, tokens: number }[]} 片段（无 id / 无标题前缀）。
 */
export function chunkDocument(text, options = {}) {
  const maxTokens = options.maxTokens ?? 320;
  const overlapTokens = options.overlapTokens ?? 50;
  const baseLine = options.startLine ?? 1;
  if (typeof text !== 'string' || text.trim() === '') return [];

  // 逐段记录其在原文中的起始行，使片段能回指真实行号。
  /** @type {{ text: string, line: number }[]} */
  const paragraphs = [];
  {
    const raw = text.split('\n');
    let buffer = [];
    let bufferStart = baseLine;
    const flush = () => {
      const body = buffer.join('\n').trim();
      if (body) paragraphs.push({ text: body, line: bufferStart });
      buffer = [];
    };
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i].trim() === '') {
        flush();
      } else {
        // 段落首行的绝对行号：baseLine 是本段文本在原始文档中的起始行，
        // 加数组下标即得。不要用"上一个空行"的位置，那会稳定偏 1。
        if (buffer.length === 0) bufferStart = baseLine + i;
        buffer.push(raw[i]);
      }
    }
    flush();
  }

  /** @type {{ text: string, line: number, tokens: number }[]} */
  const units = [];
  // 行号必须**累加**推进，不能靠"段落缓冲区起始下标 + 基准行"推算：段落可能自身跨多行，
  // 且段落之间还有空行，用下标会随着文档变长持续偏低。
  let nextLine = baseLine;
  for (const para of paragraphs) {
    const paraLines = countLines(para.text);
    if (approxTokens(para.text) <= maxTokens && para.text.length <= MAX_UNIT_CHARS) {
      units.push({ text: para.text, line: nextLine, tokens: approxTokens(para.text) });
      nextLine += paraLines + 1;
      continue;
    }
    const parts = sentences(para.text);
    for (const part of parts) {
      units.push({ text: part, line: nextLine, tokens: approxTokens(part) });
      nextLine += countLines(part);
    }
    nextLine += 1;
  }

  /** @type {{ text: string, startLine: number, endLine: number, tokens: number }[]} */
  const chunks = [];
  let current = [];
  let currentStart = baseLine;
  let currentTokens = 0;
  let lastLine = baseLine;

  const flush = () => {
    const body = current.join('\n\n').trim();
    if (body) {
      chunks.push({
        text: body,
        startLine: currentStart,
        endLine: Math.max(currentStart, lastLine),
        tokens: approxTokens(body),
      });
    }
    current = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const currentChars = current.reduce((sum, u) => sum + u.length, 0);
    // 字符数是对片段总长的**硬约束**，不只是对单个单元的约束：早期版本只比较单个单元长度，
    // 结果被切开的两个 1200 字符单元又会被合并回一个 2400 字符的巨片，兜底等于没有。
    // 单次最多超出 MAX_UNIT_CHARS（一个已切到上限的单元加上一小段重叠尾巴）。
    const overflowChars = currentChars + unit.text.length > MAX_UNIT_CHARS;
    if (current.length > 0 && (currentTokens + unit.tokens > maxTokens || overflowChars)) {
      const prevLast = current[current.length - 1];
      // 重叠：把上一单位末尾的整句带进下一片段，作为新片段的开头。
      // 必须在 flush 之前算好，且 flush 之后要把它重新写回 current——早期版本在这里
      // 先 flush 再赋值 current，赋值紧接着被 flush 内部的清空覆盖，重叠静默失效。
      const tail = [];
      let tailTokens = 0;
      for (const sent of sentences(prevLast).reverse()) {
        const t = approxTokens(sent);
        if (tailTokens + t > overlapTokens) break;
        tail.unshift(sent);
        tailTokens += t;
      }
      flush();
      if (tail.length > 0) {
        // 重叠尾巴同样受字符预算约束：尾句自身可能就是一个已切到上限的长句，
        // 原样带入会让新片段一开头就超预算。
        const budget = Math.min(MAX_OVERLAP_CHARS, Math.max(120, currentChars));
        current = [tail.join(' ').slice(-budget)];
        currentTokens = approxTokens(current[0]);
      }
    }
    if (current.length === 0) currentStart = unit.line;
    current.push(unit.text);
    currentTokens += unit.tokens;
    lastLine = unit.line + countLines(unit.text) - 1;
  }
  flush();

  return chunks;
}

/**
 * 数一段文本占多少行（至少 1 行）。
 * @param {string} text - 文本。
 * @returns {number} 行数。
 */
function countLines(text) {
  if (!text) return 1;
  let n = 1;
  for (const ch of text) if (ch === '\n') n += 1;
  return n;
}

/** 编号式与中文序数式标题（参考实现的四种模式，行为保持不变）。 */
const HEADING_PATTERNS = [
  // 1. / 2.1 / 2.2.3
  { rx: /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([\u4e00-\u9fff（(].{0,58})$/, level: null },
  // 一、
  { rx: /^([一二三四五六七八九十]{1,3})、\s*(\S.{0,40})$/, level: 1 },
  // （一）
  { rx: /^（([一二三四五六七八九十]{1,3})）\s*(\S.{0,40})$/, level: 2 },
  // （1）短标题
  { rx: /^（(\d{1,2})）\s*([^。；，,]{1,30})$/, level: 4 },
];

/** Markdown ATX 标题：`## 标题`（1–6 个 #，后跟空格）。 */
const MARKDOWN_HEADING = /^(#{1,6})\s+(\S.*?)\s*#*\s*$/;

/**
 * 判定一行是否是章节标题。
 *
 * 排除正文句子（含中文句号）与过长行——否则目录行、正文里带编号的句子会被误判成标题，
 * 把文档切得支离破碎。
 *
 * @param {string} line - 一行文本。
 * @returns {{ level: number, title: string } | null} 标题层级与原文，非标题返回 null。
 */
export function detectHeading(line) {
  const s = String(line).trim();
  if (!s || s.length > 62 || s.includes('。')) return null;

  const md = MARKDOWN_HEADING.exec(s);
  if (md) return { level: md[1].length, title: md[2].trim() };

  for (const { rx, level } of HEADING_PATTERNS) {
    const m = rx.exec(s);
    if (m) {
      const resolved = level === null ? m[1].split('.').length : level;
      return { level: resolved, title: s };
    }
  }
  return null;
}

/**
 * 结构感知切分：先按章节标题分节（片段不跨节），每节再按 token 预算切，
 * 并给每个片段前缀一行 `【文档 › 标题路径】`。
 *
 * 围栏代码块（``` / ~~~）内部的行不参与标题识别，因为代码注释里的
 * `# 说明` 会被 Markdown 标题规则误判。
 *
 * @param {string} text - 文档全文。
 * @param {string} docId - 文档标识（相对工作区的路径）。
 * @param {{ maxTokens?: number, overlapTokens?: number, title?: string }} [options] - 预算参数；`title` 可选地作为路径根。
 * @returns {Chunk[]} 片段数组。
 */
export function chunkBySections(text, docId, options = {}) {
  const maxTokens = options.maxTokens ?? 320;
  const overlapTokens = options.overlapTokens ?? 50;
  if (typeof text !== 'string' || text.trim() === '') return [];

  const root = options.title ? `${docId} › ${options.title}` : docId;

  /** @type {{ path: string, body: string, startLine: number }[]} */
  const sections = [];
  /** @type {{ level: number, title: string }[]} */
  let stack = [];
  let buffer = [];
  let bodyStart = 1;
  let bodyEnd = 1;
  let contentSinceHeading = false;
  let inFence = false;

  const close = () => {
    const body = buffer.join('\n').trim();
    if (body) {
      sections.push({ path: stack.map((s) => s.title).join(' › '), body, startLine: bodyStart, endLine: bodyEnd });
    }
    buffer = [];
    contentSinceHeading = false;
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) inFence = !inFence;

    const heading = inFence ? null : detectHeading(line);
    if (heading) {
      close();
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
    } else if (line.trim() === '') {
      // 标题之后、正文之前的空行不算正文，避免片段行号落在空行上；
      // 但正文开始之后的空行是段落分隔，必须保留，否则行号被压缩。
      if (contentSinceHeading) {
        buffer.push(line);
        bodyEnd = i + 1;
      }
    } else {
      if (!contentSinceHeading) {
        bodyStart = i + 1;
        contentSinceHeading = true;
      }
      buffer.push(line);
      bodyEnd = i + 1;
    }
  }
  close();

  /** @type {Chunk[]} */
  const chunks = [];
  let ordinal = 0;

  for (const section of sections) {
    const path = section.path;
    const header = path ? `【${root} › ${path}】` : `【${root}】`;
    const parts = chunkDocument(section.body, {
      maxTokens,
      overlapTokens,
      startLine: section.startLine,
    });
    for (const part of parts) {
      chunks.push({
        id: `${docId}#${ordinal}`,
        docId,
        text: `${header}\n${part.text}`,
        headingPath: path || undefined,
        startLine: part.startLine,
        endLine: part.endLine,
        tokens: approxTokens(`${header}\n${part.text}`),
        lang: detectLang(part.text),
      });
      ordinal += 1;
    }
  }

  return chunks;
}
