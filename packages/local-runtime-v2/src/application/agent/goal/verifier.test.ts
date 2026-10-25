import { describe, expect, it } from 'vitest';
import type { AgentMessage, RiskLevel } from '@local-agent/protocol';
import { decidePermission } from '@local-agent/local-runtime';
import { buildVerificationPrompt, renderEvidence, VERIFIER_TOOL_NAMES } from './verifier.js';
import type { GoalSpec } from './types.js';

/**
 * The verifier judges in its own session. Two things must hold:
 *
 * - the prompt carries the evidence of the work it has to judge, because the
 *   session cannot see the parent history;
 * - the prompt states the goal exactly as the service parsed it.
 */

const spec: GoalSpec = {
  objective: '让 LICENSE 的第 1 行出现在回答里',
  acceptanceCriteria: ['会话历史里出现一条 tool_result，内容包含 MIT License'],
  constraints: ['不修改任何文件'],
  workBoundary: ['只允许读 LICENSE'],
  stopConditions: ['读取失败'],
};

const user = (text: string): AgentMessage => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-10-22T00:00:00.000Z',
});

const toolResult = (text: string): AgentMessage => ({
  id: 'm2',
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId: 'call_1',
      content: [{ type: 'text', text }],
      isError: false,
    },
  ],
  createdAt: '2026-10-22T00:00:01.000Z',
});

describe('the verification prompt', () => {
  it('carries the goal, the criteria, the constraints and the stop conditions', () => {
    const prompt = buildVerificationPrompt(spec);

    expect(prompt).toContain('让 LICENSE 的第 1 行出现在回答里');
    expect(prompt).toContain('会话历史里出现一条 tool_result');
    expect(prompt).toContain('不修改任何文件');
    expect(prompt).toContain('只允许读 LICENSE');
    expect(prompt).toContain('读取失败');
    expect(prompt).toContain('goal_verdict');
  });

  it('carries the evidence of the work it has to judge', () => {
    const prompt = buildVerificationPrompt(
      spec,
      'tool: result: MIT License\n\nCopyright (c) 2026',
    );

    expect(prompt).toContain('MIT License');
    expect(prompt).toContain('the session you are verifying');
  });

  it('says nothing about evidence when there is none', () => {
    const prompt = buildVerificationPrompt(spec, '');

    expect(prompt).not.toContain('the session you are verifying');
  });
});

describe('the rendered evidence', () => {
  it('shows the recent messages of the session', () => {
    const evidence = renderEvidence([user('读 LICENSE'), toolResult('MIT License')]);

    expect(evidence).toContain('user: 读 LICENSE');
    expect(evidence).toContain('result: MIT License');
  });

  it('keeps more of a tool result than of the prose around it', () => {
    const long = 'x'.repeat(5000);
    const evidence = renderEvidence([user('short'), toolResult(long)], {
      maxChars: 100,
      maxResultChars: 1000,
    });

    expect(evidence).toContain('x'.repeat(1000));
    expect(evidence).not.toContain('x'.repeat(1001));
  });

  it('keeps the last messages only', () => {
    const evidence = renderEvidence([user('first'), user('second'), user('third')], {
      maxMessages: 2,
    });

    expect(evidence).not.toContain('first');
    expect(evidence).toContain('second');
    expect(evidence).toContain('third');
  });
});

describe('the verification session', () => {
  /**
   * The invariant that keeps the goal loop alive.
   *
   * The verification session runs in the `auto` mode. A call that ends in
   * "ask" would park the turn until a human answers, and that question
   * would live in a session the user is not looking at. The goal loop would
   * stop there, silently.
   */
  it('never asks the user: every call is allowed or denied', () => {
    const toolRisks = new Map<string, RiskLevel>([
      ['create_goal', 'none'],
      ['get_goal', 'none'],
      ['update_goal', 'none'],
      ['goal_verdict', 'none'],
    ]);

    const calls = [
      { toolName: 'read', input: { path: 'README.md' }, path: 'README.md' },
      { toolName: 'grep', input: { pattern: 'TODO' } },
      { toolName: 'glob', input: { pattern: '**/*.ts' } },
      { toolName: 'bash', input: { command: 'ls -la' }, command: 'ls -la' },
      { toolName: 'bash', input: { command: 'pnpm verify' }, command: 'pnpm verify' },
      { toolName: 'bash', input: { command: 'rm -rf /' }, command: 'rm -rf /' },
      { toolName: 'get_goal', input: {} },
      { toolName: 'goal_verdict', input: { achieved: true } },
    ];

    for (const call of calls) {
      const decision = decidePermission(
        { toolName: call.toolName, input: call.input, ...('path' in call ? { path: call.path } : {}), ...('command' in call ? { command: call.command } : {}) },
        { mode: 'auto', sessionRules: [], cwd: '/workspace', toolRisks },
      );
      expect(`${call.toolName}: ${decision.outcome}`).not.toContain('ask');
    }
  });

  it('has no tool that changes the workspace', () => {
    // A tool that writes would be a medium risk, and a medium risk asks.
    for (const name of ['write', 'edit', 'apply_patch', 'todo_write', 'ask_user']) {
      expect(VERIFIER_TOOL_NAMES).not.toContain(name);
    }
  });
});
