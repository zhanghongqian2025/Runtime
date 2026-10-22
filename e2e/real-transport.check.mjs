import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSseBody,
  DONE_FRAME,
  startOpenAiCompatibleServer,
  textFrame,
  toolCallFrame,
  usageFrame,
} from './fixtures/openai-compatible-server.mjs';

/**
 * The runtime against a real HTTP server.
 *
 * The provider is local, but everything else is real: a real socket, real
 * chunked SSE, the real `fetch`, the real retry contract and the real tool
 * execution. The point is to exercise the paths a cloud provider would
 * exercise, without an account and without the network.
 *
 * Run it with: pnpm check:transport
 */

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const start = async () => {
  const scenarios = [
    // 1. A plain answer, streamed in three frames.
    {
      body: buildSseBody(
        textFrame('Hello '),
        textFrame('from '),
        textFrame('the local provider.'),
        usageFrame(12, 7),
        DONE_FRAME,
      ),
      frameDelayMs: 15,
    },
    // 2. A tool call. The loop runs another step after a tool call, so the
    //    next scenario is the model's reaction to the tool result.
    {
      body: buildSseBody(
        toolCallFrame(0, 'call_1', 'read', { path: 'notes.txt' }),
        DONE_FRAME,
      ),
    },
    {
      body: buildSseBody(textFrame('I read the notes.'), DONE_FRAME),
    },
    // 3. A rate limit: the adapter must retry.
    {
      status: 429,
      body: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      headers: { 'retry-after': '0' },
    },
    // 4. The retry succeeds.
    { body: buildSseBody(textFrame('Recovered from the rate limit.'), DONE_FRAME) },
    // 5. An authentication failure: the adapter must not retry.
    { status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) },
  ];

  return startOpenAiCompatibleServer({ scenarios });
};

const main = async () => {
  process.stdout.write('real transport check (local OpenAI-compatible server)\n\n');

  const local = await start();
  const baseUrl = `http://127.0.0.1:${local.port}/v1`;

  // A real configuration file, with the key taken from the environment.
  const xdgDir = mkdtempSync(join(tmpdir(), 'local-agent-config-'));
  const configDir = join(xdgDir, 'local-agent');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      'host: 127.0.0.1',
      'httpPort: 0',
      'permissionMode: full-access',
      'providers:',
      '  - id: openai-compatible',
      `    baseUrl: ${baseUrl}`,
      '    apiKeyEnvVar: LOCAL_AGENT_TEST_KEY',
      '    model: local-test-model',
      '    contextWindowTokens: 128000',
      '    maxOutputTokens: 4096',
      '',
    ].join('\n'),
    'utf8',
  );

  process.env['LOCAL_AGENT_TEST_KEY'] = 'sk-local-test-key-not-a-real-secret';
  process.env['XDG_CONFIG_HOME'] = xdgDir;

  const { loadRuntimeConfig, createProviderFromConfig } = await import(
    '../packages/local-runtime/dist/index.js'
  );
  const { createApplication } = await import('../packages/local-runtime-v2/dist/index.js');

  // 1. The configuration file is read and the key comes from the environment.
  const loaded = loadRuntimeConfig(process.env, { readFile: true });
  check(
    'the configuration file is read',
    loaded.config.providers.length === 1 && loaded.config.providers[0]?.baseUrl === baseUrl,
    `provider: ${loaded.config.providers[0]?.id ?? 'none'} @ ${loaded.config.providers[0]?.baseUrl ?? '-'}`,
  );
  check(
    'the key comes from the environment, not from the file',
    loaded.secrets.has('LOCAL_AGENT_TEST_KEY') &&
      !readFileSync(configPath, 'utf8').includes('sk-local-test'),
    'the file holds only the variable name',
  );

  const provider = createProviderFromConfig(loaded);
  check('the provider adapter is built from the configuration', provider !== undefined);

  const app = createApplication({
    config: loaded,
    provider,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(...args) {
        console.log('   runtime error:', ...args);
      },
    },
    writeRuntimeFile: false,
    env: process.env,
    dataDir: mkdtempSync(join(tmpdir(), 'local-agent-real-')),
  });
  const port = await app.listen();
  const api = `http://127.0.0.1:${port}`;
  process.stdout.write(`\n   runtime on ${api}\n\n`);

  const post = async (path, body) => {
    const response = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const createSession = async () => {
    const response = await fetch(`${api}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpdir() }),
    });
    return (await response.json()).session.id;
  };

  // 2. A plain turn over the real transport.
  {
    const sessionId = await createSession();
    const submitted = await post(`/v1/sessions/${sessionId}/messages`, { text: 'hello' });
    check('the message is accepted', submitted.status === 202, `HTTP ${submitted.status}`);

    await new Promise((resolve) => setTimeout(resolve, 900));

    const history = await (await fetch(`${api}/v1/sessions/${sessionId}/history`)).json();
    const assistant = history.messages.find((message) => message.role === 'assistant');
    const text = (assistant?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    check(
      'the streamed answer is assembled from the SSE frames',
      text === 'Hello from the local provider.',
      JSON.stringify(text),
    );
  }

  // 3. A tool call over the real transport.
  {
    const sessionId = await createSession();
    await post(`/v1/sessions/${sessionId}/messages`, { text: 'read the notes' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const history = await (await fetch(`${api}/v1/sessions/${sessionId}/history`)).json();
    const toolMessage = history.messages.find((message) => message.role === 'tool');
    check(
      'the tool call is executed and its result is in the history',
      toolMessage !== undefined,
      toolMessage === undefined ? 'no tool message' : 'tool_result present',
    );
  }

  // 4. A 429 is retried, a 401 is not.
  {
    const before = local.received.length;
    const sessionId = await createSession();
    await post(`/v1/sessions/${sessionId}/messages`, { text: 'trigger the rate limit' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const history = await (await fetch(`${api}/v1/sessions/${sessionId}/history`)).json();
    const assistant = history.messages.find((message) => message.role === 'assistant');
    const text = (assistant?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const calls = local.received.length - before;
    check(
      'a 429 is retried and the turn recovers',
      text.includes('Recovered from the rate limit'),
      `${calls} provider request(s), answer: ${JSON.stringify(text)}`,
    );
  }

  {
    const before = local.received.length;
    const sessionId = await createSession();
    await post(`/v1/sessions/${sessionId}/messages`, { text: 'trigger the auth failure' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const calls = local.received.length - before;
    check('a 401 is not retried', calls === 1, `${calls} provider request(s)`);
  }

  await app.close();
  await local.close();

  const failed = results.filter((entry) => !entry.passed);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  process.stderr.write(`the check failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
