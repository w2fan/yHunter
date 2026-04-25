"use client";

import { useState } from "react";
import type { PointerEvent } from "react";

import type { ManagerNavPoint, ProductSnapshot } from "@/lib/types";

type RecommendationTone = "good" | "warn" | "bad" | "neutral";

type YieldHistoryChartProps = {
  latestHistory: ProductSnapshot[];
  navHistory: ManagerNavPoint[];
  recommendationLabel: string;
  recommendationHint: string;
  recommendationTone?: RecommendationTone;
};

type ChartPoint = {
  label: string;
  shortLabel: string;
  value: number;
};

type PositionedChartPoint = ChartPoint & {
  x: number;
  y: number;
};

const SVG_WIDTH = 640;
const SVG_HEIGHT = 220;
const CHART_PADDING = { top: 18, right: 16, bottom: 34, left: 16 };
const TOOLTIP_WIDTH = 178;
const TOOLTIP_HEIGHT = 74;

function formatPercent(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}%`;
}

function formatSigned(value: number | null) {
  if (value === null) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)} pct`;
}

function buildSnapshotPoints(history: ProductSnapshot[]): ChartPoint[] {
  return history
    .filter((item) => item.incomeRate !== null)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .map((item) => ({
      label: item.capturedDate,
      shortLabel: item.capturedDate.slice(5),
      value: item.incomeRate as number
    }));
}

function buildNavPoints(history: ManagerNavPoint[]): ChartPoint[] {
  return history
    .filter((item) => item.annualizedYield !== null)
    .sort((left, right) => left.navDate.localeCompare(right.navDate))
    .map((item) => ({
      label: item.navDate,
      shortLabel: item.navDate.slice(5),
      value: item.annualizedYield as number
    }));
}

function summarizeTrend(points: ChartPoint[]) {
  if (points.length < 2) return null;
  const diff = points.at(-1)!.value - points[0].value;
  return {
    diff,
    rising: diff > 0.03,
    falling: diff < -0.03
  };
}

