# Architecture — Local Agent Runtime

> 本地运行的开源 Coding Agent Runtime（MiniMax Code 本地运行时形态的行为等价实现）。
> 状态：**设计阶段**。本文件是实现的唯一分层权威；任何与代码冲突之处，以代码为准并回头修订本文件。

---

## 0. TL;DR

- **分层口径一句话：`agent-core` 只负责 loop，runtime 负责环境与状态。**
- 9 个包，单向依赖，无环。`protocol` 是唯一权威来源（消息 + 事件契约）。
- 核心不引用宿主：core 里出现的所有"环境"都是**注入的能力接口**（`ToolBinder` / `PermissionCore` / `MessageSink` / `EventDelivery` …），由 runtime 提供实现。
- 一切不确定 = 拒绝或请求确认（fail-closed）。不允许"乐观放行"。

```
                    ┌──────────────┐
                    │    cli       │  仅 HTTP 客户端
                    └──────┬───────┘
                           │ HTTP/SSE
                    ┌──────▼───────────────────────────────────────┐
                    │  local-runtime-v2  (应用层: turn-system,     │
                    │                    service/plan, goal-*)     │
                    └──────┬───────────────────────────────────────┘
                           │
                    ┌──────▼───────────────────────────────────────┐
                    │  local-runtime  (宿主: HTTP, 会话存储,       │
                    │                权限核心, 事件总线, 配置)      │
                    └──────┬───────────────────────────────────────┘
                           │
              ┌────────────┼──────────────┬───────────────┐
              ▼            ▼              ▼               ▼
      agent-extension  agent-tools   agent-core/*    (event-bridge)
              │            │              │
              └────────────┴──────┬───────┘
                                  ▼
                              protocol
```

---

## 1. 目标与非目标

### 1.1 目标

一个可发布（MIT）的本地进程，提供完整 Coding Agent 能力：
会话、流式输出、工具执行、权限管控、计划模式、目标模式、上下文压缩、会话持久化与恢复，附最小 CLI 客户端。

### 1.2 硬约束

| 约束 | 落地方式 |
| --- | --- |
| 全部本地执行 | 无任何官方服务依赖；无账号体系；无额度；无云端执行后端 |
| 模型接入仅 BYOK | OpenAI-compatible + Anthropic Messages 两种适配器；密钥只从环境变量读取 |
| 密钥不落日志 / 不回显 / 不进 git | 密钥字段在所有日志/事件/持久化路径上被 redaction；`config.yaml` 只存**环境变量名**；`.gitignore` 覆盖 `.env*` |
| 不复制闭源实现 | 全部代码独立编写；反编译产物只作为行为规格参考，并在 `docs/provenance.md` 逐条登记 |
| 禁止半成品 stub | 明确不做的能力**不建包、不建 stub、不建空实现** |

### 1.3 明确不做（不实现、不留 stub）

账号密码登录与鉴权体系 · 远程控制（手机连电脑）· 定时任务/调度 · 网站部署与站点管理 · 插件市场与插件系统 · 技能（Skill）系统与加载 · 云端任务与端云交接 · Mini App · 无限画布 · IM 渠道 · 官方遥测与自动更新。

> 这些能力若日后需要，**不**通过"预留空包"的方式进入仓库；一律作为新包提出，走同一套评审。

---

## 2. 仓库布局与包清单

> **包边界口径（与真实工程一致）**：`agent-core` 是**一个包**，内部三个子目录以**子路径导出**（subpath exports）对外暴露。
> 依据：公开仓库 `MiniMax-AI/minimax-code` 的 `packages/agent-core/src/` 下确有 `tools/`、`event-bridge/`、`pi-turn-runner/` 三个子目录，属同一包。照此办理。

```
packages/
  protocol/                 @local-agent/protocol
  agent-core/               @local-agent/agent-core
    src/
      tools/                 → @local-agent/agent-core/tools
      event-bridge/          → @local-agent/agent-core/event-bridge
      pi-turn-runner/        → @local-agent/agent-core/pi-turn-runner
  agent-tools/              @local-agent/agent-tools
  agent-extension/          @local-agent/agent-extension
  local-runtime/            @local-agent/local-runtime
  local-runtime-v2/         @local-agent/local-runtime-v2
  cli/                      @local-agent/cli
```

