# Provenance — 行为规格来源登记

> **本仓库全部代码为独立编写的原创实现。**
> 本文件逐条登记每一条**行为规格**的来源与推导依据，用于审计"哪部分是参考、哪部分是原创"。
>
> 登记原则：
> 1. 只登记**行为规格**的来源，不登记"代码抄自哪里"——因为没有抄。
> 2. 闭源产物**只能**作为行为规格的参考来源，**不得**作为实现来源。本仓库未从任何闭源产物中提取或复制代码。
> 3. 每条规格必须可追溯到下列来源之一，或标注为"本仓库独立设计"。

## 来源代号

| 代号 | 来源 | 性质 | 可用性 |
| --- | --- | --- | --- |
| **[S1]** | MiniMax Code CLI 开源仓库（MIT）<br>https://github.com/MiniMax-AI/minimax-code | **公开可读源码** | 可读、可引用；**本仓库未复制其代码** |
| **[S2]** | MiniMax Code 官方文档（产品行为口径）<br>https://agent.minimaxi.com/docs/code/desktop/goal.md<br>https://agent.minimaxi.com/docs/code/workflows/tasks.md<br>https://agent.minimaxi.com/docs/code/workflows/permissions.md | **公开文档** | 可读、可引用 |
| **[S3]** | 本任务的需求规格（用户提供的任务书，第 0–7 节） | **本项目的权威规格** | 行为定义以此为准 |
| **[S4]** | 本仓库独立设计 | 原创 | 记录于 `docs/decisions.md` |
| **[S5]** | 闭源桌面产物的**行为观察**（仅用于确认能力边界与术语口径） | **行为参考，非代码来源** | 仅确认"某能力在桌面侧、开源仓库不含" |

### [S1] 的开源边界（已核实）

`docs/open-source-status.md`（[S1]，2026-10-21 读取）明确写道：

> "The in-process runtime, public workspace dependencies, tools, and sandbox are included. Internal generated IDL, **the Desktop HTTP front door**, and **cloud-executor-only implementations** are excluded."

即：桌面 HTTP 前门与仅在云端执行器内运行的实现**不在**开源范围内。
→ **本项目要实现的 Plan / Goal 编排层属于桌面侧能力，必须按 [S3] 独立实现。**

### [S1] 已核实的目录事实（用于对齐包结构）

`packages/agent-core/src/` 下确有 `tools/`、`event-bridge/`、`pi-turn-runner/`、`protocol/` 四个子目录（同属一个包）→ 对应本仓库 `packages/agent-core/src/{tools,event-bridge,pi-turn-runner}` 的布局（决策 D-002）。

---

## 逐条登记

### A. 架构与工程约定

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 9 个包的单向依赖分层 | **[S3] §1** + **[S1]** 目录结构 | [S1] 证实 `agent-core/{tools,event-bridge,pi-turn-runner}` 与 `third_party/pi-mono`、`third_party/sandbox-runtime` 的存在；本仓库按 [S3] 的包清单重排为自有分层，**实现全部原创** |
| "agent-core 只负责 loop，runtime 负责环境与状态" | **[S3] §1** | 采纳为分层口径一句话 |
| 端口按消费者能力命名（`EventDelivery`/`SessionResolver`/`MessageSink`/`ToolBinder`/`PermissionCore`） | **[S3] §1** | 采纳为命名规范；实现原创 |
| 真实端口字段用 `listenPort` / `httpPort` | **[S3] §1** | 采纳 |
| 禁止 `XxxPort` / `host-ports.ts` / `types/` 大杂烩 | **[S3] §1** | 采纳为 lint 规则 |
| 存储介质（JSONL + 原子 rename + journal） | **[S4]** | D-004；[S1] 的 `vitest.oss.config.mjs` 等工程约定只作风格参考 |
| 事件双层序列号 `seq` / `logOffset` | **[S4]** | D-005；[S3] 要求"core 生成 seq"且"SSE 按 seq 续传"，双层是同时满足两者的唯一无冲突解 |
| HTTP 层用 `node:http` 不引框架 | **[S4]** | D-006 |
| 工具结果截断阈值（32 KiB / 256 KiB / 2000 行，保头尾） | **[S3] §2.B**（原则）+ **[S4]**（具体数值） | 原则来自 [S3]，数值由本仓库选定（D-018） |
| 幂等键设计（`clientMessageId` / `requestId` / `clientSessionId`） | **[S4]** | D-004 与 [S3] 的"幂等与恢复"要求结合推导 |

