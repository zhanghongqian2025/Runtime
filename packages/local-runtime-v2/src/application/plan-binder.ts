import type { ToolBinder, ToolImpl } from '@local-agent/agent-core/tools';
import { LOCAL_TOOLS } from '@local-agent/agent-tools';
import { planWriteTool } from '@local-agent/agent-extension/plan-mode';

/**
 * The tools of the plan mode.
 *
 * In the plan mode the agent may look around, but it may not change anything
 * except the plan draft. The execution tools are therefore taken away and
 * `plan_write` is added.
 */

export const PLAN_MODE_EXCLUDED_TOOLS: readonly string[] = [
  'bash',
  'write',
  'edit',
  'apply_patch',
];

export function createPlanBinder(): ToolBinder {
  const allowed = LOCAL_TOOLS.filter(
    (tool) => !PLAN_MODE_EXCLUDED_TOOLS.includes(tool.definition.name),
  );
  const implementations: readonly ToolImpl[] = [...allowed, planWriteTool];
  const byName = new Map(implementations.map((tool) => [tool.definition.name, tool]));

  return {
    resolve: (name: string): ToolImpl | undefined => byName.get(name),
    list: () =>
      implementations.map((implementation) => ({
        definition: implementation.definition,
        runtime: 'local' as const,
        enabled: true,
      })),
    bind: (definitions) =>
      definitions
        .filter((definition) => byName.has(definition.name))
        .map((definition) => ({
          definition,
          runtime: 'local' as const,
          enabled: true,
        })),
  };
}
