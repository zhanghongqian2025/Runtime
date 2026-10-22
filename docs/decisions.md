# Decisions — 设计决策记录

> 规则：本文档没覆盖的设计决策，按「**最保守且可撤销**」原则选，并在本文登记。
> 每条决策格式：**决策 / 备选 / 取舍理由 / 如何撤销**。
> 决策被推翻时，**保留旧条目并标注"已废弃 → 新决策 D-xxx"**，不删除历史。

---

## D-001 Node.js 版本与安装方式

- **决策**：目标运行时 Node ≥ 22.19；开发机安装 **Node v24.22.0 LTS**（免 sudo，解压到 `~/.local/lib/node-v24.22.0-darwin-arm64`，软链到 `~/.local/bin`）。pnpm 12.14.0。
- **备选**：(a) Node 22.x LTS —— 与最低要求完全对齐，但本机无 Homebrew，安装路径更绕；(b) 系统包管理器安装 —— 需要 sudo，污染系统环境；(c) `fnm`/`nvm` 版本管理器 —— 多一层依赖，且非交互 shell 里 PATH 注入更复杂。
- **理由**：本机**完全没有 Node**，必须先装。选官方 tarball 解压 + 软链：免 sudo、可卸载（删目录即可）、版本可并存。选 24 LTS 而非 22：24 已进入 LTS，API 兼容 22，且 `node:test`/ESM 工具链更成熟。
- **如何撤销**：删除 `~/.local/lib/node-v24.22.0-darwin-arm64` 与 `~/.local/bin/{node,npm,npx,pnpm,pnpx,corepack}` 软链即可。`package.json` 的 `engines` 保持 `>=22.19`，CI 矩阵同时测 22 与 24。

## D-002 `agent-core` 是单包 + 三个子路径导出（与真实工程一致）

- **决策**：`packages/agent-core` 是**一个包**，`src/{tools,event-bridge,pi-turn-runner}` 为其子目录，通过 `package.json#exports` 以子路径（`@local-agent/agent-core/tools` 等）对外暴露。包内用 ESLint 规则禁止反向导入（`tools` / `event-bridge` ⇏ `pi-turn-runner`）。
- **备选**：(a) 三个独立包 —— 编译期边界更强，但与真实工程布局不一致，且多出 3 份 package.json / tsconfig / 构建单元；(b) 单包单入口（只导出根）—— 外部无法只依赖"工具协议层"，`agent-tools` 会被迫依赖整个 loop 核心。
- **理由**：公开仓库 `MiniMax-AI/minimax-code` 的 `packages/agent-core/src/` 下确实是这三个子目录、属同一包（已核对 `contents/packages/agent-core/src`）。规格要求"照抄真实工程的约定"，故采用同构布局；子路径导出同时满足"外部可只依赖协议层"的需求。
- **如何撤销**：若包内出现真实循环依赖，把 `tools` 提升为独立包 `packages/core-tools`（同步改 §2 允许边表与 D-002 本身，保留旧条目并标注"已废弃"）。

## D-003 端口命名与 owner 声明规则

- **决策**：接口按消费者能力命名（`EventDelivery` / `SessionResolver` / `MessageSink` / `ToolBinder` / `PermissionCore`），放在 owner 模块的 `types.ts` / `hooks.ts`；**禁止** `XxxPort`、禁止 `host-ports.ts`、禁止 `types/` 大杂烩桶。当契约是"core 向宿主索取能力"时，由**消费方（core）声明**，宿主实现并注入。
- **备选**：(a) 全部集中在 runtime 声明 —— 会让 core 反向依赖 runtime，违反单向依赖；(b) 全部由 core 声明 —— 会让"事实归属"模糊（如 `SessionResolver` 明明属于 runtime）。
- **理由**：两条规则合起来既满足"单向依赖"又满足"owner 归属"。具体地，`PermissionCore` 契约声明在 `agent-core/tools`（工具层的消费契约），实现落在 `local-runtime/permissions`（安全策略的事实所有者）；`SessionResolver` 契约声明在 `local-runtime/sessions`（事实 owner 自身）。
- **如何撤销**：若某契约被两个包同时需要，优先声明在**更靠近事实 owner** 的一侧，另一侧通过结构类型兼容。

## D-004 存储介质：JSONL + 原子 rename，而非 SQLite