### B. Agent Loop Core

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| turn / step 的划分，`runTurn` 的输入输出边界 | **[S3] §2.A** | 实现原创 |
| hook 三分语义（decision pipeline / notification fan-out / boundary） | **[S3] §2.A** | [S1] 存在 `docs/hooks.md`（hook 概念），但**分类语义为本项目独立设计**；实现原创 |
| `onHistoryChangedHook` 的 ack 语义（全部 ack 才推进 cursor，失败 fail-close） | **[S3] §2.A** | 实现原创 |
| `beforeLlmCallHook` 决策集 7 项 | **[S3] §2.A** | 逐项照 [S3] 列举实现 |
| `appendMessage` 只接受隐藏 typed custom message、marker 累积顺序、单次 flush | **[S3] §2.A** | 实现原创 |
| `respond` 的零 usage / host 已验证文本 / 禁止绕过模型调用 | **[S3] §2.A** | 实现原创 |
| `afterLlmCallHook` 的 `continue`/`retry`/`fail` 三分支语义 | **[S3] §2.A** | 实现原创 |
| retry 走 Pi 内部 follow-up queue、拒绝的 response 不入 history | **[S3] §2.A** | "Pi"这一命名沿用 [S1] 的 `third_party/pi-mono` / `pi-turn-runner` 术语；队列实现原创 |
| 事件 id / seq 在 core 内闭环生成 | **[S3] §2.A** | 实现原创 |
| `projectAgentMessagesForModel` 纯函数投影 | **[S3] §2.A** | 实现原创 |

### C. 事件协议与流式输出

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| `AgentEvent`（内部词汇）→ `RuntimeEvent`（对外主干）双层事件模型 | **[S1]**（`packages/agent-core/src/event-bridge/` 的存在）+ **[S3] §2.C** | [S1] 证实存在 event-bridge 层；**转换函数全部原创** |
| `RespData` 展示 payload 的概念 | **[S1]**（`event-bridge/resp-data.ts` 存在） | 概念沿用，**结构独立设计** |
| 展示层脱敏（`display-sanitize`） | **[S1]**（`event-bridge/display-sanitize.ts` 存在）+ **[S3] §2.C** | 概念沿用，规则独立设计 |
| 事件类型清单（文本/思考增量、工具开始/进行中/结束、文件变更、权限请求与结果、问卷请求与结果、todo 更新、压缩通知、终态 session.status） | **[S3] §2.C** | 逐项照 [S3] 实现 |
| SSE 断线按 seq 续传 | **[S3] §2.C** | 实现原创 |

### D. 工具协议与工具集

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 工具协议层（`ToolDefinition`/`ToolImpl`/`RuntimeTool`/`ToolResult`/`ToolExecutionContext`） | **[S3] §2.B** + **[S1]**（`agent-core/src/tools/` 存在） | 概念沿用，**类型全部原创** |
| 9 个本地工具（read/write/edit/apply_patch/bash/grep/glob/todo_write/ask_user） | **[S3] §2.B** | [S1] 的工具集合可作能力参照，**本项目按 [S3] 清单独立实现** |
| "不得统统塞给模型一个万能 shell" | **[S3] §2.B** | 采纳为设计约束 |
| `edit` 失败必须可诊断、不得静默 | **[S3] §2.B** | 实现原创 |
| `bash` 超时/输出上限/后台任务/增量回调 | **[S3] §2.B** | 实现原创 |

