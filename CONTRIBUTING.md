# Contributing

Thanks for taking the time to contribute. This project is a **fully local,
open-source coding agent runtime**: everything runs on your machine, the model
is reached through your own key, and nothing is sent to a service we control.

## Ground rules

1. **Everything stays local.** No telemetry, no auto-update, no remote call
   that is not the model endpoint you configured.
2. **No copied implementation.** Behaviour may be inspired by public
   specifications (see `docs/provenance.md`); implementations are written from
   scratch here.
3. **Fail closed.** When a decision is uncertain, deny or ask. Never approve
   optimistically.
4. **Secrets never reach the repository.** Keys are read from environment
   variables; the config file stores the *name* of the variable, never the
   value.

## Getting set up

```bash
pnpm install
pnpm verify        # lint + dependency check + typecheck + tests + build
```

Requirements: Node.js ≥ 22.19 and pnpm ≥ 10.

## The shape of the code

Read `docs/architecture.md` first — it is the authority on layering.

| Package | Owns |
| --- | --- |
| `@local-agent/protocol` | The message and event contracts (zod schemas). The root of the dependency graph. |
| `@local-agent/agent-core` | The pure loop: `/tools` (tool protocol), `/event-bridge` (AgentEvent → RuntimeEvent), `/pi-turn-runner` (turn assembly, hooks, compaction). |
| `@local-agent/agent-tools` | The local tool implementations. |
| `@local-agent/agent-extension` | Optional extensions; the plan mode lives here. |
| `@local-agent/local-runtime` | The host: HTTP, sessions, permissions, events, configuration. |
| `@local-agent/local-runtime-v2` | The application layer: the composition root, the plan mode, the goal mode. |
| `@local-agent/cli` | The client. It talks to the runtime over HTTP and never imports it in-process. |

Dependencies flow one way: `local-runtime(-v2) → agent-core → protocol` and
`local-runtime(-v2) → agent-tools → agent-core/tools`. `pnpm check:deps`
enforces the edges; the ESLint rules enforce the imports.

## Adding a tool

1. Implement it in `packages/agent-tools/src/` as a `ToolImpl`.
2. Give it a zod `schema`, a `risk` and a description the model can act on.
3. Keep the result small: the shared size governance trims it and reports how
   many bytes were dropped.
4. Add the boundary cases to `packages/agent-tools/src/tools.test.ts`.

## Changing a contract

Contracts are versioned by the code, not by a document. When you change one:

1. Update `packages/protocol` and the owning package together.
2. Update `docs/contracts.md` in the same change — it is the readable mirror of
   the schema.
3. Record the decision in `docs/decisions.md` if it is not obvious.
4. Record the provenance of the behaviour in `docs/provenance.md` if it comes
   from an external specification.

## Tests

- Every package has unit tests next to the code (`*.test.ts`).
- The end-to-end tests live in `e2e/` and use a **recorded-replay provider**:
  nothing in the test suite touches the network.
- The retry classification, the permission matrix, the hook semantics, the
  compaction ratio and the goal state machine are the parts that must not
  regress; they have dedicated tests.

## Style

- English identifiers and English comments. User-facing prompts and documents
  may be bilingual.
- Strict TypeScript. No `any`, no non-null assertions in library code, and
  `exactOptionalPropertyTypes` is on.
- Parsing functions return `undefined` for input they do not understand; they
  never throw. Only genuine programming errors throw.
- Public behaviour is documented before it is implemented, in
  `docs/contracts.md`.

## Reporting a security issue

Please do not open a public issue for a vulnerability that would let the
runtime execute something the user did not approve. Describe it privately to
the maintainers first.

## License

Contributions are accepted under the [MIT license](LICENSE).
