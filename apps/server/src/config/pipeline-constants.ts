/**
 * 固定流水线的**全部阈值**（`docs/plan-fixed-pipeline.md` §1.5 Q2 / §4.5 / §9 / §10.1）。
 *
 * 为什么不做成 `repos.settings` 里的项目配置：Q2 定案把「超时 / 重跑上限 / 并发 / 容器策略」一律收为
 * **系统级常量**，改动走发布；项目级可配项只剩 3 类（4 条提示词版本线、`managers`、
 * `labels.vocabulary[].role`）。把 48h 与 5 次放进面板，等于让每个仓库各有一套「关不关 issue」的规则，
 * 出问题时无法复现。面板对这些值**只读展示**，不提供编辑入口。
 *
 * 为什么要「可注入」：`closeAfterHours=48` 与 `formatMaxFails=5` 在单测里没法真的等 48 小时、
 * 也没人愿意跑 5 轮失败（V12 / V19 明确要求注入 `0.01` 小时与 `2` 次）。
 * 所以这里给出 `createPipelineLimits(overrides)` —— **纯函数**，不读 env、不连库、无副作用；
 * 生产代码直接用 `PIPELINE_LIMITS`，测试与作业实现接受注入的 `PipelineLimits`。
 *
 * 命名的双份是有意的：
 *  - `PIPELINE_CLOSE_AFTER_HOURS` 这类**单个常量**方便调用点一眼看懂「这个 48 是哪来的」；
 *  - `PIPELINE_LIMITS` 是**同一个值的聚合**，便于整体注入（作业签名里只需一个参数）。
 * 两者不是两份数据：单个常量全部从聚合里取，改值只改一处。
 */

/**
 * 聚合常量。数字全部写成 `as number`：默认值不是类型（`0.01` 与 `2` 是合法的注入值），
 * 若用 `as const` 把 `48` 收成字面量类型，`createPipelineLimits({ closeAfterHours: 0.01 })` 会编译不过。
 * `Object.freeze` 只保证运行期不被顺手改，不代替注入。
 */
export const PIPELINE_LIMITS = Object.freeze({
  /** `awaiting_info`（等用户补充）满多少小时自动关 issue（D5 / §9）。0.01 = 36 秒，给单测用 */
  closeAfterHours: 48 as number,
  /**
   * 格式**不通过**累计多少次即自动关 issue（Q5 / §5）。
   * 注意是「失败次数」，不是「重跑次数」：通过不计数，重跑本身不限次。
   */
  formatMaxFails: 5 as number,
  /**
   * 同一阶段两次重跑之间的最小间隔（§16.2 第 3 条）。
   * 只挡 `issues.edited` 触发的重跑；**评论补充优先**，不受这条冷却约束。
   */
  recheckCooldownSeconds: 120 as number,
  /** 门禁回执（`pipeline:notice`）每个 issue 的限速间隔：每小时 1 条（§8 / Q8） */
  gateNoticeIntervalSeconds: 3600 as number,
  /** 阶段 2 会话轮换：轮数达到即 archive + 新建会话（§7） */
  sessionMaxTurns: 30 as number,
  /** 阶段 2 会话轮换：会话存活超过多少天即轮换（§7） */
  sessionMaxAgeDays: 7 as number,
  /** `tasks.target_supplement` 只保留最近几条补充评论（§16.2 第 2 条） */
  supplementMaxItems: 3 as number,
  /** 每条补充评论截断到多少字符（§16.2 第 2 条） */
  supplementItemMaxChars: 1000 as number,
  /**
   * `tasks.target_body` 入队时的截断长度（§4.2）。
   * 比进提示词的 4000 大一倍：正文快照多留一点，后续阶段（如分类要看证据）才有余地。
   */
  targetBodyMaxChars: 8000 as number,
  /** 分类阶段（sandboxed）的执行闸：超过即按 `timed-out` 处理（§6 / §13「30min 闸」） */
  classifyMaxMinutes: 30 as number,
  /**
   * `queue.expireInSeconds`：按命令前缀取（§4.6 / §10.6）。
   * format 必须比 notice 长（要读正文再判定），classify 要起容器装依赖所以最长。
   */
  commandExpireSeconds: Object.freeze({
    format: 600 as number,
    classify: 1800 as number,
    notice: 300 as number,
  }),
});

