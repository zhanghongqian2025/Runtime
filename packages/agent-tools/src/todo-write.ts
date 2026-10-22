import { z } from 'zod';
import { TodoItemSchema, type TodoItem } from '@local-agent/protocol';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { failure, textResult } from './result.js';

/**
 * `todo_write` — the task list.
 *
 * The list is the **truth source of the progress**: it is written to the
 * session file `todo.json` and published on the event stream, so the client
 * always shows the same list the agent works from.
 */

export const TodoWriteInputSchema = z
  .object({
    items: z.array(TodoItemSchema),
  })
  .strict();
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export const TODO_FILE = 'todo.json';

export const todoWriteTool: ToolImpl = {
  definition: {
    name: 'todo_write',
    description:
      'Write the task list. The list is the truth source of the progress: it replaces the previous list and is published to the client.',
    schema: TodoWriteInputSchema,
    executionMode: 'sync',
    risk: 'none',
  },

  async execute(ctx, input) {
    const parsed = TodoWriteInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure(
        'todo_write',
        `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    const items: TodoItem[] = parsed.data.items;

    try {
      await ctx.artifacts.write(TODO_FILE, `${JSON.stringify(items, null, 2)}\n`);
    } catch (error: unknown) {
      return failure(
        'todo_write',
        `cannot write the task list: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await ctx.emitEvent({ type: 'todo.updated', items });

    const done = items.filter((item) => item.status === 'completed').length;
    return textResult(`task list updated: ${done}/${items.length} completed`);
  },
};