`agent-core` 的导出面（`package.json#exports`）：

| 子路径 | 内容 | 允许依赖（包内） |
| --- | --- | --- |
| `@local-agent/agent-core` | 公共类型再导出 | 无 |
| `@local-agent/agent-core/tools` | 工具协议层 | `protocol` |
| `@local-agent/agent-core/event-bridge` | `AgentEvent → RuntimeEvent` 纯转换 | `protocol` |
| `@local-agent/agent-core/pi-turn-runner` | 纯 agent-loop 核心 | `protocol`、`./tools`、`./event-bridge` |

**包内不得反向导入**（由 ESLint 规则强制，见 §2.2）：
`tools` ⇏ `pi-turn-runner`、`tools` ⇏ `event-bridge`、`event-bridge` ⇏ `pi-turn-runner`。
即：**协议层与转换层只能被 loop 依赖，不能依赖 loop**。

### 2.1 包职责表

| 包 | 一句话职责 | 允许的内部依赖 | 禁止出现 |
| --- | --- | --- | --- |
| `protocol` | 消息与事件契约的唯一权威来源（zod schema + TS 类型） | — （仅 zod 等第三方） | 任何运行时逻辑、IO |
| `agent-core/tools` | 工具协议层：`ToolDefinition` / `ToolImpl` / `ToolResult` / `ToolExecutionContext` / `ToolBinder` / `PermissionCore` 契约 | `protocol` | 具体工具实现、宿主概念 |
| `agent-core/event-bridge` | `AgentEvent → RuntimeEvent` 的纯转换（可测、无副作用） | `protocol` | IO、状态 |
| `agent-core/pi-turn-runner` | 纯 agent-loop 核心：turn/step 装配、hook 契约、follow-up queue、provider-bound 投影 | `protocol`、`./tools`、`./event-bridge` | 文件系统、网络、进程、宿主配置 |
| `agent-tools` | 本地工具实现（read/write/edit/apply_patch/bash/grep/glob/todo_write/ask_user） | `@local-agent/agent-core/tools`、`protocol` | 会话存储、HTTP |
| `agent-extension` | 可选扩展机制 + `plan-mode` 扩展 | `protocol`、`@local-agent/agent-core/pi-turn-runner`、`@local-agent/agent-core/tools` | 直接依赖 runtime |
| `local-runtime` | 宿主：HTTP 服务、会话存储、权限核心、事件总线、配置、密钥 | `protocol`、`@local-agent/agent-core/*`、`agent-tools` | 反向依赖任何上层 |
| `local-runtime-v2` | 应用层：`turn-system`、`service/plan`、`application/agent/goal-*` | `local-runtime`、`@local-agent/agent-core/*`、`agent-extension` | 直接碰文件系统（走 local-runtime 能力接口） |
| `cli` | 最小客户端：SSE 订阅 + 渲染 + 交互 | `protocol`（仅类型/schema） | 业务逻辑、进程内调用 runtime |

### 2.2 依赖方向的机器可校验

四条硬规则，CI 必须逐条检查：

1. `protocol` 不依赖任何 `@local-agent/*`。
2. `agent-core` 不依赖 `local-runtime*`、`agent-tools`、`agent-extension`。
3. `agent-core` **包内**：`tools` / `event-bridge` 不得导入 `pi-turn-runner`。
4. 依赖图无环（pnpm workspace 拓扑天然无环，但需断言）。

校验方式（三处，缺一不可）：

- **依赖清单检查**：脚本 `scripts/check-deps.mjs` 读各包 `package.json` 的 `dependencies`，用一张**允许边表**断言，超出即失败。
- **跨包 import 检查**：ESLint `no-restricted-imports`，按包配置禁止路径（见 `eslint.config.js`）。
- **包内 import 检查**：ESLint `no-restricted-imports` 规则 3（`tools` / `event-bridge` 禁止 `../pi-turn-runner/**`）。

> 单元测试无法替代这条检查：TS 的 `import type` 在编译期不产生运行时依赖，package.json 才是真相。

---

## 3. 命名规范

### 3.1 接口（"端口"）命名

