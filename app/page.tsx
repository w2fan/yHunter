"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import type { CandidateInsight, DashboardData, HoldingInsight } from "@/lib/types";

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

const signalText = {
  sell: "考虑卖出",
  watch: "重点观察",
  hold: "继续持有",
  insufficient_data: "数据不足"
} as const;

function formatRate(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}%`;
}

function formatDiff(value: number | null) {
  if (value === null) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)} pct`;
}

function formatSampleCount(value: number) {
  return `${value} 条`;
}

function signalBadge(signal: HoldingInsight["signal"]) {
  if (signal === "sell") return "badge badge-bad";
  if (signal === "watch") return "badge badge-warn";
  return "badge badge-good";
}

function candidateBadge(stage: CandidateInsight["stage"]) {
  if (stage === "fresh_spike") return "badge badge-good";
  if (stage === "fading") return "badge badge-bad";
  return "badge badge-warn";
}

function holdingFromCandidate(candidate: CandidateInsight, holding: HoldingInsight["holding"]): HoldingInsight {
  const signal: HoldingInsight["signal"] =
    candidate.stage === "fading" ? "watch" : candidate.stage === "mature" ? "hold" : "watch";

  return {
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
    signal,
    confidence: candidate.confidence,
    reasons: [
      "已从候选池加入持仓，沿用当前本地分析结果；下次刷新时会再补最新官方数据。",
      ...candidate.reasons
    ]
  };
}

export default function HomePage() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
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
      if (!response.ok) return;
      const data = (await response.json()) as RefreshProgress;
      setRefreshProgress(data);
    } catch {
      // Ignore progress polling failures and let the main refresh result speak for itself.
    }
  }

  async function loadDashboard() {
    setLoading(true);
    setError(null);
    await pollRefreshProgress();
    stopProgressPolling();
    progressTimerRef.current = window.setInterval(() => {
      void pollRefreshProgress();
    }, 1200);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "刷新失败");
      }
      setDashboard(data);
      await pollRefreshProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
      await pollRefreshProgress();
    } finally {
      stopProgressPolling();
      setLoading(false);
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
                holding: data,
                latest: null,
                latestHistory: [],
                navHistory: [],
                performanceSamples: 0,
                marketGap: null,
                peakDrawdown: null,
                sevenDayChange: null,
                recentAnnualized: null,
                priorAnnualized: null,
                acceleration: null,
                signal: "insufficient_data",
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
          <h1>打榜理财猎手</h1>
          <p>
            盯住浦发公告代销的日日丰、R1、人民币现金管理类理财，识别谁在打榜、谁回归了均值。
          </p>
          <div className="hero-toolbar">
            <div className="hero-meta">
              <span className="pill">默认卖出规则：回归均值 + 高位回落</span>
              <span className="pill">候选规则：收益溢价 + 新鲜度 + 动量</span>
            </div>
            <button className="button" onClick={loadDashboard} disabled={loading || saving}>
              {loading ? "刷新中..." : "立即刷新官方数据"}
            </button>
          </div>
          {loading || refreshProgress?.active ? (
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

        <section className="panel">
          <div className="split-title">
            <div>
              <h2>市场概况</h2>
              <p>只统计浦发官网中筛选出的 `日日丰 / R1低风险 / 人民币` 在售产品。</p>
            </div>
            <div className="pill sync-pill">
              最近同步：{dashboard?.lastSyncedAt ? new Date(dashboard.lastSyncedAt).toLocaleString("zh-CN") : "--"}
            </div>
          </div>
          <div className="stats-grid" style={{ marginTop: 16 }}>
            <div className="stat-card">
              <div className="stat-label">样本数量</div>
              <div className="stat-value">{dashboard?.marketSummary.totalProducts ?? "--"}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">平均收益</div>
              <div className="stat-value">{formatRate(dashboard?.marketSummary.averageYield ?? null)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">中位收益</div>
              <div className="stat-value">{formatRate(dashboard?.marketSummary.medianYield ?? null)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">最高收益</div>
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
                        <div className="detail-label">当前收益</div>
                        <div className="detail-value">{formatRate(item.latest?.incomeRate ?? null)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">历史样本</div>
                        <div className="detail-value">{formatSampleCount(item.performanceSamples)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">相对均值</div>
                        <div className="detail-value">{formatDiff(item.marketGap)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">7天变化</div>
                        <div className="detail-value">{formatDiff(item.sevenDayChange)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">近期7日年化</div>
                        <div className="detail-value">{formatRate(item.recentAnnualized)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">短期动能</div>
                        <div className="detail-value">{formatDiff(item.acceleration)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">距高点回落</div>
                        <div className="detail-value">{formatDiff(item.peakDrawdown)}</div>
                      </div>
                    </div>

                    <div className="badge-row">
                      <span className="badge">{item.latest?.incomeRateLabel || "收益标签待获取"}</span>
                      <span className="badge">置信度 {item.confidence}</span>
                      {item.latest?.productStatus ? <span className="badge">{item.latest.productStatus}</span> : null}
                    </div>

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
                        {item.stage === "fresh_spike"
                          ? "新近打榜"
                          : item.stage === "warming_up"
                            ? "升温中"
                            : item.stage === "mature"
                              ? "已进入强势期"
                              : "疑似退潮"}
                      </div>
                    </div>

                    <div className="score-strip">
                      <div className="score-strip-label">候选得分</div>
                      <div className="score-strip-value">{item.score.toFixed(1)}</div>
                    </div>

                    <div className="detail-grid">
                      <div className="detail">
                        <div className="detail-label">当前收益</div>
                        <div className="detail-value">{formatRate(item.product.incomeRate)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">历史样本</div>
                        <div className="detail-value">{formatSampleCount(item.performanceSamples)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">相对中位溢价</div>
                        <div className="detail-value">{formatDiff(item.marketPremium)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">近几日变化</div>
                        <div className="detail-value">{formatDiff(item.recentChange)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">近期7日年化</div>
                        <div className="detail-value">{formatRate(item.recentAnnualized)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">短期动能</div>
                        <div className="detail-value">{formatDiff(item.acceleration)}</div>
                      </div>
                    </div>

                    <div className="badge-row">
                      <span className="badge">{item.product.incomeRateLabel}</span>
                      <span className="badge">{item.product.deadlineBrandId || "日日丰"}</span>
                      <span className="badge">置信度 {item.confidence}</span>
                    </div>

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
