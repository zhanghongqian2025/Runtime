# Contracts — 事件、Hook、工具、权限、HTTP、Provider

> 本文件是**对外契约**的权威来源。`packages/protocol` 中的 zod schema 是其可执行副本；
> 两者冲突时以 schema 为准，并在同一次改动里修订本文件。

---

## 0. 通用约定

| 约定 | 规则 |
| --- | --- |
| 权威来源 | 所有跨包数据形状在 `packages/protocol` 用 zod 声明，**运行时校验** |
| 校验时机 | ① HTTP 入参（出口）② 持久化读回（入口）③ provider 响应（入口）④ 事件发往客户端（出口） |
| 时间戳 | ISO-8601 UTC 字符串（`2026-10-21T06:43:12.345Z`） |
| 标识符 | ① `sessionId` = `sess_<26位base32url>` ② `turnId` = `turn_<26位base32url>` ③ `toolCallId` = `tool_<26位base32url>` ④ `requestId` = `req_<26位base32url>` ⑤ `eventId` = `<turnId>:<seq>` |
| 分页 | 列表接口用 `?limit=&cursor=`，`cursor` 为不透明字符串 |
| 未知字段 | 入参 schema 用 `.strict()` 拒绝未知字段（fail-closed，避免拼写错误被静默忽略） |
| 大小写 | JSON 字段一律 `camelCase` |

---

## 1. 消息模型（`packages/protocol/src/message.ts`）

### 1.1 角色与块

```ts
export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,        // { type:'text'; text:string }
  ThinkingBlockSchema,    // { type:'thinking'; text:string; signature?:string }
  ToolUseBlockSchema,     // { type:'tool_use'; toolCallId:string; name:string; input:unknown }
  ToolResultBlockSchema,  // { type:'tool_result'; toolCallId:string; content:ToolContentBlock[]; isError:boolean }
  ImageBlockSchema,       // { type:'image'; mediaType:string; data:string /*base64*/ }
  CustomBlockSchema,      // { type:'custom'; kind:CustomMessageKind; hidden:boolean; payload:unknown }
]);
```

### 1.2 AgentMessage

```ts
export interface AgentMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  readonly createdAt: string;
  readonly meta?: {
    readonly turnId?: string;
    readonly stepIndex?: number;
    readonly usage?: TokenUsage;      // { inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens? }
    readonly providerId?: string;
    readonly model?: string;
  };
}
export const AgentMessageSchema: z.ZodType<AgentMessage>;
```

### 1.3 Typed custom message（隐藏消息）

`appendMessage` 决策只接受 `kind` 属于**封闭枚举**的 custom block；`hidden: true` 表示不进入 provider 请求视图。

```ts
export const CustomMessageKindSchema = z.enum([
  'marker.tail',                 // 追加到 history 末尾
  'marker.before-current-user',  // 插入到当前真实 user 消息之前
  'after-commit',                // 本轮已提交结果的说明（排在所有 tail marker 之前）
]);
export const CustomBlockSchema = z.object({
  type: z.literal('custom'),
  kind: CustomMessageKindSchema,
  hidden: z.literal(true),
  payload: z.unknown(),
});
```

**封闭枚举是硬约束**：不在枚举内的 kind 一律 `parse` 失败（返回 `undefined`），不允许 runtime 塞入任意结构。

---

## 2. 事件协议

### 2.1 两套词汇的分工

| | `AgentEvent` | `RuntimeEvent` |
| --- | --- | --- |
| 位置 | `protocol/src/agent-event.ts` | `protocol/src/runtime-event.ts` |
| 面向 | **loop 内部**：core 内部的语义 | **对外主干**：客户端 / SSE |
| 产生 | `pi-turn-runner` 内部 | `event-bridge` 转换而来 |
| 顺序 | 单调 | 单调，且携带 core 分配的 `seq` |

> 核心不允许直接产出 `RuntimeEvent`；必须先产出 `AgentEvent`，再经 `event-bridge` 转换。这样转换逻辑是**纯函数**，可独立测试。

### 2.2 AgentEvent 清单（内部词汇）

```
turn.started              turn.completed            turn.failed
step.started              step.completed
llm.request.started       llm.response.completed    llm.retry.scheduled
text.delta                thinking.delta
tool.intent.created       tool.intent.started       tool.intent.progress
tool.intent.completed     tool.intent.blocked
file.changed
history.flushed
compaction.started        compaction.completed
```

### 2.3 RuntimeEvent 清单（对外主干）

统一信封：

```ts
export interface RuntimeEventEnvelope {
  readonly id: string;          // eventId = `${turnId}:${seq}`
  readonly seq: number;         // turn 内 1-based，单调递增（core 生成）
  readonly logOffset: number;   // session 内单调递增（runtime 落 events.jsonl 时分配）
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly ts: string;
  readonly type: RuntimeEventType;
}
export type RuntimeEvent = RuntimeEventEnvelope & RuntimeEventPayload;
```

`RuntimeEventType` 与载荷：

| type | 载荷字段 | 说明 |
| --- | --- | --- |
| `session.status` | `status: 'running'\|'completed'\|'failed'\|'aborted'\|'awaiting_approval'\|'awaiting_input'`, `reason?: string`, `error?: {code,message}` | **终态事件**：turn 结束时必发且只发一次 |
| `message.delta` | `messageId`, `text: string` | assistant 文本增量 |
| `message.completed` | `message: AgentMessage` | 完整 assistant 消息（含 usage） |
| `thinking.delta` | `messageId`, `text: string` | thinking 增量 |
| `tool.call.started` | `toolCallId`, `name`, `input: unknown` | 工具开始执行 |
| `tool.call.progress` | `toolCallId`, `name`, `chunk: string` | 增量输出（bash 后台/流式） |
| `tool.call.completed` | `toolCallId`, `name`, `result: ToolResult` | 工具结束（含 isError） |
| `file.changed` | `path: string`, `change: 'created'\|'modified'\|'deleted'`, `bytes?: number` | 文件变更（路径脱敏） |
| `permission.requested` | `requestId`, `toolName`, `input`, `risk`, `matchedRule?: string`, `reason`, `options: ApprovalOption[]` | 审批卡片 |
| `permission.resolved` | `requestId`, `choice: 'allow-once'\|'allow-session'\|'deny'`, `decidedBy: 'user'\|'timeout'\|'policy'` | 审批结果 |
| `question.requested` | `requestId`, `title`, `questions: QuestionItem[]` | 问卷请求 |
| `question.resolved` | `requestId`, `answers: Record<string,string>`, `cancelled?: boolean` | 问卷结果 |
| `todo.updated` | `items: TodoItem[]` | todo 清单（进度真相源） |
| `context.compaction.started` | `reason: 'watermark'\|'manual'`, `beforeTokens: number` | 压缩开始 |
| `context.compaction.completed` | `beforeTokens`, `afterTokens`, `savedRatio: number`, `checkpointId` | 压缩完成（`savedRatio < 0.7` 视为无效） |
| `goal.updated` | `goal: GoalSnapshot` | 目标状态变化 |

**M0 增补的运行时事件**（实现时为使事件流自描述而加入，payload 已在下表固定）：

