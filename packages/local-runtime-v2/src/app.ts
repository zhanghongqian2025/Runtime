import { homedir } from 'node:os';
import {
  createRuntimeServer,
  createToolBinder,
  runtimeStateDir,
  type LoadedRuntimeConfig,
  type Logger,
  type ProviderAdapter,
  type RuntimeServer,
  type RuntimeServices,
  type TurnPolicy,
} from '@local-agent/local-runtime';
import { createLogger } from '@local-agent/local-runtime';
import { LOCAL_TOOLS } from '@local-agent/agent-tools';
import { createPlanBinder } from './application/plan-binder.js';
import {
  createGoalService,
  createGoalStore,
  registerGoalRoutes,
  type GoalService,
} from './application/agent/goal/index.js';
import { createPlanService, registerPlanRoutes, type PlanService } from './service/plan/index.js';

/**
 * The application.
 *
 * This is the composition root: it wires the host runtime and the
 * application layer together. The plan mode and the goal mode install
 * themselves as the turn policy, so the fence, the queue classification and
 * the automatic continuation are honoured by the loop without the loop
 * knowing anything about them.
 */

export interface ApplicationOptions {
  readonly config: LoadedRuntimeConfig;
  readonly provider?: ProviderAdapter;
  readonly dataDir?: string;
  readonly logger?: Logger;
  readonly writeRuntimeFile?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface Application {
  readonly server: RuntimeServer;
  readonly services: RuntimeServices;
  readonly plan: PlanService;
  readonly goal: GoalService;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createApplication(options: ApplicationOptions): Application {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ homeDir: homedir() });
  const dataDir = options.dataDir ?? runtimeStateDir(env);
  const firstProvider = options.config.config.providers[0];

  const server = createRuntimeServer({
    config: options.config,
    logger,
    ...(options.writeRuntimeFile === undefined
      ? {}
      : { writeRuntimeFile: options.writeRuntimeFile }),
    env,
    dataDir,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });

  const plan = createPlanService({
    sessions: server.services.sessions,
    events: server.services.events,
    turns: server.services.turns,
    dataDir,
    logger,
    planBinder: createPlanBinder(),
  });

  // The goal service needs the tools of a verification session, and those
  // tools include the goal tools: the holder breaks the cycle.
  const goalHolder: { service?: GoalService } = {};
  const toolsForVerifier = (): ReturnType<typeof createToolBinder> =>
    createToolBinder([...LOCAL_TOOLS, ...(goalHolder.service?.tools ?? [])]);

  const goal = createGoalService({
    sessions: server.services.sessions,
    events: server.services.events,
    turns: server.services.turns,
    store: createGoalStore({ dataDir }),
    logger,
    tools: server.services.tools,
    toolsForVerifier,
    cwd: process.cwd(),
    providerId: firstProvider?.id ?? 'openai-compatible',
    model: firstProvider?.model ?? 'unknown',
  });
  goalHolder.service = goal;

  // The goal tools join the sessions; the verification session sees them too,
  // and they refuse to work there.
  server.setExtraTools(goal.tools);

  // The permission core only approves what it knows: the tools of the host
  // are registered with their risk.
  for (const tool of goal.tools) {
    server.services.turns.registerPermissionTool(
      tool.definition.name,
      tool.definition.risk ?? 'none',
    );
  }
  for (const tool of createPlanBinder().list()) {
    server.services.turns.registerPermissionTool(
      tool.definition.name,
      tool.definition.risk ?? 'none',
    );
  }

  // The composite policy: the plan mode owns the fence, the goal mode owns
  // the continuation. The most restrictive answer wins.
  const policy: TurnPolicy = {
    classify(item) {
      const fromPlan = plan.classify(item);
      const fromGoal = goal.classify(item);
      if (fromPlan === 'cancel' || fromGoal === 'cancel') return 'cancel';
      if (fromPlan === 'defer' || fromGoal === 'defer') return 'defer';
      return 'run';
    },
    async prepareTurn(sessionId, turnId) {
      const fromPlan = (await plan.prepareTurn?.(sessionId, turnId)) ?? [];
      const parts = [...fromPlan];
      return parts.length > 0 ? parts : undefined;
    },
    binderForTurn(sessionId, turnId) {
      return (
        plan.binderForTurn?.(sessionId, turnId) ?? goal.binderForTurn?.(sessionId, turnId)
      );
    },
    async afterTurn(sessionId, turnId, outcome) {
      await plan.afterTurn?.(sessionId, turnId, outcome);
      await goal.afterTurn(sessionId, turnId, outcome);
    },
  };

  server.setPolicy(policy);
  server.setExtraRoutes((router) => {
    registerPlanRoutes(router, plan);
    registerGoalRoutes(router, goal);
  });

  return {
    server,
    services: server.services,
    plan,
    goal,
    async listen(port?: number): Promise<number> {
      return server.listen(port);
    },
    async close(): Promise<void> {
      await server.close();
    },
  };
}
