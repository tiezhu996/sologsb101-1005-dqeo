import type { RowMeta } from './persistence';

/** 控制批口径：每次提交时由记录人选择 */
export type BatchCaliber = 'batch' | 'merge';

export const BATCH_CALIBER_LABEL: Record<BatchCaliber, string> = {
  batch: '本批为准',
  merge: '并入历史',
};

/** 有效读数口径（实际参与同步偏差 / 限位告警 / 校验 / 签署） */
export type EffectiveCaliber = 'batch' | 'merge' | 'legacy';

export const EFFECTIVE_CALIBER_LABEL: Record<EffectiveCaliber, string> = {
  batch: '本批为准',
  merge: '并入历史',
  legacy: '全部读数（旧步骤）',
};

/** 测点读数 */
export interface Reading extends RowMeta {
  id: string;
  /** 所属顶升步骤 */
  stepId: string;
  /** 测点编号，如 P1、J-2 */
  pointCode: string;
  /** 位移（mm） */
  displacementMm: number;
  /** 应力（MPa） */
  stressMpa: number;
  /** 记录时间 yyyy-MM-dd HH:mm */
  recordedAt: string;
  /** 记录人 */
  operator: string;
  /** 控制批编号：同一次批量提交的读数共享；v3 前的旧读数为空 */
  batchId?: string;
  /** 提交时记录人选择的口径；旧读数为空（旧步骤沿用全部读数） */
  batchCaliber?: BatchCaliber;
  /** 提交时间（ISO），用于识别控制批先后；旧读数为空时按记录时间参与 */
  submittedAt?: string;
}

/** 测点读数表单草稿 */
export interface ReadingDraft {
  stepId: string;
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
  recordedAt: string;
  operator: string;
  batchId?: string;
  batchCaliber?: BatchCaliber;
  submittedAt?: string;
}

/** 测点读数视图：带步骤上下文与偏差 */
export interface ReadingView extends Reading {
  stepSeq: number;
  bridgeId: string;
  bridgeName: string;
  syncRequirement: string;
  /** 同步骤内相对有效读数平均位移的偏差（mm） */
  deviationMm: number;
  /** 是否超过限位值 */
  overLimit: boolean;
  /** 应力是否超过关注值 */
  stressAlert: boolean;
  /** 是否为当前生效读数（参与告警 / 校验 / 签署）；false 表示仅留档 */
  effective: boolean;
  /** 该读数所属步骤当前生效口径 */
  stepCaliber: EffectiveCaliber;
  /** 列表口径标记 */
  caliberTag: string;
}

/** 同一步骤的批量录入行 */
export interface ReadingBatchRow {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
}

/** 步骤有效读数口径解析结果 */
export interface StepCaliberResult {
  /** 实际参与计算的读数 */
  effectiveReadings: Reading[];
  /** 生效口径 */
  caliber: EffectiveCaliber;
  /** 生效控制批编号（legacy / merge 时为 null） */
  controlBatchId: string | null;
  /** 控制批提交时间（展示用） */
  controlSubmittedAt: string | null;
  /** 补录但未顶掉当前批的留档批（仅本批为准口径下存在） */
  archivedBatchIds: string[];
}

/** 测点编号建议：按同步要求给出四角测点 */
export const POINT_CODES: string[] = ['P1', 'P2', 'P3', 'P4', 'J1', 'J2', 'J3', 'J4'];

/** 应力关注值（MPa）：超过即提示复核 */
export const STRESS_ALERT_MPA = 12;

/** 批量生成测点编号 */
export function suggestPointCodes(bearingCount: number): string[] {
  const count = Math.max(2, Math.min(POINT_CODES.length, bearingCount * 2));
  return POINT_CODES.slice(0, count);
}

/** 位移平均 */
export function meanDisplacement(rows: Array<{ displacementMm: number }>): number {
  if (rows.length === 0) return 0;
  return Number((rows.reduce((sum, item) => sum + item.displacementMm, 0) / rows.length).toFixed(3));
}

/** 同步偏差（mm）：最大位移 − 最小位移 */
export function syncDeviationMm(rows: Array<{ displacementMm: number }>): number {
  if (rows.length === 0) return 0;
  const values = rows.map((item) => item.displacementMm);
  return Number((Math.max(...values) - Math.min(...values)).toFixed(3));
}

/** 按测点取最新一条：先比记录时间，再比提交时间，最后比创建时间兜底 */
function isLaterReading(candidate: Reading, current: Reading): boolean {
  if (candidate.recordedAt !== current.recordedAt) return candidate.recordedAt > current.recordedAt;
  if ((candidate.submittedAt ?? '') !== (current.submittedAt ?? '')) {
    return (candidate.submittedAt ?? '') > (current.submittedAt ?? '');
  }
  return (candidate.createdAt ?? '') > (current.createdAt ?? '');
}

