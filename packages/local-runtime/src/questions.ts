import type { QuestionRequest, QuestionResolution } from '@local-agent/protocol';

/**
 * The question bridge.
 *
 * `ask_user` publishes the request and then waits here until the client
 * answers it. The bridge is per session: the HTTP endpoint resolves the
 * pending promise.
 *
 * The channel is separate from the approval channel (D-009): an approval
 * answers "may I?", a question asks "what do you want?".
 */

export interface QuestionBridge {
  askUser(request: QuestionRequest): Promise<QuestionResolution>;
  /** Answer a pending question. Returns false when the id is unknown. */
  resolve(requestId: string, answers: Record<string, string>): boolean;
  /** The ids of the questions waiting for an answer. */
  pending(): readonly string[];
}

export function createQuestionBridge(): QuestionBridge {
  const waiting = new Map<string, (resolution: QuestionResolution) => void>();

  return {
    askUser(request: QuestionRequest): Promise<QuestionResolution> {
      return new Promise<QuestionResolution>((resolve) => {
        waiting.set(request.requestId, resolve);
      });
    },
    resolve(requestId: string, answers: Record<string, string>): boolean {
      const resolvePending = waiting.get(requestId);
      if (!resolvePending) return false;
      waiting.delete(requestId);
      resolvePending({ requestId, answers });
      return true;
    },
    pending(): readonly string[] {
      return [...waiting.keys()];
    },
  };
}
