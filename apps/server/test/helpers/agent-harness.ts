/**
 * agent 运行时（S1）的集成夹具：真 PG + 真 `handleWebhook` + 真 `agent/dispatcher.ts`。
 *
 * 与 `e2e-harness.ts` 的分工：那个夹具装配**整台应用**（假 RACP host + 假 docker）；
 * 这里只到「投递 → 消息 → 任务」这一步，用最小的假实现把 `userland` 端口换掉，
 * 于是 E-01 / L-07 / C-10 这类「投递规则」用例不必起容器也不需要 RACP。
 */
import { createNullLogger } from '../../../../packages/shared/src/index.ts';
import { dispatchNextForIssue } from '../../src/agent/index.ts';
import type { WebhookAck, WebhookDeps } from '../../src/http/index.ts';
import { validSettingsJson } from './repo-settings.ts';
import type { TestDb } from './queries-db.ts';

/** 夹具用的仓库与管理员（与 `repo-settings.ts::TEST_MANAGER` 一致）。 */
export const AGENT_REPO = 'acme/widgets';
export const AGENT_MANAGER = 'alice';
/** 触发别名（部署默认里也有 `pi-bot`，这里显式给一份，避免依赖部署配置）。 */
export const AGENT_ALIASES = ['pi-bot'];

export type AgentSent = { readonly taskId: string; readonly repo: string; readonly command: string };

export type AgentHarness = {
  readonly deps: WebhookDeps;
  /** 投进 `run-task` 的载荷（按投递顺序） */
  readonly sent: AgentSent[];
  /** eyes reaction（评论级回执） */
  readonly reactions: Array<{ repo: string; issueNumber: number; commentId: number | null }>;
  /** 非管理员的「无权限」回复 */
  readonly deniedReplies: Array<{ repo: string; issueNumber: number; actorLogin: string; text: string }>;
};

/**
 * 只清**本切片会写**的表。
 *
 * 为什么不用 `db.truncate()`：整库清空会擦掉并行跑的其它文件的 `host_credentials`
 * （`runtime-credentials-pg.test.ts` 不走 advisory lock，见 `queries-db.ts` 的约定 2）。
 */
export async function resetAgentTables(db: TestDb): Promise<void> {
  await db.pool.query(
    `truncate table
       agent_sessions, agent_messages, agent_denials,
       tasks, runs, run_events, envelopes, actions, usage_costs,
       issue_feedback, bot_labels, label_decisions,
       webhook_deliveries, repos, runtime_flags
     cascade`,
  );
}

/** 写一行可用的 `repos`（`agent.managers` 默认 `[alice]`）。 */
export async function seedAgentRepo(
  db: TestDb,
  options: {
    readonly repo?: string;
    readonly dryRun?: boolean;
    readonly enabled?: boolean;
    readonly managers?: readonly string[];
    readonly agent?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const repo = options.repo ?? AGENT_REPO;
  const settings = validSettingsJson({
    agent: {
      managers: [...(options.managers ?? [AGENT_MANAGER])],
      ...(options.agent ?? {}),
    },
  });
  await db.pool.query(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, $2, $3, $4::jsonb, true)
     on conflict (repo_full_name) do update set
       enabled = excluded.enabled,
       dry_run = excluded.dry_run,
       settings = excluded.settings,
       settings_valid = true`,
    [repo, options.enabled ?? true, options.dryRun ?? false, settings],
  );
}

/** 造一组 `WebhookDeps`：真库 + 假入队/假回执 + **真** dispatcher。 */
export function agentHarness(
  db: TestDb,
  options: {
    readonly verify?: boolean;
    readonly skills?: readonly string[];
    readonly aliases?: readonly string[];
  } = {},
): AgentHarness {
  const sent: AgentSent[] = [];
  const reactions: AgentHarness['reactions'] = [];
  const deniedReplies: AgentHarness['deniedReplies'] = [];
  const aliases = options.aliases ?? AGENT_ALIASES;

  const ack: WebhookAck = {
    async addEyesReaction(input) {
      reactions.push({
        repo: input.repo,
        issueNumber: input.issueNumber,
        commentId: input.commentId ?? null,
      });
    },
  };

  const deps: WebhookDeps = {
    verify: async (input) => (options.verify ?? true) && input.signature === 'good-signature',
    db: db.pool,
    enqueue: async (data) => {
      sent.push({ taskId: data.taskId, repo: data.repo, command: data.command });
      return `job-${String(sent.length)}`;
    },
    ack,
    logger: createNullLogger(),
    aliases,
    replyDenied: async (input) => {
      deniedReplies.push({
        repo: input.repo,
        issueNumber: input.issueNumber,
        actorLogin: input.actorLogin,
        text: input.text,
      });
    },
    ...(options.skills === undefined ? {} : { listSkills: async () => options.skills ?? [] }),
    /**
     * 用**真** dispatcher 投递：于是「消息落库后立刻领一条 + 建 tasks + 投 run-task」这条链路
     * 在用例里也是真的（只是把 boss.send 换成记账）。
     */
    dispatchAgent: (key) =>
      dispatchNextForIssue(
        {
          db: db.pool,
          enqueue: async ({ taskId, repo, command }) => {
            sent.push({ taskId, repo, command });
            return `job-${String(sent.length)}`;
          },
        },
        key,
      ),
  };

  return { deps, sent, reactions, deniedReplies };
}

/** `issues.*` 载荷。 */
export function issuesPayload(input: {
  readonly action: string;
  readonly number?: number;
  readonly updatedAt?: string;
  readonly title?: string;
  readonly body?: string;
  readonly repo?: string;
  readonly sender?: { login: string; type: string };
  readonly changes?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    action: input.action,
    repository: { full_name: input.repo ?? AGENT_REPO },
    sender: input.sender ?? { login: AGENT_MANAGER, type: 'User' },
    issue: {
      number: input.number ?? 7,
      updated_at: input.updatedAt ?? '2026-06-01T00:00:00Z',
      title: input.title ?? '登录按钮没反应',
      body: input.body ?? '复现步骤：点一下登录',
      author_association: 'OWNER',
    },
    ...(input.changes === undefined ? {} : { changes: input.changes }),
  };
}

/** `issue_comment.created` 载荷。 */
export function commentPayload(input: {
  readonly body: string;
  readonly number?: number;
  readonly commentId?: number;
  readonly login?: string;
  readonly type?: string;
  readonly updatedAt?: string;
  readonly repo?: string;
}): Record<string, unknown> {
  const login = input.login ?? AGENT_MANAGER;
  return {
    action: 'created',
    repository: { full_name: input.repo ?? AGENT_REPO },
    sender: { login, type: input.type ?? 'User' },
    issue: {
      number: input.number ?? 7,
      updated_at: input.updatedAt ?? '2026-06-01T00:00:00Z',
      title: '登录按钮没反应',
      body: '复现步骤：点一下登录',
      author_association: 'OWNER',
    },
    comment: {
      id: input.commentId ?? 555,
      body: input.body,
      author_association: 'OWNER',
      user: { login, type: input.type ?? 'User' },
    },
  };
}
