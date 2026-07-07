"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { YieldHistoryChart } from "@/components/yield-history-chart";
import type { CandidateInsight, DashboardData, HoldingInsight, ManagerNavPoint, StableCoreMetrics } from "@/lib/types";

type RefreshProgress = {
  active: boolean;
  stage: string;
  detail: string | null;
  currentManager: string | null;
  currentProduct: string | null;
  processed: number;
  total: number;
  startedAt: string | null;
  updatedAt: string;
};

type Per10kInsightFields = {
  recentPer10k?: number | null;
  priorPer10k?: number | null;
  per10kAcceleration?: number | null;
  per10kDrawdown?: number | null;
  dailyPerformanceSamples?: number;
};

type InsightWithPer10k = (HoldingInsight | CandidateInsight) & Per10kInsightFields;

type Per10kSeriesPoint = {
  date: string;
  value: number;
};

type HomePageProps = {
  appVersion: string;
};

function formatRefreshFailure(progress: RefreshProgress | null, fallback: string) {
  const location = progress?.currentProduct
    ? `${progress.currentManager ?? "管理人官网"} / ${progress.currentProduct}`
    : progress?.currentManager ?? progress?.detail;

  if (!location) return fallback;
  return `${fallback}（卡在 ${location}）`;
}

const signalText = {
  sell: "卖出",
  hold: "持有"
} as const;

function formatRate(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}%`;
}

function formatDiff(value: number | null) {
  if (value === null) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)} pct`;
}

function formatPer10k(value: number | null) {
  return value === null ? "--" : value.toFixed(4);
}

