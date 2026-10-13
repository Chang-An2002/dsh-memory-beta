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
import { WorkspaceIndex, buildIndex, checkStaleness } from './workspace-index.js';
import { search, searchWithEvidence } from './search.js';
import { SUFFICIENCY } from './evidence.js';

/** 插件名（与 cordis.patch.yml 中的 name 一致）。 */
export const name = 'dsh-memory-beta';

/**
 * 本插件依赖的两个宿主服务，都是 DSH 的基础服务：
 * 工具注册走 `ctx.tools`，提示词注入走 `ctx.systemPrompt`。
 *
 * 声明 `inject` 而不是"裸访问 + 存在性判断"，是因为 Cordis 的上下文代理在服务不可用时
 * 会**直接抛错**（`cannot get property "x" without inject`），可选链挡不住它。
 * 明确声明之后，服务要么就绪、要么本插件干脆不激活——两种结果都比"运行到一半炸掉"好。
 *
 * 注意**不能**把 `agent` 写进来：它只存在于每个 agent 的 scope 里，根上下文没有。
 * 工作区要按调用现取，见 `resolveWorkspace` 与 `createTools` 的注释。
 */
export const inject = ['tools', 'systemPrompt'];

/**
 * 配置项的类型与默认值。
 *
 * 这是**唯一的事实源**：`Config` 的校验与 `resolveConfig` 的回退都以它为准。
 */
const CONFIG_FIELDS = {
  maxPassages: { kind: 'number', fallback: 6 },
  injectMemory: { kind: 'boolean', fallback: true },
  maxInjectedEntries: { kind: 'number', fallback: 40 },
  maxInjectedChars: { kind: 'number', fallback: 3000 },
  autoReindex: { kind: 'boolean', fallback: true },
};

/**
 * 一份手写的「配置原值」校验。
 *
 * 只做类型检查：数字项要求有限数字，布尔项要求布尔。校验通过后按默认值补全，
 * 因此返回的 `value` 一定是四项齐全的完整配置。
 *
 * `undefined` 是**合法输入**，表示「patch 里没写 config」，此时全部取默认值。
 * 这是实测出来的契约：profile patch 里只写 `- id/name` 时，Cordis 传给校验的就是
 * `undefined`，照搬 JSON Schema 的「必须传对象」会直接让插件无法激活。
 *
 * @param {object} [raw] - 用户写在 profile patch 里的 `config:`。
 * @returns {{ value: object } | { issues: { message: string, path: string[] }[] }} 标准校验结果。
 */
function validateRawConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config must be an object', path: [] }] };
  }
  const issues = [];
  const value = {};
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) {
      value[key] = field.fallback;
      continue;
    }
    if (field.kind === 'number' ? !Number.isFinite(raw[key]) : typeof raw[key] !== 'boolean') {
      issues.push({ message: `expected ${field.kind}`, path: [key] });
      continue;
    }
    value[key] = raw[key];
  }
  return issues.length > 0 ? { issues } : { value };
}

/**
 * 插件配置 schema。
 *
 * **必须是标准 schema 形状（`~standard.validate`），不能是普通默认值对象。**
 * Cordis 在激活插件时会执行 `runtime.Config["~standard"].validate(config)`；缺失该属性的
 * 普通对象不会在加载时报错，而是让每次激活都抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 然后整条插件 fiber 被标记为失败并卸载——**工具与提示词段落一个都不会出现**，
 * 而宿主只在 stderr 打一行 "entry did not activate"。这个坑与第 103 行 `output.render`
 * 是同一类：假桩测试抓不到，只有真机启动才能暴露。
 *
 * 这里手写而不引入 `@deepseek-ai/schemastery`：引入它会要求声明 peerDependency，
 * 与「零依赖、装得上」的取舍冲突（见文件头注释）。
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-memory-beta',
    validate: validateRawConfig,
  }),
});

/**
 * 解析配置并补齐默认值。
 *
 * 接受两种输入：Cordis 已按 `Config` 校验过的完整配置，或直接传进来的原值
 * （测试与 `createTools` 走这条路）。因此这里**先补默认值、再逐项判类型**，
 * 非法值静默回退到默认值而不是抛错——记忆是增强功能，不该让 agent 起不来。
 *
 * @param {object} [config] - 用户配置。
 * @returns {{ maxPassages: number, injectMemory: boolean, maxInjectedEntries: number, maxInjectedChars: number, autoReindex: boolean }} 生效配置。
 */
