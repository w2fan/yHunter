import type {
  CandidateInsight,
  DashboardData,
  DbShape,
  Holding,
  HoldingInsight,
  ManagerNavPoint,
  ProductSnapshot
} from "@/lib/types";

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
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
  return db.navHistory
    .filter((point) => point.productCode === productCode)
    .filter((point) => point.annualizedYield !== null || point.per10kProfit !== null)
    .sort((a, b) => a.navDate.localeCompare(b.navDate));
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

  return average(slice);
}

function recentPerformanceMetrics(history: ManagerNavPoint[]) {
  const recentAnnualized = averageField(history, (point) => point.annualizedYield, 3);
  const priorAnnualized = averageField(history, (point) => point.annualizedYield, 3, 3);
  const recentPer10k = averageField(history, (point) => point.per10kProfit, 3);
  const priorPer10k = averageField(history, (point) => point.per10kProfit, 3, 3);
  const acceleration =
    recentAnnualized !== null && priorAnnualized !== null ? recentAnnualized - priorAnnualized : null;
  const per10kAcceleration =
    recentPer10k !== null && priorPer10k !== null ? recentPer10k - priorPer10k : null;

  let peakAnnualized: number | null = null;
  if (history.length >= 3) {
    for (let offset = 0; offset <= history.length - 3; offset += 1) {
      const value = averageField(history, (point) => point.annualizedYield, 3, offset);
      if (value === null) continue;
      if (peakAnnualized === null || value > peakAnnualized) {
        peakAnnualized = value;
      }
    }
  }

  const drawdown =
    recentAnnualized !== null && peakAnnualized !== null ? peakAnnualized - recentAnnualized : null;

  return {
    recentAnnualized,
    priorAnnualized,
    recentPer10k,
    priorPer10k,
    acceleration,
    per10kAcceleration,
    drawdown
  };
}