| type | 载荷字段 | 说明 |
| --- | --- | --- |
| `step.started` | `stepIndex: number` | 一个 step（一次 assistant 响应 + 其工具执行）开始 |
| `step.completed` | `stepIndex: number` | step 结束 |
| `llm.request.started` | `attempt: number` | 一次 physical provider 请求发起 |
| `llm.retry.scheduled` | `attempt: number`, `delayMs: number`, `reason: string` | 计划中的重试（退避后发出） |
| `tool.call.blocked` | `toolCallId: string`, `blockedBy: string`, `reason: string` | 工具调用被阻断（权限/策略/扩展），**未执行、无副作用** |

> `tool.call.completed` 的载荷是 `ToolResult`（`ok` / `content` / `isError` / `metadata?` / `truncated?`）。
> `ToolResult` 的契约定义在 `protocol` 而非工具层：它要穿过"工具 → 事件 → 客户端"三道边界。

### 2.4 双层序列号（重要）

- `seq`：**turn 内**序号，由 **core** 生成（core 闭环，runtime 不自造）。
- `logOffset`：**session 内**序号，由 runtime 在写入 `events.jsonl` 时分配。

两者不冲突：`seq` 表达 turn 内部顺序，`logOffset` 表达会话内可续传位置。

### 2.5 断线重连契约

- SSE 端点：`GET /v1/sessions/{id}/events?after=<logOffset>`
- 响应头 `Content-Type: text/event-stream`，每条事件的 SSE `id:` 字段 = `logOffset`。
- 客户端断线后用两种方式之一续传：
  - `Last-Event-ID: <logOffset>` 请求头，或
  - `?after=<logOffset>` 查询参数（`Last-Event-ID` 优先）。
- 服务端从 `events.jsonl` 中 `logOffset > after` 的条目开始重放，然后转入实时推送。
- **不重复**：重放区间为 `(after, latest]`，与实时流在 `latest` 处无缝衔接。
- 超出保留窗口的 `after`（事件已被轮转丢弃）→ 返回 `409 EVENT_LOG_TRUNCATED`，客户端应改用 `GET /v1/sessions/{id}/history` + `GET /v1/sessions/{id}/status` 重建状态。

---

## 3. Hook 契约（`packages/agent-core/pi-turn-runner/src/hooks.ts`）

### 3.1 三类 hook 的语义（**必须区分**）

| 类别 | hook | 执行方式 | 失败语义 |
| --- | --- | --- | --- |
| **decision pipeline** | `beforeLlmCallHook` / `afterLlmCallHook` / `beforeToolCallHook` / `afterToolCallHook` | 按注册顺序**依次执行**，每个 hook 的返回值参与决策 | 任一最终失败 → **本 turn fail-close** |
| **notification fan-out** | `onHistoryChangedHook` | 按注册顺序**逐个 await**（投递） | 任一最终失败 → **本 turn fail-close** |
| **boundary hooks** | `onStepEndHook` | 按注册顺序依次执行，**避免多模块争用同一 boundary** | 任一失败 → 本 turn fail-close |

**ack 语义**（`onHistoryChangedHook`）：
- hook 的 resolve 即 **delivery ack**。
- 只有**全部 ack 之后**才推进 history cursor。
- 任一 hook 最终失败（reject / 超时 / 返回 rejected promise）→ 本 turn fail-close：
  - 不继续执行尚未开始的工具；
  - 不发起下一次 LLM 请求；
  - turn 终态为 `failed`，错误码 `HOOK_ACK_FAILED`。

### 3.2 `beforeLlmCallHook` 决策集

```ts
export type BeforeLlmCallDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'skip' }                            // 不发起 provider 请求，本 step 直接结束
  | { readonly kind: 'replaceRequestMessages'; readonly messages: readonly AgentMessage[] } // 仅替换请求视图
  | { readonly kind: 'replaceMessages'; readonly messages: readonly AgentMessage[] }           // 替换 canonical history（持久化）
  | { readonly kind: 'appendMessage'; readonly message: AgentMessage }  // 仅接受 hidden typed custom message
  | { readonly kind: 'respond'; readonly text: string }   // 零 usage 的 assistant 响应
  | { readonly kind: 'abort'; readonly reason: string };
```

**逐条约束：**

- `appendMessage`
  - 只接受 `kind ∈ {marker.tail, marker.before-current-user, after-commit}` 的 hidden custom message；否则该决策被**拒绝**（记 `invalidDecision`，pipeline 视为 `continue`，不终止）。
  - **不结束 decision pipeline**：后续 hook 立刻能看到已累积的 marker（通过决策入参的 `pendingMarkers` 字段）。
  - marker 按**注册顺序**累积：
    - `marker.tail` → 落在 history 末尾；
    - `marker.before-current-user` → 落在当前真实 user 消息**之前**；
    - `after-commit` → 排在**所有 tail marker 之前**。
  - 最终落盘顺序：`[...history替换结果, after-commit 消息, ...tail marker（注册序）]`，且**只 flush 一次 history**。
  - 落盘失败 → **fail-closed**（本 turn 终止，不发起 provider 请求）。

- `respond`
  - 只允许 **host 已验证的非空文本**：`text.trim().length > 0`，且必须带 `verified: true` 标记（由 host 注入的可信来源）。
  - **不发起 provider 请求**，生成 `usage = { inputTokens: 0, outputTokens: 0 }` 的 assistant 响应。
  - 用途：把**独立执行器**（如 verifier 子会话）已完成的可信结果提交回当前 turn。
  - **禁止**用于绕过正常模型调用：若同一 turn 内已发生 provider 调用，则 `respond` 决策被拒绝（记 `respondAfterProviderCall`，pipeline 视为 `continue`）。

- `replaceRequestMessages` 只影响**本次请求的临时副本**，不写 canonical history。
- `replaceMessages` 是**durable replace**，写入 canonical history（与已放置的 marker 一并带上）。
- `abort` 立即终止 turn，`session.status = aborted`，携带 `reason`。

### 3.3 `afterLlmCallHook` 决策集

```ts
export type AfterLlmCallDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string; readonly error?: { code: string; message: string } };
```

- `retry`
  - 通过 **Pi 内部 follow-up queue** 在**同一个 product turn 内**重试。
  - 被拒绝的 response：**不进入 completed message、不进 history**，并**同步删除 loop 中对应的 tool intent**。
  - 重试次数上限由 provider 重试预算约束（§7.4），语义不同的两层预算**不叠加**。
- `fail`
  - 删除**尚未执行**的 tool intent；
  - 在**当前 step 边界**终止 loop；
  - **不消费**该 step-end hook 新排入的 internal steering / follow-up（丢弃本 step 末尾新入队的项）。

### 3.4 `beforeToolCallHook` / `afterToolCallHook`

```ts
export type BeforeToolCallDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'block'; readonly reason: string; readonly blockedBy?: 'permission'|'policy'|'extension' };

export type AfterToolCallDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'replaceResult'; readonly result: ToolResult };
```

- `block`：**只阻断 + 标注 `blockedBy`**，不执行工具、不产生副作用。
- 被阻断的 tool call 以**只读**数组 `blockedToolCalls` 传给 `onStepEndHook`（不含任何可执行引用）。
- 权限层**不得**直接执行工具；它只提供判定（§5）。

### 3.5 `onStepEndHook`（boundary）

