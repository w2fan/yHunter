import type {
  CandidateInsight,
  DashboardData,
  DbShape,
  Holding,
  HoldingInsight,
  ManagerNavPoint,
  ProductSnapshot
} from "@/lib/types";
import { supportsCmbCfwebCashHistory } from "@/lib/manager-support";

const DAILY_TREND_WINDOW = 3;
const DAILY_TREND_LOOKBACK = 30;
const MAX_DAILY_TREND_GAP_DAYS = 7;

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

function buildHoldingInsight(holding: Holding, db: DbShape, marketBaseline: number | null): HoldingInsight {
  const snapshotHistory = groupSnapshotHistory(db, holding.productCode);
  const performanceHistory = groupPerformanceHistory(db, holding.productCode);
  const performanceSamples = performanceHistory.length;
  const latest = snapshotHistory.at(-1) ?? null;

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
  const performanceTrendSamples = metrics.dailyPerformanceSamples;
  const hasShortPerformanceTrend = performanceTrendSamples >= 3;
  const hasReliablePerformanceTrend = performanceTrendSamples >= 6;
  const hasSparsePerformanceHistory = performanceSamples >= 3 && metrics.dailyPerformanceSamples < 3;

  const reasons: string[] = [];
  let signal: HoldingInsight["signal"] = "hold";
  let confidence: HoldingInsight["confidence"] =
    hasReliablePerformanceTrend ? "high" : hasShortPerformanceTrend || snapshotHistory.length >= 4 ? "medium" : "low";

  const hasPerformanceMetric = metrics.recentPer10k !== null;

  if ((!latest || rate === null) && !hasPerformanceMetric) {
    signal = "insufficient_data";
    reasons.push("当前样本还不够判断去留，先别因为一次榜单波动就调仓。");
    reasons.push("暂未抓到这只持仓的最新收益快照或管理人万份收益历史，先不要依据当前结果调仓。");
    confidence = "low";
  } else {
    const usesPer10kTrend = metrics.recentPer10k !== null;
    const per10kPullback =
      (metrics.per10kDrawdown !== null && metrics.per10kDrawdown >= 0.08) ||
      (metrics.per10kAcceleration !== null && metrics.per10kAcceleration <= -0.05);
    const weakPerformance =
      (usesPer10kTrend &&
        ((metrics.per10kAcceleration !== null && metrics.per10kAcceleration < 0) ||
          (metrics.per10kDrawdown !== null && metrics.per10kDrawdown >= 0.04)));
    const confirmedPerformancePullback =
      hasReliablePerformanceTrend &&
      per10kPullback;

    const sellLike =
      hasReliablePerformanceTrend &&
      (confirmedPerformancePullback ||
        (marketGap !== null && marketGap <= 0.08 && weakPerformance) ||
        (marketGap !== null && marketGap < 0 && weakPerformance) ||
        (marketGap !== null && marketGap <= 0.1 && snapshotDrawdown !== null && snapshotDrawdown >= 0.2));

    const watchLike =
      !sellLike &&
      ((hasShortPerformanceTrend && weakPerformance) ||
        (marketGap !== null && marketGap <= 0.2) ||
        (sevenDayChange !== null && sevenDayChange < 0) ||
        (!hasShortPerformanceTrend && snapshotDrawdown !== null && snapshotDrawdown >= 0.2));

    if (sellLike) {
      signal = "sell";
    } else if (watchLike) {
      signal = "watch";
    } else {
      signal = "hold";
    }

    if (signal === "sell") {
      reasons.push("万份收益已经确认从高位回落，短期重新冲回强势区的概率不高，建议直接换到更强的产品。");
    } else if (signal === "watch") {
      reasons.push("当前还没弱到必须卖，但万份收益已有走弱迹象，接下来几次刷新要重点盯。");
    } else {
      reasons.push("当前万份收益主线还没出现明确走弱，暂时没必要急着动这只持仓。");
    }

    if (!latest || rate === null) {
      reasons.push("浦发列表快照暂缺，本次主要依据管理人官网万份收益历史判断。");
    }
    if (!hasShortPerformanceTrend) {
      reasons.push(
        hasSparsePerformanceHistory
          ? "管理人官网万份收益历史存在大断档，暂不能拿来计算日频动能，浦发列表快照仅作横向参考。"
          : "管理人官网万份收益日频样本还不够，浦发列表快照仅作横向参考，只适合先观察。"
      );
    }
    if (marketGap !== null && marketGap <= 0.1) {
      reasons.push("浦发列表展示收益率已经接近或低于市场平均水平。");
    }
    if (snapshotDrawdown !== null && snapshotDrawdown >= 0.3) {
      reasons.push("浦发列表展示收益率相对近期高点已经出现明显回落。");
    }
    if (sevenDayChange !== null && sevenDayChange <= -0.12) {
      reasons.push("最近 7 天浦发列表收益快照下滑较快。");
    }
    if (metrics.recentPer10k !== null) {
      reasons.push(`最近 3 个观测点的万份收益均值约 ${round(metrics.recentPer10k, 4)}。`);
    }
    if (metrics.per10kAcceleration !== null) {
      reasons.push(
        metrics.per10kAcceleration >= 0 ? "万份收益较上一阶段继续抬升。" : "万份收益较上一阶段回落。"
      );
    }
    if (metrics.per10kDrawdown !== null && metrics.per10kDrawdown >= 0.04) {
      reasons.push(`万份收益距近期高点回落约 ${round(metrics.per10kDrawdown, 4)}。`);
    }
    if (reasons.length === 0) {
      reasons.push("当前万份收益没有出现明确走弱信号。");
    }
  }

  return {
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
    signal,
    confidence,
    reasons
  };
}

