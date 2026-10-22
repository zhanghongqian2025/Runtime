import { describe, expect, it } from 'vitest';
import { missingAspects, parseGoal } from './parse.js';

describe('parsing a goal', () => {
  it('reads the labelled form', () => {
    const spec = parseGoal(
      [
        '目标: 让支付模块升级到新版 SDK',
        '验收: 集成测试全部通过',
        '约束: 公开 API 的行为不变',
        '边界: 只修改 src/payment 与 tests/payment',
        '停止条件: 缺少测试数据时停止并汇报',
      ].join('\n'),
    );

    expect(spec).toBeDefined();
    expect(spec?.objective).toContain('支付模块');
    expect(spec?.acceptanceCriteria).toContain('集成测试全部通过');
    expect(spec?.constraints).toContain('公开 API 的行为不变');
    expect(spec?.workBoundary.join(' ')).toContain('src/payment');
    expect(spec?.stopConditions.join(' ')).toContain('缺少测试数据时停止并汇报');
  });

  it('reads the template form of the documentation', () => {
    const spec = parseGoal(
      [
        '实现【支付模块升级到新版 SDK】，并通过【集成测试全部通过】验证。',
        '工作过程中保持【公开 API 的行为不变】。',
        '只使用或修改【src/payment 与 tests/payment】。',
        '如果出现【缺少测试数据】，停止继续尝试，并汇报已经尝试的路径、现有证据、阻塞原因以及继续工作所需的输入。',
      ].join('\n'),
    );

    expect(spec).toBeDefined();
    expect(spec?.objective).toContain('支付模块升级');
    expect(spec?.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(spec?.constraints.length).toBeGreaterThan(0);
    expect(spec?.workBoundary.length).toBeGreaterThan(0);
    expect(spec?.stopConditions.length).toBeGreaterThan(0);
  });

  it('refuses a goal without an acceptance criterion', () => {
    expect(parseGoal('目标: 让支付模块升级到新版 SDK')).toBeUndefined();
  });

  it('refuses an empty or meaningless text', () => {
    expect(parseGoal('')).toBeUndefined();
    expect(parseGoal('   \n  ')).toBeUndefined();
    expect(parseGoal('做点事情')).toBeUndefined();
  });

  it('reports what is missing', () => {
    expect(missingAspects(undefined)).toEqual(
      expect.arrayContaining(['目标（最终状态）', '验收标准（怎么算完成）']),
    );
    expect(missingAspects(parseGoal('目标: x\n验收: y'))).toEqual([]);
  });
});
