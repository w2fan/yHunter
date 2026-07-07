import type {
  CandidateInsight,
  DashboardData,
  DbShape,
  Holding,
  HoldingInsight,
  ManagerNavPoint,
  ProductSnapshot,
  StableCoreMetrics
} from "@/lib/types";
import { supportsCmbCfwebCashHistory } from "@/lib/manager-support";

const DAILY_TREND_WINDOW = 3;
const DAILY_TREND_LOOKBACK = 30;
const MAX_DAILY_TREND_GAP_DAYS = 7;
const STABLE_CORE_MAIN_WINDOW = 30;
const STABLE_CORE_RECENT_WINDOW = 14;
const STABLE_CORE_LONG_WINDOW = 60;
const MIN_STABLE_CORE_MAIN_SAMPLES = 14;
const MIN_STABLE_CORE_RECENT_SAMPLES = 7;
const MIN_STABLE_CORE_LONG_SAMPLES = 30;
const PER10K_SPIKE_CAP = 0.15;
const ROTATION_CONFIRM_GAP = 0.05;
const MIN_SWITCH_EXPECTED_LIFT = 0.05;
const SWITCH_EVALUATION_DAYS = 30;
const SWITCH_NO_YIELD_DAYS = 2;

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function expectsManagerHistory(product: ProductSnapshot): boolean {
  return (
    product.taCode === "66" ||
    product.taCode === "MS" ||
    (product.taCode === "ZY" && supportsCmbCfwebCashHistory(product.productName)) ||
    (product.taCode === "EW" && /阳光碧乐活/u.test(product.productName)) ||
    (product.taCode === "ZX" && /日盈象天天利/u.test(product.productName))
  );
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];

  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function groupSnapshotHistory(db: DbShape, productCode: string): ProductSnapshot[] {
  return db.snapshots
    .filter((snapshot) => snapshot.productCode === productCode)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

function groupPerformanceHistory(db: DbShape, productCode: string): ManagerNavPoint[] {
  const latestByDate = new Map<string, ManagerNavPoint>();

  for (const point of db.navHistory) {
    if (point.productCode !== productCode) continue;
    if (point.source === "spdb_report") continue;
    if (point.per10kProfit === null) continue;

    const key = `${point.source}:${point.navDate}`;
    const current = latestByDate.get(key);
    if (!current || current.fetchedAt < point.fetchedAt) {
      latestByDate.set(key, point);
    }
  }

  return [...latestByDate.values()].sort(
    (a, b) => a.navDate.localeCompare(b.navDate) || a.fetchedAt.localeCompare(b.fetchedAt)
  );
}

function latestByCode(products: ProductSnapshot[]): Map<string, ProductSnapshot> {
  const map = new Map<string, ProductSnapshot>();
  for (const product of products) {
    const current = map.get(product.productCode);
    if (!current || current.capturedAt < product.capturedAt) {
      map.set(product.productCode, product);
    }
  }
  return map;
}

function findPastRate(history: ProductSnapshot[], daysAgo: number): number | null {
  if (history.length === 0) return null;
  const latest = new Date(history.at(-1)!.capturedAt).getTime();
  const cutoff = latest - daysAgo * 24 * 60 * 60 * 1000;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const ts = new Date(history[i].capturedAt).getTime();
    if (ts <= cutoff) {
      return history[i].incomeRate;
    }
  }

  return history[0].incomeRate;
}

