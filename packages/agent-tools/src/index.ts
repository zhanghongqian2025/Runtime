import type { ToolImpl } from '@local-agent/agent-core/tools';
import { applyPatchTool } from './apply-patch.js';
import { askUserTool } from './ask-user.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { todoWriteTool } from './todo-write.js';
import { writeTool } from './write.js';

/**
 * @local-agent/agent-tools
 *
 * The local tool implementations. Each tool is a separate, named capability:
 * the model never gets one universal shell in place of them.
 */
export * from './apply-patch.js';
export * from './ask-user.js';
export * from './bash.js';
export * from './edit.js';
export * from './glob.js';
export * from './grep.js';
export * from './paths.js';
export * from './read.js';
export * from './result.js';
export * from './todo-write.js';
export * from './truncate.js';
export * from './walk.js';
export * from './write.js';

/** Every local tool, in the order the model sees them. */
export const LOCAL_TOOLS: readonly ToolImpl[] = [
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  bashTool,
  grepTool,
  globTool,
  todoWriteTool,
  askUserTool,
];