export function resolveConfig(config = {}) {
  return {
    maxPassages: Number.isFinite(config.maxPassages) ? config.maxPassages : CONFIG_FIELDS.maxPassages.fallback,
    injectMemory: config.injectMemory !== false,
    maxInjectedEntries: Number.isFinite(config.maxInjectedEntries) ? config.maxInjectedEntries : CONFIG_FIELDS.maxInjectedEntries.fallback,
    maxInjectedChars: Number.isFinite(config.maxInjectedChars) ? config.maxInjectedChars : CONFIG_FIELDS.maxInjectedChars.fallback,
    autoReindex: config.autoReindex !== false,
  };
}

/**
 * 解析当前会话的工作区路径。
 *
 * 首选 `agent.session.header.cwd`——这是 DSH 自带文件工具用的同一条路径
 * （`dsh-tool-fs` 的 `sessionCwd(exec)` 就是 `exec.agent?.session.header.cwd`），
 * 因此本插件的"工作区"和 `read`/`write`/`edit` 的工作区必然是同一个。
 * 拿不到时退回进程工作目录。**不做猜测式的向上查找**：索引范围必须可预测，
 * 用户应当能明确知道"它在索引哪个目录"。
 *
 * @param {object} [agent] - 调用方 agent（可选）。
 * @param {string} [fallback] - 兜底路径。
 * @returns {string} 工作区绝对路径。
 */
export function resolveWorkspace(agent, fallback) {
  const fromAgent = agent?.session?.header?.cwd
    ?? agent?.session?.summary?.cwd
    ?? agent?.session?.cwd
    ?? agent?.cwd;
  const raw = typeof fromAgent === 'string' && fromAgent.trim() !== ''
    ? fromAgent
    : fallback ?? process.cwd();
  return path.resolve(raw);
}

/** DSH 编译器认定的“注解”字段，按它自己的拷贝顺序排列。 */
const SCHEMA_ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/**
 * 按 DSH 编译器的顺序重建一个属性节点。
 *
 * 顺序不是洁癖：它决定了模型看到的 schema 里字段的先后，而 `defineTool` 产出的就是
 * `type` → 注解 → `enum`/`const` → 其余。这里跟着排，才能保证手写编译器的输出
 * 与官方**逐字节一致**（`.probe/compile-parity.mjs` 就是这条对齐证明）。
 *
 * @param {object} spec - 原始属性说明。
 * @returns {object} 排序后的节点。
 */
function orderPropertySpec(spec) {
  const ordered = {};
  if (Object.hasOwn(spec, 'type')) ordered.type = spec.type;
  for (const key of SCHEMA_ANNOTATION_KEYS) {
    if (Object.hasOwn(spec, key)) ordered[key] = spec[key];
  }
  if (Object.hasOwn(spec, 'enum')) ordered.enum = Array.from(spec.enum);
  if (Object.hasOwn(spec, 'const')) ordered.const = spec.const;
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required' || key in ordered) continue;
    ordered[key] = value;
  }
  return ordered;
}