```ts
export interface StepEndContext {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly completedToolCalls: readonly ToolCallSummary[];
  readonly blockedToolCalls: readonly BlockedToolCall[];   // 只读
  readonly usage: TokenUsage;
  readonly state: 'step-end';
}
export type OnStepEndHook = (ctx: StepEndContext) => Promise<void> | void;
```

- boundary hooks 按序执行，避免多模块争用同一 boundary（例如 plan-mode 与 goal-verifier 不得同时改写 step 末尾状态）。
- 本 hook **不参与** decision pipeline（无返回值决策），但**抛错会导致本 turn fail-close**。

---

### 3.6 回合预算（防止无限循环）

规格未定义 hook 驱动的重试上限，本仓库按「最保守且可撤销」补上（决策 D-024）：

| 预算 | 值 | 触发时的行为 |
| --- | --- | --- |
| `MAX_LLM_RETRIES` | 5 | 同一 turn 内 `afterLlmCall` 连续要求重试超过 5 次 → turn 失败（`TURN_ABORTED`），原因写明 |
| `MAX_STEPS` | 50 | 单个 turn 的 step 数超过 50 → turn 失败（`TURN_ABORTED`） |

预算耗尽是**显式失败**，不是静默截断：事件流里能看到 `session.status: failed` 与原因。

---

## 4. 工具协议（`packages/agent-core/tools/src/types.ts`）

### 4.1 模型可见的 ToolDefinition

```ts
export interface ToolDefinition {
  readonly name: string;              // ^[a-z][a-z0-9_]{0,63}$
  readonly description: string;       // 模型可见；不得包含密钥、绝对路径模板
  readonly schema: z.ZodTypeAny;      // 工具入参 schema（zod）
  readonly executionMode: 'sync' | 'async' | 'background';
  readonly prepareArguments?: (raw: unknown) => PrepareResult; // 预处理/规范化，失败返回 {ok:false,error}
  readonly risk?: RiskLevel;          // 'none'|'low'|'medium'|'high'|'critical'
}
export type PrepareResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
```

### 4.2 执行侧 ToolImpl

```ts
export interface ToolImpl {
  readonly definition: ToolDefinition;
  execute(
    ctx: ToolExecutionContext,
    input: unknown,
    signal: AbortSignal,
    onUpdate: (u: ToolUpdate) => void,
  ): Promise<ToolResult>;
}
```

### 4.3 ToolExecutionContext

```ts
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly cwd: string;                 // 工作区根（绝对路径，仅内部使用，不外泄）
  readonly env: Readonly<Record<string, string>>;  // 已脱敏的环境变量白名单
  readonly now: () => number;
  readonly requestPermission: (req: ApprovalRequest) => Promise<PermissionDecision>;
  readonly onFileChanged: (c: FileChange) => void | Promise<void>;
  /** 发布宿主侧事件（信封由 core 分配，session 偏移由 host 分配） */
  readonly emitEvent: (body: RuntimeEventBody) => Promise<void>;
  /** 结构化问卷：发布请求后等待用户作答 */
  readonly askUser: (request: QuestionRequest) => Promise<QuestionResolution>;
  /** 会话文件：`todo.json`、`artifacts/plan.md`、`artifacts/background/<id>.log` */
  readonly artifacts: ToolArtifacts;
  /** 结果大小治理阈值 */
  readonly limits: ToolOutputLimits;
  readonly log: ToolLogger;             // 结构化日志，自动 redact
}

/**
 * 宿主提供的部分。
 *
 * core 拥有调用身份与事件通道，宿主只提供环境：工作目录、环境变量、时钟、
 * 大小阈值、权限/问卷桥接、会话文件与日志器。
 */
export type ToolEnvironment = Omit<
  ToolExecutionContext,
  'sessionId' | 'turnId' | 'toolCallId' | 'emitEvent'
>;
```

### 4.4 ToolResult 与大小治理

```ts
export interface ToolResult {
  readonly ok: boolean;
  readonly content: readonly ToolContentBlock[];   // text | image
  readonly isError: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly truncated?: { readonly omittedBytes: number; readonly strategy: 'head-tail'|'head'|'none' };
}
```

**大小治理契约**（所有工具必须遵守）：

| 上限 | 默认值 | 行为 |
| --- | --- | --- |
| 单条工具结果最大字节 | 32 KiB | 超限按 **保头尾** 截断：保留头 60% + 尾 40%，中间插入 `\n…[truncated N bytes]…\n` |
| 单次调用最大总字节 | 256 KiB | 超限直接截断并置 `truncated` |
| 单条结果最大行数 | 2000 | 超限保头尾 |

- 截断**必须**在 `metadata`/`truncated` 中标注被裁剪的字节数，供模型判断信息是否丢失。
- 不得让单条工具结果撑爆上下文：写入 history 前再次按全局预算裁剪（§8）。

### 4.5 RuntimeTool / ToolBinder

```ts
export interface RuntimeTool {
  readonly definition: ToolDefinition;
  readonly runtime: 'local';
  readonly enabled: boolean;
}

export interface ToolBinder {
  resolve(name: string): ToolImpl | undefined;
  list(): readonly RuntimeTool[];
  bind(definitions: readonly ToolDefinition[]): readonly RuntimeTool[];  // 过滤未启用/未知
}
```

> 同名工具允许不同实现；**core 只认协议，不认实现来源**。

### 4.6 本地工具集（`packages/agent-tools`）

| 工具 | 关键入参 | 关键行为 | 风险等级 |
| --- | --- | --- | --- |
| `read` | `path`, `offset?`, `limit?` | 按行范围读取；超长行/大文件按 §4.4 截断；支持 `head`/`tail` | low |
| `write` | `path`, `content` | 整文件写；目录不存在时**不自动创建**（报错） | medium |
| `edit` | `path`, `oldString`, `newString`, `replaceAll?` | 精确字符串替换；**oldString 不唯一或未命中 → 返回可诊断错误**（含出现次数与建议），绝不静默失败 | medium |
| `apply_patch` | `patch`（**统一 diff 文本**，D-023） | 逐 hunk 精确匹配应用；任一 hunk 失败则**整体回滚**并返回失败原因 | medium |
| `bash` | `command`, `timeoutMs?`, `background?` | 带超时、输出上限、后台任务与增量回调；shell 命令执行。**后台任务在 turn / 会话结束后继续运行**（D-021），输出落 `artifacts/background/<taskId>.log` | **high**（按命令内容再判定） |
| `grep` | `pattern`, `path?`, `mode: 'regex'\|'literal'`, `glob?`, `maxMatches?` | 内容搜索；regex 非法 → 返回可诊断错误 | low |
| `glob` | `pattern`, `path?`, `maxResults?` | 文件名/路径模式搜索 | low |
| `todo_write` | `items: TodoItem[]` | 任务清单（**进度真相源**），触发 `todo.updated` 事件 | none |
| `ask_user` | `title`, `questions: QuestionItem[]` | 结构化问卷；阻塞点使用；结果经 `question.resolved` 回填 | none |

`TodoItem`：`{ id, content, status: 'pending'|'in_progress'|'completed'|'cancelled', priority?: 'low'|'medium'|'high' }`。

