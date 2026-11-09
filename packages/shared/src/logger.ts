/**
 * 日志门面（tech-plan §10.2）：pino 10 + 字段路径脱敏 + 值级脱敏 + 四级 in id。
 *
 * 为什么再包一层薄门面，而不是让各模块直接用 pino：
 * 1. 值级脱敏必须对**每一次**调用都生效，靠「记得传 censor」不可靠；门面是唯一入口。
 * 2. 下游只需要 5 个方法（debug/info/warn/error/child），窄接口便于在测试里注入假 logger。
 * 3. 真正落盘仍是 pino（JSON 行、redact 路径、时间戳），不自己写格式化。
 */
import pino, { type DestinationStream } from 'pino';
import { REDACTED, redactSecrets, redactValue } from './redact.ts';

/** pino 的字段路径脱敏。覆盖 plan §10 点名的字段名与常见变体。 */
export const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'privateKey',
  '*.privateKey',
  'env.PI_BOT_GITHUB_APP_PRIVATE_KEY',
  'env.PI_BOT_MODEL_API_KEY',
  'env.PI_BOT_WEBHOOK_SECRET',
  'env.PI_BOT_PG_PASSWORD',
];

export type LogBindings = Record<string, unknown>;
export type LogMethod = (fields: LogBindings | string, message?: string) => void;

export interface Logger {
  readonly level: string;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  child(bindings: LogBindings): Logger;
}

export type LoggerOptions = {
  /** 服务名，落在 `base.service` 上，便于 journald 里按服务过滤。 */
  service: string;
  level?: string;
  /** 附加到每条日志的固定字段（例如 `hostVersion`）。 */
  base?: LogBindings;
  /** 测试用：注入 pino 的目标流。不传则写 stdout（生产由 systemd 收进 journald）。 */
  destination?: DestinationStream;
};

const DEFAULT_LEVEL = 'info';

/** 把 pino 实例包成窄门面：所有参数先做值级脱敏，再交给 pino。 */
function wrap(instance: pino.Logger): Logger {
  const method = (write: (fields: unknown, message?: string) => void): LogMethod => {
    return (fields, message) => {
      if (typeof fields === 'string') {
        write(redactSecrets(fields));
        return;
      }
      write(redactValue(fields), message === undefined ? undefined : redactSecrets(message));
    };
  };

  return {
    get level(): string {
      return instance.level;
    },
    debug: method((fields, message) => {
      instance.debug(fields as object, message);
    }),
    info: method((fields, message) => {
      instance.info(fields as object, message);
    }),
    warn: method((fields, message) => {
      instance.warn(fields as object, message);
    }),
    error: method((fields, message) => {
      instance.error(fields as object, message);
    }),
    child: (bindings) => wrap(instance.child(redactValue(bindings) as pino.Bindings)),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const base: pino.Bindings = { service: options.service, ...(options.base ?? {}) };
  const instance = pino(
    {
      level: options.level ?? DEFAULT_LEVEL,
      base,
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    options.destination,
  );
  return wrap(instance);
}

/** 静默 logger：测试与 CLI 的 `--quiet` 用（不依赖 pino 的 level 开关是否被覆盖）。 */
export function createNullLogger(): Logger {
  const noop: LogMethod = () => {};
  const nullLogger: Logger = {
    level: 'silent',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => nullLogger,
  };
  return nullLogger;
}