function formatPer10kDiff(value: number | null) {
  if (value === null) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(4)}`;
}

function formatSampleCount(value: number) {
  return `${value} 条`;
}

function formatDays(value: number | null) {
  return value === null ? "--" : `${value} 天`;
}

function formatSpikeDays(value: number | null) {
  return value === null ? "--" : `${value} 天`;
}

function DetailLabel({ children, help }: { children: string; help: string }) {
  return (
    <div className="detail-label" title={help}>
      {children}
    </div>
  );
}

const emptyStableCoreMetrics: StableCoreMetrics = {
  stableCoreYield: null,
  stableCoreSamples: 0,
  recentPer10k30Median: null,
  recentPer10k30WinsorizedAvg: null,
  recentPer10k14Median: null,
  recentPer10k14WinsorizedAvg: null,
  recentPer10k60Median: null,
  spikeDays30: null,
  stability30: null,
  latestNavDate: null,
  navFreshnessDays: null
};

function pickStableCoreMetrics(insight: StableCoreMetrics): StableCoreMetrics {
  return {
    stableCoreYield: insight.stableCoreYield,
    stableCoreSamples: insight.stableCoreSamples,
    recentPer10k30Median: insight.recentPer10k30Median,
    recentPer10k30WinsorizedAvg: insight.recentPer10k30WinsorizedAvg,
    recentPer10k14Median: insight.recentPer10k14Median,
    recentPer10k14WinsorizedAvg: insight.recentPer10k14WinsorizedAvg,
    recentPer10k60Median: insight.recentPer10k60Median,
    spikeDays30: insight.spikeDays30,
    stability30: insight.stability30,
    latestNavDate: insight.latestNavDate,
    navFreshnessDays: insight.navFreshnessDays
  };
}

function daysBetween(laterDate: string, earlierDate: string) {
  const later = new Date(`${laterDate}T00:00:00Z`).getTime();
  const earlier = new Date(`${earlierDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return Number.POSITIVE_INFINITY;
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

function buildPer10kSeries(history: ManagerNavPoint[]): Per10kSeriesPoint[] {
  const latestByDate = new Map<string, ManagerNavPoint>();

  for (const item of history) {
    if (item.per10kProfit === null) continue;

    const current = latestByDate.get(item.navDate);
    if (!current || current.fetchedAt < item.fetchedAt) {
      latestByDate.set(item.navDate, item);
    }
  }

  return [...latestByDate.values()]
    .sort((left, right) => left.navDate.localeCompare(right.navDate) || left.fetchedAt.localeCompare(right.fetchedAt))
    .map((item) => ({
      date: item.navDate,
      value: item.per10kProfit as number
    }));
}

function buildContinuousPer10kTail(history: ManagerNavPoint[]) {
  const series = buildPer10kSeries(history);
  const latest = series.at(-1);
  if (!latest) return [];

  const tail = [latest];
  for (let index = series.length - 2; index >= 0; index -= 1) {
    const nextNewer = tail[0];
    const candidate = series[index];
    if (daysBetween(nextNewer.date, candidate.date) > 7) {
      break;
    }
    tail.unshift(candidate);
  }

  return tail;
}

function averagePer10kWindow(history: ManagerNavPoint[], size: number, offset = 0) {
  const series = buildContinuousPer10kTail(history);
  const end = series.length - offset;
  if (end <= 0) return null;

  const window = series.slice(Math.max(0, end - size), end);
  if (window.length < size) return null;

  return window.reduce((sum, point) => sum + point.value, 0) / window.length;
}

function peakPer10kWindow(history: ManagerNavPoint[], size: number) {
  const series = buildContinuousPer10kTail(history);
  if (series.length < size) return null;

  let peak: number | null = null;
  for (let start = 0; start <= series.length - size; start += 1) {
    const window = series.slice(start, start + size);
    const average = window.reduce((sum, point) => sum + point.value, 0) / window.length;
    if (peak === null || average > peak) {
      peak = average;
    }
  }

  return peak;
}

function getRecentPer10k(insight: HoldingInsight | CandidateInsight) {
  const per10kInsight = insight as InsightWithPer10k;
  if (typeof per10kInsight.recentPer10k === "number") return per10kInsight.recentPer10k;
  return averagePer10kWindow(per10kInsight.navHistory, 3);
}

function getPriorPer10k(insight: HoldingInsight | CandidateInsight) {
  const per10kInsight = insight as InsightWithPer10k;
  if (typeof per10kInsight.priorPer10k === "number") return per10kInsight.priorPer10k;
  return averagePer10kWindow(per10kInsight.navHistory, 3, 3);
}

function getPer10kAcceleration(insight: HoldingInsight | CandidateInsight) {
  const per10kInsight = insight as InsightWithPer10k;
  if (typeof per10kInsight.per10kAcceleration === "number") return per10kInsight.per10kAcceleration;

  const recentPer10k = getRecentPer10k(per10kInsight);
  const priorPer10k = getPriorPer10k(per10kInsight);
  return recentPer10k !== null && priorPer10k !== null ? recentPer10k - priorPer10k : null;
}

function getPer10kDrawdown(insight: HoldingInsight | CandidateInsight) {
  const per10kInsight = insight as InsightWithPer10k;
  if (typeof per10kInsight.per10kDrawdown === "number") return per10kInsight.per10kDrawdown;

  const recentPer10k = getRecentPer10k(per10kInsight);
  const peakPer10k = peakPer10kWindow(per10kInsight.navHistory, 3);
  return recentPer10k !== null && peakPer10k !== null ? peakPer10k - recentPer10k : null;
}

function getDailyPerformanceSamples(insight: HoldingInsight | CandidateInsight) {
  const per10kInsight = insight as InsightWithPer10k;
  if (typeof per10kInsight.dailyPerformanceSamples === "number") return per10kInsight.dailyPerformanceSamples;
  return buildContinuousPer10kTail(per10kInsight.navHistory).length;
}

function buildPer10kFields(insight: HoldingInsight | CandidateInsight): Required<Per10kInsightFields> {
  const recentPer10k = getRecentPer10k(insight);
  const priorPer10k = getPriorPer10k(insight);
  const explicitAcceleration = (insight as InsightWithPer10k).per10kAcceleration;
  const per10kAcceleration =
    typeof explicitAcceleration === "number"
      ? explicitAcceleration
      : recentPer10k !== null && priorPer10k !== null
        ? recentPer10k - priorPer10k
        : null;
  const per10kDrawdown = getPer10kDrawdown(insight);

  return {
    recentPer10k,
    priorPer10k,
    per10kAcceleration,
    per10kDrawdown,
    dailyPerformanceSamples: getDailyPerformanceSamples(insight)
  };
}

const REFRESH_TIMEOUT_MS = 30 * 60 * 1000;

function formatRefreshSummary(summary: DashboardData["lastRefreshSummary"]) {
  if (!summary) return "官网抓取：--";
  return `官网抓取：成功 ${summary.succeededProducts}/${summary.totalProducts}`;
}

function signalBadge(signal: HoldingInsight["signal"]) {
  if (signal === "sell") return "badge badge-bad";
  return "badge badge-good";
}

function holdingActionHint(signal: HoldingInsight["signal"]) {
  if (signal === "sell") {
    return "建议卖出";
  }
  return "建议持有";
}

function candidateBadge(stage: CandidateInsight["stage"]) {
  if (stage === "core") return "badge badge-good";
  if (stage === "stale") return "badge badge-bad";
  return "badge badge-warn";
}

function candidateStageLabel(stage: CandidateInsight["stage"]) {
  if (stage === "core") return "稳态核心";
  if (stage === "candidate") return "核心候选";
  if (stage === "watch") return "继续确认";
  return "数据偏旧";
}

function candidateActionHint(stage: CandidateInsight["stage"], confidence: CandidateInsight["confidence"]) {
  if (stage === "core") {
    return confidence === "high" ? "入核心池比较" : "先确认样本";
  }
  if (stage === "candidate") {
    return confidence === "high" ? "可重点比较" : "有吸引力但先确认";
  }
  if (stage === "stale") {
    return "先刷新官网数据";
  }
  return confidence === "low" ? "先等更多样本" : "继续确认";
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon-button-svg">
      <path d="M20 11a8 8 0 0 0-14.2-5" />
      <path d="M6 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.2 5" />
      <path d="M18 21v-5h-5" />
    </svg>
  );
}

