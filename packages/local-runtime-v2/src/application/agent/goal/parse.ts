import type { GoalSpec } from './types.js';

/**
 * Goal text parsing.
 *
 * The parser is a **pure function**: it either extracts the structure of a
 * goal or it returns `undefined`. It never guesses: a goal without a checkable
 * end state is not a goal, and the service asks the user to complete it.
 *
 * Two shapes are understood:
 *
 * 1. the labelled form — `目标: …`, `验收: …`, `约束: …`, `边界: …`, `停止条件: …`;
 * 2. the template form of the official documentation — a sentence per aspect.
 */

/** The labelled sections, in Chinese and in English. */
const LABELS = {
  objective: ['目标', '目的', '最终状态', '验收标准', 'objective', 'goal'],
  acceptance: ['验收', '验收标准', '验证', '完成标准', 'acceptance', 'verification'],
  constraints: ['约束', '保持', '不能退步', 'constraint', 'constraints'],
  boundary: ['边界', '范围', '只使用', '允许修改', 'boundary', 'scope'],
  stop: ['停止条件', '阻塞条件', '停止', 'stop condition', 'stopping'],
} as const;

type SectionKey = keyof typeof LABELS;

const LABEL_TO_KEY = new Map<string, SectionKey>();
for (const [key, labels] of Object.entries(LABELS) as [SectionKey, readonly string[]][]) {
  for (const label of labels) {
    LABEL_TO_KEY.set(label.toLowerCase(), key);
  }
}

/** Split the text into lines that carry content. */
const contentLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** Does the line start with one of the labels? */
const labelOf = (line: string): { key: SectionKey; value: string } | undefined => {
  const match = /^([A-Za-z一-鿿][A-Za-z一-鿿\s]{0,11})[:：]\s*(.*)$/.exec(line);
  if (!match) return undefined;
  const label = (match[1] ?? '').trim().toLowerCase();
  const key = LABEL_TO_KEY.get(label);
  if (key === undefined) return undefined;
  return { key, value: (match[2] ?? '').trim() };
};

/** Split a value into its items (bullets or sentences). */
const items = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0);

/**
 * The template form.
 *
 * The official documentation suggests one sentence per aspect; the parser
 * recognises the leading phrase of each sentence.
 */
const TEMPLATE_PATTERNS: readonly { key: SectionKey; pattern: RegExp }[] = [
  { key: 'objective', pattern: /^(实现|完成|达到|make it so|implement)\s*/i },
  { key: 'acceptance', pattern: /.*(并通过|并验证|通过.*验证|verified by|validated by)/i },
  { key: 'constraints', pattern: /^(工作过程中保持|保持|不得|必须保持|keep)\s*/i },
  { key: 'boundary', pattern: /^(只使用或修改|只使用|仅使用|只允许|limit the scope)/i },
  { key: 'stop', pattern: /^(如果出现|若出现|当出现|if .*block)/i },
];

/**
 * Parse a goal text.
 *
 * Returns `undefined` when the text does not carry an objective **and** a
 * checkable acceptance criterion: the caller must then ask the user.
 */
export function parseGoal(text: string): GoalSpec | undefined {
  const lines = contentLines(text);
  if (lines.length === 0) return undefined;

  const buckets = new Map<SectionKey, string[]>();

  const push = (key: SectionKey, value: string): void => {
    if (value.length === 0) return;
    const bucket = buckets.get(key) ?? [];
    bucket.push(value);
    buckets.set(key, bucket);
  };

  // 1. The labelled form.
  let current: SectionKey | undefined;
  for (const line of lines) {
    const labelled = labelOf(line);
    if (labelled !== undefined) {
      current = labelled.key;
      push(current, labelled.value);
      continue;
    }
    if (current !== undefined) {
      push(current, line);
      continue;
    }
    // 2. The template form: a sentence that starts with a known phrase.
    //    One sentence can carry two aspects (the objective and the way it is
    //    verified live in the same sentence), so every match counts.
    let matched = false;
    for (const { key, pattern } of TEMPLATE_PATTERNS) {
      if (pattern.test(line)) {
        push(key, line);
        matched = true;
      }
    }
    if (matched) current = undefined;
  }

  const objective = (buckets.get('objective') ?? []).join(' ').trim();
  const acceptance = buckets.get('acceptance') ?? [];
  const constraints = buckets.get('constraints') ?? [];
  const boundary = buckets.get('boundary') ?? [];
  const stop = buckets.get('stop') ?? [];

  if (objective.length === 0) return undefined;
  if (acceptance.length === 0) return undefined;

  return {
    objective,
    acceptanceCriteria: acceptance.flatMap((entry) => items(entry)).filter((entry) => entry.length > 0),
    constraints: constraints.flatMap((entry) => items(entry)).filter((entry) => entry.length > 0),
    workBoundary: boundary.flatMap((entry) => items(entry)).filter((entry) => entry.length > 0),
    stopConditions: stop.flatMap((entry) => items(entry)).filter((entry) => entry.length > 0),
  };
}

/** The aspects a goal text is missing. */
export function missingAspects(spec: GoalSpec | undefined): readonly string[] {
  const missing: string[] = [];
  if (spec === undefined || spec.objective.length === 0) missing.push('目标（最终状态）');
  if (spec === undefined || spec.acceptanceCriteria.length === 0) missing.push('验收标准（怎么算完成）');
  return missing;
}
