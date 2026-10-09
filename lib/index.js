/**
 * 插件入口：把记忆与检索能力暴露为 DSH 工具，并把长期记忆注入系统提示词。
 *
 * # 一个关键的工程取舍：零依赖
 *
 * 官方插件（如 `@deepseek-ai/dsh-tool-goal`）用 `@deepseek-ai/dsh-tools` 的 `defineTool`
 * 声明工具。但那要求插件声明 peerDependency，并让运行时的版本与用户安装的 DSH 版本精确匹配
 * ——插件管理器会**在安装前**做版本校验，不匹配直接拒绝，用户看到的是"装不上"。
 *
 * 对一个要让别人下载即用的插件来说，**安装成功率本身就是功能**。所以这里不导入任何
 * `@deepseek-ai/*` 包：工具定义用普通对象（DSH 的 schema DSL 本身就是普通 JSON Schema 形状），
 * 由 `apply` 从宿主上下文里取得 `ctx.tools.register`。这也让全部逻辑能在纯 Node 下测试，
 * 不需要启动 DSH。
 *
 * 这一决定的代价是：若 DSH 未来改变工具定义契约，本插件需要跟着改。可接受——那份契约
 * 就是 `{ name, description, parameters, output, execute }` 这几个字段。
 */

import path from 'node:path';

import { assertInside } from './paths.js';
import { openUserMemory, openProjectMemory, SOURCE } from './memory.js';
import { WorkspaceIndex, buildIndex } from './workspace-index.js';
import { search, searchWithEvidence } from './search.js';
import { SUFFICIENCY } from './evidence.js';

/** 插件名（与 cordis.patch.yml 中的 name 一致）。 */
export const name = 'dsh-memory';

/**
 * 本插件不注入任何服务：工具注册走 `ctx.tools`，提示词走 `ctx.systemPrompt`，
 * 两者都做存在性判断，缺失时静默降级而不是让整个 profile 起不来。
 */
export const inject = [];

/** 插件配置。 */
export const Config = {
  /** 检索默认返回的片段数上限。 */
  maxPassages: 6,
  /** 是否把长期记忆注入系统提示词。 */
  injectMemory: true,
  /** 注入记忆时最多带多少条。 */
  maxInjectedEntries: 40,
  /** 注入记忆的字符预算，超出则按重要度截断。 */
  maxInjectedChars: 3000,
};

/**
 * 解析配置并补齐默认值。
 * @param {Partial<typeof Config>} [config] - 用户配置。
 * @returns {typeof Config} 生效配置。
 */
export function resolveConfig(config = {}) {
  return {
    maxPassages: Number.isFinite(config.maxPassages) ? config.maxPassages : Config.maxPassages,
    injectMemory: config.injectMemory !== false,
    maxInjectedEntries: Number.isFinite(config.maxInjectedEntries) ? config.maxInjectedEntries : Config.maxInjectedEntries,
    maxInjectedChars: Number.isFinite(config.maxInjectedChars) ? config.maxInjectedChars : Config.maxInjectedChars,
  };
}

/**
 * 解析当前会话的工作区路径。
 *
 * DSH 的会话摘要里带 `cwd`；拿不到时退回进程工作目录。**不做猜测式的向上查找**：
 * 索引范围必须可预测，用户应当能明确知道"它在索引哪个目录"。
 *
 * @param {object} [agent] - 调用方 agent（可选）。
 * @param {string} [fallback] - 兜底路径。
 * @returns {string} 工作区绝对路径。
 */
export function resolveWorkspace(agent, fallback) {
  const fromAgent = agent?.session?.summary?.cwd
    ?? agent?.session?.cwd
    ?? agent?.cwd;
  const raw = typeof fromAgent === 'string' && fromAgent.trim() !== ''
    ? fromAgent
    : fallback ?? process.cwd();
  return path.resolve(raw);
}

/**
 * 构造工具定义列表。
 *
 * 抽成纯函数以便在测试里直接调用 `execute`，无需启动 DSH 宿主。
 *
 * @param {{ workspace: string, dshHome?: string, env?: NodeJS.ProcessEnv, config?: object }} deps - 依赖。
 * @returns {object[]} 工具定义列表。
 */
