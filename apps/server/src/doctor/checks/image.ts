/**
 * `image`：worker 镜像存在 + 工具链版本匹配（tech-plan §6.4 第三项）。
 *
 * 两段，都是真跑：
 *  1. `docker image inspect`：镜像在不在，并读它自带的两个 label
 *     （`pi-bot.toolchain`、`pi-bot.uid`，由 `images/node22.Dockerfile` 写入）。
 *  2. `docker run --rm <img> node -v`：**真的在容器里问一句** Node 版本。
 *     「镜像 tag 叫 node22」不等于「里面的 node 是 22」——tag 是手工打的，label 也是；
 *     只有跑出来的 `vX.Y.Z` 是证据。三者对不上就是 `fail`，因为这会直接改变
 *     agent 生成的命令能不能跑（tech-plan §6.1 的镜像分档）。
 *
 * 故意不做的事：不自动 `docker build`。预检只报告，不动生产镜像（少一处可变面）。
 */
import type { CheckDefinition, CommandResult } from '../deps.ts';

/** 从 `node22` / `21` 这类 label 里抠出主版本号。 */
export function majorFromToolchainLabel(label: string): number | undefined {
  const matched = /(\d+)/.exec(label);
  if (matched === null) {
    return undefined;
  }
  const major = Number.parseInt(matched[1] ?? '', 10);
  return Number.isFinite(major) ? major : undefined;
}

/** 从 `v22.23.4` 里抠出主版本号。 */
export function majorFromNodeVersion(version: string): number | undefined {
  const matched = /^v?(\d+)\./i.exec(version.trim());
  if (matched === null) {
    return undefined;
  }
  const major = Number.parseInt(matched[1] ?? '', 10);
  return Number.isFinite(major) ? major : undefined;
}

/** `inspect --format` 的输出：`toolchain|uid|User`。 */
export function parseImageInspect(stdout: string): {
  readonly toolchain: string;
  readonly uid: string;
  readonly user: string;
} {
  const [toolchain = '', uid = '', user = ''] = stdout.trim().split('|');
  return { toolchain: toolchain.trim(), uid: uid.trim(), user: user.trim() };
}

function tail(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter((line) => line.trim() !== '');
  return text.slice(-3).join(' / ');
}

export const imageCheck: CheckDefinition = {
  id: 'image',
  title: 'worker 镜像存在且工具链版本匹配',
  async run(ctx) {
    const image = ctx.image;
    const inspected = await ctx.run(
      'docker',
      ['image', 'inspect', '--format', '{{index .Config.Labels "pi-bot.toolchain"}}|{{index .Config.Labels "pi-bot.uid"}}|{{.Config.User}}', image],
      { timeoutMs: 20_000 },
    );
    if (inspected.code !== 0) {
      return {
        status: 'fail',
        detail: `镜像 ${image} 不存在（docker image inspect 退 ${String(inspected.code)}：${tail(inspected)}）`,
        fixHint: `docker build -t ${image} -f images/node22.Dockerfile images（§6.1 的三档镜像按需构建）`,
      };
    }
    const labels = parseImageInspect(inspected.stdout);

    const ran = await ctx.run('docker', ['run', '--rm', image, 'node', '-v'], { timeoutMs: 60_000 });
    if (ran.code !== 0) {
      return {
        status: 'fail',
        detail: `镜像 ${image} 在容器里跑不起来：docker run … node -v 退 ${String(ran.code)}（${tail(ran)}）`,
        fixHint: '镜像可能损坏或缺少 node：重新 build，并确认不是「同名 tag 指向别的基础镜像」',
      };
    }
    const nodeVersion = ran.stdout.trim();
    const actualMajor = majorFromNodeVersion(nodeVersion);
    const expectedMajor = labels.toolchain === '' ? undefined : majorFromToolchainLabel(labels.toolchain);

    if (actualMajor === undefined) {
      return {
        status: 'fail',
        detail: `容器内 node -v 输出无法解析：${JSON.stringify(nodeVersion)}`,
        fixHint: '镜像是 worker 运行时，必须带可用的 node；检查 Dockerfile 的 FROM 与 PATH',
      };
    }

    // label 缺失 → 无法证明「tag 与内容一致」，但 node 确实能跑：warn（不 fail，避免只因缺 label 挡住启动）
    if (expectedMajor === undefined) {
      return {
        status: 'warn',
        detail: `镜像 ${image} 存在，容器内 node ${nodeVersion}；但缺少 pi-bot.toolchain label，无法核对 tag 与内容是否一致`,
        fixHint: '镜像按 images/node22.Dockerfile 的 LABEL 段构建（pi-bot.toolchain / pi-bot.uid）',
      };
    }

    if (expectedMajor !== actualMajor) {
      return {
        status: 'fail',
        detail: `工具链不匹配：label toolchain=${labels.toolchain}（期望 node${String(expectedMajor)}），容器内实际 ${nodeVersion}`,
        fixHint: `重打镜像（tag 与内容必须一致）：docker build -t ${image} -f images/node22.Dockerfile images`,
      };
    }

    const uidNote =
      labels.uid === '' || labels.user === ''
        ? '；uid label 缺失'
        : `；User=${labels.user}（期望 1001:1001）`;
    return {
      status: 'ok',
      detail: `镜像 ${image} 存在；容器内 node ${nodeVersion} 与 label toolchain=${labels.toolchain} 匹配${uidNote}`,
    };
  },
};
