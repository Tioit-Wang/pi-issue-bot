/**
 * `bot/*` 分支回收（tech-plan §5.5 的「清理」）。
 *
 * 三条规则：
 * 1. **只碰 `bot/*`**：前缀必须在 `bot/` 之下；别的分支一律不看（plan §7.1「永不改写贡献者分支」）。
 * 2. **只删已合并的**：用 `merge-base --is-ancestor <sha> <base>` 判定。未合并的分支里
 *    有还没进主干的提交，删掉就是丢工作——跳过并给出原因，交给人决定。
 * 3. **`dryRun` 必须先跑**：批量删除不可撤销，运维应当先看一眼 `matched`。
 *
 * 判定放在**缓存仓库**（有 `origin` 的那份）上做：它永远不 checkout，所以 `fetch`
 * 与 `ls-remote` 不会踩任何任务的工作树。
 */
import { AppError } from './deps.ts';
import type { Logger } from './deps.ts';
import { assertBotBranch, deleteBotBranch } from './push.ts';
import type { RunGit } from './run-git.ts';

/** 前缀只允许出现在 `bot/` 之下，且不能含会改变 refspec 语义的字符。 */
const BOT_PREFIX_RE = /^bot\/([A-Za-z0-9._-]+\/?)*$/;

export interface BotBranchCleanupInput {
  /** 缓存仓库目录（`origin` 指向 GitHub）。 */
  readonly cwd: string;
  readonly runGit: RunGit;
  /** 只清理这个前缀下的分支（例如 `bot/task-123`），默认 `bot/`。 */
  readonly prefix?: string;
  /** 基准分支的远端引用，例如 `refs/remotes/origin/main`；缺省自动探测。 */
  readonly base?: string;
  readonly dryRun?: boolean;
  readonly remote?: string;
  readonly logger?: Logger | undefined;
}

export interface BotBranchRecord {
  readonly branch: string;
  readonly sha: string;
}

export interface SkippedBotBranch extends BotBranchRecord {
  readonly reason: 'unmerged';
  readonly detail: string;
}

export interface BotBranchCleanupResult {
  /** 前缀命中且**已合并**的分支（可以删的那一批）。 */
  readonly matched: readonly BotBranchRecord[];
  /** 真正删掉的（`dryRun` 时为空）。 */
  readonly deleted: readonly BotBranchRecord[];
  readonly skipped: readonly SkippedBotBranch[];
  readonly dryRun: boolean;
  /** 判定「已合并」用的基准引用。 */
  readonly base: string;
}

/** 解析 `git ls-remote --heads` 的输出（`<sha>\t<ref>`）。 */
export function parseLsRemote(stdout: string): BotBranchRecord[] {
  const records: BotBranchRecord[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [sha, ref] = trimmed.split('\t');
    if (sha === undefined || ref === undefined || !ref.startsWith('refs/heads/')) {
      continue;
    }
    records.push({ sha, branch: ref.slice('refs/heads/'.length) });
  }
  return records;
}

/** 探测基准引用：`origin/HEAD` → `origin/main` → `origin/master`。 */
async function detectBase(cwd: string, runGit: RunGit, remote: string): Promise<string> {
  for (const candidate of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
    const result = await runGit(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      cwd,
      allowFailure: true,
    });
    if (result.code === 0) {
      return candidate;
    }
  }
  return `refs/remotes/${remote}/HEAD`;
}

export async function cleanupBotBranches(input: BotBranchCleanupInput): Promise<BotBranchCleanupResult> {
  const remote = input.remote ?? 'origin';
  const dryRun = input.dryRun ?? false;
  const prefix = input.prefix ?? 'bot/';
  if (!BOT_PREFIX_RE.test(prefix)) {
    // 前缀是拼进 ls-remote 的 pattern 里的，字符集必须收紧（否则 `*` 会横扫全部分支）。
    throw new AppError(`回收前缀不合法：${JSON.stringify(prefix)}（只允许 bot/ 之下的安全字符）`, {
      code: 'BOT_PREFIX_INVALID',
      failureClass: 'sandbox',
      retriable: false,
      details: { prefix },
    });
  }

  // 先 fetch：判「已合并」需要对象在本地。
  await input.runGit(['fetch', '--prune', '--no-tags', '--quiet', remote, `+refs/heads/*:refs/remotes/${remote}/*`], {
    cwd: input.cwd,
    code: 'GIT_FETCH_FAILED',
  });

  const base = input.base ?? (await detectBase(input.cwd, input.runGit, remote));
  const listed = await input.runGit(['ls-remote', '--heads', remote, `refs/heads/${prefix}*`], {
    cwd: input.cwd,
    code: 'GIT_LS_REMOTE_FAILED',
  });

  const matched: BotBranchRecord[] = [];
  const deleted: BotBranchRecord[] = [];
  const skipped: SkippedBotBranch[] = [];

  for (const record of parseLsRemote(listed.stdout)) {
    if (!record.branch.startsWith(prefix)) {
      continue;
    }
    try {
      assertBotBranch(record.branch);
    } catch {
      // 命中了 `bot/` 前缀但名字不合法的分支（例如带空格）：不碰它，留给人看。
      skipped.push({ ...record, reason: 'unmerged', detail: '分支名不在 bot/* 白名单内，跳过' });
      continue;
    }

    const ancestor = await input.runGit(['merge-base', '--is-ancestor', record.sha, base], {
      cwd: input.cwd,
      allowFailure: true,
    });
    if (ancestor.code !== 0) {
      skipped.push({
        ...record,
        reason: 'unmerged',
        detail: `提交 ${record.sha.slice(0, 12)} 未合并进 ${base}（exit ${ancestor.code}），删掉会丢工作`,
      });
      continue;
    }

    matched.push(record);
    if (dryRun) {
      continue;
    }
    await deleteBotBranch({
      jobDir: input.cwd,
      branch: record.branch,
      runGit: input.runGit,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
      remote,
    });
    deleted.push(record);
  }

  input.logger?.info(
    { matched: matched.length, deleted: deleted.length, skipped: skipped.length, dryRun, base },
    dryRun ? 'bot 分支回收（dry-run：未删除任何东西）' : 'bot 分支回收完成',
  );

  return { matched, deleted, skipped, dryRun, base };
}
