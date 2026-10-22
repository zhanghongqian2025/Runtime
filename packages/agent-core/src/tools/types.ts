import { z } from 'zod';
import type {
  ApprovalRequest,
  ApprovalResolution,
  PermissionMode,
  PermissionOutcome,
  QuestionRequest,
  QuestionResolution,
  RiskLevel,
  RuntimeEventBody,
  ToolResult,
  ToolUpdate,
} from '@local-agent/protocol';

/**
 * Tool protocol layer.
 *
 * This module owns the contract between the loop and whatever executes a tool.
 * The loop only knows the protocol: it never knows where an implementation
 * comes from, and several implementations may share a name.
 */

/** Tool names are model visible and therefore constrained. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const ExecutionModeSchema = z.enum(['sync', 'async', 'background']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Result of a `prepareArguments` step: normalized input, or a diagnosable error. */
export type PrepareResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** The model-visible description of a tool. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly executionMode: ExecutionMode;
  readonly prepareArguments?: (raw: unknown) => PrepareResult;
  readonly risk?: RiskLevel;
}

/** The execution-side contract. */
export interface ToolImpl {
  readonly definition: ToolDefinition;
  execute(
    ctx: ToolExecutionContext,
    input: unknown,
    signal: AbortSignal,
    onUpdate: (update: ToolUpdate) => void,
  ): Promise<ToolResult>;
}

/** A tool bound into a running session. */
export interface RuntimeTool {
  readonly definition: ToolDefinition;
  readonly runtime: 'local';
  readonly enabled: boolean;
}

/** File change reported by a tool. */
export interface FileChange {
  readonly path: string;
  readonly change: 'created' | 'modified' | 'deleted';
  readonly bytes?: number;
}

/** Structured logger handed to tools; redacts before it writes. */
export interface ToolLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Size governance of a tool result. */
export interface ToolOutputLimits {
  /** Maximum size of a single tool result. */
  readonly maxBytes: number;
  /** Maximum number of lines. */
  readonly maxLines: number;
}

/**
 * Session artifacts.
 *
 * Artifacts belong to the session, not to the workspace: the plan draft, the
 * background task logs and everything else the runtime keeps for later.
 */
export interface ToolArtifacts {
  /** Absolute path of an artifact. The name must be a relative path. */
  path(name: string): string;
  /** Replace an artifact. */
  write(name: string, content: string): Promise<void>;
  /** Append to an artifact. */
  append(name: string, content: string): Promise<void>;
  /** Read an artifact. Returns undefined when it does not exist. */
  read(name: string): Promise<string | undefined>;
}

/** Everything a tool is allowed to know about its environment. */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  /** Workspace root. Internal use only: never echoed to the client. */
  readonly cwd: string;
  /** Allow-listed environment variables, already redacted. */
  readonly env: Readonly<Record<string, string>>;
  readonly now: () => number;
  readonly requestPermission: (request: ApprovalRequest) => Promise<ApprovalResolution>;
  readonly onFileChanged: (change: FileChange) => void | Promise<void>;
  /**
   * Publish a host-side event on the session stream. The core assigns the
   * turn-scoped envelope; the host assigns the session offset.
   */
  readonly emitEvent: (body: RuntimeEventBody) => Promise<void>;
  /** Ask the user a structured question and wait for the answer. */
  readonly askUser: (request: QuestionRequest) => Promise<QuestionResolution>;
  /** Session artifacts. */
  readonly artifacts: ToolArtifacts;
  /** Size governance applied to the tool result. */
  readonly limits: ToolOutputLimits;
  readonly log: ToolLogger;
}

/**
 * The part of the tool context the host provides.
 *
 * The core owns the session/turn/call identity and the event channel, so the
 * host fills in the environment only.
 */
export type ToolEnvironment = Omit<
  ToolExecutionContext,
  'sessionId' | 'turnId' | 'toolCallId' | 'emitEvent'
>;

/** Binds tool implementations by name for a session. */
export interface ToolBinder {
  resolve(name: string): ToolImpl | undefined;
  list(): readonly RuntimeTool[];
  bind(definitions: readonly ToolDefinition[]): readonly RuntimeTool[];
}

/** The decision a permission request resolves to. */
export type { PermissionOutcome, PermissionMode } from '@local-agent/protocol';

/** Input of a permission decision. */
export interface PermissionQuery {
  readonly toolName: string;
  /** Normalized arguments; the decision must not depend on raw input. */
  readonly normalizedInput: unknown;
  readonly mode: PermissionMode;
  readonly sessionRules: readonly SessionRule[];
  readonly cwd: string;
}

/** A rule granted for the duration of a session. */
export interface SessionRule {
  readonly id: string;
  readonly description: string;
  readonly toolName: string;
  /** When set, the rule only covers commands that start with this prefix. */
  readonly commandPrefix?: string;
}

/** The deterministic outcome of a permission decision. */
export interface PermissionDecision {
  readonly outcome: PermissionOutcome;
  readonly reason: string;
  readonly risk: RiskLevel;
  readonly matchedRule?: string;
  readonly approval?: ApprovalRequest;
}

/**
 * The permission policy owner.
 *
 * The permission layer decides; it never executes. A blocked call is reported
 * back to the loop as `blockedBy: 'permission'`.
 */
export interface PermissionCore {
  decide(query: PermissionQuery): PermissionDecision;
  /**
   * Ask the user for permission and wait for the answer.
   *
   * The host owns the pending request; the core publishes the request on the
   * event stream and waits for the resolution.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResolution>;
  resolveApproval(requestId: string, choice: ApprovalResolution['choice']): void;
  listSessionRules(sessionId: string): readonly SessionRule[];
}

/** Validate a tool name against the model-visible naming rule. */
export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
}