function buildHoldingInsight(holding: Holding, db: DbShape, marketBaseline: number | null): HoldingInsight {
  const snapshotHistory = groupSnapshotHistory(db, holding.productCode);
  const performanceHistory = groupPerformanceHistory(db, holding.productCode);
  const performanceSamples = performanceHistory.length;
  const hasShortPerformanceTrend = performanceSamples >= 3;
  const hasReliablePerformanceTrend = performanceSamples >= 5;
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

  const reasons: string[] = [];
  let signal: HoldingInsight["signal"] = "hold";
  let confidence: HoldingInsight["confidence"] =
    hasReliablePerformanceTrend ? "high" : hasShortPerformanceTrend || snapshotHistory.length >= 4 ? "medium" : "low";

  if (!latest || rate === null) {
    signal = "insufficient_data";
    reasons.push("暂未抓到这只持仓的最新收益快照，先不要依据当前结果调仓。");
    confidence = "low";
  } else {
    if (!hasShortPerformanceTrend) {
      reasons.push("管理人官网的 7 日年化和万份收益历史样本还不够，当前判断以浦发列表快照为主，只适合先观察。");
    }
    if (marketGap !== null && marketGap <= 0.1) {
      reasons.push("当前收益已经接近或低于市场平均水平。");
    }
    if (snapshotDrawdown !== null && snapshotDrawdown >= 0.3) {
      reasons.push("相对近期收益高点已经出现明显回落。");
    }
    if (sevenDayChange !== null && sevenDayChange <= -0.12) {
      reasons.push("最近 7 天列表收益快照下滑较快。");
    }
    if (metrics.recentAnnualized !== null) {
      reasons.push(`最近 3 个观测点的 7 日年化均值约 ${round(metrics.recentAnnualized)}%。`);
    }
    if (metrics.recentPer10k !== null) {
      reasons.push(`最近 3 个观测点的万份收益均值约 ${round(metrics.recentPer10k, 4)}。`);
    }
    if (metrics.acceleration !== null && metrics.acceleration < 0) {
      reasons.push("短期 7 日年化较上一阶段转弱。");
    }
    if (metrics.per10kAcceleration !== null && metrics.per10kAcceleration < 0) {
      reasons.push("万份收益较上一阶段回落。");
    }

    const sellLike =
      hasReliablePerformanceTrend &&
      ((marketGap !== null &&
        marketGap <= 0.08 &&
        metrics.recentAnnualized !== null &&
        marketBaseline !== null &&
        metrics.recentAnnualized <= marketBaseline) ||
        (marketGap !== null && marketGap < 0 && metrics.acceleration !== null && metrics.acceleration <= -0.35) ||
        (marketGap !== null &&
          marketGap < 0 &&
          metrics.per10kAcceleration !== null &&
          metrics.per10kAcceleration < 0) ||
        (marketGap !== null && marketGap <= 0.1 && snapshotDrawdown !== null && snapshotDrawdown >= 0.2));

    const watchLike =
      !sellLike &&
      ((hasShortPerformanceTrend && metrics.acceleration !== null && metrics.acceleration < 0) ||
        (hasShortPerformanceTrend &&
          metrics.per10kAcceleration !== null &&
          metrics.per10kAcceleration < 0) ||
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

    if (reasons.length === 0) {
      reasons.push("当前收益和收益动能都没有出现明确走弱信号。");
    }
  }

  return {
    holding,
    latest,
    latestHistory: snapshotHistory.slice(-10),
    navHistory: performanceHistory.slice(-12),
    performanceSamples,
    marketGap: round(marketGap),
    peakDrawdown: round(metrics.drawdown ?? snapshotDrawdown),
    sevenDayChange: round(sevenDayChange),
    recentAnnualized: round(metrics.recentAnnualized),
    priorAnnualized: round(metrics.priorAnnualized),
    acceleration: round(metrics.acceleration),
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
  const hasShortPerformanceTrend = performanceSamples >= 3;
  const hasReliablePerformanceTrend = performanceSamples >= 5;
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
  const performanceScore = hasShortPerformanceTrend
    ? Math.max(
        0,
        (metrics.recentAnnualized ?? 0) * 0.5 +
          (metrics.acceleration ?? 0) * 0.8
      )
    : 0;
  const score = premiumScore + freshnessScore + momentumScore + performanceScore;

  let stage: CandidateInsight["stage"] = "warming_up";
  if (hasShortPerformanceTrend) {
    if (
      hasReliablePerformanceTrend &&
      (metrics.recentAnnualized ?? 0) >= ((marketAverage ?? 0) + 0.25) &&
      (metrics.acceleration ?? 0) > 0.08
    ) {
      stage = "fresh_spike";
    } else if (hasReliablePerformanceTrend && (metrics.acceleration ?? 0) < -0.08) {
      stage = "fading";
    } else if (
      (marketPremium ?? 0) >= 0.4 ||
      (metrics.recentAnnualized ?? 0) >= ((marketAverage ?? 0) + 0.4)
    ) {
      stage = "mature";
    }
  }

  const reasons: string[] = [];
  if (!hasShortPerformanceTrend) {
    reasons.push("管理人官网的 7 日年化和万份收益历史样本还不够，当前候选排序主要参考浦发列表快照。");
  }
  if (marketPremium !== null) {
    reasons.push(`相对池内中位收益溢价 ${round(marketPremium)} 个百分点。`);
  }
  if (ageDays !== null) {
    reasons.push(`本地首次发现距今 ${ageDays} 天，越短通常越接近打榜起点。`);
  } else {
    reasons.push("这是首次纳入本地观察，可能正处于较早阶段。");
  }
  if (metrics.recentAnnualized !== null) {
    reasons.push(`最近 3 个观测点的 7 日年化均值约 ${round(metrics.recentAnnualized)}%。`);
  }
  if (metrics.recentPer10k !== null) {
    reasons.push(`最近 3 个观测点的万份收益均值约 ${round(metrics.recentPer10k, 4)}。`);
  }
  if (metrics.acceleration !== null) {
    reasons.push(
      metrics.acceleration >= 0 ? "短期 7 日年化动能在增强。" : "短期 7 日年化动能已经回落，注意别追在尾声。"
    );
  } else if (recentChange !== null) {
    reasons.push(recentChange >= 0 ? "最近几次收益快照仍在走强。" : "最近几次收益快照已经回落。");
  } else {
    reasons.push("历史样本还少，当前判断更多依赖横向比较。");
  }
  if (marketAverage !== null && currentRate !== null && currentRate < marketAverage) {
    reasons.push("当前收益已经低于候选池平均值，应降低优先级。");
  }

  return {
    product,
    latestHistory: snapshotHistory.slice(-10),
    navHistory: performanceHistory.slice(-12),
    performanceSamples,
    score: round(score) ?? 0,
    stage,
    confidence: hasReliablePerformanceTrend ? "high" : hasShortPerformanceTrend || snapshotHistory.length >= 2 ? "medium" : "low",
    reasons,
    marketPremium: round(marketPremium),
    recentChange: round(recentChange),
    recentAnnualized: round(metrics.recentAnnualized),
    priorAnnualized: round(metrics.priorAnnualized),
    acceleration: round(metrics.acceleration),
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