function buildCandidateInsight(
  product: ProductSnapshot,
  db: DbShape,
  marketAverage: number | null,
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
  const ageDays = firstSeenAt
    ? Math.max(0, Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / (24 * 60 * 60 * 1000)))
    : null;

  const freshnessScore = ageDays === null ? 18 : Math.max(0, 18 - ageDays);
  const premiumScore = marketPremium === null ? 0 : Math.max(0, marketPremium * 22);
  const momentumScore =
    recentChange === null
      ? 5
      : recentChange >= 0
        ? 12 + recentChange * 30
        : Math.max(0, 10 + recentChange * 40);

  const metrics = recentPerformanceMetrics(performanceHistory);
  const performanceTrendSamples = metrics.dailyPerformanceSamples;
  const hasShortPerformanceTrend = performanceTrendSamples >= 3;
  const hasReliablePerformanceTrend = performanceTrendSamples >= 6;
  const hasSparsePerformanceHistory = performanceSamples >= 3 && metrics.dailyPerformanceSamples < 3;
  const hasPer10kTrend = metrics.recentPer10k !== null;
  const recentPer10kAnnualized = annualizedEquivalentFromPer10k(metrics.recentPer10k);
  const performanceScore = hasShortPerformanceTrend
    ? hasPer10kTrend
      ? Math.max(
          0,
          (metrics.recentPer10k ?? 0) * 2.2 +
            (metrics.per10kAcceleration ?? 0) * 12 -
            (metrics.per10kDrawdown ?? 0) * 4
        )
      : 0
    : 0;
  const historyPenalty =
    hasShortPerformanceTrend
      ? 0
      : shouldHaveManagerHistory
        ? metrics.dailyPerformanceSamples === 0
          ? 60
          : 32
        : metrics.dailyPerformanceSamples === 0
          ? 24
          : 12;
  const score = premiumScore + freshnessScore + momentumScore + performanceScore - historyPenalty;

  let stage: CandidateInsight["stage"] = "warming_up";
  if (hasShortPerformanceTrend) {
    const premium = marketPremium ?? 0;
    const change = recentChange ?? 0;
    const clearlyAheadByPer10k =
      recentPer10kAnnualized !== null && marketAverage !== null
        ? recentPer10kAnnualized >= marketAverage + 0.25
        : metrics.recentPer10k !== null && metrics.recentPer10k >= 0.65;
    const clearlyAhead = premium >= 0.6 || clearlyAheadByPer10k;
    const stillRunningHot =
      metrics.per10kAcceleration !== null
        ? metrics.per10kAcceleration >= 0.015 || (metrics.per10kAcceleration >= 0 && change >= 0.08)
        : false;
    const trulyCooling =
      hasReliablePerformanceTrend &&
      premium < 0.45 &&
      (hasPer10kTrend &&
        change <= 0.05 &&
        ((metrics.per10kAcceleration !== null && metrics.per10kAcceleration <= -0.025) ||
          (metrics.per10kDrawdown !== null && metrics.per10kDrawdown >= 0.06)));

    if (hasReliablePerformanceTrend && clearlyAhead && stillRunningHot) {
      stage = "fresh_spike";
    } else if (trulyCooling) {
      stage = "fading";
    } else if (clearlyAhead) {
      stage = "mature";
    }
  }

  const reasons: string[] = [];
  if (stage === "fresh_spike") {
    reasons.push("万份收益仍在抬升，当前处在强势冲榜区间，适合优先放进对比名单。");
  } else if (stage === "mature") {
    reasons.push("万份收益处在高位稳定区间，吸引力还在，但更适合和同梯队产品横向比较。");
  } else if (stage === "fading") {
    reasons.push("万份收益开始回落，先别因为榜单位置靠前就直接追进去。");
  } else {
    reasons.push("当前还在观察期，先看后续几次万份收益能不能继续走强。");
  }
  if (!hasShortPerformanceTrend) {
    reasons.push(
      hasSparsePerformanceHistory
        ? "管理人官网万份收益历史存在大断档，暂不能拿来计算日频动能，已在排序里降权。"
        : shouldHaveManagerHistory
        ? "这类产品理论上应该能抓到官网万份收益历史，但当前样本还不够，已在排序里额外降权，先别只看浦发快照就追高。"
        : "管理人官网万份收益历史样本还不够，当前候选排序主要参考浦发列表快照，可信度会低一些。"
    );
  }
  if (marketPremium !== null) {
    reasons.push(`浦发列表展示收益率相对池内中位数溢价 ${round(marketPremium)} 个百分点。`);
  }
  if (ageDays !== null) {
    reasons.push(`本地首次发现距今 ${ageDays} 天，越短通常越接近打榜起点。`);
  } else {
    reasons.push("这是首次纳入本地观察，可能正处于较早阶段。");
  }
  if (metrics.recentPer10k !== null) {
    reasons.push(`最近 3 个观测点的万份收益均值约 ${round(metrics.recentPer10k, 4)}。`);
  }
  if (metrics.per10kAcceleration !== null) {
    reasons.push(
      metrics.per10kAcceleration >= 0 ? "万份收益较上一阶段继续抬升。" : "万份收益较上一阶段回落。"
    );
  }
  if (metrics.per10kDrawdown !== null && metrics.per10kDrawdown >= 0.04) {
    reasons.push(`万份收益距近期高点回落约 ${round(metrics.per10kDrawdown, 4)}。`);
  }
  if (recentChange !== null) {
    reasons.push(recentChange >= 0 ? "最近几次浦发列表快照仍在走强。" : "最近几次浦发列表快照较前几日回落。");
  } else {
    reasons.push("历史样本还少，当前判断更多依赖横向比较。");
  }
  if (marketAverage !== null && currentRate !== null && currentRate < marketAverage) {
    reasons.push("浦发列表展示收益率已经低于候选池平均值，应降低优先级。");
  }

  return {
    product,
    latestHistory: snapshotHistory.slice(-10),
    navHistory: performanceHistory.slice(-12),
    performanceSamples,
    dailyPerformanceSamples: metrics.dailyPerformanceSamples,
    score: round(score) ?? 0,
    stage,
    confidence:
      hasReliablePerformanceTrend
        ? "high"
        : hasShortPerformanceTrend
          ? "medium"
          : shouldHaveManagerHistory
            ? "low"
            : snapshotHistory.length >= 2
              ? "medium"
              : "low",
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

  const holdings = db.holdings.map((holding) => buildHoldingInsight(holding, db, marketAverage));
  const holdingCodes = new Set(db.holdings.map((item) => item.productCode));

  const candidates = latestMarket
    .filter((product) => !holdingCodes.has(product.productCode))
    .map((product) => buildCandidateInsight(product, db, marketAverage, marketMedian))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

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