- **决策**：history / events / turns / journal 用 **JSONL 追加**；元数据类（meta / todo / goal / 产物）用 **临时文件 + rename** 原子替换。
- **备选**：(a) SQLite —— 事务能力更强、查询方便，但引入原生依赖（`better-sqlite3` 需编译），且历史数据不可用 `git diff` / `cat` 人工审查，与"可撤销、可审计"的取向冲突；(b) 单个 JSON 文件存全部 —— 写入需整文件重写，大会话下代价高且易损坏。
- **理由**：本项目的数据量是"单个用户的工作会话"，JSONL 的读写模式与访问模式完全匹配；可人工检查 = 可运维。事务需求由 journal（F13）补足。
- **如何撤销**：若日后出现"跨会话全文检索"需求，再引入一个**派生索引**（如 SQLite FTS），保持 JSONL 仍是唯一真相源。**不要**把 SQLite 变成主存储。

## D-005 双层序列号：`seq`（turn 内）+ `logOffset`（session 内）

- **决策**：`RuntimeEvent.seq` 由 **core** 在 turn 内生成（1-based）；`RuntimeEvent.logOffset` 由 **runtime** 落 `events.jsonl` 时分配（session 内单调）。SSE 的 `id:` 用 `logOffset`。
- **备选**：(a) 只有 session 级 seq —— core 无法在 turn 内表达顺序，且与"runtime 不自造 seq"冲突；(b) 只有 turn 级 seq —— 跨 turn 的 SSE 续传无法定位。
- **理由**：规格同时要求"事件 id / runtime seq 在 core 内部按 turn 闭环生成，runtime 不自造"和"SSE 按 seq 断线续传"。两层序号分别满足这两句，且互不冒充。
- **如何撤销**：若客户端统一改用 `id`（`<turnId>:<seq>`）续传，可让 runtime 维护 `turnId → logOffset` 映射表；但届时仍应保留双层字段以免破坏历史日志。

## D-006 HTTP 层用 `node:http`，不引框架

- **决策**：使用 Node 内置 `node:http` + 极小的自研路由/中间件；不引入 Express / Fastify / Hono。
- **备选**：(a) Fastify —— 生态好、schema 友好，但引入依赖与类型摩擦；(b) Hono —— 轻量且 Web 标准，但它是"框架"（规格允许"框架自带的轻量 server"）。
- **理由**：路由面很小（约 20 个端点），需要的能力是：路由、SSE、JSON body 解析、静态错误处理。自研这部分约 200 行，完全可控且零依赖。规格原话是"HTTP 层用框架自带的轻量 server 即可"，`node:http` 正是 Node 自带的。
- **如何撤销**：若路由复杂度上升（中间件链、参数校验），可换 Hono —— 契约层（`protocol` + zod）不受影响。

## D-007 权限：确定性规则引擎，三档模式，默认 deny

- **决策**：权限判定是**纯函数式策略引擎**：`decide(toolName, normalizedInput, mode, sessionRules) → allow|deny|ask`，默认 `deny`；三档模式 `ask` / `auto` / `full-access`。
- **备选**：(a) 规则用正则/DSL 配置化 —— 更灵活，但"判定是否可证明安全"的逻辑难以形式化，易被绕过；(b) 让模型自己判断是否危险 —— 不可靠，且违反 fail-closed。
- **理由**：规格要求"权限判定必须是确定性策略所有者""输出 = allow/deny/ask，且默认 deny"。纯函数 + 有限枚举输出 = 可穷举测试（验收项要求"权限策略矩阵"测试）。
- **如何撤销**：规则表可配置化（`config.yaml` 的 `permissions.rules`），但**判定逻辑本身**保持纯函数，不引入可执行表达式。

## D-008 `bash` 安全性：白名单 + 无 shell 元字符 + 危险模式强制 deny

