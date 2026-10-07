/**
 * 顶升步骤时间线服务（Angular 以 Injectable 实现 useStepTimeline 语义）
 * 提供顶升步骤时间线、累计顶升量与同步偏差的 RxJS 派生流，
 * 被顶升步骤页、测点读数页消费。
 * 全部监测派生指标按控制批口径计算（本批为准 / 并入历史 / 旧步骤全部读数）。
 */
import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import { IdbTableService } from './idb-table.service';
import { listBearings, listBridges, listReadingBatches, listReadings, listSteps } from '../utils/db';
import type {
  BridgeRow,
  BearingRow,
  ReadingBatchRow,
  ReadingRow,
  StepRow,
} from '../utils/db';
import { sortSteps, SYNC_REQUIREMENT_LABEL, arrivalGateReason, type StepView } from '../types/step';
import {
  CONTROL_MODE_LABEL,
  partitionStepReadings,
  type StepReadingPartition,
} from '../types/control-batch';
import { meanDisplacement, syncDeviationMm, type ReadingView } from '../types/reading';
import { overallLevel, syncLevel, type ToleranceLevel } from '../utils/tolerance';

/** 步骤时间线的一级节点 */
export interface StepTimelineNode {
  step: StepView;
  /** 该步骤的读数（含偏差与留档标记） */
  readings: ReadingView[];
  /** 同步偏差等级 */
  deviationLevel: ToleranceLevel;
  /** 综合限位等级（仅参与控制批口径的读数） */
  limitLevel: ToleranceLevel;
}

/** 时间线汇总 */
export interface StepTimelineSnapshot {
  steps: StepRow[];
  readings: ReadingRow[];
  readingBatches: ReadingBatchRow[];
  bearings: BearingRow[];
  bridges: BridgeRow[];
}

@Injectable({ providedIn: 'root' })
export class StepTimelineService {
  private readonly idb = inject(IdbTableService);