function holdingFromCandidate(candidate: CandidateInsight, holding: HoldingInsight["holding"]): HoldingInsight {
  const per10kFields = buildPer10kFields(candidate);

  const insight: HoldingInsight & Per10kInsightFields = {
    ...pickStableCoreMetrics(candidate),
    holding,
    latest: candidate.product,
    latestHistory: candidate.latestHistory,
    navHistory: candidate.navHistory,
    performanceSamples: candidate.performanceSamples,
    marketGap: candidate.marketPremium,
    peakDrawdown: null,
    sevenDayChange: candidate.recentChange,
    recentAnnualized: candidate.recentAnnualized,
    priorAnnualized: candidate.priorAnnualized,
    acceleration: candidate.acceleration,
    switchTargetProductCode: candidate.product.productCode,
    switchTargetProductName: candidate.product.productName,
    bestCandidateCoreYield: candidate.stableCoreYield,
    bestCandidateCoreYieldGap: 0,
    switchExpectedLiftPer10k: null,
    ...per10kFields,
    signal: "hold",
    confidence: candidate.confidence,
    reasons: [
      "已从候选池加入持仓，沿用当前核心万份分析结果；下次刷新时会再补最新官方数据。",
      ...candidate.reasons
    ]
  };

  return insight;
}

export default function HomePage({ appVersion }: HomePageProps) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const [showHoldingComposer, setShowHoldingComposer] = useState(false);
  const progressTimerRef = useRef<number | null>(null);
  const [form, setForm] = useState({
    productCode: "",
    productName: "",
    managerProductCode: "",
    registrationCode: "",
    note: ""
  });

  function stopProgressPolling() {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }

  async function pollRefreshProgress() {
    try {
      const response = await fetch("/api/dashboard/progress", { cache: "no-store" });
      if (!response.ok) return null;
      const data = (await response.json()) as RefreshProgress;
      setRefreshProgress(data);
      return data;
    } catch {
      // Ignore progress polling failures and let the main refresh result speak for itself.
      return null;
    }
  }

  async function loadDashboard() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "刷新失败");
      }
      setDashboard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboard() {
    setRefreshing(true);
    setError(null);
    await pollRefreshProgress();
    stopProgressPolling();
    progressTimerRef.current = window.setInterval(() => {
      void pollRefreshProgress();
    }, 1200);

    let timeoutId: number | null = null;
    try {
      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
      const response = await fetch("/api/dashboard", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "刷新失败");
      }
      setDashboard(data);
      await pollRefreshProgress();
    } catch (err) {
      const latestProgress = await pollRefreshProgress();
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(formatRefreshFailure(latestProgress, "刷新超时"));
      } else {
        setError(formatRefreshFailure(latestProgress, err instanceof Error ? err.message : "刷新失败"));
      }
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      stopProgressPolling();
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(() => () => stopProgressPolling(), []);

  useEffect(() => {
    if (!dashboard) return;
    if (!dashboard.holdings.length) {
      setShowHoldingComposer(true);
    }
  }, [dashboard]);

  async function submitHolding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/holdings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "保存失败");
      }

      const candidate = dashboard?.candidates.find((item) => item.product.productCode === data.productCode);
      if (candidate) {
        setDashboard((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            generatedAt: new Date().toISOString(),
            holdings: [holdingFromCandidate(candidate, data), ...prev.holdings.filter((item) => item.holding.id !== data.id)],
            candidates: prev.candidates.filter((item) => item.product.productCode !== data.productCode)
          };
        });
      } else {
        setDashboard((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            generatedAt: new Date().toISOString(),
            holdings: [
              {
                ...emptyStableCoreMetrics,
                holding: data,
                latest: null,
                latestHistory: [],
                navHistory: [],
                performanceSamples: 0,
                dailyPerformanceSamples: 0,
                marketGap: null,
                peakDrawdown: null,
                sevenDayChange: null,
                recentAnnualized: null,
                priorAnnualized: null,
                acceleration: null,
                switchTargetProductCode: null,
                switchTargetProductName: null,
                bestCandidateCoreYield: null,
                bestCandidateCoreYieldGap: null,
                switchExpectedLiftPer10k: null,
                signal: "hold",
                confidence: "low",
                reasons: ["已加入持仓，等待下次刷新补全最新官方快照和管理人历史。"]
              },
              ...prev.holdings.filter((item) => item.holding.id !== data.id)
            ]
          };
        });
      }

      setForm({
        productCode: "",
        productName: "",
        managerProductCode: "",
        registrationCode: "",
        note: ""
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function addCandidateToHoldings(candidate: CandidateInsight) {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/holdings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          productCode: candidate.product.productCode,
          productName: candidate.product.productName
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "保存失败");
      }

      setDashboard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          generatedAt: new Date().toISOString(),
          holdings: [holdingFromCandidate(candidate, data), ...prev.holdings.filter((item) => item.holding.id !== data.id)],
          candidates: prev.candidates.filter((item) => item.product.productCode !== data.productCode)
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteHolding(id: string) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/holdings/${id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "删除失败");
      }
      setDashboard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          generatedAt: new Date().toISOString(),
          holdings: prev.holdings.filter((item) => item.holding.id !== id)
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page-shell">
      <div className="page-inner">
        <section className="hero">
          <div className="hero-heading-row">
            <h1>稳态现金管理筛选</h1>
            <span className="version-pill" title="服务器当前 Git 版本">
              版本 {appVersion}
            </span>
          </div>
          <p>
            用管理人官网每日万份收益筛出稳态核心产品，低频比较、少动仓位，不追单日脉冲。
          </p>
          <div className="hero-toolbar">
            <div className="hero-meta">
              <span className="pill">持仓规则：核心万份差距 ≥0.04-0.05 后连续确认</span>
              <span className="pill">候选规则：30 日核心万份 + 14 日确认 + 60 日背书</span>
            </div>
          </div>
          {refreshing || refreshProgress?.active ? (
            <div className="refresh-status" aria-live="polite">
              <div className="refresh-status-title">{refreshProgress?.detail || "正在刷新官方数据"}</div>
              <div className="refresh-status-meta">
                {refreshProgress?.currentProduct
                  ? `当前产品：${refreshProgress.currentProduct}`
                  : refreshProgress?.currentManager
                    ? `当前来源：${refreshProgress.currentManager}`
                    : "正在准备刷新任务"}
                {refreshProgress && refreshProgress.total > 0
                  ? ` · ${Math.min(refreshProgress.processed + (refreshProgress.active ? 1 : 0), refreshProgress.total)}/${refreshProgress.total}`
                  : ""}
              </div>
            </div>
          ) : null}
        </section>

        {error ? <div className="alert">{error}</div> : null}

        <section className="panel market-panel">
          <div className="split-title">
            <div>
              <h2>市场概况</h2>
              <p>只统计浦发官网中筛选出的 `日日丰 / R1低风险 / 人民币` 在售产品；7 日年化仅作展示参考。</p>
            </div>
            <div className="market-tools">
              <div className="pill sync-pill">
                <span className="sync-pill-line">
                  最近同步：{dashboard?.lastSyncedAt ? new Date(dashboard.lastSyncedAt).toLocaleString("zh-CN") : "--"}
                </span>
                <span className="sync-pill-line sync-pill-subtle">
                  {formatRefreshSummary(dashboard?.lastRefreshSummary ?? null)}
                </span>
              </div>
              <button
                className="icon-button"
                onClick={refreshDashboard}
                disabled={loading || refreshing || saving}
                aria-label="刷新官方数据"
                title="刷新官方数据"
              >
                <RefreshIcon />
              </button>
            </div>
          </div>
          <div className="stats-grid" style={{ marginTop: 16 }}>
            <div className="stat-card">
              <div className="stat-label">样本数量</div>
              <div className="stat-value">{dashboard?.marketSummary.totalProducts ?? "--"}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">平均展示收益</div>
              <div className="stat-value">{formatRate(dashboard?.marketSummary.averageYield ?? null)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">中位展示收益</div>
              <div className="stat-value">{formatRate(dashboard?.marketSummary.medianYield ?? null)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">最高展示收益</div>
              <div className="stat-value">{formatRate(dashboard?.marketSummary.highestYield ?? null)}</div>
            </div>
          </div>
        </section>

        <section className="section-grid">
          <div className="panel">
            <div className="split-title">
              <div>
                <h2>我的持仓</h2>
              </div>
            </div>

            <div className="list">
              {dashboard?.holdings.length ? (
                dashboard.holdings.map((item) => (
                  <article className="card" key={item.holding.id}>
                    <div className="card-top">
                      <div>
                        <div className="card-title">{item.holding.productName}</div>
                        <div className="card-subtitle">
                          {item.holding.productCode} · {item.latest?.taName || "官方快照待获取"}
                        </div>
                        {item.holding.managerProductCode ? (
                          <div className="card-subtitle">管理人代码: {item.holding.managerProductCode}</div>
                        ) : null}
                        {item.holding.registrationCode ? (
                          <div className="card-subtitle">登记编码: {item.holding.registrationCode}</div>
                        ) : null}
                      </div>
                      <div className={signalBadge(item.signal)}>{signalText[item.signal]}</div>
                    </div>

                    <div className="detail-grid">
                      <div className="detail">
                        <DetailLabel help="浦发列表展示的 7 日年化或收益率快照，仅作展示参考，不作为买入或卖出主信号。">
                          展示7日年化
                        </DetailLabel>
                        <div className="detail-value">{formatRate(item.latest?.incomeRate ?? null)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="最近连续官网万份收益尾部中，进入 30 日核心窗口的有效观测天数，最多 30 条。">
                          核心样本
                        </DetailLabel>
                        <div className="detail-value">{formatSampleCount(item.stableCoreSamples)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="最近 30 个连续官网万份收益观测日中，超过 30 日中位数 +0.15 的单日值按上限截尾后求均值。">
                          30日截尾均值
                        </DetailLabel>
                        <div className="detail-value">{formatPer10k(item.recentPer10k30WinsorizedAvg)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="最近 30 个连续官网万份收益观测日的中位数，用来代表稳态水平并降低单日脉冲影响。">
                          30日中位数
                        </DetailLabel>
                        <div className="detail-value">{formatPer10k(item.recentPer10k30Median)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="最近 14 个连续官网万份收益观测日按同样截尾规则求均值，用来确认近期收益是否变差。">
                          14日截尾均值
                        </DetailLabel>
                        <div className="detail-value">{formatPer10k(item.recentPer10k14WinsorizedAvg)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="换仓对标候选的核心万份减去本持仓核心万份。优先使用 30 日截尾均值，缺失时回退到可用稳态口径。">
                          候选核心差距
                        </DetailLabel>
                        <div className="detail-value">{formatPer10kDiff(item.bestCandidateCoreYieldGap)}</div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="用于换仓测算的候选产品：候选池中按稳态核心得分排序第一、且有核心万份数据的产品。">
                          换仓对标
                        </DetailLabel>
                        <div className="detail-value">
                          {item.switchTargetProductName
                            ? `${item.switchTargetProductName} ${item.switchTargetProductCode ?? ""}`
                            : "--"}
                        </div>
                      </div>
                      <div className="detail">
                        <DetailLabel help="按 30 天低频持有、2 天申赎在途无收益折算后，换到对标候选预计每天万份收益可提高多少。">
                          换仓预计提高万份
                        </DetailLabel>
                        <div className="detail-value">{formatPer10kDiff(item.switchExpectedLiftPer10k)}</div>
                      </div>
                    </div>

                    <div className="badge-row">
                      <span className="badge">置信度 {item.confidence}</span>
                      <span className="badge">{holdingActionHint(item.signal)}</span>
                    </div>

                    <YieldHistoryChart
                      navHistory={item.navHistory}
                      recommendationLabel={`${signalText[item.signal]} · ${item.confidence}`}
                      recommendationHint={holdingActionHint(item.signal)}
                      recommendationTone={
                        item.signal === "sell" ? "bad" : "good"
                      }
                    />

                    <ul className="reason-list">
                      {item.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>

                    <div className="inline-actions">
                      <button className="ghost-button" onClick={() => deleteHolding(item.holding.id)} disabled={saving}>
                        移出持仓
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty">还没有持仓。先录入产品代码和名称，系统就会开始跟踪它的官方收益快照。</div>
              )}

              <div className="add-card">
                <button
                  className="add-toggle"
                  type="button"
                  onClick={() => setShowHoldingComposer((prev) => !prev)}
                  aria-expanded={showHoldingComposer}
                >
                  <span>
                    <strong>手动添加持仓</strong>
                    <small>只填浦发产品代码，剩余信息由系统自动匹配</small>
                  </span>
                  <span className="add-toggle-icon">{showHoldingComposer ? "−" : "+"}</span>
                </button>

                {showHoldingComposer ? (
                  <form onSubmit={submitHolding} className="composer-shell">
                    <div className="form-grid form-grid-compact form-grid-single">
                      <div className="field field-wide">
                        <label htmlFor="productCode">浦发产品代码</label>
                        <input
                          id="productCode"
                          value={form.productCode}
                          onChange={(event) => setForm((prev) => ({ ...prev, productCode: event.target.value }))}
                          placeholder="例如 2301259216"
                        />
                      </div>
                    </div>
                    <div className="inline-actions">
                      <button className="button" type="submit" disabled={saving}>
                        {saving ? "保存中..." : "保存并刷新"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="split-title">
              <div>
                <h2>候选池</h2>
              </div>
            </div>

            <div className="list">
              {dashboard?.candidates.length ? (
                dashboard.candidates.map((item) => (
                  <article className="card" key={item.product.productCode}>
                    <div className="card-top">
                      <div>
                        <div className="card-title">{item.product.productName}</div>
                        <div className="card-subtitle">
                          {item.product.productCode} · {item.product.taName}
                        </div>
                      </div>
                      <div className={candidateBadge(item.stage)}>
                        {candidateStageLabel(item.stage)}
                      </div>
                    </div>

                    <div className="score-strip">
                      <div className="score-strip-label">核心得分</div>
                      <div className="score-strip-value">{item.score.toFixed(1)}</div>
                    </div>

                    <div className="detail-grid">
                      <div className="detail">
                        <div className="detail-label">展示7日年化</div>
                        <div className="detail-value">{formatRate(item.product.incomeRate)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">核心样本</div>
                        <div className="detail-value">{formatSampleCount(item.stableCoreSamples)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">30日截尾均值</div>
                        <div className="detail-value">{formatPer10k(item.recentPer10k30WinsorizedAvg)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">30日中位数</div>
                        <div className="detail-value">{formatPer10k(item.recentPer10k30Median)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">14日截尾均值</div>
                        <div className="detail-value">{formatPer10k(item.recentPer10k14WinsorizedAvg)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">60日中位数</div>
                        <div className="detail-value">{formatPer10k(item.recentPer10k60Median)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">Spike天数</div>
                        <div className="detail-value">{formatSpikeDays(item.spikeDays30)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">净值新鲜度</div>
                        <div className="detail-value">{formatDays(item.navFreshnessDays)}</div>
                      </div>
                    </div>

                    <div className="badge-row">
                      <span className="badge">置信度 {item.confidence}</span>
                      <span className="badge">{candidateActionHint(item.stage, item.confidence)}</span>
                    </div>

                    <YieldHistoryChart
                      navHistory={item.navHistory}
                      recommendationLabel={`${candidateStageLabel(item.stage)} · ${item.confidence}`}
                      recommendationHint={candidateActionHint(item.stage, item.confidence)}
                      recommendationTone={item.stage === "core" ? "good" : item.stage === "stale" ? "bad" : "warn"}
                    />

                    <ul className="reason-list">
                      {item.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>

                    <div className="inline-actions">
                      <button className="ghost-button" onClick={() => addCandidateToHoldings(item)} disabled={saving}>
                        加入持仓
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty">候选池为空，可能是数据还没刷新成功，或者当前样本都已在你的持仓里。</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