- **决策**：自动放行需**同时**满足：① 命令在白名单 ② 整个命令串不含 shell 元字符（`;` `|` `&&` `||` `` ` `` `$(` `>` `<` `&`）③ 命中危险模式时一律 deny/强制确认。
- **备选**：(a) 用 shell AST 解析（`bash -n` / tree-sitter）—— 更精确，但引入解析器依赖，且无法覆盖"命令组合"的所有语义；(b) 纯黑名单 —— 漏网即失守。
- **理由**：规格明确"对字面可证明安全的命令才允许自动放行；无法证明安全的一律走 ask 或 deny，不得猜测"。白名单 + 无元字符 = "字面可证明"的最强低成本实现。
- **如何撤销**：若需支持复杂流水线，引入 shell AST 解析并保留危险模式层；**任何情况下都不得**改为"未命中黑名单即放行"。

## D-009 `ask_user` 走独立通道，不复用权限审批通道

- **决策**：问卷（`question.requested` / `question.resolved`）与审批（`permission.requested` / `permission.resolved`）是**两套独立**的挂起机制。
- **备选**：复用审批通道（参数加类型）—— 端点更少，但"是否放行"与"请提供信息"语义相反，混在一起会让审批卡片语义污染，也更难实现"确认动作按 requestId 精确排除"这类 fence 规则。
- **理由**：语义不同、生命周期不同（审批通常单选且短，问卷可能多轮）、fence 规则不同。
- **如何撤销**：见 `docs/architecture.md` §11 Q1；若确需合并，保留两套事件类型，仅共用底层挂起队列。

## D-010 verifier = 独立子会话（隔离 history）

- **决策**：目标验收由**独立子会话**执行（`parentSessionId` 指向目标会话），子会话有独立 history；子会话内 `create_goal` / `update_goal` 被拒绝（`GOAL_MUTATION_FORBIDDEN`）。
- **备选**：(a) 同会话内的受限子代理 —— 实现简单，但会污染主 history、且"禁止改目标"靠提示词约束不可靠；(b) 同进程内的独立 loop、共享 history —— 污染更严重。
- **理由**：规格要求"独立的 verifier 子会话"且"该子会话中禁止再创建/修改目标（防止目标被自己改写）"。独立 history + 工具级硬拒绝 = 双保险。
- **如何撤销**：见 `docs/architecture.md` §11 Q5。

## D-011 压缩走 turn pipeline 的辅助调用路径

- **决策**：compaction 通过**复用同一套 turn pipeline 的辅助调用路径**（走 `beforeLlmCall` hook）实现，产生独立的辅助 turn，**不写入主对话 history**。
- **备选**：(a) 独立的压缩函数直接调 provider —— 简单，但绕过 hook 管线，扩展无法参与，且重试/超时语义会与主链路分叉；(b) 压缩结果写进主 history —— 直接违反"不污染主对话历史"。
- **理由**：规格明确要求复用 hook 路径且不污染主 history。辅助 turn 的事件仍发往客户端（`context.compaction.*`），可观测。
- **如何撤销**：若辅助 turn 造成事件噪音，可给压缩事件加独立 `channel` 标记，客户端默认折叠。

## D-012 密钥只从环境变量读取；配置文件只存变量名

- **决策**：`ModelConfig.apiKeyEnvVar` 存**环境变量名**；进程启动时从 env 取值，仅驻留内存。`config.yaml` 中不出现任何密钥值。
- **备选**：(a) 配置文件存密钥（`0600` 权限）—— 体验好，但违反"密钥只从环境变量或本地配置文件读取，禁止写入日志"这条约束的保守解读，且易被误提交；(b) 系统钥匙串 —— 跨平台实现成本高，本项目明确不做账号体系。
- **理由**：规格允许"环境变量或本地配置文件"，但要求密钥"禁止写入日志、禁止回显、禁止进 git"。选最保守的一侧：**配置文件只存名字**。
- **如何撤销**：若用户明确要求"配置文件存密钥"，改为写 `config.local.yaml`（`0600`）且加入 `.gitignore` 与 `check-secrets.mjs` 扫描；接口形状不变。

## D-013 假 provider = 录制回放（fixture）

- **决策**：e2e 使用**录制回放**的假 provider：fixture 为 JSONL，逐块回放；可注入错误序列（429 / 500 / 401 / timeout）。**不联网**。
- **备选**：(a) mock 掉整个 provider 接口层 —— 无法测重试分类与超时（因为那正是 provider 层的职责）；(b) 本地起一个假 HTTP server —— 更真实，但引入端口管理，且"不联网"要求下仍需本地网络栈。
- **理由**：验收要求"用假 provider（录制回放，不联网）跑一轮含 3 个工具调用的任务"，且"重试分类测试"必须真实经过 provider 适配层。fixture 回放能覆盖到 SSE 分块解析、超时与重试判定。
- **如何撤销**：如需更真实的传输层行为，可让假 provider 起在 `127.0.0.1` 的临时端口（仍是本机、不外网）。

## D-014 构建：pnpm workspace + `tsc -b` project references + vitest

- **决策**：pnpm workspace（`packages/*` + `packages/agent-core/*`）；根 `tsconfig.json` 用 project references 串起所有包，`pnpm build` = `tsc -b`；测试用 vitest（根配置聚合 + 各包独立可跑）。
- **备选**：(a) tsup/esbuild 打包 —— 快，但类型声明与 project references 的增量构建体验更好，且无额外依赖；(b) 单包 + 路径别名 —— 破坏包边界，依赖方向无法机械校验。
- **理由**：project references 能在**编译期**强制包边界（引用不存在的导出直接报错），与"依赖单向"要求天然契合。
- **如何撤销**：若发布需要单文件产物，后续加打包步骤即可（`tsc -b` 产物已是可发布的 ESM + `.d.ts`）。

## D-015 事件日志保留策略

- **决策**：`events.jsonl` 保留最近 2000 条 + 关键事件永久（`session.status`、`permission.*`、`question.*`、`context.compaction.*`、`goal.updated`）。
- **备选**：(a) 无限保留 —— 长期运行会无限膨胀；(b) 纯 FIFO —— 会丢掉"用户曾经批准过什么"这类审计信息。
- **理由**：SSE 续传窗口与审计需求是两个不同需求，分开满足。
- **如何撤销**：保留窗口做成配置项 `runtime.events.retainCount`。

## D-016 CLI 只通过 HTTP 驱动 runtime

- **决策**：CLI 是**纯 HTTP 客户端**（+ SSE 订阅），不进程内调用 runtime。
- **备选**：(a) CLI 直接 import runtime 包 —— 少一次网络往返，但会让 CLI 与 runtime 强耦合、无法测"重启续跑"、也违背"本地服务进程"的产品形态。
- **理由**：规格要求"在本机启动一个本地服务进程"并"附带一个最小可用的客户端（CLI 优先）用于驱动它"。进程边界是设计的一部分。
- **如何撤销**：如需离线批处理，另开一个 `local-agent run --in-process` 入口（复用同一套契约层）。

## D-017 明确不做项不建 stub

- **决策**：规格中"明确不做"的 12 项能力，**不建包、不建空接口、不建 TODO 骨架**。
- **备选**：预留空包/接口占位 —— 看起来"有规划"，但会污染依赖图、误导后续开发者以为功能存在，且违反规格"不要留半成品 stub"。
- **理由**：显式约束。
- **如何撤销**：任何一项要实现时，作为**新包**提出并走同一套评审，同时更新 `docs/architecture.md` §1.3。

## D-018 工具结果截断阈值

- **决策**：单条结果 32 KiB、单次调用 256 KiB、2000 行；超限**保头尾**（头 60% / 尾 40%），中间插入 `…[truncated N bytes]…`，并在 `truncated` 字段标注被裁剪字节数。
- **备选**：(a) 只保头 —— 尾部常含错误信息与退出码；(b) 直接丢弃超限结果 —— 模型失去关键信息且无从得知。
- **理由**：规格要求"保头尾 + 标注被裁剪字节数"且"不得让单条工具结果撑爆上下文"。
- **如何撤销**：阈值做成配置项（`runtime.tools.maxResultBytes`）。

## D-019 计划冻结快照 = 纯 Markdown（front-matter 仅元信息）

- **决策**：`artifacts/plan.review.md` 为**纯 Markdown 正文**；审阅元信息（planId、冻结时间、批准人、源草稿哈希）放在**独立文件** `artifacts/plan.review.meta.json`，正文不掺 front-matter。
- **备选**：(a) 正文带 YAML front-matter —— 一份文件自包含，但模型读取时可能把元信息当正文；(b) 只存 JSON —— 用户不友好。
- **理由**：实施轮以冻结快照为权威依据，**正文纯净**比自包含更重要；元信息单独存便于程序校验哈希。
- **如何撤销**：见 `docs/architecture.md` §11 Q2。

## D-020 目标自动续跑不合成隐藏 prompt

- **决策**：目标未达成且无阻塞时，runtime **直接 continue 已有 history** 发起下一轮，**不**构造任何"系统提示/隐藏 user 消息"。
- **备选**：(a) 注入隐藏提示"继续推进直到完成" —— 实现直观，但会污染 history 与 provider 请求视图（违反"不合成隐藏 prompt"）；(b) 新建一轮并重放历史 —— 成本更高且效果相同。
- **理由**：规格明确"不合成隐藏 prompt，直接 continue 已有 history"。
- **如何撤销**：无。

---

## D-021 `bash` 后台任务在 turn / 会话结束后继续运行

- **决策**：以 `background: true` 启动的 `bash` 任务**脱离 turn 生命周期**：turn 结束、turn 被 abort、会话被关闭后任务**仍继续运行**。输出持续追加到 `sessions/<sid>/artifacts/background/<taskId>.log`（滚动，保头尾，上限 10 MB）。日志首行为 JSON 头 `{ taskId, pid, command, startedAt }`，模型用 `read` 工具读该文件即可查看进度，需要时按 pid 自行终止。
- **备选**：(a) 任务随 turn 结束被 kill —— 简单，但编译 / 测试类长任务不可用；(b) 任务随会话目录删除被清理 —— 删除会话时必须额外回收子进程，容易漏。
- **理由**：用户拍板"继续跑"。长时任务是真实场景（构建、测试套件），且"任务与对话解耦"更符合本地执行器的直觉。
- **如何撤销**：把后台任务的存活期改为绑定 turn 生命周期，只需改后台 supervisor 的收尾钩子；产物格式与读取方式不变。

## D-022 上下文压缩的计量口径按 token 估算

- **决策**：上下文水位、输出预算与"一次压缩至少节省 70%"一律按 **token 估算**计算。估算函数：优先使用 provider 适配器暴露的 `countTokens`；不可得时回退 `estimateTokens(text) = ceil(utf8ByteLength(text) / 4)`。回退口径对 CJK 文本会**低估**（实际约 1 token/汉字），该偏差被接受并记录在压缩事件的 `savedRatio` 中。
- **备选**：(a) 按字符数 —— 与 token 无稳定关系，水位会失真；(b) 强制引入 tiktoken —— 额外依赖且不覆盖所有 provider 的分词规则。
- **理由**：用户拍板"token"。
- **如何撤销**：所有调用点统一走 `estimateTokens` / `countTokens` 两个入口，替换实现即可。

## D-023 `apply_patch` 采用统一 diff 文本

- **决策**：`apply_patch` 接受**统一 diff 文本**（`--- a/<path>` / `+++ b/<path>` / `@@ -l,c +l,c @@` hunk）。逐 hunk 精确匹配应用；**任一 hunk 失败则整体回滚**（已应用的部分全部还原）并返回失败原因。
- **备选**：(a) 结构化 JSON patch —— 需要模型额外产出 JSON，格式错误率显著高于 diff 文本；(b) 只支持新增/删除整文件 —— 表达能力不足。
- **理由**：用户拍板"统一 diff 文本"；模型原生产出的就是该格式，解析更稳。
- **如何撤销**：解析（patch → hunk 列表）与执行（hunk → 文本变更）分离，新增 JSON patch 输入源不需要改执行器。

---

## D-024 回合预算：LLM 重试 5 次、step 50 步

- **决策**：单个 turn 内，`afterLlmCall` 连续要求 `retry` 超过 **5** 次，或 step 数超过 **50**，则 turn **显式失败**（`session.status: failed`，原因写明预算耗尽），而不是继续跑。
- **备选**：(a) 不设上限 —— hook 写错就会无限循环，实测会把 V8 拖到崩溃；(b) 交给 provider 的重试预算兜底 —— 那是**物理请求**层预算，管不到 hook 层的"重跑一轮"。
- **理由**：规格只要求"重试在同一 product turn 内"，没给上限；验收又要求"没有无限循环"。取与 provider 重试预算同量级的 5 次，是最保守的一侧。
- **如何撤销**：两个常量在 `packages/agent-core/src/pi-turn-runner/run-turn.ts`（`MAX_LLM_RETRIES` / `MAX_STEPS`），改值即可；`docs/contracts.md` §3.6 需同步。

## D-025 M1 的会话存储是内存实现

- **决策**：M1 的会话与历史只存在进程内存里（`createMemorySessionStore`），接口就是最终的 `SessionStore` 契约；磁盘持久化在 M4 落地，契约不变。
- **备选**：(a) M1 就写 JSONL —— 提前实现 M4 的内容，且会让 M1 的验收掺入未验证的崩溃恢复语义；(b) 用 SQLite —— 同上，且引入依赖。
- **理由**：M1 的验收目标是"用户消息 → 一次 LLM → 文本回复，事件流完整"。持久化有自己的验收项（重启续跑不重复执行工具），提前做会模糊里程碑。
- **如何撤销**：实现一个新的 `SessionStore` 并在 `createRuntimeServer` 里换掉即可；上层（turn system、HTTP 路由）不感知存储介质。

---

## D-026 子进程不继承完整环境变量

- **决策**：`bash` 启动的命令只拿到 `PATH` / `HOME` / `LANG` / `LC_ALL` / `TMPDIR` / `USER` / `SHELL` 七个变量，再加上工具上下文里的白名单变量；**不继承**运行时的完整进程环境。
- **备选**：(a) 继承完整 `process.env` —— 构建类命令最省事，但模型可以让命令跑 `env` 把运行时的 API 密钥读出来；(b) 完全清空环境 —— 安全，但 `bash` 连 `PATH` 都没有，几乎不可用。
- **理由**：工具执行的是**模型生成的命令**。密钥在运行时是活的（provider 用），泄漏它等于让模型绕过权限层拿到凭据。取"够用且不泄密"的一侧。
- **如何撤销**：扩展 `COMMAND_ENV_KEYS`（`packages/agent-tools/src/bash.ts`）即可；若某类任务确实需要某个变量，按变量名显式加白名单，而不是整体放开。

---

## D-027 审批等待：core 发事件并等待，宿主持有 pending

- **决策**：`permission.requested` / `permission.resolved` 由 **core** 发布（core 拥有事件信封与 `seq`），core 在 `BeforeToolCallContext.requestApproval` 里**等待**；**宿主**持有 pending 请求，并在用户应答后 resolve（`POST /v1/sessions/{id}/permissions/{requestId}`）。
- **备选**：(a) 宿主直接发布审批事件 —— 宿主拿不到 core 的 turn 内序号，只能自造，破坏"core 拥有 seq"；(b) core 自己持有 pending map —— core 每轮都是新实例，宿主没有句柄去 resolve 它。
- **理由**：事件信封归 core、挂起状态归宿主，两者用 `requestApproval` / `onApprovalRequested` 这一对接口连起来。core 只管"发事件 + 等待"，不关心 HTTP；宿主只管"存 pending + 解决"，不关心序号。
- **如何撤销**：若要让宿主直接发事件，需要给宿主一个"发布宿主事件"的公共通道（当前只有工具通过 `ctx.emitEvent` 拿到）。

---

## D-028 会话落盘：JSONL + 原子替换，内存实现整体退役

- **决策**：M4 起**只有一种会话存储实现**——磁盘版（`sessions/disk-store.ts`）：`meta.json` 原子替换，`history.jsonl` / `turns.jsonl` / `events.jsonl` 追加，`history.checkpoints/` 存检查点，`journal.jsonl` 记写前日志。原来的内存实现被**删除**（而不是两套并存）。
- **备选**：(a) 内存 + 磁盘双实现 —— 上层要面对两个语义，测试要跑两遍，且"哪套是真的"没有答案；(b) SQLite —— 事务更强，但引入原生依赖、且历史不再可人工审查（与 D-004 的取舍相反）。
- **理由**：一个事实一个 owner。M1–M3 的内存实现只是"还没有磁盘"阶段的临时物；M4 之后它不再有存在价值，留着只会变成第二个真相源。
- **如何撤销**：若测试需要无盘运行，实现一个同契约的 `SessionStore` 并在 `createRuntimeServer` 里替换；磁盘版是默认。

## D-029 中断的 turn 不自动续跑

- **决策**：进程重启后，处于 `running` 状态的 turn 被标记为 `interrupted`，**不会被自动续跑**。已经完成的工具调用保留在 turn 索引与历史里，不会再执行一次；用户用 `--continue` 发新消息时，对话在既有历史上继续。
- **备选**：(a) 自动续跑中断的 turn —— 看起来"更聪明"，但工具可能有副作用（写文件、发请求），自动重放等于替用户做了决定；(b) 完全不记录中断状态 —— 续跑时无法区分"已完成"和"没开始"，就可能重复执行。
- **理由**：规格要求"重启后 --continue 接着对话且**不重复执行已完成的工具调用**"。记录终态 + 不自动续跑，是同时满足这两条的最小实现。
- **如何撤销**：若要支持"恢复未完成的 turn"，在恢复流程里按 turn 索引只重放**未完成**的工具调用，并把该行为做成显式开关（默认关）。

---

## D-030 计划模式是应用层策略，不是 core 能力

- **决策**：计划模式住在 `local-runtime-v2/service/plan`，通过**回合策略**（`TurnPolicy`）接入回合系统：策略负责**分类**（run / defer / cancel）、**注入权威上下文**（冻结快照）与**收窄工具**（计划模式去掉执行类工具、加上 `plan_write`）。core 不认识"计划"这个概念。
- **备选**：(a) 把计划模式写进 `agent-core` —— core 就会知道"会话"与"产品模式"，违反"core 只负责 loop"；(b) 让 HTTP 路由直接改会话状态 —— 判定与落库分成两处，补偿语义没法保证。
- **理由**：计划模式是**产品语义**（先规划后执行、审阅、fence），不是循环机制。策略接口让应用层拥有语义、core 保持无知；`agent-core` 只多了一个 `TurnPolicy` 契约。
- **如何撤销**：若要把计划模式下沉到 core，需要在 core 里引入"会话模式"概念——那是一次架构变更，不是这个决策的反面。

## D-031 被 fence 挡下的队列暂存在内存里

- **决策**：计划模式激活或审阅挂起时，普通消息被分类为 `defer`：消息**立即写入历史**（所以不会丢），但**暂不执行**；待执行的 turn 列表放在**内存**里。审阅通过时 `resumeDeferred` 释放它们。进程重启后，待执行的 turn 不会自动续跑（与 D-029 一致）。
- **备选**：(a) 待执行队列落盘 —— 需要给会话存储再加一套队列契约与恢复语义，M5 的验收项并不要求；(b) 不暂存，消息直接丢弃 —— 用户的输入会消失，不可接受。
- **理由**：消息本身在历史里（不丢），丢的只是"何时执行"。重启后由用户再发一条即可，符合 D-029 的"不替用户做决定"。
- **如何撤销**：给 `SessionStore` 加 `enqueue/dequeue`（JSONL），并让 `recoverSessions` 把 pending 队列重新装回内存。

---

## D-032 目标模式是应用层策略，用回合策略接入

- **决策**：目标模式住在 `local-runtime-v2/application/agent/goal`，通过回合策略接入：策略在**回合结束时**被通知（`afterTurn`），由它决定"再跑一轮 / 暂停 / 阻塞"。core 不认识"目标"，它只提供一个 `TurnPolicy` 契约和两个回合能力（`continueTurn` / `awaitTurn`）。
- **备选**：(a) 把目标循环写进 core —— core 就会知道"产品模式"和"验收"，违反"core 只负责 loop"；(b) 让 HTTP 层轮询目标状态来决定续跑 —— 轮询既不及时也不可靠。
- **理由**：目标模式是**产品语义**（终点、验收、预算、阻塞），与计划模式同层。core 只提供机制（继续一轮、等一轮结束），语义留在应用层。
- **如何撤销**：若要把目标循环下沉到 core，需要在 core 里引入"验收/预算/阻塞"概念——那是一次架构变更，不是这个决策的反面。

## D-033 自动续跑有两道刹车

- **决策**：自动续跑由两道刹车兜底：① **token 预算**（用完即暂停，并提示可以提升预算后继续）；② **轮次上限** `MAX_GOAL_ROUNDS = 50`（超过即暂停）。另外"连续两轮无进展"与"方向明显错误"也会暂停并汇报。
- **备选**：(a) 只靠预算 —— 没有预算上限的目标会一直跑到天荒地老；(b) 只靠轮次 —— 一个明明该停的目标会白白烧掉 50 轮 token。
- **理由**：规格要求"没有无限循环"。预算与轮次各管一头：一个管**花费**，一个管**时长**。
- **如何撤销**：两个常量都在 `packages/local-runtime-v2/src/application/agent/goal/service.ts`（`MAX_GOAL_ROUNDS`、`MAX_ROUNDS_WITHOUT_PROGRESS`），预算上限来自 `update_goal({ tokenBudget })`。

---

## D-034 Web 控制台是零依赖静态页，只做 HTTP API 的一个客户端

- **决策**：`GET /` 返回一个单文件静态页面（原生 HTML/JS/CSS，无框架、无客户端构建），复用 CLI 用的同一套 HTTP API。三栏布局（会话 / 对话 / 实时事件流）+ 底部输入框；**每个面板自己滚动，页面不滚动**；待审批卡片放在输入框**上方**的独立容器里，不在会被重建的对话区里；非 2xx 响应必须显式报错；SSE 从 `logOffset` 续传并自动重连。
- **备选**：(a) 引 React/Vue 之类的框架 —— 违背"无 UI 框架"的既定边界，还要引入构建链与依赖审计；(b) 只做 CLI，不要界面 —— CLI 是最小闭环，但审批、长输出、事件流这些用 CLI 很难受；(c) 复用 Electron 壳 —— 本项目没有桌面壳的需求，徒增体积与签名负担。
- **理由**：规格明确"不做 UI 框架"，但"要能用"包含一个能看见、能点批准的入口。零依赖静态页把成本压到**一个文件**，而它的行为完全由 HTTP 契约决定，不引入第二套真相。
- **如何撤销**：删掉 `packages/local-runtime/src/http/ui/` 与 `scripts/copy-ui.mjs` 即可，运行时其余部分不依赖它。

## D-035 被拦截的工具调用也要写回结果，并且要再问模型一次

- **决策**：工具被权限层或策略**拦截/拒绝**时，运行时照常往历史里追加一条 `role:'tool'` 的消息，内容是 `isError: true` 的 `tool_result`（正文写明被谁、因为什么拦下）；并且**循环继续**，让模型看到拒绝并给出回应。
- **备选**：(a) 拦截后什么都不写、也不继续 —— 历史里留下一条没有结果的 `tool_use`，上游可能回**空内容**，一轮"看起来成功"其实什么也没发生；(b) 拦截后直接终止整轮 —— 用户拿不到任何解释，体验比拒绝本身更糟。
- **理由**：**每个 `tool_use` 都必须有配对的 `tool_result`**，否则历史畸形。这是数据完整性要求，不是风格问题。模型需要知道"这次调用没跑成"才能改用别的方式。
- **如何撤销**：删掉 `run-turn.ts` 里 `block` 分支中的 `messages.push(...)`，并把 `continueLoop` 改回只看 `completed`——但那会把"静默空回复"重新引回来。

## D-036 上游的空回复必须当失败处理

- **决策**：provider 适配器在流正常结束、却**没有任何内容块**时，抛出 `empty-response`（**不可重试**）。**纯工具调用**（没有文字）不算空回复。
- **备选**：(a) 当成成功、返回空消息 —— 用户看到"这一轮什么也没发生"，而日志里全是成功记录，最难排查；(b) 归到 `unknown` —— 语义含糊，无法与真正的未知错误区分。
- **理由**：部分上游对畸形历史**不报错**，而是 `200` + 空流。这类"成功"是**失败伪装成成功**，必须显式失败（fail-closed）。有了它，D-035 描述的那类问题才会立刻暴露，而不是变成静默。
- **如何撤销**：从 `PROVIDER_ERROR_KINDS` 移除 `empty-response`，并删掉两个适配器里的 `assertProduced()`。

## D-037 测试绑定临时端口，不占用配置端口

- **决策**：`RuntimeServer.listen(port?)` 接受端口覆盖；**所有测试用 `listen(0)`**，由操作系统分配空闲端口。生产入口仍然用配置里的 `httpPort`。
- **备选**：(a) 测试继续用 8787 —— 开发者本地跑着运行时时，`pnpm test` 必然 `EADDRINUSE` 失败；(b) 让测试改配置文件 —— 破坏"配置只由启动参数决定"的边界。
- **理由**：测试套件必须能在"本机正跑着同一个运行时"的情况下通过，否则回归验证只能靠先停服务。
- **如何撤销**：把测试里的 `listen(0)` 改回 `listen()`，并删掉 `listen` 的可选参数。

---

## 设计选择收敛索引

第一轮评审的 8 个待确认问题已于 2026-10-21 全部收敛，对应决策：Q1→D-009、Q2→D-019、Q3→D-004、Q4→D-021、Q5→D-010、Q6→D-022、Q7→D-015、Q8→D-023。索引见 `docs/architecture.md` §11。

M1 期间新增的两条决策（规格未覆盖、按最保守且可撤销处理）：**D-024**（回合预算：LLM 重试 5 次 / step 50 步）、**D-025**（M1 会话存储为内存实现，契约不变、持久化在 M4 落地）。