- 按**消费者需要的能力**命名，不按技术形态命名。
  ✅ `EventDelivery` `SessionResolver` `MessageSink` `ToolBinder` `PermissionCore`
  ❌ `XxxPort` / `XxxAdapter` / `XxxService`（仅在实现类名上可用）/ `HttpPort`
- 名字是名词短语，描述"能做什么"，不描述"怎么实现"。

### 3.2 接口的放置规则（owner 模块）

- 接口放在 **owner 模块**的 `types.ts` / `hooks.ts` 里。
- **禁止**新建 `host-ports.ts`、`ports.ts`、`types/` 大杂烩桶、`interfaces.ts`。
- **禁止** `types/` 目录：类型跟随其 owner 目录，不集中堆放。

### 3.3 owner 的判定

| 情况 | owner | 例子 |
| --- | --- | --- |
| 契约描述的事实/行为由某模块**拥有** | 该模块 | `PermissionCore` 由 runtime 的权限核心拥有；`SessionResolver` 由会话存储拥有；`EventDelivery` 由事件总线拥有 |
| 契约是 core 向宿主**索取能力**（依赖倒置） | 消费方（core）声明，宿主实现 | `MessageSink`、`ToolBinder`、`EventWriter` 由 `pi-turn-runner` 声明消费契约，runtime 提供实现 |

> 第二种情况下，**依赖方向仍然单向**：宿主依赖 core，core 只声明接口、不引用宿主实现。实现通过构造函数注入。

### 3.4 字段与常量命名

- 真实网络端口字段：`listenPort` / `httpPort`（不叫 `port`、不叫 `serverPort`）。
- 布尔：`has*` / `is*` / `can*` / `should*` / `*Enabled`。
- 决策结果统一用 `outcome` 字段，取值 `allow | deny | ask`。
- 标识符、日志 key、metric label 一律英文小驼峰；面向用户的文案可中英双语。

### 3.5 代码风格

- TypeScript `strict: true` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；**禁止 `any` 逃逸**（ESLint `no-explicit-any: error`）。
- 解析类函数（parse / 从自由文本抽取结构）对不可识别输入返回 `undefined`/可选值，**绝不 throw**；只有真正的编程错误才 throw。
- 英文标识符 + 英文注释；面向用户的提示词与文档可中英双语。

---

## 4. 核心运行时序

### 4.1 普通 turn

```
client ──POST /v1/sessions/{id}/messages──▶ runtime
runtime ──▶ turn-system: 取 session lock（同会话串行）
        ──▶ runTurn({ model, tools, history, hooks, writeEvent })
              │
              ├ step 1: beforeLlmCallHook*  (decision pipeline)
              │            └ marker 累积 / request 投影
              ├ provider.stream()  ──▶ AgentEvent 逐条
              │            ├ text.delta  ──▶ RuntimeEvent(message.delta) ──▶ SSE
              │            └ thinking.delta
              ├ afterLlmCallHook* (continue|retry|fail)
              ├ tool intents:
              │      beforeToolCallHook* ──▶ PermissionCore.decide()
              │            ├ allow → 执行 → afterToolCallHook* → tool.call.completed
              │            ├ ask   → 发 permission.requested → 挂起 → 恢复
              │            └ deny  → 阻断（blockedBy=permission）→ blockedToolCalls
              ├ onStepEndHook* (boundary，按序)
              └ 全部步骤结束 → 终态 RuntimeEvent(session.status)
runtime ──▶ 落 history.jsonl / events.jsonl ──▶ SSE
```

### 4.2 一次工具调用（含人工审批）

```
beforeToolCallHook → PermissionCore.decide → 'ask'
   └─▶ RuntimeEvent(permission.requested) { requestId, tool, args, rule, risk, options }
       └─▶ pending/permissions/<requestId>.json 落盘（可重启恢复）
           └─▶ turn 挂起（AwaitingApproval），同会话后续消息入队
用户应答 POST /v1/sessions/{id}/permissions/{requestId} { choice }
   └─▶ PermissionCore.resolveApproval → RuntimeEvent(permission.resolved)
       └─▶ turn 恢复 → 按 choice 执行 or 阻断
```

