# Local Agent Runtime

A fully local, open-source **coding agent runtime**. It provides the complete
agent loop — sessions, streaming output, tool execution, permission control,
plan mode, goal mode, context compaction, persistence and resume — as a local
service process, driven by a minimal CLI.

* License: **MIT**
* Stack: TypeScript · Node.js ≥ 22.19 · pnpm · vitest · zod
* No account system, no quota, no cloud execution backend, no telemetry, no auto-update.
* Model access is **BYOK only** (OpenAI-compatible / Anthropic Messages). Keys are read
  from environment variables and never written to disk, logs, or the repository.

> ## Project status: M0 complete
>
> The design documents, the package skeleton and the **M0 contracts** are in place:
> message and event contracts, the tool protocol layer, the hook contracts, the
> event bridge, the HTTP host (`/health`, `/v1/version`, `/v1/config`) and a
> minimal CLI. The agent loop itself lands with **M1**; the milestone table below
> tracks what exists and what is next.

---

## Architecture

```
                    ┌──────────────┐
                    │    cli       │  HTTP + SSE client only
                    └──────┬───────┘
                           │
                    ┌──────▼───────────────────────────────────────┐
                    │  local-runtime-v2   turn-system              │
                    │                     service/plan              │
                    │                     application/agent/goal-*  │
                    └──────┬───────────────────────────────────────┘
                           │
                    ┌──────▼───────────────────────────────────────┐
                    │  local-runtime         HTTP · sessions ·      │
                    │                       permissions · events ·   │
                    │                       config · keys           │
                    └──────┬───────────────────────────────────────┘
                           │
              ┌────────────┼──────────────┬───────────────┐
              ▼            ▼              ▼               ▼
      agent-extension  agent-tools   agent-core/tools   agent-core/
                                          │            event-bridge
                                          └──────┬───────┘
                                                 ▼
                                             protocol
```

**One-line rule: `agent-core` owns the loop, the runtime owns environment and state.**

Dependency direction is single-direction and machine-checked
(`pnpm check:deps` + ESLint `no-restricted-imports`).

| Package | Responsibility |
| --- | --- |
| `@local-agent/protocol` | Authoritative message and event contracts (zod) |
| `@local-agent/agent-core` | Pure loop: `/tools` (tool protocol), `/event-bridge` (AgentEvent → RuntimeEvent), `/pi-turn-runner` (`runTurn`, hooks) |
| `@local-agent/agent-tools` | Local tools: read, write, edit, apply_patch, bash, grep, glob, todo_write, ask_user |
| `@local-agent/agent-extension` | Extension mechanism + the plan-mode extension |
| `@local-agent/local-runtime` | Host: HTTP server, session store, permission core, event bus, configuration |
| `@local-agent/local-runtime-v2` | Application layer: turn-system, `service/plan`, `application/agent/goal-*` |
| `@local-agent/cli` | Minimal client (`local-agent`) |

---

## Documentation

| Document | Content |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layering, dependency direction, naming rules, runtime sequences, concurrency, failure semantics |
| [`docs/contracts.md`](docs/contracts.md) | Event / hook / tool / permission / HTTP / provider contracts, retry classification, error codes |
| [`docs/state-ownership.md`](docs/state-ownership.md) | Which module owns which fact, on-disk layout, atomic writes, locking, crash recovery |
| [`docs/decisions.md`](docs/decisions.md) | Every design decision with alternatives, rationale and how to undo it |
| [`docs/provenance.md`](docs/provenance.md) | Per-spec provenance: public MIT repo, official docs, this task's spec, or independent design |

---

## Quick start

```bash
# 1. install
pnpm install

# 2. verify the workspace
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# 3. start the local runtime (binds 127.0.0.1, writes a port file)
pnpm build
node packages/local-runtime-v2/dist/main.js
#   local-agent-runtime listening on http://127.0.0.1:<port>

# 4. check it from another terminal
curl -s http://127.0.0.1:<port>/health
node packages/cli/dist/index.js health      # discovers the runtime via the port file

# 5. send a message and watch the turn stream in
node packages/cli/dist/index.js send "hello"

# 5b. keep talking in the same session (the sessions live on disk)
node packages/cli/dist/index.js send "and now?" --continue
node packages/cli/dist/index.js sessions

# 5c. or drive the same runtime from the browser console
open http://127.0.0.1:8787/
#   zero-dependency static page: sessions, chat, live event stream, approvals

# 6. configure a provider: the file holds the variable NAME, the key stays
#    in the environment
mkdir -p ~/.config/local-agent
cat > ~/.config/local-agent/config.yaml <<'YAML'
host: 127.0.0.1
httpPort: 8787
permissionMode: ask
providers:
  - id: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKeyEnvVar: OPENAI_API_KEY
    model: gpt-4o-mini
    contextWindowTokens: 128000
    maxOutputTokens: 16384
YAML
export OPENAI_API_KEY="sk-..."
```

Precedence: **defaults < configuration file < environment**.
Environment overrides: `LOCAL_AGENT_HOST`, `LOCAL_AGENT_HTTP_PORT`, `LOCAL_AGENT_PERMISSION_MODE`.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0** | Skeleton: message/event types, hook contracts, `/health`, CI | ✅ done |
| **M1** | Minimal loop: one provider → user message → LLM call → text reply, SSE stream, CLI rendering | ✅ done |
| **M2** | Local tools: read/write/edit/apply_patch/bash/grep/glob/todo_write/ask_user, cancellation, timeouts, truncation, background bash | ✅ done |
| **M3** | Permissions: three modes, deterministic policy, approval cards, blocked calls have no side effect | ✅ done |
| **M4** | Sessions: JSONL persistence, resume after a restart, fork, rewind, context compaction with checkpoints | ✅ done |
| **M5** | Plan mode: mode switch with compensation, frozen review snapshot, fence, deferred queue | ✅ done |
| **M6** | Goal mode: goal tools, state machine, token budget, automatic continuation, independent verifier | ✅ done |
| **M1** | Minimal loop: one provider → user message → LLM call → text reply, SSE stream, CLI rendering | pending |
| **M2** | Tools: read/write/edit/apply_patch/bash/grep/glob, cancellation, timeouts, output truncation, background bash | pending |
| **M3** | Permissions: three modes, approval cards, blocked calls have no side effects | pending |
| **M4** | Sessions: persist, resume, fork, rewind; context compaction with checkpoints | pending |
| **M5** | Plan mode: mode switch, draft backup/compensation, frozen review snapshot, fence, queue deferral | pending |
| **M6** | Goal mode: goal tools, state machine, token budget, auto-continue, independent verifier, block reports | pending |

## Requirements

* Node.js ≥ 22.19 (developed on 24.x LTS)
* pnpm ≥ 10

## Development

```bash
pnpm install
pnpm lint          # eslint, includes dependency-direction rules
pnpm check:deps    # package.json dependency edges must stay inside the allow-list
pnpm check:secrets # no credential-shaped content in tracked files
pnpm typecheck     # tsc -b (project references)
pnpm test          # vitest
pnpm build         # tsc -b
pnpm check:transport  # the runtime against a real local provider server
pnpm verify        # all of the above, in CI order
```

## Security notes

* Keys are read **only** from environment variables; the config file stores the
  *variable name*, never the value.
* The permission core is deterministic and **defaults to deny**. Commands are
  auto-approved only when safety is provable from the literal command text.
* Logs, events and error payloads are redacted: credential patterns are masked
  and absolute paths are collapsed.
* Approval and questionnaire requests stay suspended until the user answers.

## License

[MIT](LICENSE)
