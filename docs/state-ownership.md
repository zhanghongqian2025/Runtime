# State Ownership — 谁拥有哪个事实、存在哪里、怎么恢复

> 原则：**每个事实只有一个 owner**。任何数据只能由一个模块写入；其他模块读它、写它都必须经 owner 暴露的能力接口。
> 违反此原则的代码一律视为缺陷（"两处真相" = 未来必然不一致）。

---

## 1. 事实归属总表

| # | 事实 | Owner 模块 | 存储位置 | 写入方式 | 崩溃后语义 |
| --- | --- | --- | --- | --- | --- |
| F1 | 会话元数据（id / title / cwd / createdAt / updatedAt / interactionMode / status / provider / model） | `local-runtime/sessions` | `sessions/<sid>/meta.json` | 原子 replace | 读到旧值即安全（replace 是全量写） |
| F2 | **canonical history**（消息序列） | `local-runtime/sessions` | `sessions/<sid>/history.jsonl` | 追加（append-only） | 尾部半行 → 启动时截断到最后一个完整 JSON |
| F3 | 压缩 checkpoint | `local-runtime/sessions` | `sessions/<sid>/history.checkpoints/<cid>.jsonl` | 追加 | 同 F2 |
| F4 | 事件日志（供 SSE 续传） | `local-runtime/events` | `sessions/<sid>/events.jsonl` | 追加 | 尾部半行 → 截断 |
| F5 | 计划草稿 / 冻结审阅快照 | `agent-extension/plan-mode`（逻辑）+ `local-runtime`（落盘能力） | `sessions/<sid>/artifacts/plan.md`、`artifacts/plan.review.md`、`artifacts/plan.md.bak-<ts>` | 原子 replace | 旧文件保留（备份优先于覆盖） |
| F6 | todo 清单（进度真相源） | `agent-tools/todo_write`（写入）+ `local-runtime`（落盘） | `sessions/<sid>/todo.json` | 原子 replace | 读到旧清单即安全 |
| F7 | 目标状态 + token 预算 + 轮次 + 阻塞报告 | `local-runtime-v2/application/agent/goal` | `sessions/<sid>/goal.json` | 原子 replace + journal | journal 回滚到上一个一致状态 |
| F8 | 挂起的权限审批 | `local-runtime/permissions` | `sessions/<sid>/pending/permissions/<rid>.json` | 原子 replace | 恢复为"待用户应答" |
| F9 | 挂起的问卷 | `local-runtime/questions` | `sessions/<sid>/pending/questions/<rid>.json` | 原子 replace | 恢复为"待用户应答" |
| F10 | 计划审阅请求（fence 载体） | `local-runtime-v2/service/plan` | `sessions/<sid>/pending/plan-review.json` | 原子 replace | 恢复 fence 阻塞态 |
| F11 | turn / step / toolCall 索引（重连续跑用） | `local-runtime/turns` | `sessions/<sid>/turns.jsonl` | 追加 | 尾部截断；已完成的 toolCall 不重复执行 |
| F12 | 会话锁 | `local-runtime/sessions` | `sessions/<sid>/lock` | 原子 replace（含 pid + 心跳） | 进程死 → 按 pid 存活性判陈旧并接管 |
| F13 | 写前日志（journal） | `local-runtime/persistence` | `sessions/<sid>/journal.jsonl` | 追加 | 启动时 replay：未 commit 的事务回滚 |
| F14 | 运行时配置（base_url / model / env 变量名） | `local-runtime/config` | `${XDG_CONFIG_HOME:-~/.config}/local-agent/config.yaml`（也接受 `.yml` / `.json`） | 原子 replace | 读到旧值即安全；**文件坏了会明确报错**，不会被静默忽略 |
| F15 | **密钥** | **不归任何模块持久化** | 仅进程内存 | 启动时从 env 读取 | 进程退出即消失，**不落盘** |
| F16 | 运行时端口 / pid | `local-runtime` | `${XDG_STATE_HOME:-~/.local/state}/local-agent/runtime.json` | 原子 replace | 读到旧值 → 视为未运行 |
| F17 | 后台 bash 任务输出 | `local-runtime/background` | `sessions/<sid>/artifacts/background/<taskId>.log` | 追加 | 任务已死 → 输出仍可读；**任务在 turn/会话结束后仍继续运行**（D-021），输出随会话目录长期保留 |
| F18 | 工具执行结果（canonical 形态） | `local-runtime/sessions` | 随 history 一起写（F2） | 追加 | 同 F2 |

### 1.1 明确的"非事实"

| 不是事实 | 说明 |
| --- | --- |
| provider 请求视图 | 每次请求的**临时副本**（`projectAgentMessagesForModel` 的返回值），**从不持久化** |
| 内存中的 turn 状态机 | 可重建；只有 F11 的索引被持久化 |
| 进程内缓存 / 指标 | 可丢弃 |

