import type { RowMeta } from './persistence';

/**
 * 控制批口径：
 * - batch 本批为准：同步偏差 / 限位告警 / 步骤校验 / 顶升到位签署只看当前控制批，旧读数仅留档
 * - merge 并入历史：当前控制批并入历史，每个测点按最新一条记录参与计算
 */
export type ControlMode = 'batch' | 'merge';

export const CONTROL_MODE_LABEL: Record<ControlMode, string> = {
  batch: '本批为准',
  merge: '并入历史',
};

export const CONTROL_MODES: ControlMode[] = ['batch', 'merge'];

/** 提交面板的口径说明 */
export const CONTROL_MODE_HINT: Record<ControlMode, string> = {
  batch: '本批为准：现场告警与签署只盯本批最新读数，历史读数仅留档；补录更早时间不会顶掉当前批。',
  merge: '并入历史：本批并入历史，每个测点按最新一条记录参与；补录的旧读数不会覆盖该测点的最新值。',
};

/**
 * 控制批：一次批量提交对应一条记录。
 * 同一步骤的当前控制批为 recordedAt 最新的一批（并列时取提交时间 createdAt 最新），
 * 旧步骤（无任何控制批）沿用全部读数。
 */
export interface ReadingBatch extends RowMeta {
  id: string;
  /** 所属顶升步骤 */
  stepId: string;
  /** 记录时间 yyyy-MM-dd HH:mm（批内读数统一记录时间） */
  recordedAt: string;
  /** 记录人 */
  operator: string;
  /** 口径：本批为准 / 并入历史 */
  mode: ControlMode;
  /** 读数条数（冗余，便于列表展示） */
  readingCount: number;
}

/** 某步骤读数按控制批口径切分后的结果 */
export interface StepReadingPartition {
  /** 参与同步偏差 / 限位告警 / 步骤校验 / 签署的读数 */
  effective: import('./reading').Reading[];
  /** 仅留档、不参与控制判定的读数 */
  archived: import('./reading').Reading[];
  /** 当前控制批；无控制批（旧步骤）时为 null，此时全部读数参与 */
  controlBatch: ReadingBatch | null;
  /** 是否沿用旧口径（无控制批，全部读数参与） */
  legacy: boolean;
}

/** 读数新旧排序：先按记录时间，再按提交时间（createdAt），最后按 id 兜底 */
function compareRecency(a: import('./reading').Reading, b: import('./reading').Reading): number {
  const time = b.recordedAt.localeCompare(a.recordedAt);
  if (time !== 0) return time;
  const created = b.createdAt.localeCompare(a.createdAt);
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

/** 控制批新旧排序：先按批记录时间，再按提交时间，最后按 id 兜底 */
function compareBatchRecency(a: ReadingBatch, b: ReadingBatch): number {
  const time = b.recordedAt.localeCompare(a.recordedAt);
  if (time !== 0) return time;
  const created = b.createdAt.localeCompare(a.createdAt);
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

/** 取某步骤的当前控制批（recordedAt 最新的一批） */
export function latestBatchOfStep(
  stepId: string,
  batches: ReadingBatch[],
): ReadingBatch | null {
  const own = batches
    .filter((item) => item.stepId === stepId)
    .sort(compareBatchRecency);
  return own[0] ?? null;
}

/**
 * 按控制批口径切分某步骤的全部读数。
 * - 无控制批（旧步骤）：全部读数参与（旧步骤沿用全部读数）
 * - 本批为准：仅当前控制批的读数参与，其余留档
 * - 并入历史：每个测点取最新一条记录参与，其余留档
 */
export function partitionStepReadings(
  stepId: string,
  readings: import('./reading').Reading[],
  batches: ReadingBatch[],
): StepReadingPartition {
  const own = readings.filter((item) => item.stepId === stepId);
  const controlBatch = latestBatchOfStep(stepId, batches);
  if (!controlBatch) {
    return { effective: [...own].sort(compareRecency), archived: [], controlBatch: null, legacy: true };
  }
  if (controlBatch.mode === 'batch') {
    const effective = own
      .filter((item) => item.batchId === controlBatch.id)
      .sort(compareRecency);
    const archived = own
      .filter((item) => item.batchId !== controlBatch.id)
      .sort(compareRecency);
    return { effective, archived, controlBatch, legacy: false };
  }
  // 并入历史：每个测点按最新一条记录参与（记录时间优先，提交时间兜底）
  const latestByPoint = new Map<string, import('./reading').Reading>();
  for (const reading of [...own].sort(compareRecency)) {
    if (!latestByPoint.has(reading.pointCode)) latestByPoint.set(reading.pointCode, reading);
  }
  const effectiveIds = new Set([...latestByPoint.values()].map((item) => item.id));
  return {
    effective: own.filter((item) => effectiveIds.has(item.id)).sort(compareRecency),
    archived: own.filter((item) => !effectiveIds.has(item.id)).sort(compareRecency),
    controlBatch,
    legacy: false,
  };
}