`QuestionItem`：`{ id, question, type: 'single'|'multi'|'text'|'boolean', options?: { id, label }[], required?: boolean, defaultValue?: unknown }`。

### 4.7 M2 落地的工具行为

| 工具 | 实现要点 |
| --- | --- |
| `read` | `offset` 为 1 起始行号、`limit` 为行数；目录/缺失文件/越界路径都返回**可诊断错误**；结果按 §4.4 保头尾裁剪并标注裁剪字节数 |
| `write` | 父目录不存在时**报错**（不自动建目录，避免掩盖拼写错误）；写后经 `onFileChanged` 上报 `created`/`modified` |
| `edit` | `oldString` 命中 0 次 → 报错并附前缀提示；命中 >1 次且未设 `replaceAll` → 报错并给出出现次数；**绝不静默失败** |
| `apply_patch` | 统一 diff；逐 hunk 精确匹配（行号漂移时回退到上下文搜索）；**任一 hunk 失败则整体回滚**并在错误里写明 |
| `bash` | 超时（默认 120s）→ SIGTERM→SIGKILL；`AbortSignal` → 立即终止；非零退出码 → 错误结果并附输出；增量输出经 `onUpdate` 回调 |
| `bash`（后台） | **脱离 turn 生命周期继续运行**（D-021）：detached + unref，输出落 `artifacts/background/<taskId>.log`，日志首行为 `{ taskId, pid, command, startedAt }` JSON 头；模型用 `read` 读该文件跟进进度 |
| `bash` 的环境 | **不继承完整进程环境**：只透传 `PATH/HOME/LANG/LC_ALL/TMPDIR/USER/SHELL` + 工具白名单变量，模型无法通过 `env` 读到运行时的 API 密钥 |
| `grep` | `literal`（默认）/ `regex` 两种模式；正则非法 → 报错；输出 `path:line:content`；跳过二进制文件与常见噪声目录 |
| `glob` | 模式匹配**相对路径**（`**` 跨目录、`*` 不跨目录、`?` 单字符）；结果排序后按 §4.4 裁剪 |
| `todo_write` | 写入会话文件 `todo.json`（进度真相源）**并**发布 `todo.updated` 事件 |
| `ask_user` | 生成 `requestId` → 发布 `question.requested` → 等待 `ctx.askUser` → 发布 `question.resolved`；通道与审批通道分离（D-009） |

**路径安全**：所有文件类工具只允许访问工作区根之内；越界路径（`..`、绝对路径逃逸）一律拒绝并报 `escapes the workspace`。
**会话文件**：`ctx.artifacts` 的根是**会话目录**，因此工具用 `todo.json`、`artifacts/plan.md`、`artifacts/background/<id>.log` 这样的相对路径寻址，与 `docs/state-ownership.md` §2 的磁盘布局一致。

---

## 5. 权限契约（`packages/local-runtime/src/permissions/types.ts`）

### 5.1 PermissionCore（**唯一判定所有者**）

```ts
export type PermissionMode = 'ask' | 'auto' | 'full-access';

export interface PermissionQuery {
  readonly toolName: string;
  readonly normalizedInput: unknown;  // 规范化后的参数（去绝对路径、去临时噪声后的稳定形式）
  readonly mode: PermissionMode;
  readonly sessionRules: readonly SessionRule[];  // 本会话已授予的规则
  readonly cwd: string;
}

export type PermissionOutcome = 'allow' | 'deny' | 'ask';

export interface PermissionDecision {
  readonly outcome: PermissionOutcome;
  readonly reason: string;            // 人类可读，必须能解释为什么
  readonly risk: RiskLevel;
  readonly matchedRule?: string;      // 命中的规则描述（脱敏）
  readonly approval?: ApprovalRequest; // outcome==='ask' 时给出
}

export interface PermissionCore {
  decide(query: PermissionQuery): PermissionDecision;
  /** 发起审批并等待用户作答（宿主持有 pending 请求，core 负责发事件与等待） */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResolution>;
  resolveApproval(requestId: string, choice: ApprovalChoice): void;
  listSessionRules(sessionId: string): readonly SessionRule[];
}
export type ApprovalChoice = 'allow-once' | 'allow-session' | 'deny';
```

> **审批等待放在哪**：core 负责**发事件**（它拥有信封）与**等待**，宿主负责**持有 pending 请求**并在用户应答后 resolve。
> 因此 `BeforeToolCallContext` 带一个 `requestApproval(request)` 能力，`RunTurnInput` 带一个 `onApprovalRequested(request)` 回调（决策 D-027）。

**默认 deny**：`decide` 任何未命中规则的情况返回 `deny`（`mode='auto'` 且工具风险 `none/low` 时才可能 `allow`）。

### 5.2 判定矩阵

| 情形 | ask | auto | full-access |
| --- | --- | --- | --- |
| 风险 `none`（`todo_write`） | allow | allow | allow |
| 风险 `low`（`read`/`grep`/`glob`） | **ask** | allow | allow |
| 风险 `medium`（`write`/`edit`/`apply_patch`） | ask | ask（可被会话规则 allow） | allow |
| 风险 `high`（`bash` 不可证明安全） | ask | **deny** | allow |
| 高危类别（删除 / 覆盖 / 推送到远端 / 改系统配置 / 读凭据文件 / 网络外发） | **deny 或强制人工确认** | **deny** | **强制人工确认**（不静默放行） |

### 5.3 命令安全性判定（`bash`）

