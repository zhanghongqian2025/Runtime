import type { AgentMessage } from '@local-agent/protocol';
import type { ToolBinder } from '@local-agent/agent-core/tools';
import type { Logger, SessionStore, TurnSystem } from '@local-agent/local-runtime';
import type { GoalSpec, GoalVerification } from './types.js';

/**
 * The verifier.
 *
 * The acceptance check runs in an **independent sub-session**: its own
 * history, its own tools and its own verdicts. The goal itself cannot be
 * touched from there — the goal tools refuse to work in a verifier session.
 *
 * See docs/contracts.md §10.5.
 */

export interface GoalVerifier {
  verify(parentSessionId: string, spec: GoalSpec): Promise<GoalVerification>;
  /** The verification sessions that were created. */
  readonly sessions: readonly string[];
}

export interface GoalVerifierOptions {
  readonly sessions: SessionStore;
  readonly turns: TurnSystem;
  readonly logger: Logger;
  /** The tools of a verification session. */
  readonly toolsForVerifier: (sessionId: string) => ToolBinder;
  /** Registers a session as a verification session. */
  readonly registerVerifierSession: (sessionId: string) => void;
  /** The verdict of a verification session. */
  readonly takeVerdict: (sessionId: string) => GoalVerification | undefined;
  readonly cwd: string;
  readonly providerId: string;
  readonly model: string;
}

/**
 * The tools a verification session may use.
 *
 * It looks at the workspace, it never changes it. The set is deliberately
 * short: every tool in it is either read-only or, in the case of `bash`,
 * limited to the commands the permission policy proves safe. A tool that
 * changes the workspace would end up asking the user inside a session
 * nobody is watching, and the whole goal loop would stall there.
 */
export const VERIFIER_TOOL_NAMES: readonly string[] = ['read', 'grep', 'glob', 'bash'];

/** The instruction the verifier session receives. */
export function buildVerificationPrompt(spec: GoalSpec, evidence?: string): string {
  const lines = [
    'You verify whether a goal is achieved. Work in the workspace: read the files, run the tests, look at the logs.',
    '',
    `Goal: ${spec.objective}`,
    '',
    'Acceptance criteria:',
    ...spec.acceptanceCriteria.map((entry) => `- ${entry}`),
    '',
  ];

  if (spec.constraints.length > 0) {
    lines.push('Constraints that must not regress:', ...spec.constraints.map((entry) => `- ${entry}`), '');
  }
  if (spec.workBoundary.length > 0) {
    lines.push('What you may use or change:', ...spec.workBoundary.map((entry) => `- ${entry}`), '');
  }
  if (spec.stopConditions.length > 0) {
    lines.push('When you must stop:', ...spec.stopConditions.map((entry) => `- ${entry}`), '');
  }

  if (evidence !== undefined && evidence.length > 0) {
    lines.push(
      'The work that was done in the session you are verifying, with its evidence:',
      '',
      evidence,
      '',
      'Judge the evidence above first. Only look at the workspace yourself when the evidence does not settle a criterion.',
      '',
    );
  }

  lines.push(
    'Check every acceptance criterion with real evidence.',
    'When you are done, call goal_verdict with:',
    '- achieved: true only when every acceptance criterion is met',
    '- reason: what you checked and what you found',
    '- evidence: the tests, the build output, the logs and the artifacts, with their paths',
    '- progressed: whether this round moved the goal forward',
    '- directionWrong: true when the approach is clearly wrong',
  );

  return lines.join('\n');
}

/**
 * Render the recent work of the session being verified.
 *
 * The verifier judges in its own session, so it cannot see what the work
 * produced. The evidence travels with the prompt instead of being read from
 * the parent history.
 */
export function renderEvidence(
  messages: readonly AgentMessage[],
  options: {
    readonly maxMessages?: number;
    readonly maxChars?: number;
    readonly maxResultChars?: number;
  } = {},
): string {
  const maxMessages = options.maxMessages ?? 8;
  const maxChars = options.maxChars ?? 400;
  // A tool result carries the proof: the test output, the build log. It is
  // worth more room than the prose around it.
  const maxResultChars = options.maxResultChars ?? 2000;
  const recent = messages.slice(-maxMessages);

  return recent
    .map((message) => {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text.slice(0, maxChars));
        if (block.type === 'tool_use') {
          parts.push(`→ ${block.name} ${JSON.stringify(block.input).slice(0, maxChars)}`);
        }
        if (block.type === 'tool_result') {
          const text = block.content
            .map((entry) => (entry.type === 'text' ? entry.text : '[image]'))
            .join('')
            .slice(0, maxResultChars);
          parts.push(`result${block.isError ? ' (error)' : ''}: ${text}`);
        }
      }
      const text = parts.join(' | ');
      return text.length === 0 ? undefined : `${message.role}: ${text}`;
    })
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function createGoalVerifier(options: GoalVerifierOptions): GoalVerifier {
  const created: string[] = [];

  return {
    get sessions(): readonly string[] {
      return created;
    },

    async verify(parentSessionId: string, spec: GoalSpec): Promise<GoalVerification> {
      const parent = options.sessions.get(parentSessionId);
      const child = options.sessions.create({
        cwd: parent?.cwd ?? options.cwd,
        providerId: parent?.providerId ?? options.providerId,
        model: parent?.model ?? options.model,
        title: 'verification',
        // The verification session may look at the workspace, but it must
        // never ask the user: a question here would stall the whole goal
        // loop, and the question would land in a session nobody is watching.
        permissionMode: 'auto',
      });

      created.push(child.id);
      options.registerVerifierSession(child.id);

      const evidence = renderEvidence(options.sessions.readHistory(parentSessionId));

      const submitted = await options.turns.submit(
        child.id,
        buildVerificationPrompt(spec, evidence),
      );
      if (submitted.turnId === undefined) {
        return {
          achieved: false,
          reason: 'the verification session could not be started',
          evidence: [],
          progressed: false,
        };
      }

      await options.turns.awaitTurn(child.id, submitted.turnId);

      const verdict = options.takeVerdict(child.id);
      if (verdict === undefined) {
        return {
          achieved: false,
          reason: 'the verifier did not report a verdict',
          evidence: [],
          progressed: false,
        };
      }
      return verdict;
    },
  };
}
