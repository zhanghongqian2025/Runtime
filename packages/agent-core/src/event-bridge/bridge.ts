import type { AgentEvent, RuntimeEventBody, RuntimeEventDraft } from '@local-agent/protocol';
import { newEventId } from '@local-agent/protocol';

/**
 * Event bridge: `AgentEvent` -> `RuntimeEvent`.
 *
 * The conversion is pure with respect to the event itself; the emitter keeps
 * only the turn-scoped sequence counter and the tool intent bookkeeping the
 * wire format needs. Both the turn-scoped `id` and `seq` are produced here,
 * inside the turn, so the host never has to invent them.
 *
 * See docs/contracts.md §2.
 */

export interface TurnEventEmitterOptions {
  readonly sessionId: string;
  readonly turnId: string;
  /** Injectable clock, mainly for deterministic tests. */
  readonly now?: () => string;
}

export interface TurnEventEmitter {
  /**
   * Convert an internal event into a wire draft.
   *
   * Returns `undefined` for internal-only events that have no wire
   * representation; those do not consume a sequence number.
   */
  emit(event: AgentEvent): RuntimeEventDraft | undefined;
  /**
   * Publish a host-side event body.
   *
   * The envelope is assigned here, in the core, so the turn-scoped sequence
   * stays in one place.
   */
  emitHost<T extends RuntimeEventBody>(body: T): RuntimeEventDraft;
  /** Number of wire events emitted so far (equals the last assigned seq). */
  readonly emittedCount: number;
}

interface ToolIntent {
  readonly name: string;
  readonly input: unknown;
}

export function createTurnEventEmitter(options: TurnEventEmitterOptions): TurnEventEmitter {
  const { sessionId, turnId } = options;
  const now = options.now ?? ((): string => new Date().toISOString());

  let seq = 0;
  const toolIntents = new Map<string, ToolIntent>();

  const envelope = (): {
    id: string;
    seq: number;
    sessionId: string;
    turnId: string;
    ts: string;
  } => {
    seq += 1;
    return { id: newEventId(turnId, seq), seq, sessionId, turnId, ts: now() };
  };

  const emit = (event: AgentEvent): RuntimeEventDraft | undefined => {
    switch (event.type) {
      case 'turn.started':
        return { ...envelope(), type: 'session.status', status: 'running' };

      case 'turn.completed':
        return { ...envelope(), type: 'session.status', status: 'completed' };

      case 'turn.failed':
        return {
          ...envelope(),
          type: 'session.status',
          status: 'failed',
          error: { code: event.code, message: event.reason },
        };

      case 'step.started':
        return { ...envelope(), type: 'step.started', stepIndex: event.stepIndex };

      case 'step.completed':
        return { ...envelope(), type: 'step.completed', stepIndex: event.stepIndex };

      case 'llm.request.started':
        return { ...envelope(), type: 'llm.request.started', attempt: event.attempt };

      case 'llm.retry.scheduled':
        return {
          ...envelope(),
          type: 'llm.retry.scheduled',
          attempt: event.attempt,
          delayMs: event.delayMs,
          reason: event.reason,
        };

      case 'message.completed':
        return { ...envelope(), type: 'message.completed', message: event.message };

      case 'text.delta':
        return { ...envelope(), type: 'message.delta', messageId: event.messageId, text: event.text };

      case 'thinking.delta':
        return { ...envelope(), type: 'thinking.delta', messageId: event.messageId, text: event.text };

      case 'tool.intent.created':
        toolIntents.set(event.toolCallId, { name: event.name, input: event.input });
        return undefined;

      case 'tool.intent.started': {
        const intent = toolIntents.get(event.toolCallId);
        return {
          ...envelope(),
          type: 'tool.call.started',
          toolCallId: event.toolCallId,
          name: intent?.name ?? 'unknown',
          input: intent?.input,
        };
      }

      case 'tool.intent.progress':
        return {
          ...envelope(),
          type: 'tool.call.progress',
          toolCallId: event.toolCallId,
          name: event.name,
          chunk: event.chunk,
        };

      case 'tool.intent.completed':
        return {
          ...envelope(),
          type: 'tool.call.completed',
          toolCallId: event.toolCallId,
          name: event.name,
          result: event.result,
        };

      case 'tool.intent.blocked':
        return {
          ...envelope(),
          type: 'tool.call.blocked',
          toolCallId: event.toolCallId,
          name: event.name,
          blockedBy: event.blockedBy,
          reason: event.reason,
        };

      case 'file.changed':
        return { ...envelope(), type: 'file.changed', path: event.path, change: event.change };

      case 'history.flushed':
        return undefined;

      case 'compaction.started':
        return {
          ...envelope(),
          type: 'context.compaction.started',
          reason: event.reason,
          beforeTokens: event.beforeTokens,
        };

      case 'compaction.completed':
        return {
          ...envelope(),
          type: 'context.compaction.completed',
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          savedRatio: event.savedRatio,
          checkpointId: event.checkpointId,
        };

      default: {
        // Exhaustiveness guard: a new agent event without a wire mapping is a
        // programming error, not a runtime condition.
        const never: never = event;
        throw new Error(`unmapped agent event: ${JSON.stringify(never)}`);
      }
    }
  };

  const emitHost = <T extends RuntimeEventBody>(body: T): RuntimeEventDraft => {
    // The body already carries the payload of exactly one event variant, so
    // merging it with the envelope yields a well-formed draft.
    return { ...envelope(), ...body } as RuntimeEventDraft;
  };

  return {
    emit,
    emitHost,
    get emittedCount(): number {
      return seq;
    },
  };
}
