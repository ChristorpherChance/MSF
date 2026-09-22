import { fingerprint } from '@msf/shared';
import { splitSections } from './sections.js';

/**
 * RTM 追踪链派生与健康度实算（LLD-2 DSG-F06 同步纯函数；REQ-207/208/310）。
 *
 * 派生口径（任务分解 M2 注①，版本提交同事务执行）：
 * - R 集合 = CRD 全文出现的全部 R-\d+；
 * - CRD 中标题含 CR-\d+ 的章节，其正文内的 R-x 建 R→CR refines；
 * - PRD 中标题含 REQ-\d+ 的章节，正文内 CR-x 建 CR→REQ refines、DSG-* 锚点建 REQ→DSG implements；
 * - deferred/dropped 为人工标记行（from==to 自指），派生重建不动人工标记。
 */

export interface DerivedLink {
  fromKind: 'r' | 'cr' | 'req';
  fromCode: string;
  toKind: 'cr' | 'req' | 'dsg';
  toCode: string;
  relation: 'refines' | 'implements';
}

export interface RtmNodeSets {
  r: string[];
  cr: string[];
  req: string[];
  dsg: string[];
}

const RE_R = /\bR-\d{3}\b/g;
const RE_CR = /\bCR-\d{3}\b/g;
const RE_REQ = /\bREQ-\d{3}\b/g;
const RE_DSG = /\bDSG-[A-Za-z][A-Za-z0-9.-]*/g;

const scanCodes = (text: string, re: RegExp): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out].sort();
};

/** 从 CRD/PRD 当前版本全文派生追踪链与节点集（无文档侧按空集计） */
export function deriveLinks(
  crdContent: string,
  prdContent: string,
): { links: DerivedLink[]; nodes: RtmNodeSets } {
  const links: DerivedLink[] = [];
  const dsgSet = new Set<string>();

  const rSet = new Set(scanCodes(crdContent, RE_R));
  const crSet = new Set(scanCodes(crdContent, RE_CR));
  for (const sec of splitSections(crdContent)) {
    const crs = scanCodes(sec.title, RE_CR);
    for (const cr of crs) {
      crSet.add(cr);
      for (const r of scanCodes(sec.md, RE_R)) {
        rSet.add(r);
        links.push({ fromKind: 'r', fromCode: r, toKind: 'cr', toCode: cr, relation: 'refines' });
      }
    }
  }

  const reqSet = new Set(scanCodes(prdContent, RE_REQ));
  for (const sec of splitSections(prdContent)) {
    const reqs = scanCodes(sec.title, RE_REQ);
    for (const req of reqs) {
      reqSet.add(req);
      for (const cr of scanCodes(sec.md, RE_CR)) {
        crSet.add(cr);
        links.push({ fromKind: 'cr', fromCode: cr, toKind: 'req', toCode: req, relation: 'refines' });
      }
      for (const dsg of scanCodes(sec.md, RE_DSG)) {
        dsgSet.add(dsg);
        links.push({ fromKind: 'req', fromCode: req, toKind: 'dsg', toCode: dsg, relation: 'implements' });
      }
    }
  }

  return {
    links,
    nodes: {
      r: [...rSet].sort(),
      cr: [...crSet].sort(),
      req: [...reqSet].sort(),
      dsg: [...dsgSet].sort(),
    },
  };
}

export interface HealthGap {
  code: 'L0A_BELOW' | 'L0C_BELOW' | 'RTM_HEALTH';
  target: string;
  message: string;
}

export interface HealthResult {
  ok: boolean;
  l0a: number;
  l0b: number;
  l0c: number;
  l0d: number;
  warnings: string[];
  gaps: HealthGap[];
  deferredItems: Array<{ nodeId: string }>;
  basisFingerprint: string;
}

/** F06-1 四指标实算：分母=active（deferred/dropped 不计），空分母记 1 并告警 */
export function computeHealth(
  nodes: RtmNodeSets,
  links: Array<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>,
): HealthResult {
  const deferred = new Set(
    links
      .filter((l) => l.relation === 'deferred' || l.relation === 'dropped')
      .map((l) => l.from_code),
  );
  const active = (codes: string[]) => codes.filter((c) => !deferred.has(c));

  const covered = new Set(
    links.filter((l) => l.relation === 'refines' || l.relation === 'implements').map((l) => `${l.from_kind}:${l.from_code}`),
  );

  const warnings: string[] = [];
  const gaps: HealthGap[] = [];

  const actR = active(nodes.r);
  const rCovered = actR.filter((c) => covered.has(`r:${c}`));
  if (actR.length === 0) warnings.push('无 R 可核对');
  const l0a = actR.length === 0 ? 1 : rCovered.length / actR.length;
  for (const c of actR.filter((c) => !covered.has(`r:${c}`))) {
    gaps.push({ code: 'L0A_BELOW', target: c, message: 'R→CR 未覆盖' });
  }

  const actCr = active(nodes.cr);
  const crCovered = actCr.filter((c) => covered.has(`cr:${c}`));
  if (actCr.length === 0) warnings.push('无 CR 可核对');
  const l0b = actCr.length === 0 ? 1 : crCovered.length / actCr.length;
  for (const c of actCr.filter((c) => !covered.has(`cr:${c}`))) {
    gaps.push({ code: 'RTM_HEALTH', target: c, message: 'CR→REQ 未承接' });
  }

  const actReq = active(nodes.req);
  const reqCovered = actReq.filter((c) => covered.has(`req:${c}`));
  if (actReq.length === 0) warnings.push('无 REQ 可核对');
  const l0c = actReq.length === 0 ? 1 : reqCovered.length / actReq.length;
  for (const c of actReq.filter((c) => !covered.has(`req:${c}`))) {
    gaps.push({ code: 'L0C_BELOW', target: c, message: 'REQ→DSG 无承接锚点' });
  }

  const deferredItems = [...deferred].sort().map((nodeId) => ({ nodeId }));
  const ok = l0a >= 0.95 && l0b === 1;
  return {
    ok,
    l0a,
    l0b,
    l0c,
    l0d: deferredItems.length,
    warnings,
    gaps,
    deferredItems,
    basisFingerprint: fingerprint({
      nodes: nodes as never,
      links: links.map((l) => `${l.from_kind}:${l.from_code}>${l.to_kind}:${l.to_code}#${l.relation}`),
    }),
  };
}