function buildTimelineLabels(snapshotPoints: ChartPoint[], navPoints: ChartPoint[]) {
  return [...new Set([...snapshotPoints, ...navPoints].map((point) => point.label))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function buildPath(points: PositionedChartPoint[]) {
  if (points.length === 0) return "";

  return points
    .map((point, index) => {
      return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    })
    .join(" ");
}

function timelineX(label: string, timelineLabels: string[]) {
  const innerWidth = SVG_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const index = timelineLabels.indexOf(label);
  const maxIndex = Math.max(1, timelineLabels.length - 1);

  if (timelineLabels.length === 1) {
    return CHART_PADDING.left + innerWidth / 2;
  }

  return CHART_PADDING.left + (Math.max(0, index) / maxIndex) * innerWidth;
}

function buildDots(points: ChartPoint[], timelineLabels: string[], min: number, max: number): PositionedChartPoint[] {
  const innerHeight = SVG_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const range = max - min || 1;

  return points.map((point) => ({
    ...point,
    x: timelineX(point.label, timelineLabels),
    y: CHART_PADDING.top + innerHeight - ((point.value - min) / range) * innerHeight
  }));
}

function closestTimelineLabel(x: number, timelineLabels: string[]) {
  return timelineLabels.reduce((closest, label) => {
    const currentDistance = Math.abs(timelineX(label, timelineLabels) - x);
    const closestDistance = Math.abs(timelineX(closest, timelineLabels) - x);
    return currentDistance < closestDistance ? label : closest;
  }, timelineLabels[0]);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toneClassName(tone: RecommendationTone) {
  if (tone === "good") return "yield-chart-note yield-chart-note-good";
  if (tone === "warn") return "yield-chart-note yield-chart-note-warn";
  if (tone === "bad") return "yield-chart-note yield-chart-note-bad";
  return "yield-chart-note";
}

export function YieldHistoryChart({
  latestHistory,
  navHistory,
  recommendationLabel,
  recommendationHint,
  recommendationTone = "neutral"
}: YieldHistoryChartProps) {
  const [focusedLabel, setFocusedLabel] = useState<string | null>(null);
  const snapshotPoints = buildSnapshotPoints(latestHistory);
  const navPoints = buildNavPoints(navHistory);
  const allValues = [...snapshotPoints, ...navPoints].map((point) => point.value);

  if (allValues.length === 0) {
    return (
      <section className="yield-chart-shell">
        <div className="yield-chart-header">
          <div>
            <div className="yield-chart-title">收益走势</div>
            <div className="yield-chart-subtitle">等待自动刷新积累历史后再画图</div>
          </div>
          <div className={toneClassName(recommendationTone)}>{recommendationLabel}</div>
        </div>
        <div className="yield-chart-empty">
          当前还没有可画图的历史点位；下一次刷新后，这里会展示浦发快照收益和管理人 7 日年化的变化。
        </div>
      </section>
    );
  }

  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const padding = Math.max(0.08, (maxValue - minValue) * 0.2);
  const chartMin = Math.max(0, minValue - padding);
  const chartMax = maxValue + padding;
  const timelineLabels = buildTimelineLabels(snapshotPoints, navPoints);
  const snapshotDots = buildDots(snapshotPoints, timelineLabels, chartMin, chartMax);
  const navDots = buildDots(navPoints, timelineLabels, chartMin, chartMax);
  const snapshotTrend = summarizeTrend(snapshotPoints);
  const navTrend = summarizeTrend(navPoints);
  const latestSnapshot = snapshotPoints.at(-1)?.value ?? null;
  const latestNav = navPoints.at(-1)?.value ?? null;
  const snapshotWindowDiff =
    snapshotPoints.length >= 2 ? snapshotPoints.at(-1)!.value - snapshotPoints.at(-2)!.value : null;
  const axisLabels = [chartMax, (chartMax + chartMin) / 2, chartMin];
  const snapshotPointMap = new Map(snapshotPoints.map((point) => [point.label, point.value]));
  const navPointMap = new Map(navPoints.map((point) => [point.label, point.value]));
  const activeLabel = focusedLabel && timelineLabels.includes(focusedLabel) ? focusedLabel : timelineLabels.at(-1)!;
  const activeX = timelineX(activeLabel, timelineLabels);
  const activeSnapshot = snapshotDots.find((point) => point.label === activeLabel);
  const activeNav = navDots.find((point) => point.label === activeLabel);
  const tooltipX = clamp(activeX + 12, CHART_PADDING.left, SVG_WIDTH - CHART_PADDING.right - TOOLTIP_WIDTH);
  const tooltipY = CHART_PADDING.top + 6;

  function focusNearestPoint(event: PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * SVG_WIDTH;
    setFocusedLabel(closestTimelineLabel(clamp(x, CHART_PADDING.left, SVG_WIDTH - CHART_PADDING.right), timelineLabels));
  }

  return (
    <section className="yield-chart-shell">
      <div className="yield-chart-header">
        <div>
          <div className="yield-chart-title">收益走势</div>
          <div className="yield-chart-subtitle">把每日刷新后的官方快照和管理人历史放在一起看</div>
        </div>
        <div className={toneClassName(recommendationTone)}>{recommendationLabel}</div>
      </div>

      <div className="yield-chart-meta">
        <span className="yield-chart-legend">
          <span className="yield-chart-dot yield-chart-dot-snapshot" />
          浦发快照 {snapshotPoints.length ? formatPercent(latestSnapshot) : "--"}
        </span>
        <span className="yield-chart-legend">
          <span className="yield-chart-dot yield-chart-dot-nav" />
          官网7日年化 {navPoints.length ? formatPercent(latestNav) : "--"}
        </span>
        <span className="yield-chart-legend">{snapshotWindowDiff === null ? "近次变化 --" : `近次变化 ${formatSigned(snapshotWindowDiff)}`}</span>
      </div>

      <div className="yield-chart-frame">
        <svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className="yield-chart-svg" role="img" aria-label="收益历史折线图">
          {axisLabels.map((label) => {
            const y =
              CHART_PADDING.top +
              ((chartMax - label) / (chartMax - chartMin || 1)) * (SVG_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom);

            return (
              <g key={label}>
                <line
                  x1={CHART_PADDING.left}
                  x2={SVG_WIDTH - CHART_PADDING.right}
                  y1={y}
                  y2={y}
                  className="yield-chart-gridline"
                />
                <text x={SVG_WIDTH - CHART_PADDING.right} y={y - 6} textAnchor="end" className="yield-chart-axis">
                  {label.toFixed(2)}%
                </text>
              </g>
            );
          })}

          {snapshotPoints.length > 0 ? (
            <path d={buildPath(snapshotDots)} className="yield-chart-line yield-chart-line-snapshot" />
          ) : null}
          {navPoints.length > 0 ? (
            <path d={buildPath(navDots)} className="yield-chart-line yield-chart-line-nav" />
          ) : null}

          {snapshotDots.map((point, index) => (
            <g key={`snapshot-${point.label}-${index}`}>
              <circle cx={point.x} cy={point.y} r={3.2} className="yield-chart-point yield-chart-point-snapshot" />
              <title>{`${point.label} 浦发快照 ${formatPercent(point.value)}`}</title>
              {(index === 0 || index === snapshotDots.length - 1) && (
                <text x={point.x} y={SVG_HEIGHT - 8} textAnchor={index === 0 ? "start" : "end"} className="yield-chart-axis">
                  {point.shortLabel}
                </text>
              )}
            </g>
          ))}

          {navDots.map((point, index) => (
            <g key={`nav-${point.label}-${index}`}>
              <circle cx={point.x} cy={point.y} r={2.6} className="yield-chart-point yield-chart-point-nav" />
              <title>{`${point.label} 官网7日年化 ${formatPercent(point.value)}`}</title>
            </g>
          ))}

          <line
            x1={activeX}
            x2={activeX}
            y1={CHART_PADDING.top}
            y2={SVG_HEIGHT - CHART_PADDING.bottom}
            className="yield-chart-focus-line"
          />
          {activeSnapshot ? (
            <circle cx={activeSnapshot.x} cy={activeSnapshot.y} r={5.2} className="yield-chart-focus-point yield-chart-focus-point-snapshot" />
          ) : null}
          {activeNav ? (
            <circle cx={activeNav.x} cy={activeNav.y} r={4.8} className="yield-chart-focus-point yield-chart-focus-point-nav" />
          ) : null}

          <g transform={`translate(${tooltipX} ${tooltipY})`} className="yield-chart-tooltip">
            <rect width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT} rx={10} />
            <text x={12} y={20} className="yield-chart-tooltip-date">
              {activeLabel}
            </text>
            <text x={12} y={42} className="yield-chart-tooltip-snapshot">
              浦发快照 {formatPercent(snapshotPointMap.get(activeLabel) ?? null)}
            </text>
            <text x={12} y={62} className="yield-chart-tooltip-nav">
              官网7日年化 {formatPercent(navPointMap.get(activeLabel) ?? null)}
            </text>
          </g>

          <rect
            x={CHART_PADDING.left}
            y={CHART_PADDING.top}
            width={SVG_WIDTH - CHART_PADDING.left - CHART_PADDING.right}
            height={SVG_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom}
            className="yield-chart-hit-area"
            onPointerMove={focusNearestPoint}
            onPointerDown={focusNearestPoint}
          />
        </svg>
      </div>

      <div className="yield-chart-summary">
        <span>{snapshotTrend?.rising ? "快照仍在抬升" : snapshotTrend?.falling ? "快照开始回落" : "快照相对平稳"}</span>
        <span>{navTrend?.rising ? "官网动能增强" : navTrend?.falling ? "官网动能转弱" : "官网动能暂无明显拐点"}</span>
        <span>{recommendationHint}</span>
      </div>
    </section>
  );
}