### 4.3 计划模式（Plan Mode）

```
用户: /plan ──▶ interactionMode='plan'（事务：校验 + 落库 + 受理）
              └─▶ artifacts/plan.md 旧草稿 backup
Agent 产出 plan.md（只规划不执行）
用户: 退出计划模式 ──▶ 冻结快照 artifacts/plan.review.md
                    └─▶ 提交用户确认（确认 / 拒绝+修改意见）
用户确认 ──▶ 实施轮以**冻结快照**为权威依据
              （之后用户再改 plan.md 不影响该轮依据）
```

### 4.4 目标模式（Goal Mode）与自动续跑

```
create_goal → 解析(目标/验收标准/约束/边界/停止条件) → 解析失败则请用户补全
一轮 turn 结束 → 目标未达成 且 无阻塞 且 未超预算
      └─▶ runtime 自动发起下一轮（**不合成隐藏 prompt**，直接 continue 已有 history）
达标 ──▶ verifier 子会话独立校验（子会话内禁止 create_goal/update_goal）
      ├─ 通过 → completed
      ├─ 失败 → 继续下一轮
      └─ 预算耗尽 / 连续两轮无进展 / 方向明显错误 → paused + 结构化汇报
```

---

## 5. 并发模型

| 对象 | 策略 |
| --- | --- |
| 同一会话的 turn | **严格串行**。新消息入队，等待当前 turn 结束（`queued`）。 |
| 不同会话 | 并行，互不阻塞。 |
| 同一 turn 内的多个工具调用 | 由 provider 返回的顺序决定**发起顺序**；独立调用可并行，但**有副作用的工具默认串行**（read-only 可并行）。 |
| 工具执行取消 | 每个工具拿 `AbortSignal`；会话删除 / 用户 abort → 取消全部在飞工具。 |
| 跨进程 | 目录锁 `sessions/<id>/lock`（含 pid + 心跳），进程重启后按 pid 存活性与心跳判定陈旧锁。 |

> 锁的**唯一权威**是磁盘上的 lock 文件（state-ownership.md §4）；进程内再做一层内存锁只是优化，不作数。

---

## 6. 失败语义矩阵

| 场景 | 语义 | 是否 fail-closed |
| --- | --- | --- |
| hook 抛错 / ack 失败 | 本 turn 终止，未开始的工具不执行，不发起下一次 LLM 请求 | ✅ |
| 权限判定不确定 | `ask` 或 `deny` | ✅ |
| 权限层异常 | `deny` | ✅ |
| 工具实现抛错 | 转为 `ToolResult{isError:true}`，**不**静默失败；错误消息需可诊断 | ❌（错误被隔离在单个工具内） |
| 工具被权限阻断 | 不执行、无副作用；进入 `blockedToolCalls` 传给 step-end hook | — |
| provider 401/额度/内容过滤 | 直接失败，不重试 | ✅ |
| provider 429 / 529 / 网络 / 超时 | 按重试契约重试（≤5 次） | — |
| 进程崩溃（多步状态变更中） | 靠 journal 回滚/恢复，**不留半状态** | ✅ |
| 目标预算耗尽 | 自动暂停 + 汇报，不静默截断 | ✅ |

---

## 7. 扩展机制（agent-extension）

- 扩展 = 一个导出 `ExtensionManifest` 的包，提供：**hook 贡献**（beforeLlmCall / afterLlmCall / beforeToolCall / afterToolCall / onHistoryChanged / onStepEnd）、**额外工具**、**模式贡献**（如 plan-mode）。
- 扩展**不能**直接改写 canonical history（必须走 hook 的 `replaceMessages` 决策，且受决策约束校验）。
- `plan-mode` 扩展是第一个也是唯一的内置扩展；其余模式（goal）属于**应用层** `local-runtime-v2`，不是扩展——因为 goal 需要跨轮自动续跑与应用层状态机，不满足扩展的"单 turn 内可插拔"约束。

---

## 8. 配置与密钥

