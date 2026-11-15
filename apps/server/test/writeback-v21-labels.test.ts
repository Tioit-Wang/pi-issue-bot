/**
 * `writeback/v21/labels.ts` 的单测（`docs/v21-contract.md` §5 / FR-5.4 / BR-9~BR-11 / AC-14）。
 *
 * 这里验的是**保护规则**而不是算术：差集算错会被一眼看出来，
 * 但「空集被当成清空」「超限被静默截断」「把人打的标签删了」都是上线后才炸的那一类。
 * 所以每条规则都给一个「差点就会写错」的反例。
 */
import { describe, expect, it } from 'vitest';

import type { LabelsConfig } from '../../../packages/contract/src/index.ts';
import { labelsConfigSchema } from '../../../packages/contract/src/index.ts';
import type { LabelCatalogEntry } from '../src/workflows/ports.ts';
import { planLabelWriteback } from '../src/worker/writeback.ts';
import type { CatalogEntry, LabelPlanInput } from '../src/writeback/v21/labels.ts';
import {
  deletionOwner,
  describeLabelPlan,
  isManageableCatalogEntry,
  planLabelTargetState,
} from '../src/writeback/v21/labels.ts';

/** 一条默认「可管理」的目录项；overrides 用来造四种不可管理形态。 */
function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name,
    meaning: `${name} 的含义`,
    managed: true,
    status: 'active',
    ...overrides,
  };
}

/** 常用目录：`缺陷` / `需求` 可管理，另外三条各有各的不可管理原因。 */
function catalog(): readonly CatalogEntry[] {
  return [
    entry('缺陷'),
    entry('需求'),
    entry('外部标签', { meaning: null }),
    entry('退役标签', { status: 'retired' }),
    entry('人工标签', { managed: false }),
  ];
}

function baseInput(overrides: Partial<LabelPlanInput> = {}): LabelPlanInput {
  return {
    current: [],
    desired: [],
    catalog: catalog(),
    maxPerIssue: 3,
    botLabels: [],
    ...overrides,
  };
}