export function createTools(deps) {
  const config = resolveConfig(deps.config);
  const io = { dshHome: deps.dshHome, env: deps.env };
  const workspace = deps.workspace;

  return [
    /**
     * 建立/刷新工作区索引。
     */
    {
      name: 'kb_index',
      description:
        'Build or refresh the searchable index of this workspace (documents, notes, source files). '
        + 'Run it once before the first kb_search, and again after you add or significantly change documents. '
        + 'It is incremental: unchanged files are reused, so re-running is cheap.',
      parameters: {},
      output: { type: 'string' },
      async execute() {
        const previous = WorkspaceIndex.load(workspace, io);
        const { index, changes, stats } = buildIndex(workspace, { ...io, previous });
        index.save(workspace, io);

        const lines = [
          `已索引 ${stats.files} 个文件，共 ${stats.chunks} 个片段。`,
          `新增 ${changes.added.length}，更新 ${changes.updated.length}，删除 ${changes.removed.length}，未变 ${changes.unchanged}。`,
        ];
        if (changes.added.length > 0 && changes.added.length <= 15) {
          lines.push(`新增：${changes.added.join('、')}`);
        }
        if (changes.updated.length > 0 && changes.updated.length <= 15) {
          lines.push(`更新：${changes.updated.join('、')}`);
        }
        if (stats.truncated) {
          lines.push(`注意：文件数达到上限，索引被截断（跳过 ${stats.skipped} 项）。`);
        } else if (stats.skipped > 0) {
          lines.push(`跳过了 ${stats.skipped} 个不参与索引的条目（二进制、构建目录、非文本格式）。`);
        }
        return lines.join('\n');
      },
    },

    /**
     * 检索。
     */
    {
      name: 'kb_search',
      description:
        'Search this workspace\'s indexed documents and return the most relevant passages, each with a '
        + 'file:line citation. Use it when the answer must come from the user\'s own materials rather than '
        + 'your general knowledge. When it reports insufficient evidence, say you could not find it in their '
        + 'files instead of answering from memory.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'What to look for. Natural language or exact terms both work; identifiers and error strings are matched literally.',
        },
        max_passages: {
          type: 'number',
          description: 'Maximum number of passages to return. Defaults to the plugin configuration.',
        },
      },
      output: { type: 'string' },
      async execute(args) {
        const query = String(args.query ?? '').trim();
        if (query === '') throw new Error('query must not be empty');

        const index = WorkspaceIndex.load(workspace, io);
        if (index.chunkCount === 0) {
          return '工作区索引是空的。先调用 kb_index 建立索引，再检索。';
        }

        const out = searchWithEvidence({
          index,
          query,
          options: {
            maxPassages: Number.isFinite(args.max_passages) ? args.max_passages : config.maxPassages,
          },
        });
        return out.text;
      },
    },

    /**
     * 查看索引状态。
     */
    {
      name: 'kb_stats',
      description:
        'Report what this workspace index currently covers: how many files and passages, when it was built, '
        + 'and which files were indexed. Use it to show the user exactly what your answers are based on.',
      parameters: {},
      output: { type: 'string' },
      async execute() {
        const index = WorkspaceIndex.load(workspace, io);
        if (index.chunkCount === 0) {
          return '还没有索引。调用 kb_index 建立。';
        }
        const docIds = Object.keys(index.documents).sort();
        const lines = [
          `工作区：${workspace}`,
          `构建时间：${index.builtAt || '（未知）'}`,
          `已索引：${index.documentCount} 个文件，${index.chunkCount} 个片段`,
          '',
          '文件清单：',
          ...docIds.slice(0, 100).map((docId) => {
            const doc = index.documents[docId];
            return `- ${docId}（${doc.chunks} 个片段）`;
          }),
        ];
        if (docIds.length > 100) lines.push(`…（另有 ${docIds.length - 100} 个文件未列出）`);
        return lines.join('\n');
      },
    },

    /**
     * 长期记忆的读写与遗忘。
     */
    {
      name: 'memory',
      description:
        'Read, write, or forget long-term memory. Use scope "project" for facts that hold only in this '
        + 'workspace (decisions, stack, gotchas) and scope "user" for facts that hold everywhere (how the '
        + 'user wants to be addressed, lasting preferences). Facts are stored as human-readable Markdown the '
        + 'user can edit by hand, so keep each entry short and factual. Never store secrets, credentials, or '
        + 'anything the user did not actually state.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['read', 'write', 'forget'],
          description: 'read returns all entries; write upserts by key; forget removes by key or by content match.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'user'],
          description: 'Which memory file. Defaults to "project".',
        },
        key: {
          type: 'string',
          description: 'Stable identifier shaped like "topic.field". Writing the same key again updates that entry instead of adding one. Required for write.',
        },
        text: {
          type: 'string',
          description: 'The fact itself, one short sentence. Required for write.',
        },
        query: {
          type: 'string',
          description: 'For forget: remove entries whose content contains this text. Use it when you do not know the exact key.',
        },
      },
      output: { type: 'string' },
      async execute(args) {
        const scope = args.scope === 'user' ? 'user' : 'project';
        const store = scope === 'user'
          ? openUserMemory(io)
          : openProjectMemory(workspace, io);

        if (args.action === 'read') {
          const { entries } = store.read();
          if (entries.length === 0) return `${scope} 记忆目前是空的。`;
          return [
            `${scope} 长期记忆（${entries.length} 条）：`,
            ...entries.map((entry) => `- \`${entry.displayKey ?? entry.key}\` ${entry.text}${entry.source ? `（来源：${entry.source === SOURCE.HUMAN ? '用户' : '模型'}）` : ''}`),
          ].join('\n');
        }

        if (args.action === 'forget') {
          const key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key : undefined;
          const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query : undefined;
          if (key === undefined && query === undefined) {
            return '需要提供 key 或 query 才能删除。为避免误删，两者都缺失时不执行任何操作。';
          }
          const { removed } = store.forget({ key, query });
          if (removed.length === 0) return '没有匹配到要删除的记忆，未做改动。';
          return [
            `已删除 ${removed.length} 条：`,
            ...removed.map((entry) => `- \`${entry.displayKey ?? entry.key}\` ${entry.text}`),
          ].join('\n');
        }

        // write
        const key = String(args.key ?? '').trim();
        const text = String(args.text ?? '').trim();
        if (key === '' || text === '') return '写入记忆需要同时提供 key 与 text。';
        const { entry, created } = store.remember({
          key,
          text,
          source: SOURCE.MODEL,
        });
        return created
          ? `已记住（${scope}）：\`${entry.displayKey ?? entry.key}\` ${entry.text}`
          : `已更新（${scope}）：\`${entry.displayKey ?? entry.key}\` ${entry.text}`;
      },
    },

    /**
     * 在记忆里检索。
     */
    {
      name: 'memory_search',
      description:
        'Search long-term memory by content. Use it before asking the user something they may already have '
        + 'told you, and when memory has grown beyond what fits in the injected summary.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Text to look for in memory entries.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'user', 'both'],
          description: 'Which memory to search. Defaults to "both".',
        },
      },
      output: { type: 'string' },
      async execute(args) {
        const query = String(args.query ?? '').trim();
        if (query === '') throw new Error('query must not be empty');
        const scope = args.scope ?? 'both';

        const stores = [];
        if (scope === 'project' || scope === 'both') stores.push(['project', openProjectMemory(workspace, io)]);
        if (scope === 'user' || scope === 'both') stores.push(['user', openUserMemory(io)]);

        const lines = [];
        for (const [label, store] of stores) {
          const hits = store.search(query, { limit: 20 });
          if (hits.length === 0) continue;
          lines.push(`${label} 记忆命中 ${hits.length} 条：`);
          for (const entry of hits) lines.push(`- \`${entry.displayKey ?? entry.key}\` ${entry.text}`);
        }
        return lines.length > 0 ? lines.join('\n') : '记忆里没有找到相关内容。';
      },
    },
  ];
}

