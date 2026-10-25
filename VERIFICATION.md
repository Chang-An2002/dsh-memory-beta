# 真机验证：怎么复现

这份文档说明如何**在一个真实的 DSH 内核里**验证本插件确实被加载、注册、并且不会让提示词组装失败。

## 为什么需要它

单元测试用的是**假桩宿主**：一个手写的 `ctx` 对象加上假的 `defineTool`。它测的是"我的逻辑对不对"，测不出"宿主怎么读我们的导出"。

这个区别不是理论上的。本插件曾经在 **62 项自检全绿**的情况下**一次都没能激活**——三个宿主契约错配（`Config` 必须是标准 schema、`ctx.agent` 不能在 `apply` 里读、`ctx.tools.defineTool` 并不是服务方法）没有一个能被假桩抓到，宿主也只是在 stderr 打一行 `entry did not activate`。

所以凡是涉及 `Config` / `inject` / `output` / `parameters` / 提示词段落 / 变量名的改动，都应该跑一遍下面的流程。

## 它能证明什么、不能证明什么

**能证明**

- 包能被 DSH 的 loader 解析，插件 fiber 激活（没有 `entry did not activate`）。
- 五个工具真的进了 `ctx.tools`，且参数表已被 `defineTool` 编译成 JSON Schema。
- 提示词段落与变量已登记，`order` 合法。
- 真实的 `systemPrompt.assemble()` 能跑完，变量求值得到字符串（不是 `undefined`）。

**不能证明**

- 模型会不会调用这些工具（那要看模型，不看插件）。
- 界面表现。
- Linux / macOS 上的行为（本流程只在 Windows 实测过）。

## 前置条件

- 装有 DSH 桌面端（本流程按 Windows 写的）。
- 用 DSH **自带的 Node**（不需要另装）：`<DSH 安装目录>/resources/app.asar` 旁边那套运行时。
- 约 350 MB 磁盘（解包 app.asar 用，验证完可删）。

## 步骤

### 1. 解包 app.asar

Node 无法直接 `import` asar 内的文件，必须先解包：

```bash
node scripts/real-kernel/extract-asar.mjs \
  "C:/Users/<你>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar" \
  .verify/app
```

### 2. 建一个探针 profile

**不要用 `desktop` profile**——`dsh` CLI 会拒绝操作它
（`profile "desktop" is managed exclusively by the Electron application`）。

```
.verify/
  home/profiles/probe/
    package.json          # 依赖 + bundles 列表
    cordis.patch.yml      # 可选，给插件传 config
    node_modules/
      dsh-memory-beta -> 指向本仓库（junction / symlink）
      dsh-memory-probe/   -> 复制自 scripts/real-kernel/probe-plugin
```

`package.json` 里 `dsh.profile.bundles` 要包含
`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless`、`dsh-memory-beta`、`dsh-memory-probe`。

> ⚠️ 写 `package.json` 时别用 PowerShell 的 `Set-Content -Encoding utf8`——它会加 BOM，
> 而 DSH 的 `JSON.parse` 会因此报 `Unexpected token`。用编辑器保存成无 BOM 的 UTF-8。

### 3. 启动

```bash
DSH_HOME=.verify/home \
DSH_MEMORY_PROBE_OUT=.verify/probe-out.md \
node .verify/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile probe "任意任务"
```

没有凭据时，这次运行最终会以 `MISSING_CREDENTIAL` 结束——**这是预期的**，因为探针在
真正调用模型之前就已经把结果写出来了。探针结果在 `.verify/probe-out.md`。

## 预期输出

```
## 1. 工具注册
- kb_index: 已注册 | parameters=JSON Schema（已被 defineTool 编译） | output.render=有
- kb_search: 已注册 | ...
- kb_stats: 已注册 | ...
- memory: 已注册 | ...
- memory_search: 已注册 | ...
合计 5/5

## 2. 提示词段落
- 段落 long-term-memory：已登记 order=2500
- 变量 dsh_memory_long_term：已登记（provider 为 function）

## 3. 真实 assemble() 与变量求值
- assemble 成功，段落数 8
- 变量求值：string，长度 N
```

## 读结果时的三个判据

1. **启动 stderr 里没有 `skipping profile bundle` / `entry did not activate`** —— 否则插件根本没激活，后面都不用看。
2. **`合计 5/5`** —— 少了哪个就说明那个工具的注册失败了（常见原因：与别的插件重名，或参数 schema 不合法）。
3. **变量求值是 `string` 而不是 `undefined`** —— 按 DSH 的契约，未解析变量会让**每一次请求**都失败，而这种错误不会表现为"插件加载失败"。

## 这个流程实际抓到过的问题

见 [CHANGELOG.md](CHANGELOG.md) 的「开发过程中修掉的关键问题」。最关键的一条是：三个契约错配同时存在时，插件在 GUI 里**完全没有反应**，也没有任何错误提示，只有 CLI 启动时的一行 stderr。
