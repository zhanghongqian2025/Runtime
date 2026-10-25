#!/usr/bin/env node
/**
 * Drive one goal-mode round against the live runtime.
 *
 * It sets a goal, sends a message, answers the permission requests that come
 * in, and then reports what the goal service made of it: how many rounds
 * ran, how many the verifier accepted, and which status it ended in.
 *
 * Usage: node scripts/goal-round.mjs [--host 127.0.0.1] [--port 8787]
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const HOST = flag('host', '127.0.0.1');
const PORT = Number(flag('port', 8787));
const BASE = `http://${HOST}:${PORT}`;

const call = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
};

const GOAL_TEXT =
  process.env.GOAL_TEXT ??
  [
    '目标: 用 read 工具读出 LICENSE 文件的第 1 行，并在最终回答里原样引用它',
    '验收: 会话历史里出现一条 tool_result，其内容包含 MIT License',
    '约束: 不修改任何文件，只做读取',
    '边界: 只允许读 LICENSE',
    '停止条件: 读取失败或者权限被拒绝',
  ].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = await call('POST', '/v1/sessions', { cwd: process.cwd() });
const sessionId = created.body.session.id;
console.log(`session            ${sessionId}`);

const set = await call('POST', `/v1/sessions/${sessionId}/goal`, {
  text: GOAL_TEXT,
  tokenBudget: 120000,
});
console.log(`goal set           ${set.status} ${JSON.stringify(set.body)}`);

await call('POST', `/v1/sessions/${sessionId}/messages`, {
  text: '开始：读出 LICENSE 的第 1 行并引用它。',
});

// Answer the permission requests and watch the goal.
const answered = new Set();
const reported = new Set();
const deadline = Date.now() + 240000;
let lastRounds = -1;

const listSessions = async () => {
  const result = await call('GET', '/v1/sessions');
  return result.body?.sessions ?? [];
};

while (Date.now() < deadline) {
  await sleep(1500);
  const status = await call('GET', `/v1/sessions/${sessionId}/status`);

  for (const requestId of status.body.pendingApprovals ?? []) {
    if (answered.has(requestId)) continue;
    answered.add(requestId);
    const decision = await call('POST', `/v1/sessions/${sessionId}/permissions/${requestId}`, {
      choice: 'allow-once',
    });
    console.log(`approval           ${requestId} → ${decision.status}`);
  }

  // A verification session must never need an approval. If one shows up,
  // that is the bug this script exists to catch.
  for (const session of await listSessions()) {
    if (session.id === sessionId) continue;
    const other = await call('GET', `/v1/sessions/${session.id}/status`);
    for (const requestId of other.body.pendingApprovals ?? []) {
      if (reported.has(requestId)) continue;
      reported.add(requestId);
      console.log(
        `STUCK              session ${session.id} waits for an approval (${requestId})`,
      );
    }
  }

  const goal = await call('GET', `/v1/sessions/${sessionId}/goal`);
  if (goal.status === 200) {
    const state = goal.body.goal;
    if (state.rounds !== lastRounds) {
      lastRounds = state.rounds;
      console.log(
        `round ${state.rounds}  status=${state.status} tokens=${state.budget.tokensUsed}/${state.budget.tokenLimit ?? '∞'}`,
      );
    }
    if (state.status !== 'active') {
      console.log(`\ngoal ended        status=${state.status}`);
      if (state.blockedReport !== undefined) {
        console.log(`  reason          ${state.blockedReport.reason}`);
        console.log(`  attempted       ${state.blockedReport.attemptedPaths.join(', ')}`);
        console.log(`  needs           ${state.blockedReport.requiredInputs.join(', ')}`);
      }
      break;
    }
  }
}

const history = await call('GET', `/v1/sessions/${sessionId}/history`);
console.log('\n--- history ---');
for (const message of history.body.messages) {
  const text = message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `→ ${block.name} ${JSON.stringify(block.input)}`;
      if (block.type === 'tool_result') {
        return `result(${block.isError ? 'error' : 'ok'}): ${block.content.map((c) => c.text).join('').slice(0, 120)}`;
      }
      return block.type;
    })
    .join(' | ');
  console.log(`  ${message.role.padEnd(9)} ${text.slice(0, 220)}`);
}

console.log(`\nsession id: ${sessionId}`);