| 类别 | 来源 | 是否落盘 | 是否可进 git |
| --- | --- | --- | --- |
| API 密钥 | **仅环境变量** | ❌ | ❌ |
| 密钥的环境变量名 | 配置文件 `config.yaml` | ✅ | ✅（不含密钥本身） |
| base_url / model / 上下文窗口 | 配置文件 | ✅ | ✅ |
| 会话历史 / 产物 | 会话目录 | ✅ | ❌（默认 gitignore） |
| 日志 / 指标 | 本地日志目录 | ✅ | ❌ |

- 配置文件默认 `${XDG_CONFIG_HOME:-~/.config}/local-agent/config.yaml`。
- 所有日志/事件/错误消息经过统一 `redact()`，命中密钥模式（`sk-…`、`Bearer …` 等）一律替换为 `***`。
- 绝对路径默认按需脱敏为 `~/…` 或 `<workspace>/…`；**仅**在用户显式开启 `runtime.telemetry.revealPaths` 时显示全路径（默认关闭，且该开关本身不进 git）。

---

## 9. 测试与 CI

| 层级 | 位置 | 关注点 |
| --- | --- | --- |
| 单元测试 | 各包 `src/**/*.test.ts`（vitest） | 权限策略矩阵、hook 顺序与 ack 语义、重试分类、上下文裁剪、计划补偿、目标状态机与预算边界、verifier 隔离 |
| 契约测试 | `packages/protocol/src/*.contract.test.ts` | schema 运行时校验、事件联合类型穷尽性 |
| 端到端 | `e2e/`（vitest，独立） | 起服务 → 建会话 → 假 provider 录制回放 → 校验事件序列/history 落盘/重启续跑不重复执行工具 |

**假 provider**：录制回放（fixture JSONL），**不联网**。把 provider 的流式响应录制成 fixture，测试时逐块回放，可注入错误（429/500/401/timeout）。

CI 必跑：`lint` → `typecheck` → `test` → `build`。Node 版本矩阵：22.19+ 与 24.x。

---

## 10. 里程碑 → 包 / 测试映射

| 里程碑 | 交付物 | 主要包 | 关键测试 | 状态 |
| --- | --- | --- | --- | --- |
| **M0** 骨架 | 消息/事件类型、hook 契约、`/health` | `protocol`、`agent-core/pi-turn-runner`（空壳 + hook 契约）、`local-runtime`（HTTP 骨架）、`cli` | schema 校验、hook 契约类型、health 路由 | ✅ 已完成（2026-10-21） |
| **M1** 最小闭环 | 用户消息 → 一次 LLM → 文本回复，事件流 | `agent-core/*`、`local-runtime`、provider 适配、`cli` | 事件序列断言（假 provider） | ✅ 已完成（2026-10-21） |
| **M2** 工具 | 9 个本地工具 + 取消/超时/截断 + bash 后台增量 | `agent-tools`、`agent-core/tools` | 每个工具的边界用例；截断保头尾；超时取消 | ✅ 已完成（2026-10-21） |
| **M3** 权限 | 三档模式 + 审批卡片 + 阻断 | `local-runtime/permissions`、`agent-core/tools` | 权限矩阵（危险命令 / 管道执行 / 读凭据文件） | ✅ 已完成（2026-10-21） |
| **M4** 会话与压缩 | 持久化/恢复/fork/rewind + compaction + checkpoint | `local-runtime/sessions`、`agent-core/pi-turn-runner` | 重启续跑不重复执行工具；压缩节省 ≥70% | ✅ 已完成（2026-10-21） |
| **M5** 计划模式 | 模式切换 + 草稿备份/补偿 + 冻结审阅 + fence + defer 分类器 | `agent-extension/plan-mode`、`local-runtime-v2/service/plan` | 补偿路径；实施轮依据 == 冻结快照 | ✅ 已完成（2026-10-21） |
| **M6** 目标模式 | 工具面 + 状态机 + 预算 + 自动续跑 + verifier 子会话 | `local-runtime-v2/application/agent/goal-*` | 目标失败→blocked 结构化报告；verifier 隔离 | ✅ 已完成（2026-10-21） |