describe('planLabelTargetState：空集保护与整批拒绝', () => {
  it('desired 为空且没有 clear → empty-without-clear（不删任何标签）', () => {
    const plan = planLabelTargetState(baseInput({ current: ['缺陷', '需求'] }));
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('empty-without-clear');
    expect(plan.detail).toContain('clear');
  });

  it('全空白的 desired 与空数组等价，同样拒绝', () => {
    const plan = planLabelTargetState(baseInput({ current: ['缺陷'], desired: ['  ', '\n'] }));
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('empty-without-clear');
  });

  it('clear=true 才允许表达「清空」，且只删可管理的标签', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['缺陷', '外部标签', '退役标签', '人工标签', '目录外'],
        desired: [],
        clear: true,
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(['缺陷']);
    expect(plan.skipped.map((item) => item.reason)).toEqual([
      'missing-meaning',
      'retired',
      'unmanaged',
      'not-in-catalog',
    ]);
  });

  it('desired 超过 maxPerIssue → over-limit 整批拒绝，不截断前半段', () => {
    const plan = planLabelTargetState(
      baseInput({ current: ['需求'], desired: ['缺陷', '需求', '缺陷2', '缺陷3'], maxPerIssue: 3 }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('over-limit');
    expect(plan.detail).toContain('整批拒绝');
    // ok:false 分支根本没有 add/remove 字段：语义上不可能只写一半。
    expect('add' in plan).toBe(false);
    expect('remove' in plan).toBe(false);
  });

  it('desired 里出现目录外/不可管理的标签 → unknown-label 整批拒绝', () => {
    for (const bad of ['外部标签', '退役标签', '人工标签', '根本不在目录']) {
      const plan = planLabelTargetState(baseInput({ desired: ['缺陷', bad] }));
      expect(plan.ok, `desired 含 ${bad} 应当整批拒绝`).toBe(false);
      if (plan.ok) {
        continue;
      }
      expect(plan.reason).toBe('unknown-label');
      expect(plan.detail).toContain(bad);
    }
  });
});

describe('planLabelTargetState：目标态差集与不可管理标签的保护', () => {
  it('add = desired − current，remove = current ∩ 可管理目录 − desired，且保持顺序', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['需求', '缺陷', '外部标签', '退役标签', '人工标签', '目录外'],
        desired: ['缺陷', '已确认'],
        maxPerIssue: 5,
        catalog: [...catalog(), entry('已确认')],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['已确认']);
    expect(plan.remove).toEqual(['需求']);
    // 四种不可管理标签既不删也不加，全部进 skipped（含原因）。
    expect(plan.skipped).toEqual([
      { label: '外部标签', reason: 'missing-meaning' },
      { label: '退役标签', reason: 'retired' },
      { label: '人工标签', reason: 'unmanaged' },
      { label: '目录外', reason: 'not-in-catalog' },
    ]);
  });

  it('meaning 为空 / retired / managed=false / 目录外一律不动（不删不加）', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['外部标签', '退役标签', '人工标签', '目录外'],
        desired: ['缺陷'],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['缺陷']);
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toHaveLength(4);
  });

  it('meaning 是纯空白也等价于没填，且 isManageableCatalogEntry 与之一致', () => {
    const blank = entry('空白含义', { meaning: '   ' });
    const plan = planLabelTargetState(
      baseInput({ current: ['空白含义'], desired: ['缺陷'], catalog: [...catalog(), blank] }),
    );
    expect(isManageableCatalogEntry(blank)).toBe(false);
    expect(isManageableCatalogEntry(entry('缺陷'))).toBe(true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toEqual([{ label: '空白含义', reason: 'missing-meaning' }]);
  });

  it('重复标签名去重后不超限，也不重复写', () => {
    const plan = planLabelTargetState(
      baseInput({ desired: ['缺陷', ' 缺陷 ', '需求', '需求'], maxPerIssue: 2 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['缺陷', '需求']);
    expect(plan.remove).toEqual([]);
  });
});

describe('删除归属与审计文案', () => {
  it('deletionOwner：在 botLabels 里是 bot，否则是 human', () => {
    expect(deletionOwner('缺陷', ['缺陷', '需求'])).toBe('bot');
    expect(deletionOwner('人工标签', ['缺陷'])).toBe('human');
    expect(deletionOwner('缺陷', [])).toBe('human');
  });

  it('describeLabelPlan 带上拒绝原因，以及每个删除项的 owner', () => {
    const rejected = planLabelTargetState(baseInput());
    expect(describeLabelPlan(rejected)).toContain('empty-without-clear');

    const ok = planLabelTargetState(baseInput({ current: ['需求', '缺陷'], desired: ['缺陷'] }));
    const text = describeLabelPlan(ok, { 需求: 'bot' });
    expect(text).toContain('需求(bot)');
    expect(text).toContain('不加标签');
  });
});

/**
 * FR-5.4：平台拥有删除权，**包括删除人手动打的标签**。
 *
 * 这一组用例钉住的是「`current` 从哪来」这个根因：只要 `current` 是 GitHub 实况，
 * `botLabels` 里没有的人标签照样进 `remove`；列进 `botLabels` 只是把 `owner` 记成 `bot`。
 * 反过来，若把 `current` 换成台账（旧实现），下面第一条的 `remove` 会永远是空数组。
 */
describe('FR-5.4：删除权覆盖人手动打的标签（current 来自 GitHub 实况）', () => {
  it('人打的标签（不在 botLabels 里）照样被删，且 owner 记成 human 留痕', () => {
    const plan = planLabelTargetState(
      baseInput({
        // GitHub 上实际挂着「缺陷」（我们打的）与「需求」（人打的）
        current: ['缺陷', '需求'],
        desired: ['缺陷'],
        botLabels: ['缺陷'],
      }),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.remove).toEqual(['需求']);
    expect(deletionOwner('需求', ['缺陷'])).toBe('human');
    // 只撤人那个标签，我们自己的保持不动
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('人在 GitHub 上删掉的标签会重新进 add（人工删除不构成永久否决）', () => {
    // 台账里还记着「缺陷」（`bot_labels` 未撤），但 GitHub 上已经没有了 → 必须补加
    const plan = planLabelTargetState(
      baseInput({
        current: [],
        desired: ['缺陷'],
        botLabels: ['缺陷'],
      }),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['缺陷']);
    expect(plan.remove).toEqual([]);
  });

  it('删除权不越过「不自动管理」：managed=false 的人标签照样保留', () => {
    const plan = planLabelTargetState(
      baseInput({
        // 人打的标签既有可管理的（需求），也有被显式标成不自动管理的（人工标签）
        current: ['需求', '人工标签'],
        desired: ['缺陷'],
        botLabels: [],
      }),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.remove).toEqual(['需求']);
    expect(plan.skipped).toEqual([{ label: '人工标签', reason: 'unmanaged' }]);
  });
});

/**
 * LD-2：平台**不发明标签、不反向创建**。
 *
 * 这一组盯的是「仓库里没有这个标签时到底做什么」。旧实现有一个 `labels.missing='create'`
 * 会 `POST /repos/{o}/{r}/labels` 把标签建出来（并用平台手填的 color/description），
 * 与 LD-1（颜色/描述来自 GitHub）和 LD-2（不反向创建）都相反。
 *
 * 现在：只读 `list`；缺标签一律 `missing-label`（`label_decisions` 里留痕），绝不建。
 * 存量配置里残留的 `'create'` 也必须走同一条路 —— 升级不该让老 jsonb 突然开始写仓库。
 */
describe('LD-2：缺标签时报错，不反向创建', () => {
  const labelsOf = (input: unknown): LabelsConfig => labelsConfigSchema.parse(input);
  const VOCABULARY = [
    { name: '缺陷', role: 'defect' as const, meaning: '功能不符合预期' },
    { name: '需求', role: 'requirement' as const, meaning: '新的功能或改进' },
  ];

  /** 记录调用的假目录端口：只暴露 `list`（端口已无 `create`，这里连想调都调不到）。 */
  function catalogOf(existing: readonly LabelCatalogEntry[]): {
    readonly listed: string[];
    readonly port: { list(input: { readonly repo: string }): Promise<readonly LabelCatalogEntry[]> };
  } {
    const listed: string[] = [];
    return {
      listed,
      port: {
        async list(input) {
          listed.push(input.repo);
          return existing;
        },
      },
    };
  }

  it("存量 missing='create' 也不会建标签：缺的那个记 missing-label", async () => {
    const catalog = catalogOf([{ name: '缺陷', color: 'd73a4a' }]);
    const plan = await planLabelWriteback({
      proposed: ['缺陷', '需求'],
      policy: {
        // 旧配置：明确写着 create（升级前的存量值必须仍然能解析）
        labels: labelsOf({ vocabulary: VOCABULARY, missing: 'create' }),
        catalog: catalog.port,
      },
      repo: 'acme/widgets',
      targetNumber: 42,
      dryRun: false,
    });

    // 「需求」在词表里，但仓库里没有 → 只报错，不建
    expect(plan.desired).toEqual(['缺陷']);
    expect(plan.blocked.map((item) => [item.label, item.reason])).toEqual([['需求', 'missing-label']]);
    expect(plan.warnings.join('\n')).toContain('平台不建标签');
    // 目录端口被读过一次（而且只读过 —— 端口上已经没有 create 可调）
    expect(catalog.listed).toEqual(['acme/widgets']);
  });

  it("missing='ignore' 同样留痕（不是静默丢弃）", async () => {
    const catalog = catalogOf([{ name: '缺陷' }]);
    const plan = await planLabelWriteback({
      proposed: ['缺陷', '需求'],
      policy: { labels: labelsOf({ vocabulary: VOCABULARY, missing: 'ignore' }), catalog: catalog.port },
      repo: 'acme/widgets',
      targetNumber: 42,
      dryRun: false,
    });

    expect(plan.desired).toEqual(['缺陷']);
    expect(plan.blocked.map((item) => [item.label, item.reason])).toEqual([['需求', 'missing-label']]);
  });

  it('dry-run 一次都不查仓库标签（GitHub 零副作用）', async () => {
    const catalog = catalogOf([{ name: '缺陷' }]);
    const plan = await planLabelWriteback({
      proposed: ['缺陷', '需求'],
      policy: { labels: labelsOf({ vocabulary: VOCABULARY }), catalog: catalog.port },
      repo: 'acme/widgets',
      targetNumber: 42,
      dryRun: true,
    });

    // 不判 missing：词表里的两个都保留，且一次 GET 都没发
    expect(plan.desired).toEqual(['缺陷', '需求']);
    expect(plan.blocked).toEqual([]);
    expect(catalog.listed).toEqual([]);
  });
});