- 只允许**字面可证明安全**的命令自动放行：白名单命令 + 无 shell 元字符（`;` `|` `&&` `||` `` ` `` `$()` `>` `<` `&`）+ 无危险参数模式。
- 白名单示例（保守起步）：`ls` `cat` `pwd` `echo` `wc` `head` `tail` `grep` `find`(限深度) `git status` `git log` `git diff` `node --version` `pnpm --version`。
- **无法证明安全 → 一律 `ask` 或 `deny`，绝不猜测。**
- 危险模式（不区分模式，一律 deny 或强制确认）：`rm -rf /`、`curl … | sh`、`wget … | bash`、读取 `~/.ssh/id_rsa` / `~/.aws/credentials` / `*.pem`、`git push`、`npm publish`、`chmod 777 /`、`dd of=/dev/`、`sudo`、写 `/etc/`、写 `~/.zshrc`/`.bashrc`、写系统 PATH 目录。

### 5.4 M3 落地的判定顺序

判定是**纯函数**（`decidePermission(call, { mode, sessionRules, cwd })`），顺序固定：

1. **高危类别优先**（`detectHazard`）：越界路径 / 凭据文件 / 系统与 shell 配置 / 危险命令。
   → `ask`/`auto` 模式 **deny**；`full-access` 模式仍然 **ask**（高危类别永远要人点头）。
2. **会话规则**：命中即 allow（规则可带 `commandPrefix`，只覆盖同前缀命令）。
3. **未知工具**：直接 deny（策略不认识的工具一律不批）。
4. **模式矩阵**（见 §5.2）。

`bash` 的风险由命令本身决定：可证明安全 → `low`；不可证明安全 → `high`；危险 → `critical`。

### 5.5 审批卡片

```ts
export interface ApprovalRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;          // 脱敏后的参数（绝对路径 → 占位符）
  readonly risk: RiskLevel;
  readonly matchedRule?: string;
  readonly reason: string;
  readonly options: readonly ApprovalOption[];  // 单次允许 / 会话允许 / 拒绝
}
export interface ApprovalOption { readonly id: ApprovalChoice; readonly label: string; readonly default?: boolean }
```

- 审批在用户回应前**保持挂起**（turn 状态 `awaiting_approval`）。
- 请求落盘于 `pending/permissions/<requestId>.json`，进程重启后可恢复挂起状态。
- **判定日志不得包含密钥内容**；`input` 在写入日志与事件前必须经 `redact()`。

### 5.6 M3 落地的接口与文件

| 产出 | 位置 |
| --- | --- |
| 纯策略（判定顺序 + 模式矩阵 + 风险表） | `packages/local-runtime/src/permissions/policy.ts` |
| 命令安全判定（白名单 / 元字符 / 危险模式） | `packages/local-runtime/src/permissions/commands.ts` |
| 参数规范化与危险路径识别 | `packages/local-runtime/src/permissions/normalize.ts` |
| 权限服务（会话规则 + pending 审批） | `packages/local-runtime/src/permissions/core.ts` |
| 接入点（`beforeToolCallHook` → 阻断 / 追问） | `packages/local-runtime/src/turns/turn-system.ts` |
| 应答端点 | `POST /v1/sessions/{id}/permissions/{requestId}`（`{ choice }`） |
| 状态上报 | `GET /v1/sessions/{id}/status` 增加 `pendingApprovals` / `pendingQuestions` |
| CLI 交互 | `local-agent send` 打印审批卡片，读取 `1/2/3` 后应答 |

**被阻断的调用**：`beforeToolCallHook` 返回 `{ kind:'block', blockedBy:'permission' }` → 工具**不执行、无副作用** → 线上出现 `tool.call.blocked` 事件 → 该调用以只读形式进入 `blockedToolCalls` 传给 step-end hook。

---

## 6. HTTP API 契约（`packages/local-runtime/src/http`）

### 6.1 通用

- 默认绑定 `127.0.0.1`；端口可配（`httpPort`），默认 `0`（系统分配）并把实际端口写入 **端口文件** `~/.local/state/local-agent/runtime.json`。
- 所有响应 `Content-Type: application/json; charset=utf-8`（SSE 除外）。
- **错误不吐栈**：任何未预期异常映射为 `500 INTERNAL_ERROR`，`message` 为人类可读描述，堆栈只进本地日志。

```ts
export interface ApiError {
  readonly error: {
    readonly code: string;            // 见 §6.3
    readonly message: string;         // 人类可读
    readonly details?: unknown;       // 可选结构化细节（已脱敏）
  };
}
```

### 6.2 运行时配置

配置来自三处，优先级从低到高：**默认值 → 配置文件 → 环境变量**。

- 配置文件：`${XDG_CONFIG_HOME:-~/.config}/local-agent/config.yaml`（也接受 `config.yml` / `config.json`）。
- 文件里**只有设置**，没有密钥：provider 写 `apiKeyEnvVar`（变量名），密钥只在环境里。
- 环境变量：`LOCAL_AGENT_HOST`、`LOCAL_AGENT_HTTP_PORT`、`LOCAL_AGENT_PERMISSION_MODE`。
- 文件**存在但坏了**（YAML 语法错、字段不合法）→ 明确报错并拒绝启动，**不静默忽略**。
- 环境变量里的非法权限模式 → 忽略该值并回落到 `ask`（绝不因此放宽权限）。

```yaml
host: 127.0.0.1
httpPort: 8787
permissionMode: ask
providers:
  - id: openai-compatible
    baseUrl: https://api.example.com/v1
    apiKeyEnvVar: EXAMPLE_API_KEY   # 只写变量名
    model: example-model
    contextWindowTokens: 128000
    maxOutputTokens: 16384
```

### 6.3 端点

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ status:'ok', version, uptimeMs, pid }` |
| GET | `/v1/version` | `{ name, version, protocolVersion, buildCommit? }` |
| GET | `/v1/config` | 运行时配置（**已脱敏**：只返回 env 变量名，不返回值） |
| POST | `/v1/sessions` | 创建会话 → `{ session }` |
| GET | `/v1/sessions?limit&cursor` | 列出会话（不含历史正文） |
| GET | `/v1/sessions/{id}` | 会话元数据 |
| GET | `/v1/sessions/{id}/status` | 运行状态（running/queued/awaiting_approval/…） |
| DELETE | `/v1/sessions/{id}` | 删除会话（需 `?force=true` 才有子会话） |
| POST | `/v1/sessions/{id}/fork` | `{ fromMessageId? \| fromTurnIndex? }` → 新 sessionId |
| POST | `/v1/sessions/{id}/rewind` | `{ toTurnIndex \| toMessageId, resend: string }` → 回退并重发 |
| GET | `/v1/sessions/{id}/history` | canonical history（分页） |
| POST | `/v1/sessions/{id}/messages` | `{ text, interactionMode? }` → `{ turnId }`（异步执行） |
| GET | `/v1/sessions/{id}/events` | **SSE** 事件流（§2.5） |
| GET | `/v1/sessions/{id}/todo` | 当前 todo 清单 |
| GET | `/v1/sessions/{id}/goal` | 目标状态（无目标 → 404 `GOAL_NOT_FOUND`） |
| POST | `/v1/sessions/{id}/goal` | 创建/更新目标（admission 事务） |
| GET | `/v1/sessions/{id}/artifacts/{name}` | 读会话产物（如 `plan.md`） |
| PUT | `/v1/sessions/{id}/artifacts/{name}` | 写会话产物（原子写） |
| POST | `/v1/sessions/{id}/mode` | `{ interactionMode: 'default'\|'plan' }`（admission 事务） |
| POST | `/v1/sessions/{id}/plan/review` | `{ decision:'approve'\|'reject', feedback?, requestId }` |
| POST | `/v1/sessions/{id}/permissions/{requestId}` | `{ choice }` 审批应答 |
| POST | `/v1/sessions/{id}/questions/{requestId}` | `{ answers }` 问卷应答 |

> **M0 落地范围**：已实现 `/health`、`/v1/version`、`/v1/config`（返回**已脱敏**配置：只给出密钥的**环境变量名**与 `apiKeyConfigured` 布尔量，绝不返回值）。其余端点在对应里程碑落地。
> `GET /health` 返回 `{ status, name, version, protocolVersion, uptimeMs, pid }`。

> **M1 落地范围**：会话端点全部可用（创建 / 列出 / 读取 / 状态 / 历史 / 发消息 / 删除），事件流 `/v1/sessions/{id}/events` 为 SSE 且**支持按 `logOffset` 续传**（`?after=` 或 `Last-Event-ID`）。
>
> **M4 增补**：
> - `POST /v1/sessions/{id}/fork` —— `{ fromMessageId? \| fromTurnId?, title? }` → `201 { session }`；新会话继承历史到分叉点。
> - `POST /v1/sessions/{id}/rewind` —— `{ toMessageId? \| toTurnId?, resend }` → `202 { session, turnId }`；历史被截断，`resend` 由 turn system 追加（**只存一次**）。
> - `GET /v1/sessions/{id}/status` 增加 `pendingApprovals` / `pendingQuestions`。
> - 会话与事件**落盘**：重启后会话、历史、事件日志、turn 索引都在，SSE 仍可按 offset 续传。
> `POST /v1/sessions/{id}/messages` 返回 `202 { turnId, queued }`：`queued=1` 表示该会话已有 turn 在跑，本轮排队。
> 未实现：`fork`、`rewind`（M4）、`/v1/sessions/{id}/mode` 与 `/plan/review`（M5）、`/v1/sessions/{id}/goal`（M6）。

