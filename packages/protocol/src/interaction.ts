import { z } from 'zod';

/**
 * Interactive shapes: questionnaires, todo lists and goal snapshots.
 *
 * These travel over the event stream, so their contracts belong to
 * `protocol` even though the owning modules live elsewhere.
 */

export const QUESTION_TYPES = ['single', 'multi', 'text', 'boolean'] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const QuestionOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    type: QuestionTypeSchema,
    options: z.array(QuestionOptionSchema).optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
  })
  .strict();
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const QuestionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    title: z.string().min(1),
    questions: z.array(QuestionItemSchema),
  })
  .strict();
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

export const QuestionResolutionSchema = z
  .object({
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
    cancelled: z.boolean().optional(),
  })
  .strict();
export type QuestionResolution = z.infer<typeof QuestionResolutionSchema>;

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export const TodoStatusSchema = z.enum(TODO_STATUSES);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TODO_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TodoPrioritySchema = z.enum(TODO_PRIORITIES);
export type TodoPriority = z.infer<typeof TodoPrioritySchema>;

export const TodoItemSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1),
    status: TodoStatusSchema,
    priority: TodoPrioritySchema.optional(),
  })
  .strict();
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const GOAL_STATUSES = ['active', 'paused', 'blocked', 'completed', 'cleared'] as const;
export const GoalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalBudgetSchema = z
  .object({
    tokenLimit: z.number().int().positive().optional(),
    tokensUsed: z.number().int().nonnegative(),
  })
  .strict();
export type GoalBudget = z.infer<typeof GoalBudgetSchema>;

export const GoalSnapshotSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    status: GoalStatusSchema,
    acceptanceCriteria: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    workBoundary: z.array(z.string()).optional(),
    stopConditions: z.array(z.string()).optional(),
    budget: GoalBudgetSchema.optional(),
    blockedReason: z.string().optional(),
  })
  .strict();
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;
