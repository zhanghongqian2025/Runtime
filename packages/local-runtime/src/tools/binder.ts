import type { ToolBinder, ToolImpl } from '@local-agent/agent-core/tools';

/**
 * The tool binder.
 *
 * It resolves tool implementations by name for a session. The loop only ever
 * sees the protocol, never the implementation.
 */
export function createToolBinder(implementations: readonly ToolImpl[] = []): ToolBinder {
  const byName = new Map<string, ToolImpl>();
  for (const implementation of implementations) {
    byName.set(implementation.definition.name, implementation);
  }

  return {
    resolve(name: string): ToolImpl | undefined {
      return byName.get(name);
    },
    list() {
      return [...byName.values()].map((implementation) => ({
        definition: implementation.definition,
        runtime: 'local' as const,
        enabled: true,
      }));
    },
    bind(definitions) {
      return definitions
        .filter((definition) => byName.has(definition.name))
        .map((definition) => ({
          definition,
          runtime: 'local' as const,
          enabled: true,
        }));
    },
  };
}
