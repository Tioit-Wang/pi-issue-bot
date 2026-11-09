/**
 * `nftables`：`deploy/nftables.conf` 存在 + 规则命中（tech-plan §6.2 / §6.4 第十项）。
 *
 * 两段，语义不同：
 *  1. **读文件**：规则必须以配置文件形式随仓库发布（§6.2 明确「不用代码动态生成，少一处可变面」），
 *     文件缺失说明部署面不完整 → `fail`。
 *  2. **`nft list ruleset`**：规则有没有真的加载进来。这一段的结论**只能降级**：
 *     非 root / 没有 nft 二进制 / 非 Linux（本机 Windows 就是这种情况）都无法取证，
 *     此时一律 `warn` 并附原因——把「没权限查」判成 `fail` 会让 doctor 在开发机上永远红，
 *     把「没查到」判成 `ok` 则是撒谎。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

/** 规则表名（`deploy/nftables.conf` 里 `table inet pi_jobs`）。 */
export const NFT_TABLE_NAME = 'pi_jobs';

/** 配置里必须出现的关键片段：防止「文件在但内容是空的」，也挡住「只留注释」。 */
export const NFT_REQUIRED_SNIPPETS: readonly string[] = Object.freeze(['169.254.0.0/16', 'pi_jobs']);

export const nftablesCheck: CheckDefinition = {
  id: 'nftables',
  title: 'deploy/nftables.conf 存在 + 规则已加载',
  async run(ctx) {
    let conf: string;
    try {
      conf = await ctx.fs.readFile(ctx.nftablesConf, 'utf8');
    } catch (error) {
      return {
        status: 'fail',
        detail: `${ctx.nftablesConf} 读不出来：${describeError(error)}`,
        fixHint: '规则文件必须随仓库发布（§6.2：不用代码动态生成）；从 git 恢复 deploy/nftables.conf',
      };
    }

    const lines = conf.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#')).length;
    const missing = NFT_REQUIRED_SNIPPETS.filter((snippet) => !conf.includes(snippet));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `${ctx.nftablesConf} 存在，但缺少关键片段：${missing.join('、')}（${String(lines)} 行有效内容）`,
        fixHint: `§6.2 的 DROP 段必须覆盖 169.254.0.0/16 等私网段，并在 table inet ${NFT_TABLE_NAME} 里`,
      };
    }

    const listed = await ctx.run('nft', ['list', 'ruleset'], { timeoutMs: 15_000 });
    if (listed.code !== 0) {
      const reason = listed.stderr.trim().split('\n').slice(-2).join(' / ');
      return {
        status: 'warn',
        detail:
          `规则文件存在（${String(lines)} 行有效内容、含 169.254.0.0/16 与 ${NFT_TABLE_NAME}），` +
          `但核对不了是否已加载：nft 不可用（${reason === '' ? `退 ${String(listed.code)}` : reason}）`,
        fixHint:
          '在目标 Linux 机上 `nft -c -f deploy/nftables.conf && nft -f deploy/nftables.conf`（需 root），' +
          '再重跑 doctor；Windows 开发机没有 nftables，此项恒为 warn',
      };
    }

    if (!listed.stdout.includes(NFT_TABLE_NAME)) {
      return {
        status: 'warn',
        detail: `规则文件存在，但当前 ruleset 里没有 table inet ${NFT_TABLE_NAME}（规则未加载）`,
        fixHint: `nft -f deploy/nftables.conf 之后再 \`nft list ruleset | grep ${NFT_TABLE_NAME}\` 应能看到该表`,
      };
    }

    return {
      status: 'ok',
      detail: `规则已加载：ruleset 里有 table inet ${NFT_TABLE_NAME}；配置文件 ${String(lines)} 行（含 169.254.0.0/16）`,
    };
  },
};