/** `createPipelineLimits()` 的返回值形状；作业与流程层按它接注入。 */
export type PipelineLimits = typeof PIPELINE_LIMITS;


/** `awaiting_info` 满多少小时自动关 issue（D5）。 */
export const PIPELINE_CLOSE_AFTER_HOURS: number = PIPELINE_LIMITS.closeAfterHours;

/** 格式不通过累计上限（Q5）：`>=` 即关，第 5 次不通过就是最后一次反馈。 */
export const PIPELINE_FORMAT_MAX_FAILS: number = PIPELINE_LIMITS.formatMaxFails;

/** 重跑冷却（秒）：只作用于 `issues.edited`，评论触发的重跑优先级更高。 */
export const PIPELINE_RECHECK_COOLDOWN_SECONDS: number = PIPELINE_LIMITS.recheckCooldownSeconds;

/** 门禁回执限速（秒）：每 issue 每小时 1 条。 */
export const PIPELINE_GATE_NOTICE_INTERVAL_SECONDS: number = PIPELINE_LIMITS.gateNoticeIntervalSeconds;

/** 会话最大轮数：达到即轮换（`session_turns >= 30`）。 */
export const PIPELINE_SESSION_MAX_TURNS: number = PIPELINE_LIMITS.sessionMaxTurns;

/** 会话最大存活天数：超过即轮换。 */
export const PIPELINE_SESSION_MAX_AGE_DAYS: number = PIPELINE_LIMITS.sessionMaxAgeDays;

/** 补充评论保留条数。 */
export const PIPELINE_SUPPLEMENT_MAX_ITEMS: number = PIPELINE_LIMITS.supplementMaxItems;

/** 补充评论单条截断长度。 */
export const PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS: number = PIPELINE_LIMITS.supplementItemMaxChars;

/** `tasks.target_body` 快照截断长度。 */
export const PIPELINE_TARGET_BODY_MAX_CHARS: number = PIPELINE_LIMITS.targetBodyMaxChars;

/** 分类阶段执行闸（分钟）。 */
export const PIPELINE_CLASSIFY_MAX_MINUTES: number = PIPELINE_LIMITS.classifyMaxMinutes;

/** `queue.expireInSeconds` 的三档（`pipeline:format|classify|notice`）。 */
export const PIPELINE_COMMAND_EXPIRE_SECONDS = PIPELINE_LIMITS.commandExpireSeconds;

/** `pipeline:<stage>` 里的阶段名；`notice` 是门禁回执，不是流水线阶段。 */
export type PipelineCommandStage = keyof typeof PIPELINE_COMMAND_EXPIRE_SECONDS;

/** `pipeline-close` 定时作业的 cron：每 10 分钟（§9）。与 `queue/definitions.ts` 的 `SCHEDULES` 同源。 */
export const JOB_PIPELINE_CLOSE_SCHEDULE = '*/10 * * * *';

/**
 * 造一份可注入的阈值（**纯函数**：不读 env、不连库、不改入参）。
 *
 * 生产代码用默认的 `PIPELINE_LIMITS`；单测常写
 * `createPipelineLimits({ closeAfterHours: 0.01, formatMaxFails: 2 })`（V12 / V19）。
 * `commandExpireSeconds` 是唯一的嵌套对象，这里做浅合并而不是整体替换，
 * 免得注入一档时另外两档变 `undefined` 把 `expireIn` 拖坏。
 */
export function createPipelineLimits(overrides: Partial<PipelineLimits> = {}): PipelineLimits {
  const commandExpireSeconds = Object.freeze({
    ...PIPELINE_LIMITS.commandExpireSeconds,
    ...overrides.commandExpireSeconds,
  });
  return Object.freeze({ ...PIPELINE_LIMITS, ...overrides, commandExpireSeconds });
}
