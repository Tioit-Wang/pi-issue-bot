import { http, type HttpHandler } from 'msw';
import type { SystemResponse } from '../../lib/contract.ts';
import { MOCK_NOW, systemEmptyFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 系统页（S7）的拦截器 —— **W3-J 只改这一个文件**（也是四态代表页）。
 * 契约：`GET /api/system`（`SystemResponse`，见 `docs/spec/contract-api.md` §8）。
 *
 * 这份 payload 刻意**同时包含正常与异常**，让页面上的每个分支都能被看到：
 * - `version.host === null`（pi-host 未协商）⇒ 面板显示 `—`，不假装正常；
 * - `host.status === 'unknown'` ⇒ 面板显示「未知」（这是页面里**唯一**的「未知」，四态测试按它断言）；
 * - `doctor.status === 'fail'` + 一条 `warn` + 一条 `skip` ⇒ 逐项列表的三种样式都能看；
 * - `repos` 里一条 `configValid: false`；`skills` 里一条被禁用（`disabledReason`）；
 * - `flags` 带 `rate_limit_pause` ⇒ 全局降级横幅（`DegradedBanner`）与页面内「降级条件」都成立。
 */

export function systemMock(): SystemResponse {
  return {
    generatedAt: MOCK_NOW,
    version: {
      app: '0.4.0',
      contract: '1.0.0',
      // 没有 vendor/pi-host bundle ⇒ 协商不到版本，如实为 null
      host: null,
      hostPinned: false,
    },
    protocol: { wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' },
    host: { status: 'unknown', lastPingAt: null, sessions: 0 },
    doctor: {
      status: 'fail',
      checkedAt: '2026-06-01T11:58:00.000Z',
      checks: [
        { id: 'docker-daemon', status: 'ok', detail: 'API 1.52（Linux 容器）' },
        { id: 'docker-sock-owner', status: 'ok', detail: 'root:pi 0660' },
        { id: 'canary-network', status: 'fail', detail: '金丝雀探测不可达：1.1.1.1:443 超时' },
        { id: 'disk-space', status: 'warn', detail: '剩余 12%（阈值 15%）' },
        { id: 'pin-hash', status: 'fail', detail: 'vendor/pi-host 未 vendored' },
        { id: 'pg-reachable', status: 'ok', detail: '127.0.0.1:5432' },
        { id: 'pgboss-queues', status: 'ok', detail: '6 条队列已建' },
        { id: 'nftables', status: 'ok', detail: 'no-merge 规则已加载' },
        { id: 'tls-cert', status: 'skip', detail: '本机未部署 Caddy' },
      ],
    },
    queue: [
      { name: 'run-task', pending: 3, active: 2, retryLimit: 0, expireInMs: 1_200_000 },
      { name: 'queue-gate', pending: 0, active: 0, retryLimit: 1, expireInMs: 120_000 },
      { name: 'reconcile', pending: 1, active: 0, retryLimit: 2, expireInMs: 600_000 },
    ],
    retention: { webhookDays: 90, runEventDays: 90, transcriptDays: 30, metricsForever: true },
    flags: [
      { key: 'rate_limit_pause', value: '1', until: '2026-06-01T12:15:00.000Z' },
      { key: 'dry_run_global', value: '0', until: null },
    ],
    repos: [
      {
        repo: 'acme/widgets',
        enabled: true,
        dryRun: false,
        settingsValid: true,
        settingsError: null,
        source: 'installation',
        archivedAt: null,
        lastActivityAt: '2026-06-01T11:58:00.000Z',
        configValid: true,
        configError: null,
      },
      {
        repo: 'acme/billing',
        enabled: true,
        dryRun: true,
        settingsValid: true,
        settingsError: null,
        source: 'installation',
        archivedAt: null,
        lastActivityAt: '2026-06-01T09:12:00.000Z',
        configValid: true,
        configError: null,
      },
      {
        repo: 'other/lib',
        enabled: false,
        dryRun: false,
        settingsValid: false,
        settingsError: 'outputs 越界',
        source: 'manual',
        archivedAt: '2026-05-20T08:00:00.000Z',
        lastActivityAt: null,
        configValid: false,
        configError: 'outputs 越界',
      },
    ],
    skills: [
      {
        name: '/review-pr',
        source: 'builtin',
        enabled: true,
        disabledReason: null,
        outputs: ['comment', 'labels'],
        timeoutMs: 1_800_000,
      },
      {
        name: 'auto:triage',
        source: 'repo',
        enabled: true,
        disabledReason: null,
        outputs: ['labels', 'issue'],
        timeoutMs: 900_000,
      },
      {
        name: 'auto:compliance',
        source: 'repo',
        enabled: false,
        disabledReason: 'skill_invalid',
        outputs: ['comment'],
        timeoutMs: 1_800_000,
      },
    ],
  };
}

export const systemHandlers: HttpHandler[] = [
  http.get('/api/system', () => scenarioResponse({ data: systemMock(), empty: systemEmptyFixture() })),
];