/**
 * 把插件的「参数说明字典」编译成 DSH 真正需要的那种 JSON Schema。
 *
 * 为什么必须编译：DSH 的 `defineTool` 会把 `options.parameters`（`{ 名: { type, required?, ... } }`
 * 这种**隐式属性表**）编译成 `{ type: 'object', properties, required }`，然后
 * `tools.register()` **原样**把 `parameters` 交给模型。本插件不 import `defineTool`
 * （零依赖取舍），所以这一步得自己做——否则模型会收到一张 `{query: {...}}` 的怪 schema，
 * 而工具却没有可用的参数定义。真机探针就是靠这一条抓出来的。
 *
 * 编译规则与 `@deepseek-ai/dsh-tools` 的 `compilePropertyMap` 对齐：
 * - 属性自己的 `required: true` 被提升到根的 `required` 数组，不留在属性里
 *   （留在属性里既不是合法 JSON Schema，也会被模型当成噪声）；
 * - `description`/`title`/`default`/`examples` 原样保留；
 * - 其余键（`enum`、`oneOf`、`items` 等）原样透传。
 *
 * @param {Record<string, object>} parameters - 隐式参数表。
 * @returns {{ type: 'object', properties: object, required?: string[] }} 根为 object 的 JSON Schema。
 */
export function compileParameterSchema(parameters) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (spec === null || typeof spec !== 'object') continue;
    properties[key] = orderPropertySpec(spec);
    if (spec.required === true) required.push(key);
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/**
 * 把一份工具定义整理成 `tools.register()` 能直接收下的形状。
 *
 * 只做两件事：编译参数表（见 {@link compileParameterSchema}）、补上 `output.render`。
 * `output.render` 不能省：DSH 的 `defineTool` 读 `options.output.render` 时没有可选链，
 * 并把它接成 `render(args, value) { return userRender(args, value) }`。省略它不会在加载时
 * 报错，但模型每次调用工具都会抛 `userRender is not a function`——五个工具等于全废。
 *
 * @param {object[]} tools - `createTools` 产出的原始定义。
 * @returns {object[]} 可直接注册的定义。
 */
export function toRegistrableTools(tools) {
  return tools.map((tool) => ({
    ...tool,
    parameters: compileParameterSchema(tool.parameters),
    output: {
      schema: tool.output?.schema ?? { type: 'string' },
      render: tool.output?.render ?? ((_args, value) => [{ type: 'text', text: String(value) }]),
    },
  }));
}

/**
 * 所有工具的输出都是纯文本，统一用一个 render 渲染成 DSH 的内容块数组。
 */
const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
});

/**
 * 构造工具定义列表。
 *
 * 抽成纯函数以便在测试里直接调用 `execute`，无需启动 DSH 宿主。
 *
 * **工作区按「每次调用」解析，不在插件加载时定死**。原因是插件注册在全局上下文里，
 * 而会话（工作区）属于每个 agent 的 scope：加载时根本没有 `agent` 可读。真正的
 * cwd 在工具执行上下文里：`exec.agent.session.header.cwd`。这样做还顺带修掉了
 * "插件加载时的 cwd 被当成所有会话的工作区"这个隐患。
 *
 * @param {{ workspace?: string, dshHome?: string, env?: NodeJS.ProcessEnv, config?: object }} deps - 依赖。
 *   传了 `workspace` 就当固定工作区（测试与无 agent 场景）；不传则每次从 `exec` 解析。
 * @returns {object[]} 工具定义列表。
 */
