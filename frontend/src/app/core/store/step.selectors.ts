import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, liftedGateForStep, syncLayoutHint, type LiftedGate, type StepView } from '../types/step';
import {
  EFFECTIVE_CALIBER_LABEL,
  effectiveReadingsOf,
  meanDisplacement,
  resolveStepCaliber,
  syncDeviationMm,
} from '../types/reading';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';

export const selectStepState = createFeatureSelector<StepStateSlice>('step');
export const selectSteps = createSelector(selectStepState, (state) => state.steps);
export const selectReadings = createSelector(selectStepState, (state) => state.readings);
export const selectActiveStepBridgeId = createSelector(selectStepState, (state) => state.activeBridgeId);

/** 按桥梁分组 */
export const selectStepsByBridge = createSelector(selectSteps, (steps) => {
  const grouped = new Map<string, StepRow[]>();
  for (const step of steps) {
    const list = grouped.get(step.bridgeId) ?? [];
    list.push(step);
    grouped.set(step.bridgeId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
});

/** 找出受影响桥梁的步骤列表 */
export const selectActiveSteps = createSelector(
  selectSteps,
  selectActiveStepBridgeId,
  (steps, bridgeId) => steps.filter((item) => !bridgeId || item.bridgeId === bridgeId).sort((a, b) => a.seq - b.seq),
);

/** 步骤视图：含累计顶升量、同步偏差（当前控制批口径）与校验结论 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  let running = 0;
  return ordered.map((step) => {
    running += step.targetLiftMm;
    const stepRows = readings.filter((item) => item.stepId === step.id);
    const resolved = resolveStepCaliber(stepRows);
    const effective = resolved.effectiveReadings;
    const deviation = effective.length > 0 ? syncDeviationMm(effective) : null;
    const cumulativeLiftMm = Number(running.toFixed(2));
    const overLimit = cumulativeLiftMm > step.limitMm;
    const readingOverLimit = effective.some(
      (item) => step.limitMm > 0 && Math.abs(item.displacementMm) >= step.limitMm,
    );
    const validationParts: string[] = [];
    if (overLimit) validationParts.push(`累计顶升量 ${cumulativeLiftMm} mm 超过限位 ${step.limitMm} mm`);
    if (readingOverLimit) validationParts.push(`生效读数位移达到 / 超过限位 ${step.limitMm} mm`);
    if (deviation !== null && syncLevel(deviation) === 'exceed') {
      validationParts.push(`同步偏差 ${deviation.toFixed(2)} mm 超允许值`);
    }
    return {
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm,
      overLimit,
      readingCount: stepRows.length,
      syncDeviationMm: deviation,
      effectiveCaliber: resolved.caliber,
      effectiveReadingCount: effective.length,
      archivedReadingCount: stepRows.length - effective.length,
      readingOverLimit,
      validation:
        validationParts.length > 0
          ? `${validationParts.join('；')}（口径：${EFFECTIVE_CALIBER_LABEL[resolved.caliber]}）`
          : `顶升参数与监测数据均在控制范围内（口径：${EFFECTIVE_CALIBER_LABEL[resolved.caliber]}）`,
    };
  });
}

/** 桥梁级「顶升到位」签署闸门：该桥已到位步骤全部满足、且至少有一步已到位时放行 */
export function liftedGateForBridge(bridgeId: string, steps: StepRow[], readings: ReadingRow[]): LiftedGate {
  const mine = steps.filter((item) => item.bridgeId === bridgeId).sort((a, b) => a.seq - b.seq);
  const reasons: string[] = [];
  if (mine.length === 0) {
    reasons.push('该桥梁尚未编排顶升步骤');
    return { canSign: false, reasons };
  }
  const arrived = mine.filter((item) => item.state === 'arrived');
  if (arrived.length === 0) reasons.push('该桥梁尚无「已到位」的顶升步骤');
  for (const step of arrived) {
    const gate = liftedGateForStep(step, effectiveReadingsOf(readings, step.id));
    if (!gate.canSign) reasons.push(...gate.reasons);
  }
  return { canSign: reasons.length === 0, reasons };
}

/** 步骤统计：总级数、累计顶升量、就位数、超限数 */
export const selectStepStats = createSelector(selectSteps, selectReadings, (steps, readings) => {
  const cumulative = steps.reduce((sum, item) => sum + item.targetLiftMm, 0);
  return {
    total: steps.length,
    cumulativeMm: Number(cumulative.toFixed(2)),
    arrived: steps.filter((item) => item.state === 'arrived').length,
    lifting: steps.filter((item) => item.state === 'lifting').length,
    idle: steps.filter((item) => item.state === 'idle').length,
    readingCount: readings.length,
    maxLimitMm: steps.reduce((max, item) => Math.max(max, item.limitMm), 0),
  };
});

/** 同步偏差等级（按步骤，当前控制批口径） */
export const selectSyncLevels = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, ToleranceLevel> = {};
  for (const step of steps) {
    const rows = effectiveReadingsOf(readings, step.id);
    result[step.id] = syncLevel(rows.length > 0 ? syncDeviationMm(rows) : 0);
  }
  return result;
});

/** 步骤同步布置建议 */
export const selectSyncHints = createSelector(selectSteps, (steps) =>
  steps.map((step) => ({
    id: step.id,
    seq: step.seq,
    requirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
    hint: syncLayoutHint(step.syncRequirement),
  })),
);

/** 各步骤平均位移（测点页展示，当前控制批口径） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, number> = {};
  for (const step of steps) {
    result[step.id] = meanDisplacement(effectiveReadingsOf(readings, step.id));
  }
  return result;
});