---

## 2. 磁盘布局

```
${XDG_STATE_HOME:-~/.local/state}/local-agent/
  runtime.json                       # F16: { pid, httpPort, startedAt, version }
  sessions/
    <sessionId>/
      meta.json                      # F1
      history.jsonl                  # F2  ← canonical history（唯一权威）
      turns.jsonl                    # F11
      events.jsonl                   # F4
      journal.jsonl                  # F13
      todo.json                      # F6
      goal.json                      # F7
      lock                           # F12
      history.checkpoints/
        <checkpointId>.jsonl         # F3
      pending/
        permissions/<requestId>.json # F8
        questions/<requestId>.json   # F9
        plan-review.json             # F10
      artifacts/
        plan.md                      # F5 草稿
        plan.review.md               # F5 冻结快照
        plan.md.bak-<ts>             # F5 备份
        background/<taskId>.log      # F17
        <其他会话产物>
```

配置：`${XDG_CONFIG_HOME:-~/.config}/local-agent/config.yaml`（F14）。
密钥：**只**从环境变量读取，配置文件里只写**变量名**（F15）。
优先级：**默认值 < 配置文件 < 环境变量**。环境变量里非法的权限模式会被忽略并回落到 `ask`（绝不因此放宽权限）。

### 2.1 目录约定

- `sessionId` 形如 `sess_<26位base32url>`，**不可预测**（防目录遍历猜测）。
- 所有子路径必须经 `resolveInside(sessionDir, name)` 校验，**拒绝** `..`、绝对路径、符号链接逃逸。
- 产物名 `name` 只允许 `[a-zA-Z0-9._-]{1,64}`。

---

## 3. 写入原子性

| 场景 | 手法 |
| --- | --- |
| 整体替换（`meta.json` / `todo.json` / `goal.json` / 产物） | 写 `*.tmp-<pid>-<rand>` → `fsync` → `rename` 覆盖 → 目录 `fsync` |
| 追加（`history.jsonl` / `events.jsonl` / `turns.jsonl` / `journal.jsonl`） | 单次 `write()` 追加一行（含 `\n`）；**每行一个完整 JSON**；禁止跨行写 |
| 目录创建 | 递归 `mkdir`，已存在视为成功 |

**半行处理**：启动时扫描追加型文件，丢弃尾部不完整行（最后一个 `\n` 之后的内容），并把丢弃行数记入日志。

### 3.1 Journal（写前日志）

多步状态变更（模式切换、目标变更、审阅提交、删除会话）走：

```
1. append journal: { txId, kind, before: {...}, after: {...}, state:'begin', ts }
2. 执行持久化（原子写）
3. append journal: { txId, state:'commit', ts }
```

启动恢复：扫描 `journal.jsonl`，对所有 `begin` 且无对应 `commit` 的事务执行**回滚**（按 `before` 恢复文件，删除新建文件，释放已受理的 turn），然后把该条 journal 标记为 `rolled-back`。

- journal 只记录**文件级前后值**，不记录密钥。
- 单条 journal 记录大小上限 64 KiB，超限则拒绝该事务（fail-closed）并要求调用方拆分。

---

## 4. 锁与并发

| 范围 | 锁 | 规则 |
| --- | --- | --- |
| 同一会话 | `sessions/<sid>/lock` | 同一时刻只有一个进程能写该会话；其他进程收到 `SESSION_LOCKED` |
| 不同会话 | 无跨会话锁 | 可并行 |
| 同一 turn 内 | 进程内 mutex | 同会话 turn 严格串行 |

**lock 文件内容**：`{ pid, hostname, acquiredAt, heartbeatAt, sessionId }`。

- 写锁时用 `O_EXCL` 创建；已存在则读取并判断：
  - pid 不存在或心跳超过 30 s → 判定**陈旧**，接管（保守：先备份旧 lock 再覆盖）；
  - 否则 → `SESSION_LOCKED`。
- 持锁期间每 10 s 更新 `heartbeatAt`。
- 释放：删除 lock 文件（仅在内容 pid 与自己一致时删除）。

> 进程内内存锁只是优化，**磁盘锁才是权威**（多进程场景下以磁盘为准）。

---

## 5. 幂等与请求键