function daysBetween(laterDate: string, earlierDate: string): number {
  const later = new Date(`${laterDate}T00:00:00Z`).getTime();
  const earlier = new Date(`${earlierDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return Number.POSITIVE_INFINITY;
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

function continuousMetricHistory(
  history: ManagerNavPoint[],
  picker: (point: ManagerNavPoint) => number | null
): ManagerNavPoint[] {
  const latestByDate = new Map<string, ManagerNavPoint>();

  for (const point of history) {
    if (picker(point) === null) continue;

    const current = latestByDate.get(point.navDate);
    if (!current || current.fetchedAt < point.fetchedAt) {
      latestByDate.set(point.navDate, point);
    }
  }

  const sorted = [...latestByDate.values()].sort(
    (a, b) => a.navDate.localeCompare(b.navDate) || a.fetchedAt.localeCompare(b.fetchedAt)
  );
  const latest = sorted.at(-1);
  if (!latest) return [];

  const tail = [latest];
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const nextNewer = tail[0];
    const candidate = sorted[index];
    if (daysBetween(nextNewer.navDate, candidate.navDate) > MAX_DAILY_TREND_GAP_DAYS) {
      break;
    }
    tail.unshift(candidate);
  }

  return tail;
}

function averageField(
  history: ManagerNavPoint[],
  picker: (point: ManagerNavPoint) => number | null,
  count: number,
  offset = 0
): number | null {
  const start = Math.max(0, history.length - offset - count);
  const end = Math.max(0, history.length - offset);

  const slice = history
    .slice(start, end)
    .map(picker)
    .filter((value): value is number => value !== null);

  if (slice.length < count) return null;

  return average(slice);
}

function peakAverageField(history: ManagerNavPoint[], picker: (point: ManagerNavPoint) => number | null, count: number) {
  let peak: number | null = null;
  if (history.length < count) return peak;

  for (let offset = 0; offset <= history.length - count; offset += 1) {
    const value = averageField(history, picker, count, offset);
    if (value === null) continue;
    if (peak === null || value > peak) {
      peak = value;
    }
  }

  return peak;
}

function annualizedEquivalentFromPer10k(value: number | null): number | null {
  return value === null ? null : value * 3.65;
}

function recentPerformanceMetrics(history: ManagerNavPoint[]) {
  const per10kHistory = continuousMetricHistory(history, (point) => point.per10kProfit);
  const per10kMetricHistory = per10kHistory.slice(-DAILY_TREND_LOOKBACK);
  const recentPer10k = averageField(per10kMetricHistory, (point) => point.per10kProfit, DAILY_TREND_WINDOW);
  const priorPer10k = averageField(per10kMetricHistory, (point) => point.per10kProfit, DAILY_TREND_WINDOW, DAILY_TREND_WINDOW);
  const per10kAcceleration =
    recentPer10k !== null && priorPer10k !== null ? recentPer10k - priorPer10k : null;
  const peakPer10k = peakAverageField(per10kMetricHistory, (point) => point.per10kProfit, DAILY_TREND_WINDOW);
  const per10kDrawdown = recentPer10k !== null && peakPer10k !== null ? peakPer10k - recentPer10k : null;

  const recentAnnualized = averageField(per10kMetricHistory, (point) => point.annualizedYield, DAILY_TREND_WINDOW);
  const priorAnnualized = averageField(
    per10kMetricHistory,
    (point) => point.annualizedYield,
    DAILY_TREND_WINDOW,
    DAILY_TREND_WINDOW
  );

  return {
    recentPer10k,
    priorPer10k,
    per10kAcceleration,
    per10kDrawdown,
    recentAnnualized,
    priorAnnualized,
    acceleration: per10kAcceleration,
    drawdown: per10kDrawdown,
    dailyPerformanceSamples: per10kHistory.length,
    accelerationSource: per10kAcceleration !== null ? "per10k" : "none",
    drawdownSource: per10kDrawdown !== null ? "per10k" : "none"
  };
}

function winsorizedAverageAroundMedian(values: number[], medianValue: number | null): number | null {
  if (values.length === 0 || medianValue === null) return null;
  const cap = medianValue + PER10K_SPIKE_CAP;
  return average(values.map((value) => Math.min(value, cap)));
}

function stableWindowMedian(values: number[], minSamples: number): number | null {
  return values.length >= minSamples ? median(values) : null;
}

function stableWindowWinsorizedAverage(values: number[], minSamples: number): number | null {
  if (values.length < minSamples) return null;
  return winsorizedAverageAroundMedian(values, median(values));
}

function buildStableCoreMetrics(history: ManagerNavPoint[]): StableCoreMetrics {
  const per10kHistory = continuousMetricHistory(history, (point) => point.per10kProfit);
  const per10kSeries = per10kHistory
    .map((point) => ({
      navDate: point.navDate,
      value: point.per10kProfit
    }))
    .filter((point): point is { navDate: string; value: number } => point.value !== null);
  const latestPoint = per10kSeries.at(-1) ?? null;
  const rawFreshnessDays = latestPoint ? daysBetween(todayIsoDate(), latestPoint.navDate) : Number.POSITIVE_INFINITY;
  const navFreshnessDays = Number.isFinite(rawFreshnessDays) ? Math.max(0, rawFreshnessDays) : null;

  const values14 = per10kSeries.slice(-STABLE_CORE_RECENT_WINDOW).map((point) => point.value);
  const values30 = per10kSeries.slice(-STABLE_CORE_MAIN_WINDOW).map((point) => point.value);
  const values60 = per10kSeries.slice(-STABLE_CORE_LONG_WINDOW).map((point) => point.value);

  const recentPer10k30Median = stableWindowMedian(values30, MIN_STABLE_CORE_MAIN_SAMPLES);
  const recentPer10k30WinsorizedAvg = stableWindowWinsorizedAverage(values30, MIN_STABLE_CORE_MAIN_SAMPLES);
  const recentPer10k14Median = stableWindowMedian(values14, MIN_STABLE_CORE_RECENT_SAMPLES);
  const recentPer10k14WinsorizedAvg = stableWindowWinsorizedAverage(values14, MIN_STABLE_CORE_RECENT_SAMPLES);
  const recentPer10k60Median = stableWindowMedian(values60, MIN_STABLE_CORE_LONG_SAMPLES);
  const q75 = values30.length >= MIN_STABLE_CORE_MAIN_SAMPLES ? percentile(values30, 0.75) : null;
  const q25 = values30.length >= MIN_STABLE_CORE_MAIN_SAMPLES ? percentile(values30, 0.25) : null;
  const stability30 = q75 !== null && q25 !== null ? q75 - q25 : null;
  const spikeDays30 =
    recentPer10k30Median === null
      ? null
      : values30.filter((value) => value > recentPer10k30Median + PER10K_SPIKE_CAP).length;
  const stableCoreYield =
    recentPer10k30WinsorizedAvg ??
    recentPer10k30Median ??
    recentPer10k14WinsorizedAvg ??
    recentPer10k14Median ??
    null;

  return {
    stableCoreYield,
    stableCoreSamples: values30.length,
    recentPer10k30Median,
    recentPer10k30WinsorizedAvg,
    recentPer10k14Median,
    recentPer10k14WinsorizedAvg,
    recentPer10k60Median,
    spikeDays30,
    stability30,
    latestNavDate: latestPoint?.navDate ?? null,
    navFreshnessDays
  };
}

function roundStableCoreMetrics(metrics: StableCoreMetrics): StableCoreMetrics {
  return {
    stableCoreYield: round(metrics.stableCoreYield, 4),
    stableCoreSamples: metrics.stableCoreSamples,
    recentPer10k30Median: round(metrics.recentPer10k30Median, 4),
    recentPer10k30WinsorizedAvg: round(metrics.recentPer10k30WinsorizedAvg, 4),
    recentPer10k14Median: round(metrics.recentPer10k14Median, 4),
    recentPer10k14WinsorizedAvg: round(metrics.recentPer10k14WinsorizedAvg, 4),
    recentPer10k60Median: round(metrics.recentPer10k60Median, 4),
    spikeDays30: metrics.spikeDays30,
    stability30: round(metrics.stability30, 4),
    latestNavDate: metrics.latestNavDate,
    navFreshnessDays: metrics.navFreshnessDays
  };
}

function hasRecentCoreDeterioration(metrics: StableCoreMetrics): boolean {
  const coreYield = metrics.recentPer10k30WinsorizedAvg ?? metrics.recentPer10k30Median;
  const recentYield = metrics.recentPer10k14WinsorizedAvg ?? metrics.recentPer10k14Median;
  return coreYield !== null && recentYield !== null && recentYield < coreYield - 0.035;
}

function scoreStableCore(metrics: StableCoreMetrics, shouldHaveManagerHistory: boolean): number {
  const coreYield = metrics.stableCoreYield;
  if (coreYield === null) return shouldHaveManagerHistory ? -60 : -30;

  const recentYield = metrics.recentPer10k14WinsorizedAvg ?? metrics.recentPer10k14Median;
  const longYield = metrics.recentPer10k60Median;
  const recentConfirmationScore =
    recentYield === null
      ? -8
      : recentYield >= coreYield - 0.02
        ? 8 + Math.min(6, Math.max(0, (recentYield - coreYield) * 80))
        : Math.max(-18, (recentYield - coreYield) * 160);
  const longSupportScore =
    longYield === null
      ? -4
      : longYield >= coreYield - 0.05
        ? 8
        : Math.max(-12, (longYield - coreYield) * 120);
  const samplePenalty = metrics.stableCoreSamples >= STABLE_CORE_MAIN_WINDOW
    ? 0
    : Math.max(0, (STABLE_CORE_MAIN_WINDOW - metrics.stableCoreSamples) * 1.1);
  const freshnessPenalty =
    metrics.navFreshnessDays === null
      ? 25
      : metrics.navFreshnessDays <= 3
        ? 0
        : Math.min(30, (metrics.navFreshnessDays - 3) * 4);
  const stabilityPenalty = metrics.stability30 === null ? 10 : Math.min(24, metrics.stability30 * 80);
  const spikePenalty = metrics.spikeDays30 === null ? 8 : Math.min(24, metrics.spikeDays30 * 4);

  return coreYield * 100 + recentConfirmationScore + longSupportScore - samplePenalty - freshnessPenalty - stabilityPenalty - spikePenalty;
}

function classifyCandidateStage(metrics: StableCoreMetrics): CandidateInsight["stage"] {
  if (metrics.stableCoreYield === null) return "stale";
  if (metrics.navFreshnessDays === null || metrics.navFreshnessDays > 7) return "stale";
  if (metrics.stableCoreSamples < MIN_STABLE_CORE_MAIN_SAMPLES) return "watch";
  if (hasRecentCoreDeterioration(metrics)) return "watch";

  const stableEnough = metrics.stability30 !== null && metrics.stability30 <= 0.08;
  const lowSpikeCount = metrics.spikeDays30 !== null && metrics.spikeDays30 <= 3;
  const longTermSupport =
    metrics.recentPer10k60Median === null ||
    metrics.recentPer10k60Median >= metrics.stableCoreYield - 0.06;

  if (metrics.stableCoreSamples >= 25 && stableEnough && lowSpikeCount && longTermSupport) {
    return "core";
  }

  return "candidate";
}

function stableCoreConfidence(metrics: StableCoreMetrics, shouldHaveManagerHistory: boolean): "low" | "medium" | "high" {
  if (metrics.stableCoreYield === null) return "low";
  if (metrics.navFreshnessDays === null || metrics.navFreshnessDays > 7) return "low";
  if (metrics.stableCoreSamples >= 25 && metrics.stability30 !== null && metrics.stability30 <= 0.09) return "high";
  if (metrics.stableCoreSamples >= MIN_STABLE_CORE_MAIN_SAMPLES) return "medium";
  return shouldHaveManagerHistory ? "low" : "medium";
}

function estimateSwitchExpectedLift(currentCoreYield: number | null, candidateCoreYield: number | null) {
  if (currentCoreYield === null || candidateCoreYield === null) {
    return null;
  }

  return (
    (candidateCoreYield * (SWITCH_EVALUATION_DAYS - SWITCH_NO_YIELD_DAYS)) / SWITCH_EVALUATION_DAYS -
    currentCoreYield
  );
}

function buildHoldingInsight(
  holding: Holding,
  db: DbShape,
  marketBaseline: number | null,
  switchTarget: CandidateInsight | null
): HoldingInsight {
  const snapshotHistory = groupSnapshotHistory(db, holding.productCode);
  const performanceHistory = groupPerformanceHistory(db, holding.productCode);
  const performanceSamples = performanceHistory.length;
  const latest = snapshotHistory.at(-1) ?? null;
  const shouldHaveManagerHistory = latest ? expectsManagerHistory(latest) : false;

  const peakSnapshotRate = snapshotHistory.reduce<number | null>((max, item) => {
    if (item.incomeRate === null) return max;
    if (max === null || item.incomeRate > max) return item.incomeRate;
    return max;
  }, null);

  const rate = latest?.incomeRate ?? null;
  const past7 = findPastRate(snapshotHistory, 7);
  const sevenDayChange = rate !== null && past7 !== null ? rate - past7 : null;
  const marketGap = rate !== null && marketBaseline !== null ? rate - marketBaseline : null;
  const snapshotDrawdown = rate !== null && peakSnapshotRate !== null ? peakSnapshotRate - rate : null;
  const metrics = recentPerformanceMetrics(performanceHistory);
  const stableMetrics = buildStableCoreMetrics(performanceHistory);
  const hasSparsePerformanceHistory = performanceSamples >= 3 && metrics.dailyPerformanceSamples < 3;
  const bestCandidateCoreYield = switchTarget?.stableCoreYield ?? null;
  const bestCandidateCoreYieldGap =
    bestCandidateCoreYield !== null && stableMetrics.stableCoreYield !== null
      ? bestCandidateCoreYield - stableMetrics.stableCoreYield
      : null;
  const switchExpectedLiftPer10k = estimateSwitchExpectedLift(stableMetrics.stableCoreYield, bestCandidateCoreYield);

  const reasons: string[] = [];
  let signal: HoldingInsight["signal"] = "hold";
  let confidence: HoldingInsight["confidence"] = stableCoreConfidence(stableMetrics, shouldHaveManagerHistory);

  const hasPerformanceMetric = stableMetrics.stableCoreYield !== null || metrics.recentPer10k !== null;

  if ((!latest || rate === null) && !hasPerformanceMetric) {
    signal = "hold";
    reasons.push("当前样本还不够判断稳态核心收益，操作建议先持有，不因为一次展示收益变化卖出。");
    reasons.push("暂未抓到这只持仓的最新收益快照或管理人万份收益历史，等官网万份样本补齐后再判断是否卖出。");
    confidence = "low";
  } else {
    const dataStale = stableMetrics.navFreshnessDays === null || stableMetrics.navFreshnessDays > 7;
    const underSampled = stableMetrics.stableCoreYield === null || stableMetrics.stableCoreSamples < MIN_STABLE_CORE_MAIN_SAMPLES;
    const rotationGapMet = bestCandidateCoreYieldGap !== null && bestCandidateCoreYieldGap >= ROTATION_CONFIRM_GAP;
    const switchExpectedLiftMet =
      switchExpectedLiftPer10k !== null && switchExpectedLiftPer10k >= MIN_SWITCH_EXPECTED_LIFT;

    if (rotationGapMet && switchExpectedLiftMet && !dataStale && !underSampled) {
      signal = "sell";
    } else {
      signal = "hold";
    }

    if (signal === "sell") {
      reasons.push("持仓核心万份收益落后候选，且扣除在途拖累后预计万份收益提高达到阈值，操作建议卖出。");
    } else {
      reasons.push("操作建议持有；当前还没有满足卖出条件，低频策略下不为了小差距损失在途收益。");
    }

    if (!latest || rate === null) {
      reasons.push("浦发列表 7 日年化快照暂缺，本次主要依据管理人官网万份收益历史判断。");
    }
    if (stableMetrics.stableCoreYield !== null) {
      reasons.push(
        `近 30 日核心万份约 ${round(stableMetrics.stableCoreYield, 4)}，样本 ${stableMetrics.stableCoreSamples} 个观测日。`
      );
    }
    if (stableMetrics.recentPer10k14WinsorizedAvg !== null && stableMetrics.recentPer10k30WinsorizedAvg !== null) {
      const recentGap = stableMetrics.recentPer10k14WinsorizedAvg - stableMetrics.recentPer10k30WinsorizedAvg;
      reasons.push(
        recentGap >= -0.035
          ? "近 14 日截尾均值没有明显低于 30 日核心水平。"
          : "近 14 日截尾均值已经明显低于 30 日核心水平。"
      );
    }
    if (switchTarget && bestCandidateCoreYield !== null) {
      reasons.push(
        `换仓测算对标候选：${switchTarget.product.productName}（${switchTarget.product.productCode}），核心万份约 ${round(bestCandidateCoreYield, 4)}。`
      );
    }
    if (bestCandidateCoreYieldGap !== null) {
      reasons.push(
        bestCandidateCoreYieldGap >= ROTATION_CONFIRM_GAP
          ? `当前最佳候选核心万份高出约 ${round(bestCandidateCoreYieldGap, 4)}，已达到候选差距阈值。`
          : `当前最佳候选核心万份只高出约 ${round(bestCandidateCoreYieldGap, 4)}，不足以覆盖低频轮动的在途成本。`
      );
    }
    if (switchExpectedLiftPer10k !== null) {
      reasons.push(
        switchExpectedLiftPer10k >= MIN_SWITCH_EXPECTED_LIFT
          ? `按 ${SWITCH_EVALUATION_DAYS} 天低频持有、${SWITCH_NO_YIELD_DAYS} 天在途无收益折算，换仓后预计万份收益提高约 ${round(switchExpectedLiftPer10k, 4)}，达到卖出阈值。`
          : `按 ${SWITCH_EVALUATION_DAYS} 天低频持有、${SWITCH_NO_YIELD_DAYS} 天在途无收益折算，换仓后预计万份收益提高约 ${round(switchExpectedLiftPer10k, 4)}，未达到卖出阈值 ${MIN_SWITCH_EXPECTED_LIFT}。`
      );
    }
    if (stableMetrics.stability30 !== null) {
      reasons.push(`近 30 日万份收益 IQR 约 ${round(stableMetrics.stability30, 4)}，用于判断稳定性。`);
    }
    if (stableMetrics.spikeDays30 !== null && stableMetrics.spikeDays30 > 0) {
      reasons.push(`近 30 日有 ${stableMetrics.spikeDays30} 天超过中位数 +0.15，已按 spike 风险降权。`);
    }
    if (dataStale) {
      reasons.push("最新官网万份收益日期偏旧，调仓前需要先刷新确认。");
    }
    if (underSampled) {
      reasons.push(
        hasSparsePerformanceHistory
          ? "管理人官网万份收益历史存在大断档，暂不能拼成稳定 30 日核心窗口。"
          : "管理人官网万份收益样本还不够，暂不能形成稳定 30 日核心窗口。"
      );
    }
    if (marketGap !== null) {
      reasons.push(`浦发列表 7 日年化相对池内平均 ${round(marketGap)} 个百分点，仅作展示参考。`);
    }
    if (snapshotDrawdown !== null && snapshotDrawdown >= 0.3) {
      reasons.push("浦发列表展示收益率相对近期高点回落，但不单独作为卖出依据。");
    }
    if (metrics.recentPer10k !== null) {
      reasons.push(`最近 3 个观测点万份均值约 ${round(metrics.recentPer10k, 4)}，仅用于短期辅助观察。`);
    }
    if (reasons.length === 0) {
      reasons.push("当前核心万份收益没有出现明确走弱信号。");
    }
  }

  return {
    ...roundStableCoreMetrics(stableMetrics),
    holding,
    latest,
    latestHistory: snapshotHistory.slice(-10),
    navHistory: performanceHistory.slice(-12),
    performanceSamples,
    dailyPerformanceSamples: metrics.dailyPerformanceSamples,
    marketGap: round(marketGap),
    peakDrawdown: round(metrics.drawdown ?? snapshotDrawdown, metrics.drawdownSource === "per10k" ? 4 : 2),
    sevenDayChange: round(sevenDayChange),
    recentPer10k: round(metrics.recentPer10k, 4),
    priorPer10k: round(metrics.priorPer10k, 4),
    per10kAcceleration: round(metrics.per10kAcceleration, 4),
    per10kDrawdown: round(metrics.per10kDrawdown, 4),
    recentAnnualized: round(metrics.recentAnnualized),
    priorAnnualized: round(metrics.priorAnnualized),
    acceleration: round(metrics.acceleration, metrics.accelerationSource === "per10k" ? 4 : 2),
    switchTargetProductCode: switchTarget?.product.productCode ?? null,
    switchTargetProductName: switchTarget?.product.productName ?? null,
    bestCandidateCoreYield: round(bestCandidateCoreYield, 4),
    bestCandidateCoreYieldGap: round(bestCandidateCoreYieldGap, 4),
    switchExpectedLiftPer10k: round(switchExpectedLiftPer10k, 4),
    signal,
    confidence,
    reasons
  };
}

function buildCandidateInsight(
  product: ProductSnapshot,
  db: DbShape,
  marketMedian: number | null
): CandidateInsight {
  const snapshotHistory = groupSnapshotHistory(db, product.productCode);
  const performanceHistory = groupPerformanceHistory(db, product.productCode);
  const performanceSamples = performanceHistory.length;
  const shouldHaveManagerHistory = expectsManagerHistory(product);
  const currentRate = product.incomeRate;
  const firstSeenAt = snapshotHistory[0]?.capturedAt ?? null;
  const recentBase = findPastRate(snapshotHistory, 3);
  const recentChange = currentRate !== null && recentBase !== null ? currentRate - recentBase : null;
  const marketPremium = currentRate !== null && marketMedian !== null ? currentRate - marketMedian : null;
  const metrics = recentPerformanceMetrics(performanceHistory);
  const stableMetrics = buildStableCoreMetrics(performanceHistory);
  const hasSparsePerformanceHistory = performanceSamples >= 3 && metrics.dailyPerformanceSamples < 3;
  const score = scoreStableCore(stableMetrics, shouldHaveManagerHistory);
  const stage = classifyCandidateStage(stableMetrics);
  const confidence = stableCoreConfidence(stableMetrics, shouldHaveManagerHistory);

  const reasons: string[] = [];
  if (stage === "core") {
    reasons.push("近 30 日核心万份收益稳定靠前，可进入 2-4 只稳态持仓的核心比较池。");
  } else if (stage === "candidate") {
    reasons.push("核心万份收益有吸引力，但样本、稳定性或长期背书还需要继续确认。");
  } else if (stage === "watch") {
    reasons.push("当前只适合观察，近期确认、样本量或波动稳定性还没有达到核心候选标准。");
  } else {
    reasons.push("官网万份收益数据不足或日期偏旧，先不要作为换仓依据。");
  }
  if (stableMetrics.stableCoreYield !== null) {
    reasons.push(
      `近 30 日核心万份约 ${round(stableMetrics.stableCoreYield, 4)}，主信号来自 30 日截尾均值/中位数。`
    );
  }
  if (stableMetrics.recentPer10k30WinsorizedAvg !== null) {
    reasons.push(`30 日截尾均值约 ${round(stableMetrics.recentPer10k30WinsorizedAvg, 4)}，单日 spike 按中位数 +0.15 截尾。`);
  }
  if (stableMetrics.recentPer10k14WinsorizedAvg !== null && stableMetrics.recentPer10k30WinsorizedAvg !== null) {
    const recentGap = stableMetrics.recentPer10k14WinsorizedAvg - stableMetrics.recentPer10k30WinsorizedAvg;
    reasons.push(
      recentGap >= -0.035
        ? "近 14 日截尾均值没有明显变差，近期确认通过。"
        : "近 14 日截尾均值低于 30 日核心值，已在排序里降权。"
    );
  }
  if (stableMetrics.recentPer10k60Median !== null) {
    reasons.push(`60 日万份中位数约 ${round(stableMetrics.recentPer10k60Median, 4)}，用于稳定性背书。`);
  }
  if (stableMetrics.stability30 !== null) {
    reasons.push(`30 日稳定性 IQR 约 ${round(stableMetrics.stability30, 4)}，越小越适合低频持有。`);
  }
  if (stableMetrics.spikeDays30 !== null && stableMetrics.spikeDays30 > 0) {
    reasons.push(`近 30 日有 ${stableMetrics.spikeDays30} 天超过中位数 +0.15，避免把单日脉冲当主信号。`);
  }
  if (stableMetrics.latestNavDate !== null) {
    reasons.push(`最新官网万份日期 ${stableMetrics.latestNavDate}，距今 ${stableMetrics.navFreshnessDays ?? "--"} 天。`);
  }
  if (stableMetrics.stableCoreSamples < MIN_STABLE_CORE_MAIN_SAMPLES) {
    reasons.push(
      hasSparsePerformanceHistory
        ? "管理人官网万份收益历史存在大断档，暂不能拼成稳定 30 日核心窗口，已在排序里降权。"
        : shouldHaveManagerHistory
        ? "这类产品理论上应该能抓到官网万份收益历史，但当前样本还不够，已在排序里额外降权。"
        : "管理人官网万份收益历史样本还不够，当前不应只看浦发快照。"
    );
  }
  if (marketPremium !== null) {
    reasons.push(`浦发列表 7 日年化相对池内中位数 ${round(marketPremium)} 个百分点，仅作展示参考，不进入买入主信号。`);
  }
  if (metrics.recentPer10k !== null) {
    reasons.push(`最近 3 个观测点万份均值约 ${round(metrics.recentPer10k, 4)}，仅作短期辅助观察。`);
  }
  if (recentChange !== null) {
    reasons.push(
      recentChange >= 0
        ? "浦发列表展示收益近期上行，但不作为追买信号。"
        : "浦发列表展示收益近期回落，本次仅作为参考信息。"
    );
  }

  return {
    ...roundStableCoreMetrics(stableMetrics),
    product,
    latestHistory: snapshotHistory.slice(-10),
    navHistory: performanceHistory.slice(-12),
    performanceSamples,
    dailyPerformanceSamples: metrics.dailyPerformanceSamples,
    score: round(score) ?? 0,
    stage,
    confidence,
    reasons,
    marketPremium: round(marketPremium),
    recentChange: round(recentChange),
    recentPer10k: round(metrics.recentPer10k, 4),
    priorPer10k: round(metrics.priorPer10k, 4),
    per10kAcceleration: round(metrics.per10kAcceleration, 4),
    per10kDrawdown: round(metrics.per10kDrawdown, 4),
    recentAnnualized: round(metrics.recentAnnualized),
    priorAnnualized: round(metrics.priorAnnualized),
    acceleration: round(metrics.acceleration, metrics.accelerationSource === "per10k" ? 4 : 2),
    firstSeenAt
  };
}

export function buildDashboard(db: DbShape, marketProducts: ProductSnapshot[]): DashboardData {
  const latestMarketMap = latestByCode(marketProducts);
  const latestMarket = [...latestMarketMap.values()];
  const marketRates = latestMarket
    .map((product) => product.incomeRate)
    .filter((rate): rate is number => rate !== null);
  const marketAverage = average(marketRates);
  const marketMedian = median(marketRates);

  const holdingCodes = new Set(db.holdings.map((item) => item.productCode));

  const candidates = latestMarket
    .filter((product) => !holdingCodes.has(product.productCode))
    .map((product) => buildCandidateInsight(product, db, marketMedian))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  const switchTarget = candidates.find((candidate) => candidate.stableCoreYield !== null) ?? null;
  const holdings = db.holdings.map((holding) => buildHoldingInsight(holding, db, marketAverage, switchTarget));

  return {
    generatedAt: new Date().toISOString(),
    lastSyncedAt: db.lastSyncedAt,
    lastRefreshSummary: db.lastRefreshSummary,
    marketSummary: {
      totalProducts: latestMarket.length,
      averageYield: round(marketAverage),
      medianYield: round(marketMedian),
      highestYield: marketRates.length ? round(Math.max(...marketRates)) : null
    },
    holdings,
    candidates
  };
}
