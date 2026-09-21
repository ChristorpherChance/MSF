import { Injectable } from '@nestjs/common';
import { POLICY_GATE_KEYS, type PolicyGateKey } from '@msf/shared';
import { query } from '../../db/pool.js';

export interface GateDecision {
  gateKey: PolicyGateKey;
  mode: 'manual' | 'auto';
  /** manual=需要人工确认（默认）；auto=策略自动放行 */
}

/**
 * M12 放行策略引擎（核，REQ-711）：7 确认点策略求值。
 * 默认人工；未配置的项目级记录视为 manual。切换授权与留痕随各领域确认点接入扩展（M2+）。
 */
@Injectable()
export class PolicyService {
  async evaluate(projectId: string, gateKey: PolicyGateKey): Promise<GateDecision> {
    const r = await query<{ mode: 'manual' | 'auto' }>(
      'SELECT mode FROM policy_gates WHERE project_id=$1 AND gate_key=$2',
      [projectId, gateKey],
    );
    return { gateKey, mode: r.rows[0]?.mode ?? 'manual' };
  }

  async listGates(projectId: string): Promise<GateDecision[]> {
    const r = await query<{ gate_key: PolicyGateKey; mode: 'manual' | 'auto' }>(
      'SELECT gate_key, mode FROM policy_gates WHERE project_id=$1',
      [projectId],
    );
    const byKey = new Map(r.rows.map((row) => [row.gate_key, row.mode]));
    return POLICY_GATE_KEYS.map((gateKey) => ({ gateKey, mode: byKey.get(gateKey) ?? 'manual' }));
  }
}