### 6.4 错误码表

| code | HTTP | 含义 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 入参不符合 schema |
| `NOT_FOUND` | 404 | 资源不存在 |
| `SESSION_BUSY` | 409 | 会话正忙，需 `force` |
| `SESSION_LOCKED` | 409 | 另一个进程持有会话锁 |
| `CONFLICT` | 409 | 状态冲突（如模式已在目标状态） |
| `EVENT_LOG_TRUNCATED` | 409 | 请求的 `after` 超出事件保留窗口 |
| `APPROVAL_REQUIRED` | 409 | 需要先处理挂起的审批 |
| `QUESTION_REQUIRED` | 409 | 需要先回答问卷 |
| `PLAN_REVIEW_PENDING` | 409 | 计划审阅未完成，阻塞普通 turn |
| `GOAL_BLOCKED` | 409 | 目标处于 blocked |
| `GOAL_NOT_FOUND` | 404 | 无目标 |
| `GOAL_BUDGET_EXCEEDED` | 409 | token 预算耗尽 |
| `BUDGET_EXCEEDED` | 402 | 账户额度（上游）耗尽——不重试 |
| `RATE_LIMITED` | 429 | 本地限流 |
| `PROVIDER_AUTH_FAILED` | 502 | 上游鉴权失败——不重试 |
| `PROVIDER_ERROR` | 502 | 上游错误 |
| `LLM_TIMEOUT` | 504 | 上游超时（可重试后仍失败） |
| `INTERNAL_ERROR` | 500 | 未预期异常（不吐栈） |

### 6.5 Admission（准入）事务

模式切换、计划审阅、目标状态变更**必须**在同一个事务内完成「校验 + 落库 + 受理」：

```
BEGIN (journal)
  1. validate  —— 校验前置状态（幂等/冲突检查）
  2. persist   —— 写 meta.json / goal.json / artifacts（原子 rename）
  3. accept    —— 受理 turn（入队、释放 fence、置状态）
COMMIT (journal 中标记 commit)
```

任一步失败 → **回滚**（恢复旧值、删除已写文件、释放已受理的 turn），并向客户端返回结构化错误。**不允许半状态。**

---

## 7. Provider 契约（`packages/local-runtime/src/providers`）

### 7.1 统一接口

```ts
export interface ProviderAdapter {
  readonly id: 'openai-compatible' | 'anthropic-messages';
  stream(req: ProviderRequest, ctx: ProviderCallContext): AsyncIterable<ProviderStreamChunk>;
}
export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly AgentMessage[];   // 已是 provider-bound 投影
  readonly tools: readonly ProviderToolSpec[];
  readonly maxOutputTokens: number;
  readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number };
  readonly temperature?: number;
  readonly signal: AbortSignal;
}
export interface ProviderCallContext {
  readonly attempt: number;          // physical attempt 序号，从 1 开始
  readonly logicalCallId: string;    // 同一次逻辑调用（含重试）共享
  readonly firstEventTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}
export type ProviderStreamChunk =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly toolCallId: string; readonly name: string; readonly input: unknown }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | { readonly kind: 'done' };
```

### 7.2 模型配置

```ts
export interface ModelConfig {
  readonly providerId: 'openai-compatible' | 'anthropic-messages';
  readonly baseUrl: string;
  readonly apiKeyEnvVar: string;   // 只存**环境变量名**，不存值
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: 'none'|'low'|'medium'|'high';
  readonly thinking?: { readonly enabled: boolean };
  readonly extraHeaders?: Readonly<Record<string, string>>;  // 同样不得含密钥明文
}
```

### 7.3 重试分类（**最容易做错，逐条照抄**）

| 失败类型 | 可重试 | 判定依据 |
| --- | --- | --- |
| 连接超时 | ✅ | `ECONNABORTED` / `ETIMEDOUT` / 首事件超时 |
| 网络失败 | ✅ | `ECONNRESET` / `ENOTFOUND` / `EAI_AGAIN` / socket 错误 |
| HTTP 429 | ✅ | 状态码 429 |
| TPM / RPM 限流 | ✅ | 429 且 body 命中限流特征 |
| HTTP 529 / overload | ✅ | 状态码 529 或 `overloaded_error` |
| Token 额度耗尽 / credits | ❌ | body 命中额度特征（`insufficient_quota` / `credit`） |
| 鉴权失败 | ❌ | HTTP 401 / 403 |
| 显式 abort | ❌ | `signal.aborted` |
| bad request | ❌ | HTTP 400 / 422 |
| 内容过滤 | ❌ | body 命中 `content_filter` / `safety` |
| 通用 5xx | ❌ | HTTP 500/502/503/504（**529 除外**） |
| 未知失败 | ❌ | 其他 |

### 7.4 重试预算

| 参数 | 值 |
| --- | --- |
| 首次请求后的最大重试次数 | **5** |
| 退避 | 指数 + **equal-jitter**（`delay = random(0, min(cap, base * 2^n))`） |
| `Retry-After` | 尊重但**钳制**到单次 delay 上限内 |
| 单次 delay 上限 | 60 s |
| 总 elapsed budget | 20 min（总超时） |
| provider 自带 retry | **固定 0**（避免框架预算与 SDK 预算叠加） |
| 首事件超时（每个 physical attempt） | 300 s |
| 空闲超时（每个 physical attempt） | 60 min |
| 总超时 | 20 min |

### 7.5 丢弃与上抛规则

- **只有「尚未提交可见 text / thinking / tool call」的失败 attempt 才允许丢弃。**
- 一旦有可见输出被提交，后续错误**原样上抛**，不重新执行该次调用（避免重复副作用）。
- 若 provider stream 在**首个有效输出前断开**：`terminal attempt` 的 iterator 与 `result()` 必须以**同一个已捕获错误**收敛（否则 title / compaction 这类 result-only 调用会挂死）。
- 超时以可重试的 `LLM request timed out` 结束，交给重试判定；用户 abort 原样透传。

### 7.6 指标

三层拆分，互不混淆：

| 层 | 定义 | label 允许值 |
| --- | --- | --- |
| physical request | 一次实际 HTTP 请求 | `provider`, `model`, `errorKind` |
| logical call | 一次逻辑调用（含其重试） | 同上 |
| retry episode | 一次「调用 + 其全部重试」 | 同上 |

- **不得**把额外重试请求计入成功率分母（成功率分母 = logical call）。
- metric label **只允许有限枚举**：`provider` / `model` / `errorKind`。
- **禁止**把 `sessionId` / `turnId` / `callId` / 用户标识写进 label（高基数爆炸 + 隐私）。

---

## 8. 上下文压缩与投影契约

### 8.1 纯函数投影

```ts
export function projectAgentMessagesForModel(
  messages: readonly AgentMessage[],
  options: ProjectionOptions,
): AgentMessage[];   // 返回**临时副本**，不改写 canonical history
```

