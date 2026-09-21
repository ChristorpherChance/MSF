import { describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { executeCommand, registerCommand, resetCommands } from './command-bus.js';

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    expect.unreachable('应当抛错');
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
  }
}

describe('CommandBus（BR-01/04）', () => {
  it('未注册命令拒绝 COMMAND_UNKNOWN', async () => {
    await expectCode(
      executeCommand('platform.nope', {}, { projectId: null, actorKind: 'human', actorId: 't' }),
      'COMMAND_UNKNOWN',
    );
  });

  it('重复注册拒绝', () => {
    resetCommands();
    const noop = async () => null;
    registerCommand('health.ping', noop);
    try {
      registerCommand('health.ping', noop);
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as DomainError).code).toBe('COMMAND_UNKNOWN');
    }
    resetCommands();
  });
});