export function createTools(deps) {
  const config = resolveConfig(deps.config);
  const io = { dshHome: deps.dshHome, env: deps.env };

  /** 本次调用的工作区：优先用显式传入的固定值，否则看执行上下文里的 agent。 */
  const workspaceFor = (exec) => (deps.workspace === undefined
    ? resolveWorkspace(exec?.agent)
    : deps.workspace);

  return [
    /**
     * 建立/刷新工作区索引。
     */
    {
      name: 'kb_index',
      description:
        'Build or refresh the searchable index of this workspace (documents, notes, source files). '
        + 'You rarely need this: kb_search detects a stale index and reindexes automatically before answering. '
        + 'Call it when you want to update the index without searching. '
        + 'It is incremental: unchanged files are reused, so re-running is cheap.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const workspace = workspaceFor(exec);
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
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const query = String(args.query ?? '').trim();
        if (query === '') throw new Error('query must not be empty');

        const workspace = workspaceFor(exec);
        const loaded = WorkspaceIndex.load(workspace, io);

        // 过期检测 + 自动重建。
        //
        // 为什么默认自动重建，而不是"只加一句提醒然后照旧回答"：提醒是**软约束**，
        // 模型完全可以无视它，于是又回到"拿旧内容理直气壮地回答"这个最危险的失败模式。
        // 索引本来就是可重建的派生物（见本文件头部与 DESIGN 第 2 条），重建它不动用户的文档。
        // 但**绝不静默**：重建了什么必须写进返回文本，否则用户只会觉得"这次检索怎么慢了一拍"。
        const rebuilt = syncStaleIndex(workspace, loaded, io, { rebuild: config.autoReindex !== false });

        const index = rebuilt.index;
        if (index.chunkCount === 0) {
          // 区分两种"空"：真的没东西可索引（用户该去确认文档在哪），
          // 与"自动重建被关掉了、索引还没建"（用户该去跑 kb_index）。
          return config.autoReindex === false
            ? '工作区索引是空的。先调用 kb_index 建立索引，再检索。'
            : `${rebuilt.note === '' ? '' : `${rebuilt.note}\n`}工作区里没有可索引的内容（按扩展名白名单，只有文本与代码文件参与索引），先确认文档位置，再调用 kb_index。`;
        }

        const out = searchWithEvidence({
          index,
          query,
          options: {
            maxPassages: Number.isFinite(args.max_passages) ? args.max_passages : config.maxPassages,
          },
        });
        return rebuilt.note === '' ? out.text : `${rebuilt.note}\n\n${out.text}`;
      },
    },

    /**
     * 查看索引状态。
     */
    {
      name: 'kb_stats',
      description:
        'Report what this workspace index currently covers: how many files and passages, when it was built, '
        + 'and which files were indexed. It also reports whether the index is stale. '
        + 'Use it to show the user exactly what your answers are based on. '
        + 'Unlike kb_search, it never rebuilds the index.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const workspace = workspaceFor(exec);
        const loaded = WorkspaceIndex.load(workspace, io);

        // 与 kb_search 用同一套过期检测，保证两个工具不会给出互相矛盾的结论。
        // 但这里**不重建**：kb_stats 是"核对依据"的只读工具，偷偷改掉它正在报告的东西
        // 会让人没法信任这份报告。它只如实说哪些文件已经变了。
        const checked = syncStaleIndex(workspace, loaded, io, { rebuild: false });
        const index = checked.index;

        if (index.chunkCount === 0) {
          return checked.note === ''
            ? '还没有索引。调用 kb_index 建立。'
            : `${checked.note}\n还没有索引。调用 kb_index 建立。`;
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
        return checked.note === '' ? lines.join('\n') : `${checked.note}\n\n${lines.join('\n')}`;
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
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const workspace = workspaceFor(exec);
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
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const workspace = workspaceFor(exec);
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
 * @param {{ workspace?: string, dshHome?: string, env?: NodeJS.ProcessEnv, config?: object }} deps - 依赖；
 *   `workspace` 缺省时按 `exec.agent` 现取。
 * @returns {string} 注入文本；无内容时返回空字符串。
 */
export function renderMemoryPrompt(deps) {
  const config = resolveConfig(deps.config);
  const io = { dshHome: deps.dshHome, env: deps.env };
  const workspace = deps.workspace ?? resolveWorkspace();

  const project = openProjectMemory(workspace, io).read();
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
 * 把一批变化压成一句人话，例如「新增 2 个，改动 1 个」。
 *
 * @param {import('./workspace-index.js').StaleCheck[]} stale - 变化列表。
 * @returns {string} 数量摘要；空列表返回空串。
 */
export function summarizeStale(stale) {
  if (stale.length === 0) return '';
  const count = (kind) => stale.filter((entry) => entry.kind === kind).length;
  const parts = [];
  if (count('added') > 0) parts.push(`新增 ${count('added')} 个`);
  if (count('modified') > 0) parts.push(`改动 ${count('modified')} 个`);
  if (count('removed') > 0) parts.push(`删除 ${count('removed')} 个`);
  return parts.join('，');
}

/**
 * 列出变化的文件名，过长时截断。
 * @param {import('./workspace-index.js').StaleCheck[]} stale - 变化列表。
 * @returns {string} 形如 `a.md、b.md 等 12 个文件`。
 */
export function listStale(stale) {
  const names = stale.slice(0, 8).map((entry) => entry.docId).join('、');
  return stale.length > 8 ? `${names} 等 ${stale.length} 个文件` : names;
}

/**
 * 检测索引是否过期，并按需重建，返回可用的索引与一句如实说明。
 *
 * ## 为什么 kb_search 与 kb_stats 共用它
 *
 * 一个报"已索引 12 个文件"、另一个报"有 3 个文件变了"，是自相矛盾的。两个工具对
 * **索引新不新鲜**这件事必须给出一致判断，否则用户没法相信任何一个数字。
 *
 * ## 但两者对"要不要重建"的答案不同，这是有意的
 *
 * - `kb_search`：**要重建**。它马上就要拿这份索引回答，用旧内容回答正是要消灭的失败模式。
 * - `kb_stats`：**不重建**。它是用来"核对依据"的只读工具（README 里就是这么承诺的），
 *   偷偷改掉它正在报告的东西会让人没法信任这份报告。它只如实说"这些文件已经变了"。
 *
 * 所以"过期检测"两边一致，"重新索引"只发生在检索路径上。
 *
 * 失败时不抛错：记忆与检索是增强功能，重建出问题也要让调用继续（用旧索引），
 * 但**必须如实说明可能不准**，而不是假装一切正常。
 *
 * @param {string} workspace - 工作区绝对路径。
 * @param {WorkspaceIndex} loaded - 已加载的索引。
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} io - 家目录选项。
 * @param {{ rebuild?: boolean }} [options] - 是否允许重建。
 * @returns {{ index: WorkspaceIndex, note: string, stale: import('./workspace-index.js').StaleCheck[] }} 结果。
 */
function syncStaleIndex(workspace, loaded, io, options = {}) {
  const rebuild = options.rebuild === true;
  let stale;
  try {
    stale = checkStaleness(loaded, workspace);
  } catch (error) {
    return { index: loaded, stale: [], note: `注意：无法检查索引是否过期（${error.message}），下面的内容可能不是最新的。` };
  }
  if (stale.length === 0) return { index: loaded, stale, note: '' };

  const detectedCounts = summarizeStale(stale);
  const detected = `注意：工作区自上次索引后有变化（${detectedCounts}）——${listStale(stale)}。`;
  if (!rebuild) return { index: loaded, stale, note: `${detected}\n下面报告的是索引里的旧数据。` };

  try {
    const { index, changes } = buildIndex(workspace, { ...io, previous: loaded });
    index.save(workspace, io);
    const applied = summarizeStale([
      ...changes.added.map((docId) => ({ docId, kind: 'added' })),
      ...changes.updated.map((docId) => ({ docId, kind: 'modified' })),
      ...changes.removed.map((docId) => ({ docId, kind: 'removed' })),
    ]);
    return {
      index,
      stale,
      // 检测到的和实际重建的偶尔会不一致（例如 mtime 变了、重读后指纹其实没变），
      // 不一致时两个数字都写出来，不合并成一个。
      note: applied === detectedCounts
        ? `${detected}\n已自动重新索引后再回答。`
        : `${detected}\n已自动重新索引（实际${applied}）后再回答。`,
    };
  } catch (error) {
    return { index: loaded, stale, note: `${detected}\n但自动重新索引失败（${error.message}），下面的结果可能已经过时。` };
  }
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
 * 记忆段落在本插件没拿到官方 order 时的兜底位置。
 *
 * 定在 `TOOL_GOAL`(2400) 与 `TOOL_WORKFLOW`(2600) 之间：记忆是"用哪些工具"的指引，
 * 应当和工具说明挨着，而不是插到工具清单后面去。
 */
const MEMORY_SECTION_FALLBACK_ORDER = 2500;

/**
 * 插件入口。
 *
 * ## 注册在全局上下文，agent 只在"用的时候"读
 *
 * 插件由 profile 的 patch 挂载在**根上下文**，而会话/工作区属于每个 agent 的 scope。
 * 所以这里不能碰 `ctx.agent`——Cordis 的上下文代理会直接抛
 * `cannot get property "agent" without inject`，而且根上下文里根本没有 agent。
 * 正确做法与 DSH 自带工具一致：注册时只用全局服务，工作区在
 * **工具执行上下文** `exec.agent.session.header.cwd`、**提示词组装上下文**
 * `assembly.agent.session.header.cwd` 里现取。
 *
 * ## 注入用「变量 + 段落」两步，而不是把渲染结果写进段落文本
 *
 * 段落 `text` 是静态的：那种写法只在插件加载那一刻读一次记忆，本次会话里新写入的记忆
 * 要等下次加载才可见。`ctx.systemPrompt.variable(name, resolver)` 的 resolver 在**每次
 * 组装提示词时**求值，因此记忆是"每次请求现读"的。
 *
 * ## 整个 apply 都必须"永不抛错"
 *
 * Cordis 的 `Fiber._reload()` 一旦捕获到异常，就把这条插件 fiber 标记为失败并 `_unload()`，
 * 连已经注册好的工具都会一起撤掉；宿主只在 stderr 打一行 "entry did not activate"。
 * 也就是说：apply 里任何一句抛错，代价都是**插件彻底消失**，而不是少个功能。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} [config] - 插件配置（已由 `Config` 校验）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const deps = { config: resolved, dshHome: config?.dshHome, env: config?.env };

  // 工具注册：参数表由 compileParameterSchema 编译成 JSON Schema（见那里的注释）。
  // 任何一步失败都只意味着"少几个工具"，不该让整条 fiber 倒掉——注册到一半的
  // 工具会随 fiber 一起被回收，所以这里不需要自己回滚。
  try {
    for (const tool of toRegistrableTools(createTools(deps))) {
      ctx?.tools?.register?.(tool);
    }
  } catch {
    // 工具服务异常：跳过，提示词注入继续尝试
  }

  if (!resolved.injectMemory) return;
  if (typeof ctx?.systemPrompt?.section !== 'function'
    || typeof ctx?.systemPrompt?.variable !== 'function') {
    return;
  }

  const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('LONG_TERM_MEMORY')
    : undefined;

  // 变量 resolver 每次组装都重新读盘，因此新写入的记忆立刻生效。
  // 它必须**永不抛错、永不返回 undefined**：按 DSH 的契约，未知变量或值为 undefined
  // 都会让整个提示词组装失败（`prompt variable "..." has no value for this assembly`），
  // 而记忆只是增强功能，绝不能因为一个坏文件让 agent 无法工作。
  ctx.systemPrompt.variable(MEMORY_VARIABLE, (assembly) => {
    try {
      const workspace = resolveWorkspace(assembly?.agent);
      return renderMemoryPrompt({ ...deps, workspace });
    } catch {
      return '';
    }
  });
  ctx.systemPrompt.section({
    name: MEMORY_SECTION,
    order: Number.isFinite(order) ? order : MEMORY_SECTION_FALLBACK_ORDER,
    text: `{{${MEMORY_VARIABLE}}}`,
  });
}

export { assertInside, SUFFICIENCY, search };