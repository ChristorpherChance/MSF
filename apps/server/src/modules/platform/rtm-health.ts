import { fingerprint } from '@msf/shared';
import { splitSections } from './doc-sections.js';

/**
 * W3-004：设计册 kind → 规格单字母前缀（h/o/g/k/d/a/u/n，DSG-U06-23 统稿 M7、REQ-302、LLD-4 chapter_prefix）。
 * 权威定义在 design 域 DESIGN_BOOKS；跨域禁令下 platform 不 import 他域模块，此处镜像（改 DESIGN_BOOKS 须同步）。
 */
const DSG_BOOK_LETTER: Record<string, string> = {
  hld: 'H', mod: 'O', alg: 'G', cls: 'K', db: 'D', api: 'A', ui: 'U', nfr: 'N',
};

/**
 * RTM 追踪链派生与健康度实算（LLD-2 DSG-F06 同步纯函数；REQ-207/208/310）。
 *
 * 派生口径（任务分解 M2 注①，版本提交同事务执行）：
 * - R 集合 = CRD 全文出现的全部 R-\d+；
 * - CRD 中标题含 CR-\d+ 的章节，其正文内的 R-x 建 R→CR refines；
 * - PRD 中标题含 REQ-\d+ 的章节，正文内 CR-x 建 CR→REQ refines、DSG-* 锚点建 REQ→DSG implements；
 * - 设计册反向派生（#15 立项：自然承接方向认定）——章节回引 REQ-nnn 时：
 *   同章节含 DSG-* 锚点建精确 REQ→DSG-* implements；无锚点建 REQ→DSG-<册> 册级粗粒度链
 *   （册级链只解锁门禁，精确锚仍鼓励在 PRD 该 REQ 章节正文预埋）；
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

/** 从 CRD/PRD 当前版本全文（可选加设计各册正文，#15 反向派生）派生追踪链与节点集（无文档侧按空集计） */
export function deriveLinks(
  crdContent: string,
  prdContent: string,
  designDocs: Array<{ book: string; content: string }> = [],
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

  // #15 反向派生：设计册章节回引 REQ 编号即认定承接（REQ 节点集仍以 PRD 为权威，不回灌）
  for (const { book, content } of designDocs) {
    // W3-004：册级锚用规格单字母前缀（DSG-H/O/G/K/D/A/U/N），不再用 kind 全大写（DSG-MOD 等与八册卡错位）
    const bookAnchor = `DSG-${DSG_BOOK_LETTER[book] ?? book.toUpperCase()}`;
    for (const sec of splitSections(content)) {
      const reqs = scanCodes(`${sec.title}\n${sec.md}`, RE_REQ);
      if (reqs.length === 0) continue;
      const dsgs = scanCodes(`${sec.title}\n${sec.md}`, RE_DSG).filter((d) => d !== bookAnchor);
      for (const req of reqs) {
        if (dsgs.length > 0) {
          for (const dsg of dsgs) {
            dsgSet.add(dsg);
            links.push({ fromKind: 'req', fromCode: req, toKind: 'dsg', toCode: dsg, relation: 'implements' });
          }
        } else {
          dsgSet.add(bookAnchor);
          links.push({ fromKind: 'req', fromCode: req, toKind: 'dsg', toCode: bookAnchor, relation: 'implements' });
        }
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
    // W2-007：R 层缺口给修复引导（对照 REQ 层已有指引；R 层无 deferred 入口，出口=CRD 内承接或移除）
    gaps.push({
      code: 'L0A_BELOW', target: c,
      message: `R→CR 未覆盖：${c}（修复：在 CRD 为 ${c} 补写对应变更章节（CR-*）并提交版本；若该诉求已不做，在 CRD 中移除该条目。R 层无 deferred 标记入口）`,
    });
  }

  const actCr = active(nodes.cr);
  const crCovered = actCr.filter((c) => covered.has(`cr:${c}`));
  if (actCr.length === 0) warnings.push('无 CR 可核对');
  const l0b = actCr.length === 0 ? 1 : crCovered.length / actCr.length;
  for (const c of actCr.filter((c) => !covered.has(`cr:${c}`))) {
    gaps.push({
      code: 'RTM_HEALTH', target: c,
      message: `CR→REQ 未承接：${c}（修复：接受/补写该变更的 PRD 承接补丁（REQ-*），或在 RTM 行标记 deferred（理由必填，不计入分母））`,
    });
  }

  const actReq = active(nodes.req);
  const reqCovered = actReq.filter((c) => covered.has(`req:${c}`));
  if (actReq.length === 0) warnings.push('无 REQ 可核对');
  const l0c = actReq.length === 0 ? 1 : reqCovered.length / actReq.length;
  for (const c of actReq.filter((c) => !covered.has(`req:${c}`))) {
    gaps.push({
      code: 'L0C_BELOW', target: c,
      message: `REQ→DSG 无承接锚点：${c}（修复：在 PRD 该 REQ 章节正文补「设计承接：DSG-*」锚点，或在设计册对应章节标题/正文回引 ${c}，然后提交版本）`,
    });
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