/** 并入历史口径：每个测点取最新一条记录参与 */
export function latestPerPoint(rows: Reading[]): Reading[] {
  const latest = new Map<string, Reading>();
  for (const row of rows) {
    const current = latest.get(row.pointCode);
    if (!current || isLaterReading(row, current)) latest.set(row.pointCode, row);
  }
  return [...latest.values()];
}

/** 步骤内按控制批分组（仅 v3 后带 batchId 的读数） */
export function groupBatches(rows: Reading[]): Map<string, Reading[]> {
  const batches = new Map<string, Reading[]>();
  for (const row of rows) {
    if (!row.batchId) continue;
    const list = batches.get(row.batchId) ?? [];
    list.push(row);
    batches.set(row.batchId, list);
  }
  return batches;
}

/** 批内记录时间（取最早一条，代表该批的作业时间） */
function batchRecordedAt(rows: Reading[]): string {
  return rows.reduce((min, row) => (row.recordedAt < min ? row.recordedAt : min), rows[0]?.recordedAt ?? '');
}

/** 批提交时间（缺失时退回创建时间） */
function batchSubmittedAt(rows: Reading[]): string {
  return rows.reduce(
    (max, row) => {
      const value = row.submittedAt ?? row.createdAt ?? '';
      return value > max ? value : max;
    },
    rows[0]?.submittedAt ?? rows[0]?.createdAt ?? '',
  );
}

/**
 * 解析步骤当前生效口径：
 * - 有「本批为准」控制批：最新（按记录时间、再按提交时间）一批为准，其余留档；
 *   补录旧时间的批查看但不顶掉当前批。
 * - 无控制批但有「并入历史」批：每个测点取最新一条记录参与。
 * - 只有 v3 前旧读数：沿用全部读数。
 */
export function resolveStepCaliber(stepReadings: Reading[]): StepCaliberResult {
  const batches = [...groupBatches(stepReadings).entries()].map(([batchId, rows]) => ({
    batchId,
    rows,
    caliber: rows[0]?.batchCaliber ?? 'merge',
    recordedAt: batchRecordedAt(rows),
    submittedAt: batchSubmittedAt(rows),
  }));

  const batchBatches = batches.filter((batch) => batch.caliber === 'batch');
  if (batchBatches.length > 0) {
    batchBatches.sort((a, b) =>
      a.recordedAt !== b.recordedAt
        ? b.recordedAt.localeCompare(a.recordedAt)
        : b.submittedAt.localeCompare(a.submittedAt),
    );
    const control = batchBatches[0];
    return {
      effectiveReadings: control.rows,
      caliber: 'batch',
      controlBatchId: control.batchId,
      controlSubmittedAt: control.submittedAt,
      archivedBatchIds: batchBatches.slice(1).map((batch) => batch.batchId),
    };
  }

  if (batches.length > 0) {
    // 最新一批「并入历史」之外的旧读数同样按每测点最新记录参与
    return {
      effectiveReadings: latestPerPoint(stepReadings),
      caliber: 'merge',
      controlBatchId: null,
      controlSubmittedAt: null,
      archivedBatchIds: [],
    };
  }

  return {
    effectiveReadings: stepReadings,
    caliber: 'legacy',
    controlBatchId: null,
    controlSubmittedAt: null,
    archivedBatchIds: [],
  };
}

/** 便捷重载：从全部读数中过滤某步骤后解析口径 */
export function effectiveReadingsOf(allReadings: Reading[], stepId: string): Reading[] {
  return resolveStepCaliber(allReadings.filter((item) => item.stepId === stepId)).effectiveReadings;
}

/** 单条读数在当前口径下的列表标记 */
export function readingCaliberTag(
  reading: Reading,
  resolved: StepCaliberResult,
): '生效' | '留档' | '并入生效' {
  if (resolved.caliber === 'batch') {
    return reading.batchId === resolved.controlBatchId ? '生效' : '留档';
  }
  return resolved.effectiveReadings.some((item) => item.id === reading.id) ? '并入生效' : '留档';
}

/** 读数时间格式校验提示 */
export function readingDateHint(recordedAt: string, stepState: string): string {
  if (!recordedAt) return '请选择记录时间';
  if (stepState === 'idle') return '该步骤尚未开始顶升，录入读数前请先推进状态';
  return '记录时间应晚于步骤开始时间，并按 5~10 分钟间隔连续记录；补录旧时间可查看但不顶掉当前批';
}