  /** 原始快照流 */
  readonly snapshot$: Observable<StepTimelineSnapshot> = this.idb
    .watch<StepTimelineSnapshot>(
      async () => {
        const [steps, readings, readingBatches, bearings, bridges] = await Promise.all([
          listSteps(),
          listReadings(),
          listReadingBatches(),
          listBearings(),
          listBridges(),
        ]);
        return { steps, readings, readingBatches, bearings, bridges };
      },
      { steps: [], readings: [], readingBatches: [], bearings: [], bridges: [] },
    )
    .pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** 步骤视图流：含累计顶升量、同步偏差与校验结论 */
  readonly stepViews$: Observable<StepView[]> = this.snapshot$.pipe(
    map((snapshot) => this.buildStepViews(snapshot)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 时间线节点流：步骤 + 该步读数 + 等级判定 */
  readonly timeline$: Observable<StepTimelineNode[]> = combineLatest([
    this.stepViews$,
    this.snapshot$,
  ]).pipe(
    map(([steps, snapshot]) => {
      const bridges = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
      return steps.map((step) => {
        const partition = partitionStepReadings(step.id, snapshot.readings, snapshot.readingBatches);
        const effectiveIds = new Set(partition.effective.map((item) => item.id));
        const average = meanDisplacement(partition.effective);
        const controlLabel = partition.legacy
          ? '旧步骤全部读数'
          : CONTROL_MODE_LABEL[partition.controlBatch!.mode];
        const stepReadings = snapshot.readings
          .filter((item) => item.stepId === step.id)
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
          .map<ReadingView>((reading) => {
            const inControl = effectiveIds.has(reading.id);
            return {
              ...reading,
              stepSeq: step.seq,
              bridgeId: step.bridgeId,
              bridgeName: bridges.get(step.bridgeId) ?? '未归属桥梁',
              syncRequirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
              deviationMm: inControl ? Number((reading.displacementMm - average).toFixed(3)) : 0,
              overLimit: inControl && Math.abs(reading.displacementMm) >= step.limitMm,
              stressAlert: inControl && reading.stressMpa >= 12,
              inControl,
              controlLabel: inControl ? controlLabel : '已留档',
            };
          });
        return {
          step,
          readings: stepReadings,
          deviationLevel: syncLevel(step.syncDeviationMm ?? 0),
          limitLevel: this.worstLevel(partition, step.limitMm),
        };
      });
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  private worstLevel(partition: StepReadingPartition, limitMm: number): ToleranceLevel {
    return partition.effective.reduce<ToleranceLevel>((worst, reading) => {
      const level = overallLevel(reading.displacementMm, limitMm, reading.stressMpa);
      if (level === 'exceed' || worst === 'exceed') return 'exceed';
      if (level === 'watch' || worst === 'watch') return 'watch';
      return 'ok';
    }, 'ok');
  }

  /** 按桥梁分组的步骤流 */
  readonly stepsByBridge$: Observable<Map<string, StepView[]>> = this.stepViews$.pipe(
    map((steps) => {
      const grouped = new Map<string, StepView[]>();
      for (const step of steps) {
        const list = grouped.get(step.bridgeId) ?? [];
        list.push(step);
        grouped.set(step.bridgeId, list);
      }
      return grouped;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 累计顶升量流：桥梁 id → 累计值 */
  readonly cumulativeLift$: Observable<Record<string, number>> = this.stepViews$.pipe(
    map((steps) => {
      const totals: Record<string, number> = {};
      for (const step of steps) {
        totals[step.bridgeId] = Number(((totals[step.bridgeId] ?? 0) + step.targetLiftMm).toFixed(2));
      }
      return totals;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 同步偏差流：步骤 id → 偏差（控制批口径） */
  readonly syncDeviation$: Observable<Record<string, number>> = this.snapshot$.pipe(
    map((snapshot) => {
      const result: Record<string, number> = {};
      for (const step of snapshot.steps) {
        result[step.id] = syncDeviationMm(
          partitionStepReadings(step.id, snapshot.readings, snapshot.readingBatches).effective,
        );
      }
      return result;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 构建步骤视图（供派生流与页面共用） */
  buildStepViews(snapshot: StepTimelineSnapshot): StepView[] {
    const bridgeName = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
    const ordered = sortSteps(snapshot.steps);
    const cumulative = new Map<string, number>();
    let running = 0;
    for (const step of ordered) {
      running += step.targetLiftMm;
      cumulative.set(step.id, Number(running.toFixed(2)));
    }
    return ordered.map((step) => {
      const partition = partitionStepReadings(step.id, snapshot.readings, snapshot.readingBatches);
      const cumulativeLiftMm = cumulative.get(step.id) ?? step.targetLiftMm;
      const deviation = partition.effective.length > 0 ? syncDeviationMm(partition.effective) : null;
      const overLimit = cumulativeLiftMm > step.limitMm;
      const caliber = partition.legacy
        ? '旧步骤全部读数'
        : CONTROL_MODE_LABEL[partition.controlBatch!.mode];
      const blockReason = arrivalGateReason({
        effectiveRows: partition.effective,
        deviationMm: deviation,
        limitMm: step.limitMm,
      });
      return {
        ...step,
        bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
        cumulativeLiftMm,
        overLimit,
        readingCount: snapshot.readings.filter((item) => item.stepId === step.id).length,
        effectiveReadingCount: partition.effective.length,
        syncDeviationMm: deviation,
        controlMode: partition.controlBatch?.mode ?? null,
        controlBatchAt: partition.controlBatch?.recordedAt ?? null,
        limitExceedCount: partition.effective.filter(
          (item) => step.limitMm > 0 && Math.abs(item.displacementMm) >= step.limitMm,
        ).length,
        arrivalBlocked: blockReason !== '',
        arrivalBlockReason: blockReason,
        validation: overLimit
          ? `累计顶升量 ${cumulativeLiftMm} mm 已超过限位 ${step.limitMm} mm，需立即停止并复核`
          : deviation !== null && syncLevel(deviation) === 'exceed'
            ? `同步偏差 ${deviation.toFixed(2)} mm 超允许值，需调平后继续（${caliber}）`
            : `顶升参数与${caliber}监测数据均在控制范围内`,
      };
    });
  }
}
