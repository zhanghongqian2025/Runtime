#!/usr/bin/env node
/**
 * Drive the plan mode against the live runtime.
 *
 * It enters the plan mode, lets the agent write the draft, freezes the
 * draft for review, answers the review and reports what the plan service
 * made of it.
 *
 * Usage: node scripts/plan-round.mjs [--host 127.0.0.1] [--port 8787]
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = await call('POST', '/v1/sessions', { cwd: process.cwd() });
const sessionId = created.body.session.id;
console.log(`session            ${sessionId}`);

const entered = await call('POST', `/v1/sessions/${sessionId}/mode`, {
  interactionMode: 'plan',
});
console.log(`plan mode          ${entered.status} ${JSON.stringify(entered.body)}`);

await call('POST', `/v1/sessions/${sessionId}/messages`, {
  text:
    process.env.PLAN_REQUEST ??
    '为这个仓库写一份实施计划：先说清楚要做什么、分几步、每一步怎么验证。',
});

// Answer the permission requests: the plan draft is a low-risk tool call, and
// the ask mode wants a decision for it. The draft itself is the signal that
// the agent is done planning: the review only exists after the freeze.
const answered = new Set();
const deadline = Date.now() + 240000;
let draft = '';

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

  // The artifact name is the session-relative path; a path with a slash
  // travels URL-encoded.
  const artifact = await call(
    'GET',
    `/v1/sessions/${sessionId}/artifacts/${encodeURIComponent('artifacts/plan.md')}`,
  );
  if (artifact.status === 200 && typeof artifact.body?.content === 'string' && artifact.body.content.length > 0) {
    draft = artifact.body.content;
    break;
  }
}

console.log(`draft              ${draft.length > 0 ? `${draft.length} chars` : 'MISSING'}`);

// Freeze the draft and read the review.
const frozen = await call('POST', `/v1/sessions/${sessionId}/mode`, {
  interactionMode: 'default',
});
console.log(`frozen             ${frozen.status}`);
const review = frozen.body?.review;
if (review === undefined) {
  console.log('no review was created — the draft was missing or the freeze failed');
  process.exitCode = 1;
} else {
  console.log(`review             ${review.requestId}`);
  console.log('--- the frozen plan ---');
  console.log((review.markdown ?? '').slice(0, 2000));
  console.log('--- end of the plan ---');

  const answered = await call('POST', `/v1/sessions/${sessionId}/plan/review`, {
    requestId: review.requestId,
    decision: 'approve',
  });
  console.log(`approved           ${answered.status} ${JSON.stringify(answered.body)}`);
}

const finalState = await call('GET', `/v1/sessions/${sessionId}/plan`);
console.log(
  `final              mode=${finalState.body?.mode} blocked=${finalState.body?.blocked} ` +
    `approved=${finalState.body?.approvedPlan !== undefined}`,
);

const history = await call('GET', `/v1/sessions/${sessionId}/history`);
console.log('\n--- history ---');
for (const message of history.body.messages) {
  const text = message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `→ ${block.name} ${JSON.stringify(block.input).slice(0, 80)}`;
      if (block.type === 'tool_result') {
        return `result(${block.isError ? 'error' : 'ok'}): ${block.content.map((c) => c.text).join('').slice(0, 100)}`;
      }
      return block.type;
    })
    .join(' | ');
  console.log(`  ${message.role.padEnd(9)} ${text.slice(0, 200)}`);
}

console.log(`\nsession id: ${sessionId}`);