| 操作 | 幂等键 | 重复调用的行为 |
| --- | --- | --- |
| 发消息 | `clientMessageId`（可选） | 同 `clientMessageId` 命中已有 turn → 返回同一 `turnId`，**不重复执行** |
| 审批应答 | `requestId` | 已解决的 requestId → 返回已解决结果（`idempotent: true`），不重复放行 |
| 问卷应答 | `requestId` | 同上 |
| 模式切换 | `sessionId + targetMode` | 已在目标模式 → 幂等通过（不报错、不重复备份） |
| 计划审阅 | `requestId`（审阅单号） | 已批准/已拒绝 → 返回既有结论 |
| 目标变更 | `sessionId + goalVersion` | 版本落后 → `CONFLICT` |
| 创建会话 | `clientSessionId`（可选） | 已存在 → 返回既有 session |

**重启续跑的关键**（对应验收项「重启服务后 `--continue` 能接着对话且不重复执行已完成的工具调用」）：

- F11 `turns.jsonl` 记录每个 `toolCallId` 的终态（`started` / `completed` / `blocked` / `failed`）。
- 重启恢复时，对未完成 turn 的 toolCall：状态为 `completed` 的**不重跑**；`started` 但无终态的视为**未完成 → 重跑**（副作用可能重复，故在恢复报告中标注 `possiblyReexecuted`）。

---

## 6. 重启恢复流程

```
启动
 ├─ 1. 读 F14 配置（密钥从 env 取；缺失 → provider 不可用但服务仍可启动）
 ├─ 2. 扫描 sessions/*：
 │      a. 截断各 JSONL 尾部半行
 │      b. replay journal → 回滚未提交事务
 │      c. 校验 lock（接管陈旧锁 / 释放自己的旧锁）
 │      d. 读取 meta.json → 重建内存态
 │      e. 读取 pending/* → 重建挂起的审批/问卷/审阅（fence 仍生效）
 │      f. 读取 goal.json → 重建目标状态机与预算
 │      g. 读取 turns.jsonl → 重建未完成 turn 的续跑点
 └─ 3. 启动 HTTP 服务，写 F16 runtime.json（含实际 httpPort）
```

恢复完成后，服务在 `/v1/sessions/{id}/status` 中如实报告：
`recovered: true`、`pendingApprovals: n`、`pendingQuestions: n`、`planReviewPending: bool`、`resumableTurns: n`。

---

## 7. 保留与轮转

| 数据 | 策略 |
| --- | --- |
| `events.jsonl` | 按会话保留最近 **2000** 条 + **永久保留**关键事件（`session.status`、`permission.*`、`question.*`、`context.compaction.*`、`goal.updated`） |
| `history.checkpoints/*` | 保留最近 **5** 个 checkpoint |
| `journal.jsonl` | 事务全部 commit 后压缩为一行摘要，保留最近 200 行 |
| 后台任务日志 | 保留最近 10 MB，超出滚动截断（保头尾） |
| 会话整体 | 不自动删除；由用户显式 `DELETE` |

轮转采用"**重写 + rename**"，保证读侧要么看到旧全量、要么看到新全量，不出现半状态。

---

## 8. 敏感数据边界

**永不落盘**：

- API 密钥、Authorization 头、cookie；
- 环境变量中的密钥类变量（`pass` `proxy` `npm_` `pip_` `*_KEY` `*_TOKEN` `*_SECRET`）的**值**；
- 完整的环境变量转储。

**落盘但需脱敏**：

- 工具入参中的绝对路径 → 落盘时保留原值（功能性需要），但**日志与事件**中替换为 `<workspace>/…` 或 `~/…`；
- 命令输出中的疑似密钥（`sk-…`、`ghp_…`、`AKIA…`、`-----BEGIN … PRIVATE KEY-----`）→ 落盘前 `redact()` 替换为 `***`；
- 判定日志中命中的规则描述只记录**规则标识**，不记录**匹配到的秘密值**。

**永不进 git**：

- `.env*`、`config.yaml`（含本机路径与变量名）、`sessions/`、`*.log`、运行时数据目录。
- 仓库根 `.gitignore` 必须覆盖上述项（`scripts/check-secrets.mjs` 在 CI 中复查）。

---

## 9. 所有权边界速查

| 想写这个数据 | 正确做法 | 禁止 |
| --- | --- | --- |
| 追加一条消息到 history | 经 `MessageSink`（由 runtime 的会话存储实现） | 在 core 或工具里直接 `fs.appendFile` |
| 改会话模式 | 经 runtime 的会话能力（admission 事务） | 直接改 `meta.json` |
| 写会话产物 | 经 runtime 的产物能力 | 往工作区写 `plan.md` |
| 改目标状态 | 经 goal 应用层能力 | 直接改 `goal.json` |
| 记录判定日志 | 经统一的 `redact()` 日志器 | 裸 `console.log` 上下文原文 |
| 写事件 | 经 `EventDelivery` / 事件总线 | 在工具里直接写 `events.jsonl` |

> 落盘的**能力**统一在 `local-runtime`；`agent-core` 与 `agent-tools` 永远不碰文件系统（core 完全无 IO）。
