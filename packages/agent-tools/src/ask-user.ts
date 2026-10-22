import { z } from 'zod';
import { newId, QuestionItemSchema, type QuestionRequest } from '@local-agent/protocol';
import type { ToolImpl } from '@local-agent/agent-core/tools';
import { failure, textResult } from './result.js';

/**
 * `ask_user` — a structured questionnaire for a blocking decision.
 *
 * The tool publishes the request on the event stream and then waits for the
 * answer. The channel is separate from the approval channel: an approval
 * answers "may I?", a question asks "what do you want?".
 *
 * See docs/decisions.md D-009.
 */

export const AskUserInputSchema = z
  .object({
    title: z.string().min(1),
    questions: z.array(QuestionItemSchema).min(1),
  })
  .strict();
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export const askUserTool: ToolImpl = {
  definition: {
    name: 'ask_user',
    description:
      'Ask the user a structured question when a decision blocks the work. The call waits for the answer.',
    schema: AskUserInputSchema,
    executionMode: 'async',
    risk: 'none',
  },

  async execute(ctx, input, signal) {
    const parsed = AskUserInputSchema.safeParse(input);
    if (!parsed.success) {
      return failure(
        'ask_user',
        `invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    const request: QuestionRequest = {
      requestId: newId('request'),
      title: parsed.data.title,
      questions: parsed.data.questions,
    };

    await ctx.emitEvent({ type: 'question.requested', question: request });

    if (signal.aborted) {
      return failure('ask_user', 'the question was cancelled before it was answered');
    }

    let resolution;
    try {
      resolution = await ctx.askUser(request);
    } catch (error: unknown) {
      return failure(
        'ask_user',
        `the question could not be answered: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await ctx.emitEvent({ type: 'question.resolved', resolution });

    const answers = Object.entries(resolution.answers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    return textResult(answers.length > 0 ? answers : '(no answer)');
  },
};