/**
 * 渲染注入系统提示词的记忆摘要。
 *
 * 注入策略是**保守的**：长期记忆的价值在于"总是可见"，但它的成本是每一个请求都要重发。
 * 因此这里只注入条目文本、按字符预算截断，并在超出时明确告知模型"还有更多、可用
 * memory_search 查"，而不是把整份记忆塞进每个请求。
 *
 * @param {{ workspace: string, dshHome?: string, env?: NodeJS.ProcessEnv, config?: object }} deps - 依赖。
 * @returns {string} 注入文本；无内容时返回空字符串。
 */
export function renderMemoryPrompt(deps) {
  const config = resolveConfig(deps.config);
  const io = { dshHome: deps.dshHome, env: deps.env };

  const project = openProjectMemory(deps.workspace, io).read();
  const user = openUserMemory(io).read();

  const sections = [];
  const budget = { left: config.maxInjectedChars, count: config.maxInjectedEntries };

  const emit = (label, entries) => {
    if (entries.length === 0) return null;
    const lines = [];
    for (const entry of entries) {
      if (budget.count <= 0) break;
      const line = `- \`${entry.displayKey ?? entry.key}\` ${entry.text}`;
      if (line.length > budget.left && lines.length > 0) break;
      lines.push(line);
      budget.left -= line.length;
      budget.count -= 1;
    }
    if (lines.length === 0) return null;
    const omitted = entries.length - lines.length;
    if (omitted > 0) lines.push(`- （另有 ${omitted} 条未列出，可用 memory_search 查询）`);
    return `${label}\n${lines.join('\n')}`;
  };

  const projectSection = emit('项目长期记忆（仅本项目）', project.entries);
  const userSection = emit('用户长期记忆（所有项目）', user.entries);
  if (projectSection) sections.push(projectSection);
  if (userSection) sections.push(userSection);

  if (sections.length === 0) return '';

  return [
    '<long-term-memory>',
    '以下是此前沉淀的长期记忆，可直接当作已知前提使用。',
    '它们由用户确认或模型记录，可能过时；与当前对话冲突时以用户当前说法为准。',
    '需要新增或纠正时用 memory 工具，不要只在回复里口头承诺。',
    '',
    ...sections,
    '</long-term-memory>',
  ].join('\n');
}

