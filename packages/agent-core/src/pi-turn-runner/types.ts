import type {
  AgentMessage,
  ApprovalRequest,
  ApprovalResolution,
  RuntimeEventDraft,
  TokenUsage,
} from '@local-agent/protocol';
import type { ToolBinder, ToolEnvironment } from '../tools/index.js';
import type { TurnHooks } from './hooks.js';

/**
 * Turn assembly contracts.
 *
 * `runTurn` is a clean input/output boundary: everything the loop needs
 * arrives explicitly in `RunTurnInput`, and the result is a list of wire
 * events that always ends with a terminal `session.status` event.
 *
 * The provider stream function is declared here, on the consumer side: the
 * host supplies an implementation, the loop never depends on the host package.
 */

/** Model configuration relevant to the loop. */
export interface ModelConfig {
  readonly providerId: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number };
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

/** A model-visible tool, already projected into the provider wire format. */
export interface ProviderToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ProviderToolSpec[];
  readonly maxOutputTokens: number;
  readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number };
  readonly signal: AbortSignal;
}

export type ProviderStreamChunk =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | { readonly kind: 'done' };

export interface ProviderCallContext {
  /** Physical attempt number, starting at 1. */
  readonly attempt: number;
  /** Identifier shared by all attempts of one logical call. */
  readonly logicalCallId: string;
  readonly firstEventTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export type StreamFn = (
  request: ProviderRequest,
  context: ProviderCallContext,
) => AsyncIterable<ProviderStreamChunk>;

/** Writes messages into the canonical history. */
export interface MessageSink {
  /** Persist a batch of messages as a single history flush. */
  append(messages: readonly AgentMessage[]): Promise<void>;
  /** Durably replace the canonical history. */
  replace(messages: readonly AgentMessage[]): Promise<void>;
}

/** Publishes a wire event to the host. */
export type EventWriter = (event: RuntimeEventDraft) => void | Promise<void>;

export interface RunTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: ModelConfig;
  readonly tools: ToolBinder;
  /** The canonical history as it stands when the turn starts. */
  readonly history: readonly AgentMessage[];
  readonly hooks: TurnHooks;
  readonly messageSink: MessageSink;
  readonly writeEvent: EventWriter;
  readonly stream: StreamFn;
  /**
   * The environment a tool runs in.
   *
   * The host owns the working directory, the environment, the logger, the
   * artifacts and the permission/question bridges. The core owns the
   * identity of the call and the event channel.
   */
  readonly toolEnvironment: ToolEnvironment;
  /**
   * Answers a permission request.
   *
   * The core publishes the request and waits; the host owns the pending
   * request and resolves it when the user answers.
   */
  readonly onApprovalRequested?: (request: ApprovalRequest) => Promise<ApprovalResolution>;
  readonly signal?: AbortSignal;
}

export interface RunTurnResult {
  readonly status: 'completed' | 'failed' | 'aborted';
  /** Wire events, ending with a terminal `session.status` event. */
  readonly events: readonly RuntimeEventDraft[];
  readonly usage: TokenUsage;
  readonly error?: { readonly code: string; readonly message: string };
}