### E. 权限核心

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 三档模式 Ask / Auto / Full access | **[S3] §2.E** + **[S2] permissions.md** | [S2] 确认产品口径："删除、覆盖、上传、发送消息等动作应保留人工确认" |
| 判定输出 allow/deny/ask、默认 deny | **[S3] §2.E** | 实现原创 |
| "只对字面可证明安全的命令自动放行" | **[S3] §2.E** | 白名单 + 无 shell 元字符的实现方式为 **[S4]**（D-008） |
| 高危类别清单 | **[S3] §2.E** | 实现原创 |
| 审批卡片（命令/文件/命中规则/风险等级 + 三选项） | **[S3] §2.E** | 结构独立设计；选项语义与 [S2] 的"单次/会话/拒绝"一致 |
| 权限层不执行工具、只阻断 + `blockedToolCalls` | **[S3] §2.E** | 实现原创 |

### F. 计划模式

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 计划模式全部语义（模式切换、备份、冻结快照、补偿、fence、defer 分类器、幂等） | **[S3] §2.F** | **桌面侧能力，开源仓库不含**（见 [S1] 开源边界）；按 [S3] **完全独立实现** |
| 计划文档位于会话目录 `artifacts/plan.md`（不在工作区） | **[S3] §2.F** | 实现原创 |
| 冻结快照格式（纯 Markdown + 独立 meta 文件） | **[S4]** | D-019 |

### G. 目标模式

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| Goal 的结构：**最终结果 / 验收依据 / 约束 / 工作边界 / 停止条件** | **[S2] goal.md** + **[S3] §2.G** | [S2] 官方文档给出同构模板（"实现【最终状态】并通过【具体测试、报告或产物】验证…工作过程中保持…只使用或修改…如果出现【阻塞条件】…"） |
| 停止条件与**阻塞汇报四要素**（已尝试路径 / 现有证据 / 阻塞原因 / 继续所需输入） | **[S2] goal.md** | [S2] 原文："停止继续尝试，并汇报已经尝试的路径、现有证据、阻塞原因以及继续工作所需的输入"——与 [S3] 逐字对应 |
| 暂停三条件（达到上限 / 连续两轮无进展 / 方向不正确） | **[S2] goal.md** | [S2] 原文："达到上限、连续两轮无进展或方向不正确时，应及时暂停或编辑目标" |
| 工具面 `create_goal` / `get_goal` / `update_goal` | **[S3] §2.G** | [S2] 只有产品行为、无 API 形状 → **API 形状为本项目独立设计** |
| 目标解析（解析不出就要求用户补全，不瞎猜） | **[S3] §2.G** + **[S2] goal.md** | [S2]："最终'什么才叫完成'仍然应由用户确认" |
| 独立 verifier 子会话 + 子会话内禁止改目标 | **[S3] §2.G** | 实现原创 |
| token 预算与状态持久化 | **[S3] §2.G** | 实现原创 |

### H. 本地 HTTP 服务

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 端点清单、错误码表、`/health`、版本号 | **[S3] §2.H** | 实现原创（桌面 HTTP 前门不在开源范围） |
| Admission（校验 + 落库 + 受理）事务语义 | **[S3] §2.H** | 实现原创 |

### I. Provider 适配层

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| OpenAI-compatible / Anthropic Messages 两种适配器 | **[S3] §2.I** | [S1] 含 provider 适配（开源范围内）可作能力参照；**本项目独立实现** |
| **重试契约**（≤5 次、equal-jitter、Retry-After 钳制、429/529/网络/超时可重试；额度/鉴权/abort/400/内容过滤/通用 5xx/未知不可重试） | **[S3] §2.I** | [S3] 明确要求"照抄真实工程的口径"；本项目按 [S3] 条目**逐条独立实现** |
| provider 自带 retry 固定为 0 | **[S3] §2.I** | 采纳 |
| 首事件超时 300s / 空闲 60min / 总超时 20min | **[S3] §2.I** | 采纳 |
| "首个有效输出前断开时 iterator 与 result() 收敛到同一错误" | **[S3] §2.I** | 实现原创 |
| 指标三层拆分 + label 有限枚举 | **[S3] §2.I** | 采纳 |