### M0 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 标识符（`sess_`/`turn_`/`tool_`/`req_` + base32url） | `packages/protocol/src/ids.ts` |
| 消息契约（角色、内容块、typed custom message、`TokenUsage`、`ToolResult`） | `packages/protocol/src/message.ts` |
| 权限形状（风险等级、审批卡片、审批结论） | `packages/protocol/src/permission.ts` |
| 交互形状（问卷、todo、goal 快照） | `packages/protocol/src/interaction.ts` |
| `AgentEvent`（19 种内部词汇） | `packages/protocol/src/agent-event.ts` |
| `RuntimeEvent`（21 种对外主干 + 统一信封） | `packages/protocol/src/runtime-event.ts` |
| 工具协议层 + `PermissionCore` 契约 | `packages/agent-core/src/tools/types.ts` |
| 事件桥（`AgentEvent → RuntimeEvent`，core 侧分配 id/seq） | `packages/agent-core/src/event-bridge/bridge.ts` |
| hook 契约（三类语义 + 决策集 + 校验） | `packages/agent-core/src/pi-turn-runner/hooks.ts` |
| turn 装配契约（`RunTurnInput`/`StreamFn`/`MessageSink`） | `packages/agent-core/src/pi-turn-runner/types.ts` |
| 配置（默认值 + env 覆盖 + 脱敏视图） | `packages/local-runtime/src/config/types.ts` |
| 日志脱敏 | `packages/local-runtime/src/logging/logger.ts` |
| HTTP 骨架（router / `/health` / `/v1/version` / `/v1/config` / 端口文件） | `packages/local-runtime/src/http/` |
| CLI（`local-agent health` / `version`） | `packages/cli/src/` |

### M1 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| provider 错误分类（11 种 kind，只有 4 种可重试） | `packages/local-runtime/src/providers/errors.ts` |
| 重试契约（≤5 次、equal-jitter、Retry-After 钳制、总预算、已提交输出不重试） | `packages/local-runtime/src/providers/retry.ts`、`openai-compatible.ts` |
| 每 attempt 超时（首事件 300s / 空闲 60min / 总 20min） | `packages/local-runtime/src/providers/timeout.ts` |
| SSE 字节流解析（两个 provider 共用） | `packages/local-runtime/src/providers/sse.ts` |
| OpenAI-compatible 适配器 + 流解析 | `packages/local-runtime/src/providers/openai-compatible.ts` |
| Anthropic Messages 适配器 + 流解析 | `packages/local-runtime/src/providers/anthropic-messages.ts` |
| 消息投影（OpenAI / Anthropic 两种线格式） | `packages/local-runtime/src/providers/messages.ts` |
| **录制回放假 provider**（走同一套解析器，不联网） | `packages/local-runtime/src/providers/fake.ts` |
| **agent loop 本体**（step 循环、hook 管线、marker 累积、单次 flush、工具执行与阻断） | `packages/agent-core/src/pi-turn-runner/run-turn.ts` |
| provider-bound 投影（孤儿 tool_result / thinking / 多模态） | `packages/agent-core/src/pi-turn-runner/projection.ts` |
| zod → JSON Schema 转换 | `packages/agent-core/src/tools/json-schema.ts` |
| 会话契约 + 内存实现 | `packages/local-runtime/src/sessions/` |
| 事件总线（session 级 `logOffset`、轮转、关键事件保留） | `packages/local-runtime/src/events/` |
| turn system（同会话串行、跨会话并行） | `packages/local-runtime/src/turns/turn-system.ts` |
| 会话 HTTP 端点 + SSE 事件流（可续传） | `packages/local-runtime/src/http/session-routes.ts` |
| CLI `send`（建会话 → 发消息 → 订阅 SSE → 渲染） | `packages/cli/src/commands/send.ts` |

### M2 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 9 个本地工具（read / write / edit / apply_patch / bash / grep / glob / todo_write / ask_user） | `packages/agent-tools/src/` |
| 工作区路径解析与越界拒绝 | `packages/agent-tools/src/paths.ts` |
| 结果大小治理（保头尾 + 标注裁剪字节数） | `packages/agent-tools/src/truncate.ts` |
| 统一 diff 解析与**整体回滚** | `packages/agent-tools/src/apply-patch.ts` |
| bash：超时 / 取消 / 增量输出 / **后台任务脱离 turn 生命周期** | `packages/agent-tools/src/bash.ts` |
| 会话文件能力（todo.json、artifacts/…） | `packages/local-runtime/src/artifacts.ts` |
| 问卷桥接（发问 → 挂起 → 作答） | `packages/local-runtime/src/questions.ts`、`http/session-routes.ts` |
| 工具环境（宿主提供）与宿主事件通道（core 分配信封） | `packages/agent-core/src/tools/types.ts`、`pi-turn-runner/run-turn.ts` |

