/** 外部工具注册表单测（镜像 registerCommand 口径：重复注册拒绝/查询/重置） */
import { describe, expect, it } from 'vitest';
import { getExternalTool, registerExternalTool, resetExternalTools } from './external-tools.js';

describe('外部工具注册表', () => {
  it('注册/查询/重置；重复注册拒绝', async () => {
    resetExternalTools();
    expect(getExternalTool('x.y')).toBeUndefined();
    registerExternalTool('x.y', async () => ({ ok: true }));
    expect(await getExternalTool('x.y')!('p', { args: {} }, { projectId: 'p', actorKind: 'human', actorId: 't' }))
      .toEqual({ ok: true });
    expect(() => registerExternalTool('x.y', async () => ({}))).toThrow('重复注册');
    resetExternalTools();
    expect(getExternalTool('x.y')).toBeUndefined();
  });
});
