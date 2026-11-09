/**
 * `canary-network`：金丝雀容器**必须出不去内网**（tech-plan §6.2 / §6.4，plan §8.2 / §8.5）。
 *
 * 语义必须分成两半，缺一半就没意义：
 *  - **内网与元数据目标必须失败**：`169.254.169.254`（云元数据）、`10.0.0.1`、`172.16.0.1`
 *    （§6.2 的 DROP 段）。能连上就说明出口策略没生效——容器可以当跳板扫内网，
 *    或者直接拿宿主/云的身份，这是 plan §8.4 红线 1 的另一种形式。
 *  - **公网 DNS 必须成功**：装依赖要公网。如果连公网也断，那是把沙箱做成了「什么都干不了」，
 *    同样 `fail`——只有「内网断、公网通」才是 §6.2 想要的那个形状。
 *
 * 所以这里既不是「能出去就通过」也不是「出不去就通过」，而是一次**双向断言**。
 * 探针只在容器里跑（真的 `docker run`），宿主上的网络策略与容器无关。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition, CommandResult } from '../deps.ts';
/** 探针脚本：容器内 Node 跑，输出一行 JSON。单行写完，避免缩进/引号在 CLI 里被折。 */
const PROBE_SCRIPT = [
  "const net = require('node:net');",
  "const dns = require('node:dns');",
  'const probe = (host, port) => new Promise((resolve) => {',
  '  const socket = net.connect({ host, port });',
  '  let done = false;',
  '  const finish = (value) => { if (done) { return; } done = true; socket.destroy(); resolve(value); };',
  "  socket.setTimeout(2000, () => finish('timeout'));",
  "  socket.on('connect', () => finish('ok'));",
  "  socket.on('error', (error) => finish('error:' + (error.code || error.message)));",
  '});',
  "const resolveDns = (host) => new Promise((resolve) => dns.resolve4(host, (error, addresses) => resolve(error ? 'error:' + (error.code || error.message) : 'ok:' + ((addresses && addresses[0]) || ''))));",
  'Promise.all([',
  "  probe('169.254.169.254', 80).then((value) => ['169.254.169.254', value]),",
  "  probe('10.0.0.1', 80).then((value) => ['10.0.0.1', value]),",
  "  probe('172.16.0.1', 80).then((value) => ['172.16.0.1', value]),",
  "  resolveDns('registry.npmjs.org').then((value) => ['dns', value]),",
  ']).then((pairs) => { process.stdout.write(JSON.stringify(Object.fromEntries(pairs)) + String.fromCharCode(10)); });',
].join('\n');

/** 必须**不可达**的目标（§6.2 的 DROP 段代表）。 */
export const BLOCKED_PROBES: readonly string[] = Object.freeze(['169.254.169.254', '10.0.0.1', '172.16.0.1']);

/** 从探针输出里取出结果表：容忍容器 stdout 里的杂行（取最后一行可解析的 JSON）。 */
export function parseProbeOutput(stdout: string): Record<string, string> | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  const last = lines.at(-1);
  if (last === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]);
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

/**
 * 纯判定：给定探针结果，给出三态结论。抽出来是为了让「fail 的两种方向」都能被单测打中，
 * 而不用真去改宿主网络。
 */
export function judgeProbes(results: Record<string, string>): {
  readonly status: 'ok' | 'fail';
  readonly reachable: readonly string[];
  readonly blocked: readonly string[];
  readonly dns: string;
} {
  const reachable: string[] = [];
  const blocked: string[] = [];
  for (const host of BLOCKED_PROBES) {
    const value = results[host] ?? 'missing';
    if (value === 'ok') {
      reachable.push(host);
    } else {
      blocked.push(`${host}=${value}`);
    }
  }
  const dns = results['dns'] ?? 'missing';
  const dnsOk = dns.startsWith('ok:');
  return {
    status: reachable.length === 0 && dnsOk ? 'ok' : 'fail',
    reachable,
    blocked,
    dns,
  };
}

function tail(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  return lines.slice(-3).join(' / ');
}

export const canaryNetworkCheck: CheckDefinition = {
  id: 'canary-network',
  title: '金丝雀容器出不去内网、能出公网',
  async run(ctx) {
    const network = ctx.network;
    const networkInfo = await ctx.run('docker', ['network', 'inspect', '--format', '{{.Driver}}', network], {
      timeoutMs: 20_000,
    });
    if (networkInfo.code !== 0) {
      // 网络不存在 = 没法验证出口策略。这不是「通过」，也不该算「环境坏了」：
      // 按 §6.2 建网 + apply nftables 之前，机器本来就跑不了任务容器。
      return {
        status: 'warn',
        detail: `网络 ${network} 不存在（docker network inspect 退 ${String(networkInfo.code)}：${tail(networkInfo.stderr)}），跳过金丝雀探针`,
        fixHint: `按 deploy/docker-network.md 建网（docker network create ${network}），并在 Linux 目标机 apply deploy/nftables.conf`,
      };
    }

    const args = [
      'run',
      '--rm',
      '--network',
      network,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=32m,noexec,nosuid',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '256m',
      '--cpus',
      '1',
      ctx.image,
      'node',
      '-e',
      PROBE_SCRIPT,
    ];

    let result: CommandResult;
    try {
      result = await ctx.run('docker', args, { timeoutMs: 120_000 });
    } catch (error) {
      return {
        status: 'fail',
        detail: `金丝雀容器没跑起来：${describeError(error)}`,
        fixHint: '先看 docker / image 两项；镜像缺失时金丝雀无从验证',
      };
    }
    if (result.code !== 0) {
      return {
        status: 'fail',
        detail: `金丝雀容器退出码 ${String(result.code)}（${tail(result.stderr) || tail(result.stdout)}）`,
        fixHint: `确认镜像 ${ctx.image} 里有 node，且网络 ${network} 可用（deploy/docker-network.md）`,
      };
    }

    const probes = parseProbeOutput(result.stdout);
    if (probes === undefined) {
      return {
        status: 'fail',
        detail: `金丝雀输出无法解析：${JSON.stringify(result.stdout.slice(0, 200))}`,
        fixHint: '探针脚本被改了？见 checks/canary-network.ts 的 PROBE_SCRIPT',
      };
    }

    const verdict = judgeProbes(probes);
    if (verdict.reachable.length > 0) {
      return {
        status: 'fail',
        detail:
          `内网/元数据目标**可达**：${verdict.reachable.join('、')}（已阻断：${verdict.blocked.join('、') || '无'}；` +
          `公网 DNS=${verdict.dns}）`,
        fixHint:
          '出口策略未生效：在目标 Linux 机 apply deploy/nftables.conf（§6.2 的 DROP 段），' +
          '并确认容器跑在 pi-jobs 网桥上；Windows 开发机没有 nftables，此项必然 fail。' +
          '若本机有 VPN / 透明代理 TUN（任意 TCP 连接都被代理接受），也会表现为「内网可达」——' +
          '那同样意味着这条策略在宿主层没有生效',
      };
    }
    if (!verdict.dns.startsWith('ok:')) {
      return {
        status: 'fail',
        detail: `内网已阻断，但公网 DNS 解析失败（dns=${verdict.dns}）：沙箱连依赖都装不了`,
        fixHint: '检查上游 DNS 与公网出口（§6.2：pi-jobs 不是 internal 网络，必须能出公网）',
      };
    }
    return {
      status: 'ok',
      detail: `内网已阻断（${verdict.blocked.join('、')}）；公网 DNS 正常（${verdict.dns}）`,
    };
  },
};