### M3 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 纯权限策略（高危优先 → 会话规则 → 未知工具 → 模式矩阵） | `packages/local-runtime/src/permissions/policy.ts` |
| 命令安全判定（可证明安全 / 不可证明 / 危险） | `packages/local-runtime/src/permissions/commands.ts` |
| 参数规范化与危险路径识别 | `packages/local-runtime/src/permissions/normalize.ts` |
| 权限服务（会话规则 + pending 审批 + 应答） | `packages/local-runtime/src/permissions/core.ts` |
| 审批通道（core 发事件并等待，宿主持有 pending） | `packages/agent-core/src/pi-turn-runner/hooks.ts`、`run-turn.ts` |
| 接入点（`beforeToolCallHook` 阻断 / 追问） | `packages/local-runtime/src/turns/turn-system.ts` |
| 审批应答端点 + 状态上报 | `packages/local-runtime/src/http/session-routes.ts` |
| CLI 审批卡片交互（`1/2/3`） | `packages/cli/src/commands/send.ts` |

### M4 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 磁盘会话存储（meta 原子写 + history/turns JSONL 追加 + fork/rewind + checkpoint） | `packages/local-runtime/src/sessions/disk-store.ts` |
| 原子写与 JSONL 读写（半行容错） | `packages/local-runtime/src/sessions/files.ts` |
| 写前日志（begin/commit/rolled-back） | `packages/local-runtime/src/sessions/journal.ts` |
| 崩溃恢复（修半行、回滚未提交事务、标记中断 turn） | `packages/local-runtime/src/sessions/recovery.ts` |
| 会话锁（pid + 心跳，陈旧锁可接管） | `packages/local-runtime/src/sessions/lock.ts` |
| 持久化事件日志（SSE 重启后仍可续传） | `packages/local-runtime/src/sessions/event-log.ts` |
| 压缩纯函数（token 估算 + 水位 + 保头尾裁剪 + 整轮丢弃） | `packages/agent-core/src/pi-turn-runner/compaction.ts` |
| 压缩执行（checkpoint → 裁剪 → 摘要 → 达标才替换） | `packages/local-runtime/src/sessions/compaction.ts` |
| 压缩作为 `beforeLlmCall` hook（durable replace） | `packages/local-runtime/src/turns/turn-system.ts` |
| turn 索引（工具调用终态，用于续跑判定） | `packages/local-runtime/src/sessions/types.ts`、`turn-system.ts` |
| fork / rewind 端点 | `packages/local-runtime/src/http/session-routes.ts` |
| CLI `--continue` / `--session` / `sessions` | `packages/cli/src/commands/send.ts`、`commands/sessions.ts` |

### M5 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 计划文档约定（路径、备份命名、冻结快照、元数据） | `packages/agent-extension/src/plan-mode.ts` |
| `plan_write` 工具（只能写会话里的计划草稿） | `packages/agent-extension/src/plan-mode.ts` |
| 扩展契约（hook / 工具 / 模式） | `packages/agent-core/src/pi-turn-runner/extension.ts` |
| 计划服务（进入 / 退出 / 审阅 / fence / 队列分类 / 冻结快照注入） | `packages/local-runtime-v2/src/service/plan/plan-service.ts` |
| 计划模式端点（mode / plan / plan/review） | `packages/local-runtime-v2/src/service/plan/plan-routes.ts` |
| 回合策略接口（分类 + 上下文注入 + 工具收窄） | `packages/local-runtime/src/turns/policy.ts` |
| 计划模式的工具收窄（去掉执行类工具，加 `plan_write`） | `packages/local-runtime-v2/src/application/plan-binder.ts` |
| 组合根（把计划服务装成回合策略） | `packages/local-runtime-v2/src/app.ts` |
| CLI `plan enter/review/approve/reject/show` | `packages/cli/src/commands/plan.ts` |