`ProjectionOptions`：`{ providerId, supportsThinking, supportsImages, maxOutputTokens, keepLastTurns }`。

投影规则：
1. **孤儿 tool_result 清理**：没有对应 `tool_use` 的 `tool_result` 从请求视图中剔除（canonical history 不动）。
2. **thinking 兼容**：provider 不支持 thinking 时，thinking 块从请求视图剔除（history 保留）。
3. **多模态投影**：provider 不支持图片时，图片块替换为文本占位说明。
4. **顺序不变**：投影不重排消息。

### 8.2 压缩触发

- 依据**模型上下文窗口**动态计算：
  - `outputBudget = min(model.maxOutputTokens, contextWindow * 0.25)`
  - `compactWatermark = contextWindow - outputBudget - reserveTokens`
- **不在模型输出上限处过早压缩**：压缩水位必须预留完整输出预算。
- 压缩优先裁剪**低收益工具结果**：保头尾、合并连续同类结果、优先丢弃最旧的大块工具输出。

### 8.3 压缩有效性（M4 落地）

压缩以 **`beforeLlmCall` hook** 的形式接入：水位到了就用 `{ kind:'replaceMessages' }` 走契约里既有的 durable replace 机制，不另开一条旁路。

执行顺序：**checkpoint → 裁剪 → 摘要 → 达标才替换**。

| 步骤 | 行为 |
| --- | --- |
| checkpoint | 压缩前把当前历史写入 `history.checkpoints/<id>.jsonl`（journal 记 `begin`） |
| 裁剪 | 工具结果**处处**保头尾（头 1 KiB + 尾 512 B，可配）；头尾的**消息**不丢，但其中的巨型工具结果照样裁 |
| 丢弃 | 仍然超标时，按**整轮**丢弃最旧的轮次（一个 assistant 消息 + 它的并行工具结果一起丢，**不拆散**并行任务） |
| 摘要 | 通过**辅助调用**（独立 turn、独立 requestId、**空的 message sink**）请求模型总结被丢弃的部分；摘要作为一条 assistant 消息放在最前 |
| 达标 | `savedRatio ≥ 0.7` 才替换历史（journal 记 `commit`）；不达标则**放弃**并如实上报 `savedRatio` |

- **不污染主对话历史**：摘要调用使用空的 `messageSink`，它的消息不进 canonical history。
- **不丢子任务/并行任务状态**：todo 清单与 turn 索引都在历史之外，压缩不动它们；并行工具结果按整轮处理，不会只剩一半。
- 压缩失败（未达标）时历史**保持原样**，事件里如实上报 `savedRatio`。

### 8.4 压缩的度量口径

- 一次压缩必须至少节省 **70%** 上下文（`savedRatio >= 0.7`）才算有效；未达标则继续裁剪或放弃（并在事件里如实上报 `savedRatio`）。
- **计量口径按 token 估算**（D-022）：优先用 provider 适配器的 `countTokens`；不可得时回退 `estimateTokens(text) = ceil(utf8ByteLength(text) / 4)`。回退口径对 CJK 文本会低估（实际约 1 token/汉字），该偏差被接受并在 `savedRatio` 中体现。
- **压缩前落 checkpoint**（`history.checkpoints/<checkpointId>.jsonl`），压缩后**不丢失子任务/并行任务状态**（todo 清单与并行工具调用的状态单独保留，不随消息裁剪而消失）。
- 压缩通过**同一套 turn pipeline 的辅助调用路径**实现（复用 `beforeLlmCall` hook），**不污染主对话历史**。

---

## 9. 计划模式契约（应用层）

### 9.1 状态

```ts
export type InteractionMode = 'default' | 'plan';
// 会话 meta.json 中 interactionMode 字段缺失 → 按 'default' 处理
```

### 9.2 生命周期

| 动作 | 前置校验 | 落库 | 补偿 |
| --- | --- | --- | --- |
| 进入 plan | 会话存在、未处于 plan | `meta.interactionMode='plan'` + 旧 `artifacts/plan.md` → `artifacts/plan.md.bak-<ts>` | **admission 被拒 → 恢复草稿**（即不发生） |
| 退出 plan（提交审阅） | plan 已激活、plan.md 存在 | 冻结快照 `artifacts/plan.review.md` | **admission 成功但草稿提交失败 → 补偿模式（退回 default）+ 恢复草稿 + 把已受理的 turn 结算为失败** |
| 批准审阅 | 存在待确认审阅 | 记录 `approved` | — |
| 拒绝审阅 | 存在待确认审阅 | 记录 `rejected` + 反馈，回到 plan 模式 | — |

- 退出计划模式时提交**冻结的 Markdown 快照**给用户确认（确认 / 拒绝并给出修改意见）。
- 用户批准后，实施那一轮**以冻结快照为权威依据**；之后用户再改 `plan.md` **不改变**该轮的实施依据。

### 9.3 Fence 与队列

- 待确认的审阅**阻塞普通 turn 与队列项**。
- 确认动作自身**按 `requestId` 精确排除**，不被自己的 fence 阻塞。
- 计划模式激活时：普通消息可**入队**但被分类器判定为 `defer`（延后）；**计划入口项在模式外尚未执行时被取消**。
- **幂等**：重复的 plan-exit 在已是 `default` 的会话上**幂等通过**（不报错、不重复备份）。

### 9.4 M5 落地的实现

| 产出 | 位置 |
| --- | --- |
| 计划文档约定：`artifacts/plan.md`（草稿）、`artifacts/plan.md.bak-<ts>`（备份）、`artifacts/plan.review.md`（冻结快照）、`artifacts/plan.review.meta.json`（元数据） | `packages/agent-extension/src/plan-mode.ts` |
| `plan_write` 工具：只能写 `artifacts/plan.md` | `packages/agent-extension/src/plan-mode.ts` |
| 计划服务：`enter` / `exit` / `review` / `state` / `isBlocked` / `classify` / `prepareTurn` / `binderForTurn` | `packages/local-runtime-v2/src/service/plan/plan-service.ts` |
| 回合策略契约（分类 / 上下文注入 / 工具收窄） | `packages/local-runtime/src/turns/policy.ts` |
| 组合根（把计划服务装成回合策略） | `packages/local-runtime-v2/src/app.ts` |
| 端点 | `POST /v1/sessions/{id}/mode`、`GET /v1/sessions/{id}/plan`、`POST /v1/sessions/{id}/plan/review` |
| 事件 | `plan.mode.changed`、`plan.review.requested`、`plan.review.resolved` |
| CLI | `local-agent plan enter｜review｜approve｜reject｜show` |

**判定与执行分离**：计划模式不碰工具执行，它只决定"这一轮能不能动"。

- **工具收窄**：计划模式下的回合拿到的工具集**去掉了执行类工具**（`bash`/`write`/`edit`/`apply_patch`），只留只读工具（`read`/`grep`/`glob`）与 `plan_write`。计划阶段**改不了任何东西**，只能写计划草稿。
- **权威依据**：批准后，下一个回合会被注入一条 **system 消息**（冻结快照全文）。它是**一次性**的（`consumed` 标记），而且**快照本身不再变**——之后用户改 `plan.md` 不影响已批准的依据。
- **补偿**：`enter` 是「模式切换 + 草稿备份」的组合。备份失败 → **模式退回 `default`** + 恢复草稿 + 把已受理的计划入口 turn **结算为失败**（`session.status: failed`，错误码 `PLAN_ADMISSION_COMPENSATED`）。`exit` 同理：快照写不进去 → 恢复草稿 + 结算失败。
- **幂等**：`enter` 在已是 `plan` 的会话上直接返回（不重复备份）；`review` 重复应答返回既有结论。

