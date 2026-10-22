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

/** The instruction the verifier session receives. */
export function buildVerificationPrompt(spec: GoalSpec): string {
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
      });

      created.push(child.id);
      options.registerVerifierSession(child.id);

      const submitted = await options.turns.submit(
        child.id,
        buildVerificationPrompt(spec),
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
