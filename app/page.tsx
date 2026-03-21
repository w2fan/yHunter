"use client";

import { FormEvent, useEffect, useState } from "react";

import type { CandidateInsight, DashboardData, HoldingInsight } from "@/lib/types";

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

export default function HomePage() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    productCode: "",
    productName: "",
    managerProductCode: "",
    registrationCode: "",
    note: ""
  });

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
      setError(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

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

      setForm({
        productCode: "",
        productName: "",
        managerProductCode: "",
        registrationCode: "",
        note: ""
      });
      await loadDashboard();
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
      await loadDashboard();
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
            盯住浦发代销的日日丰、R1、人民币现金管理类理财，识别谁还在打榜、谁已经回归均值，并把候选池和你的持仓分开管理。
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
        </section>

        {error ? <div className="alert">{error}</div> : null}

        <section className="panel">
          <div className="split-title">
            <div>
              <h2>市场概况</h2>
              <p>只统计浦发官网中筛选出的 `日日丰 / R1低风险 / 人民币` 在售或停售产品。</p>
            </div>
            <div className="pill">
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
                <p>一旦加入持仓，它就不会再出现在候选池里。</p>
              </div>
            </div>

<form onSubmit={submitHolding} className="form-grid">
              <div className="field">
                <label htmlFor="productCode">产品代码</label>
                <input
                  id="productCode"
                  value={form.productCode}
                  onChange={(event) => setForm((prev) => ({ ...prev, productCode: event.target.value }))}
                  placeholder="例如 2301259216"
                />
              </div>
              <div className="field">
                <label htmlFor="productName">产品名称</label>
                <input
                  id="productName"
                  value={form.productName}
                  onChange={(event) => setForm((prev) => ({ ...prev, productName: event.target.value }))}
                  placeholder="例如 天添盈增利51号A"
                />
              </div>
              <div className="field field-wide">
                <label htmlFor="managerProductCode">管理人产品代码</label>
                <input
                  id="managerProductCode"
                  value={form.managerProductCode}
                  onChange={(event) => setForm((prev) => ({ ...prev, managerProductCode: event.target.value }))}
                  placeholder="可选，后续找到管理人或其他渠道的内部代码时填这里"
                />
              </div>
              <div className="field field-wide">
                <label htmlFor="registrationCode">理财登记编码</label>
                <input
                  id="registrationCode"
                  value={form.registrationCode}
                  onChange={(event) => setForm((prev) => ({ ...prev, registrationCode: event.target.value }))}
                  placeholder="可选，例如在产品说明书里找到的全国银行业理财登记编码"
                />
              </div>
              <div className="field field-wide">
                <label htmlFor="note">备注</label>
                <input
                  id="note"
                  value={form.note}
                  onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
                  placeholder="可选，比如买入原因、银行渠道、自己的关注点"
                />
              </div>
              <div className="inline-actions">
                <button className="button" type="submit" disabled={saving}>
                  {saving ? "保存中..." : "加入持仓"}
                </button>
              </div>
            </form>

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
                        <div className="detail-label">相对均值</div>
                        <div className="detail-value">{formatDiff(item.marketGap)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">7天变化</div>
                        <div className="detail-value">{formatDiff(item.sevenDayChange)}</div>
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
            </div>
          </div>

          <div className="panel">
            <div className="split-title">
              <div>
                <h2>候选池</h2>
                <p>越靠前表示越像“还在打榜且离起点不远”的产品。</p>
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

                    <div className="detail-grid">
                      <div className="detail">
                        <div className="detail-label">当前收益</div>
                        <div className="detail-value">{formatRate(item.product.incomeRate)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">候选得分</div>
                        <div className="detail-value">{item.score.toFixed(1)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">相对中位溢价</div>
                        <div className="detail-value">{formatDiff(item.marketPremium)}</div>
                      </div>
                      <div className="detail">
                        <div className="detail-label">近几日变化</div>
                        <div className="detail-value">{formatDiff(item.recentChange)}</div>
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
                      <button
                        className="ghost-button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            productCode: item.product.productCode,
                            productName: item.product.productName,
                            managerProductCode: "",
                            registrationCode: ""
                          }))
                        }
                      >
                        填入持仓表单
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