**队列分类**（`TurnPolicy.classify`）：

| 情形 | 结果 |
| --- | --- |
| 审阅待确认，且这一项**就是该审阅的确认**（`requestId` 相同） | `run`（自我豁免） |
| 审阅待确认（其他任何项） | `defer` |
| 计划入口项，且会话**在** plan 模式 | `run` |
| 计划入口项，但会话**不在** plan 模式 | `cancel` |
| 普通消息，且会话**在** plan 模式 | `defer` |
| 普通消息，且会话在 default 模式 | `run` |

被 `defer` 的消息**立即写入历史**（不会丢），只是暂不执行；审阅批准后 `resumeDeferred` 释放它们。

---

## 10. 目标模式契约（应用层）

### 10.1 工具面

| 工具 | 语义 |
| --- | --- |
| `create_goal` | 设定目标：文本 + 可选验收标准/约束/边界/停止条件 |
| `get_goal` | 读取目标状态（文本、验收标准、状态、预算、轮次、阻塞信息） |
| `update_goal` | 提交终态（completed/blocked/paused/cleared）或调整 token 预算 |

### 10.2 目标解析

从目标文本解析出：**目标 / 验收标准 / 约束 / 工作边界 / 停止条件**。

- 解析器为**纯函数**，对不可识别输入返回 `undefined`（**绝不 throw**）。
- **解析不出就要求用户补全**（发 `question.requested`），**不瞎猜**。

### 10.3 状态机

```
        create_goal
             │
             ▼
          active ──pause──▶ paused ──resume──▶ active
             │                │
             ├──complete──▶ completed
             ├──block─────▶ blocked
             └──clear─────▶ cleared
```

- 状态变更持久化于 `goal.json`，**进程重启后可恢复**。
- 预算与状态必须持久化。

### 10.4 自动续跑

- 一轮结束后若目标未达成且无阻塞 → runtime **自动发起下一轮**：
  - **不合成隐藏 prompt**，直接 **continue 已有 history**。
- 自动暂停条件：
  - 达到 token 预算上限；
  - **连续两轮无进展**；
  - 方向明显错误（verifier 判定为无效进展）。
- 预算耗尽 → 明确提示 + 可提升后继续（`update_goal` 调整预算）。

### 10.5 独立校验（verifier）

- 验收由一个**独立的 verifier 子会话**执行（`parentSessionId` 指向目标会话，history 隔离）。
- **子会话内禁止 `create_goal` / `update_goal`**（防止目标被自己改写）——调用直接被拒绝并返回 `GOAL_MUTATION_FORBIDDEN`。
- verifier 结论**必须带证据**：测试结果、构建输出、日志、产物路径。

### 10.6 M6 落地的实现

| 产出 | 位置 |
| --- | --- |
| 目标文本解析（纯函数；解析不出返回 `undefined`） | `packages/local-runtime-v2/src/application/agent/goal/parse.ts` |
| 目标工具面（`create_goal` / `get_goal` / `update_goal`） | `packages/local-runtime-v2/src/application/agent/goal/tools.ts` |
| 状态机 + 预算 + 自动续跑 | `packages/local-runtime-v2/src/application/agent/goal/service.ts` |
| 独立 verifier 子会话 | `packages/local-runtime-v2/src/application/agent/goal/verifier.ts` |
| 目标存储（会话目录下的 `goal.json`） | `packages/local-runtime-v2/src/application/agent/goal/store.ts` |
| 端点 | `GET /v1/sessions/{id}/goal`、`POST /v1/sessions/{id}/goal` |
| 事件 | `goal.updated` |
| CLI | `local-agent goal show｜set｜status` |

**解析**：目标文本支持两种形态——带标签的（`目标:` / `验收:` / `约束:` / `边界:` / `停止条件:`）与官方文档的模板句式。解析不出「目标 + 验收标准」时，`create_goal` **不猜**：它用 `ask_user` 请用户补全，再合并重解析；仍不完整才报错。

**工具面**：

| 工具 | 语义 |
| --- | --- |
| `create_goal` | 设定目标（文本 + 可选 token 预算）。解析不出 → 请用户补全。**verifier 会话里拒绝** |
| `get_goal` | 读取状态（目标、验收标准、约束、边界、停止条件、预算、轮次） |
| `update_goal` | 提交终态（`completed` / `blocked` / `paused` / `cleared` / `active`）或调整 token 预算。**verifier 会话里拒绝** |

**状态机**：`active → completed | blocked | paused | cleared`；`paused | blocked → active | cleared`；`completed → cleared`。非法迁移报错（`INVALID_TRANSITION`）。

**自动续跑**：一轮结束后，若目标仍是 `active`：
1. 预算用完 → **暂停**（提示可提升预算后继续）；
2. 轮次超过 `MAX_GOAL_ROUNDS = 50` → **暂停**；
3. 跑一轮**独立 verifier 子会话**（历史隔离、工具受限）；
4. 达标 → `completed`；方向明显错误 → **暂停**；连续两轮无进展 → **暂停**；
5. 否则 → **在既有 history 上继续一轮**（`continueTurn`，**不合成隐藏 prompt**）。

**verifier 隔离**：验证在**独立的子会话**里执行（自己的历史、自己的工具集）。目标工具**在 verifier 会话里会拒绝** `create_goal` / `update_goal`——防止"目标被自己改写"。验证结论通过 `goal_verdict` 工具结构化提交：达标与否、理由、**证据**（测试/构建/日志/产物路径）、本轮是否有进展、方向是否错误。

### 10.7 阻塞汇报（结构化）

```ts
export interface GoalBlockReport {
  readonly attemptedPaths: readonly string[];   // 已尝试的路径
  readonly evidence: readonly EvidenceRef[];    // 现有证据（{ kind, ref, detail }）
  readonly reason: string;                      // 阻塞原因
  readonly requiredInputs: readonly string[];   // 继续所需输入
}
export interface EvidenceRef {
  readonly kind: 'test'|'build'|'log'|'artifact'|'command';
  readonly ref: string;      // 产物路径 / 命令 / 日志位置
  readonly detail?: string;
}
```

---

## 11. 校验清单（实现自检）

- [ ] `protocol` 中每个跨包类型都有对应 zod schema，且在包边界做运行时校验
- [ ] 所有入参 schema 使用 `.strict()`（拒绝未知字段）
- [ ] 所有解析类函数对不可识别输入返回 `undefined`，不 throw
- [ ] `RuntimeEvent` 联合类型的 `switch` 具备 `never` 穷尽检查
- [ ] hook 三类语义在类型层面可区分（不同返回类型）
- [ ] 权限判定输出恒为 `allow|deny|ask`，默认 `deny`
- [ ] 日志与事件中的敏感字段全部经过 `redact()`
- [ ] metric label 仅取自有限枚举