### J. 上下文压缩

| 规格 | 来源 | 推导依据 / 说明 |
| --- | --- | --- |
| 动态输出预算与 compact 水位（不在模型输出上限处过早压缩） | **[S3] §2.D** | 实现原创 |
| 优先裁剪低收益工具结果、保头尾、合并连续同类结果 | **[S3] §2.D** | 实现原创 |
| 一次压缩至少节省 70% 才算有效 | **[S3] §2.D** | 采纳 |
| 压缩前 checkpoint、保留子任务/并行任务状态 | **[S3] §2.D** | 实现原创 |
| 压缩走同一套 turn pipeline 的辅助调用路径、不污染主历史 | **[S3] §2.D** | 实现原创（架构决策 D-011） |

### K. 闭源桌面产物（[S5]）的使用声明

- 用途**仅限**：确认 (a) Goal / Plan 编排层位于桌面侧、不在 [S1] 开源范围内；(b) 相关能力的术语口径与能力门控形态。
- **未**从任何闭源产物中提取、复制、反编译移植任何代码到本仓库。
- 本仓库中与 Plan / Goal 相关的全部实现，均为依据 [S3] 与 [S2] 的**行为描述**独立编写的原创代码。
- 若后续 review 认为某处实现"过于接近"某闭源产物，应以 [S3]/[S2] 的行为描述为唯一判据重写该处。

### L. 本仓库独立设计清单（无外部来源）

以下内容在 [S1]/[S2]/[S3] 中**均无对应物**，为满足 [S3] 的工程约束而原创设计，全部记录于 `docs/decisions.md`：

- 9 包的包名与目录布局（`@local-agent/*`）、子路径导出面（决策 D-002）
- `MessageSink` / `ToolBinder` 的"消费方声明、宿主实现"依赖倒置规则（决策 D-003）
- 双层序列号 `seq` + `logOffset`（决策 D-005）
- JSONL + 原子 rename + journal 写前日志的持久化方案（决策 D-004）
- 错误码表、端点清单（决策 D-015 及 `docs/contracts.md` §6）
- 权限矩阵与 `bash` 白名单（决策 D-007 / D-008）
- 工具结果截断阈值（决策 D-018）
- Goal 状态机与 `GoalBlockReport` 结构（决策 D-010，`docs/contracts.md` §10.6）
- 计划冻结快照的存储格式（决策 D-019）
- 假 provider 录制回放机制（决策 D-013）

---

## 变更规则

- 新增任何行为规格时，**先**在本表登记来源，**再**实现。
- 来源为 [S1] 的条目，若对应的开源实现发生变化，需重新核对并更新本表。
- 任何"参考了但没有抄"的怀疑，一律以本表 + `docs/decisions.md` 交叉验证。

## 核验方式

```bash
# 1) 确认本仓库没有任何指向闭源产物的依赖
pnpm check:deps        # 依赖边白名单
pnpm check:secrets     # 密钥/凭据扫描

# 2) 确认包结构与 [S1] 的对齐点（S1 公开可读）
#    https://github.com/MiniMax-AI/minimax-code/tree/main/packages/agent-core/src
```

---

*登记时间：2026-10-21 ｜ 最后更新：2026-10-22 ｜ 仓库状态：M0–M7 全部完成（协议契约 + agent loop 本体 + provider 适配层 + 会话/事件/SSE + 9 个本地工具 + 权限核心 + 会话持久化与压缩 + 计划模式 + 目标模式 + 零依赖 Web 控制台 + CLI；详见 `README.md` 的里程碑表）。本仓库全部实现代码为独立编写，来源见上表。*
