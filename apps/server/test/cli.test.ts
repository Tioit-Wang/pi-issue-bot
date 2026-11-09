import { describe, expect, it } from 'vitest';
import { COMMANDS, EXIT_NOT_IMPLEMENTED, EXIT_OK, EXIT_USAGE, helpText, main } from '../src/cli.ts';

type Captured = { readonly code: number; readonly stdout: string; readonly stderr: string };

function capture(argv: readonly string[]): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = main(argv, {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('pi-bot CLI 骨架', () => {
  it('--help 打印全部子命令并以 0 退出', () => {
    const result = capture(['--help']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    for (const command of COMMANDS) {
      expect(result.stdout).toContain(command.name);
    }
    expect(result.stdout).toContain('用法:');
  });

  it('helpText() 覆盖 tech-plan §8.4 的五个子命令', () => {
    const text = helpText();
    expect(text).toContain('serve');
    expect(text).toContain('doctor');
    expect(text).toContain('bootstrap-host');
    expect(text).toContain('replay');
    expect(text).toContain('migrate');
  });

  it('--version 以 0 退出', () => {
    const result = capture(['--version']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.trim()).not.toBe('');
  });

  it('无参数时是用法错误（退出码 1）', () => {
    const result = capture([]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('缺少命令');
  });

  it('未知命令是用法错误（退出码 1）', () => {
    const result = capture(['deploy-everything']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('未知命令');
  });

  it.each(COMMANDS.map((command) => command.name))(
    '子命令 %s 返回 NOT_IMPLEMENTED（退出码 2）',
    (name) => {
      const result = capture([name]);
      expect(result.code).toBe(EXIT_NOT_IMPLEMENTED);
      expect(result.stderr).toContain('NOT_IMPLEMENTED');
    },
  );

  it('子命令带 --help 时打印帮助并以 0 退出', () => {
    const result = capture(['replay', '--help']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('用法:');
  });
});
