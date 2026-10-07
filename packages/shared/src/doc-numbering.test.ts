/** 派生编号单测（大章分组/无大章退化/码入括号/s0 跳过/大章前散节） */
import { describe, expect, it } from 'vitest';
import { deriveNumbering } from './doc-numbering.js';

describe('deriveNumbering', () => {
  it('大章分组：章计数+节计数，锚点码入括号，标题保留原貌给大章', () => {
    const out = deriveNumbering([
      { id: 's0', title: '' },
      { id: 's1', title: '一、背景与目标' },
      { id: 's2', title: 'CR-001 浏览器即开即玩' },
      { id: 's3', title: 'CR-002 双人同屏' },
      { id: 's4', title: '二、非功能需求' },
      { id: 's5', title: 'CR-003 性能指标' },
    ]);
    expect(out[0]).toEqual({ id: 's0', display: '', chapter: false });
    expect(out[1]).toEqual({ id: 's1', display: '一、背景与目标', chapter: true });
    expect(out[2]).toEqual({ id: 's2', display: '1.1 浏览器即开即玩（CR-001）', chapter: false });
    expect(out[3]!.display).toBe('1.2 双人同屏（CR-002）');
    expect(out[4]).toEqual({ id: 's4', display: '二、非功能需求', chapter: true });
    expect(out[5]!.display).toBe('2.1 性能指标（CR-003）');
  });

  it('无大章（存量文档）→ 退化纯序号；无码节不带括号', () => {
    const out = deriveNumbering([
      { id: 's0', title: '前言' },
      { id: 's1', title: 'REQ-007 批量导入' },
    ]);
    expect(out[0]!.display).toBe('1. 前言');
    expect(out[1]!.display).toBe('2. 批量导入（REQ-007）');
  });

  it('大章之前的散节独立纯序号（不占章节号）', () => {
    const out = deriveNumbering([
      { id: 's0', title: '修订说明' },
      { id: 's1', title: '一、功能需求' },
      { id: 's2', title: 'REQ-001 登录' },
    ]);
    expect(out[0]!.display).toBe('1. 修订说明');
    expect(out[2]!.display).toBe('1.1 登录（REQ-001）');
  });

  it('四位以上数字的伪锚点码不提取（CR-0012 按无码节处理）', () => {
    const out = deriveNumbering([
      { id: 's0', title: '一、功能需求' },
      { id: 's1', title: 'CR-0012 误植' },
    ]);
    expect(out[1]!.display).toBe('1.1 CR-0012 误植');
  });

  it('设计册前缀码（h-n）入括号——不再裸露在派生编号标题里（2026-10-07 章码双轨实机抓修）', () => {
    const out = deriveNumbering([
      { id: 's1', title: '一、总体架构' },
      { id: 's2', title: 'h-1 分层结构与职责边界' },
      { id: 's3', title: 'h-2 部署视图' },
    ]);
    expect(out[1]!.display).toBe('1.1 分层结构与职责边界（h-1）');
    expect(out[2]!.display).toBe('1.2 部署视图（h-2）');
  });
});
