import type { AgentMessage } from '@local-agent/protocol';

/**
 * Session contracts.
 *
 * A session owns its canonical history, its mode and its status. The store is
 * the only writer (docs/state-ownership.md F1, F2).
 */

export const SESSION_STATUSES = [
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_input',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const INTERACTION_MODES = ['default', 'plan'] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export interface Session {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly interactionMode: InteractionMode;
  readonly status: SessionStatus;
  readonly providerId: string;
  readonly model: string;
}

export interface SessionView extends Session {
  /** Number of messages in the canonical history. */
  readonly messageCount: number;
}

export interface CreateSessionInput {
  readonly id?: string;
  readonly title?: string;
  readonly cwd: string;
  readonly providerId: string;
  readonly model: string;
}

/** Where a fork starts from. */
export interface ForkOptions {
  /** Fork after this message. */
  readonly fromMessageId?: string | undefined;
  /** Fork after the last message of this turn. */
  readonly fromTurnId?: string | undefined;
  readonly title?: string | undefined;
}

/** Where a rewind goes back to. */
export interface RewindOptions {
  readonly toMessageId?: string | undefined;
  readonly toTurnId?: string | undefined;
  /** The message that is sent again after the rewind. */
  readonly resend: string;
}

/** The state of a tool call inside a turn. */
export type ToolCallStatus = 'started' | 'completed' | 'blocked' | 'failed';

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly name: string;
  readonly status: ToolCallStatus;
  readonly finishedAt?: string;
}

/** The index of a turn, used to resume without repeating a tool call. */
export interface TurnRecord {
  readonly turnId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface SessionStore {
  create(input: CreateSessionInput): Session;
  get(id: string): Session | undefined;
  list(): readonly SessionView[];
  update(id: string, patch: Partial<Omit<Session, 'id' | 'createdAt'>>): Session | undefined;
  readHistory(id: string): readonly AgentMessage[];
  appendHistory(id: string, messages: readonly AgentMessage[]): void;
  replaceHistory(id: string, messages: readonly AgentMessage[]): void;
  delete(id: string): boolean;

  /** Copy the session up to a point into a new one. */
  fork(id: string, options: ForkOptions): Session | undefined;
  /** Cut the session back to a point and send a message again. */
  rewind(id: string, options: RewindOptions): Session | undefined;

  /** Record the state of a turn. The last record for a turn wins. */
  appendTurn(id: string, record: TurnRecord): void;
  readTurns(id: string): readonly TurnRecord[];

  /** Checkpoints hold the history as it was before a compaction. */
  writeCheckpoint(id: string, checkpointId: string, messages: readonly AgentMessage[]): void;
  readCheckpoint(id: string, checkpointId: string): readonly AgentMessage[];
  listCheckpoints(id: string): readonly string[];
}