/**
 * 解析要注册的工具定义（DSH 里交给宿主，测试里直接拿来调用）。
 * @param {object[]} tools - 工具定义。
 * @param {(def: object) => object} [define] - 宿主的 defineTool（可选）。
 * @returns {object[]} 可注册的定义。
 */
export function prepareTools(tools, define) {
  return typeof define === 'function' ? tools.map((tool) => define(tool)) : tools;
}

/**
 * 记忆注入使用的变量名与段落名。
 *
 * 变量名必须匹配 DSH 的 `^[a-z][a-z0-9_]*$`：**只允许小写字母、数字与下划线**。
 * 早期版本用了 `dshMemoryLongTerm` 这样的驼峰名，注册时不会报错，但每次组装提示词时
 * 都会因变量名非法而抛错——那等于插件装上去就不能用。
 */
export const MEMORY_VARIABLE = 'dsh_memory_long_term';
export const MEMORY_SECTION = 'long-term-memory';

/**
 * 插件入口。
 *
 * 注入用**变量 + 段落**两步完成，而不是在 `apply` 里直接把渲染结果写进段落文本。
 * 原因是 `text` 是静态的：那种写法只在插件加载那一刻读一次记忆，本次会话里新写入的记忆
 * 要等下次加载才可见。`ctx.systemPrompt.variable(name, resolver)` 的 resolver 在**每次
 * 组装提示词时**求值，因此记忆是"每次请求现读"的。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {Partial<typeof Config> & { dshHome?: string, env?: NodeJS.ProcessEnv }} [config] - 插件配置；`dshHome` 便于测试与多实例隔离。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const workspace = resolveWorkspace(ctx?.agent, ctx?.session?.summary?.cwd ?? process.cwd());
  const deps = { workspace, config: resolved, dshHome: config?.dshHome, env: config?.env };

  // 工具注册：DSH 用 defineTool 包装；测试或不提供该服务时直接用原定义。
  const define = ctx?.tools?.defineTool;
  const tools = prepareTools(createTools(deps), define);
  for (const tool of tools) {
    ctx?.tools?.register?.(tool);
  }

  // 系统提示词注入。
  //
  // `variable` 是 `ctx.systemPrompt` 的基础 API（不是某个新版本才有的），因此这里不做
  // "旧版本降级"——那是为一个不存在的风险写死代码。这里只做**失败隔离**：
  // 宿主没有提供提示词服务（例如最小化的测试上下文）时跳过注入，但**五个工具照常注册**。
  // 工具才是这个插件的主要价值，不应因为一个可选服务缺失而整体失效。
  if (!resolved.injectMemory) return;
  if (typeof ctx?.systemPrompt?.section !== 'function'
    || typeof ctx?.systemPrompt?.variable !== 'function') {
    return;
  }

  const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('LONG_TERM_MEMORY')
    : undefined;

  // 变量 resolver 每次组装都重新读盘，因此新写入的记忆立刻生效。
  // 它必须**永不抛错**：按 DSH 的契约，未解析的变量会让整个提示词组装失败，
  // 而记忆是增强功能，绝不能因为一个坏文件让 agent 无法工作。
  ctx.systemPrompt.variable(MEMORY_VARIABLE, () => {
    try {
      return renderMemoryPrompt(deps);
    } catch {
      return '';
    }
  });
  ctx.systemPrompt.section({
    name: MEMORY_SECTION,
    ...(order === undefined ? {} : { order }),
    text: `{{${MEMORY_VARIABLE}}}`,
  });
}

export { assertInside, SUFFICIENCY, search };