### M6 已落地的内容（2026-10-21）

| 产出 | 位置 |
| --- | --- |
| 目标契约（GoalSpec / GoalState / GoalBlockReport / EvidenceRef） | `packages/local-runtime-v2/src/application/agent/goal/types.ts` |
| 目标文本解析（纯函数，解析不出返回 undefined） | `packages/local-runtime-v2/src/application/agent/goal/parse.ts` |
| 目标存储（会话目录下的 `goal.json`） | `packages/local-runtime-v2/src/application/agent/goal/store.ts` |
| 目标工具面（`create_goal` / `get_goal` / `update_goal` + `goal_verdict`） | `packages/local-runtime-v2/src/application/agent/goal/tools.ts` |
| 目标服务（状态机 + 预算 + 自动续跑 + 阻塞汇报） | `packages/local-runtime-v2/src/application/agent/goal/service.ts` |
| 独立 verifier 子会话（历史隔离 + 禁止改目标） | `packages/local-runtime-v2/src/application/agent/goal/verifier.ts` |
| 目标端点（GET/POST `/v1/sessions/{id}/goal`） | `packages/local-runtime-v2/src/application/agent/goal/routes.ts` |
| 回合续跑与等待（`continueTurn` / `awaitTurn`） | `packages/local-runtime/src/turns/turn-system.ts` |
| 权限核心认识宿主注册的工具 | `packages/local-runtime/src/permissions/` |
| CLI `goal show/set/status` | `packages/cli/src/commands/goal.ts` |

> 依赖边补充：`local-runtime-v2 -> agent-tools`（组合根需要本地工具清单来收窄计划模式的工具），这在任务书给定的 `local-runtime(-v2) -> agent-tools -> agent-core/tools` 之内。

---

## 11. 已收敛的设计选择（2026-10-21 用户拍板）

第一轮设计评审提出的 8 个待确认问题**已全部收敛**，各自的决定、备选与撤销方式见
`docs/decisions.md` 对应条目。本表只做索引，实施时以决策条目为准。

| # | 问题 | 决定 | 决策条目 | 落地位置 |
| --- | --- | --- | --- | --- |
| Q1 | `ask_user` 是否复用权限审批通道 | **独立通道**（审批=是否放行，问卷=收集信息，语义与生命周期都不同） | D-009 | `contracts.md` §2.3、§6.2 |
| Q2 | 计划冻结快照格式 | **纯 Markdown + 独立 meta 文件**（正文纯净，元信息另存便于校验哈希） | D-019 | `state-ownership.md` F5 |
| Q3 | 会话历史存储格式 | **JSONL**（追加写 + 原子 replace，可人工审查） | D-004 | `state-ownership.md` §2、§3 |
| Q4 | `bash` 后台任务在会话/turn 结束后 | **继续跑**：脱离 turn 生命周期，输出落 `artifacts/background/<taskId>.log`，用 `read` 工具取回 | D-021 | `contracts.md` §4.6、`state-ownership.md` F17 |
| Q5 | Goal 的 verifier 形态 | **独立子会话**（`parentSessionId` 指向目标会话，history 隔离） | D-010 | `contracts.md` §10.5 |
| Q6 | 压缩"节省 ≥70%"的计量口径 | **按 token 估算**（provider tokenizer 不可得时按 `chars/4` 兜底） | D-022 | `contracts.md` §8.3 |
| Q7 | 事件日志保留策略 | **最近 2000 条 + 关键事件永久**（够用） | D-015 | `state-ownership.md` §7 |
| Q8 | `apply_patch` 补丁格式 | **统一 diff 文本**（模型原生产出该格式，解析更稳） | D-023 | `contracts.md` §4.6 |

> 未覆盖的新问题继续按「最保守且可撤销」处理，并登记到 `docs/decisions.md`。

---

## 12. 变更规则

- 本文件与代码冲突时，**以代码为准**，并在同一次改动里修订本文件。
- 任何跨包的新增依赖，必须在 §2.2 的允许边表里显式加一行，并在此处说明理由。
- 里程碑推进时，同步更新 §10 表格与 `docs/contracts.md`。
