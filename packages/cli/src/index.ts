#!/usr/bin/env node
import { RUNTIME_NAME, RUNTIME_VERSION } from '@local-agent/protocol';
import { parseArgs } from './args.js';
import { runGoal } from './commands/goal.js';
import { runHealth } from './commands/health.js';
import { runSend } from './commands/send.js';
import { runPlan } from './commands/plan.js';
import { runSessions } from './commands/sessions.js';

/**
 * @local-agent/cli
 *
 * Minimal client for the local agent runtime. It drives the runtime over
 * HTTP and never imports it in-process.
 */

const USAGE = `${RUNTIME_NAME} ${RUNTIME_VERSION}

Usage:
  local-agent health [--host <host>] [--port <port>]
  local-agent send "<message>" [--session <sessionId>] [--continue] [--host <host>] [--port <port>]
  local-agent sessions [--host <host>] [--port <port>]
  local-agent plan <enter|review|approve|reject|show> [--session <sessionId>]
  local-agent goal <show|set|status> [--session <sessionId>]
  local-agent version

Commands:
  health    Check that a runtime is reachable and print its /health payload
  send      Send a message to a session and render the turn from the event stream
            --continue  continues the most recent session instead of creating one
  sessions  List the sessions of the runtime
  plan      Drive the plan mode: enter, freeze the draft for review, approve
            or reject it
  goal      Drive the goal of a session: show it, set it, or submit a state
  version   Print the client version
`;

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));

  if (command === 'version' || flags['version'] === 'true') {
    process.stdout.write(`${RUNTIME_VERSION}\n`);
    return;
  }

  switch (command) {
    case 'health': {
      const result = await runHealth({ flags });
      process.exitCode = result.exitCode;
      return;
    }
    case 'goal': {
      const result = await runGoal({
        subcommand: positionals[0] ?? 'show',
        flags,
      });
      process.exitCode = result.exitCode;
      return;
    }
    case 'plan': {
      const result = await runPlan({
        subcommand: positionals[0] ?? 'show',
        flags,
      });
      process.exitCode = result.exitCode;
      return;
    }
    case 'sessions': {
      const result = await runSessions({ flags });
      process.exitCode = result.exitCode;
      return;
    }
    case 'send': {
      const message = flags['message'] ?? positionals[0];
      const merged = message === undefined ? flags : { ...flags, message };
      const result = await runSend({ flags: merged });
      process.exitCode = result.exitCode;
      return;
    }
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

void main();
