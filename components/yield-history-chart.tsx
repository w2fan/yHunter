"use client";

import { useState } from "react";
import type { PointerEvent } from "react";

import type { ManagerNavPoint } from "@/lib/types";

type RecommendationTone = "good" | "warn" | "bad" | "neutral";

type YieldHistoryChartProps = {
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
const TOOLTIP_WIDTH = 188;
const TOOLTIP_HEIGHT = 74;
const MAX_CHART_GAP_DAYS = 7;

function formatPer10k(value: number | null) {
  return value === null ? "--" : value.toFixed(4);
}

function formatSignedPer10k(value: number | null) {
  if (value === null) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(4)}`;
}

function lastItem<T>(items: T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

function buildNavPoints(history: ManagerNavPoint[]): ChartPoint[] {
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
      label: item.navDate,
      shortLabel: item.navDate.slice(5),
      value: item.per10kProfit as number
    }));
}

function summarizeTrend(points: ChartPoint[], threshold: number) {
  if (points.length < 2) return null;
  const latestPoint = lastItem(points);
  if (!latestPoint) return null;
  const diff = latestPoint.value - points[0].value;
  return {
    diff,
    rising: diff > threshold,
    falling: diff < -threshold
  };
}

function buildTimelineLabels(snapshotPoints: ChartPoint[], navPoints: ChartPoint[]) {
  return [...new Set([...snapshotPoints, ...navPoints].map((point) => point.label))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function buildTrendPath(points: PositionedChartPoint[]) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  if (points.length === 2) {
    return [
      `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
      `L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`
    ].join(" ");
  }

  const commands = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const previous = points[index - 1] ?? current;
    const following = points[index + 2] ?? next;
    const controlOneX = current.x + (next.x - previous.x) / 6;
    const controlOneY = current.y + (next.y - previous.y) / 6;
    const controlTwoX = next.x - (following.x - current.x) / 6;
    const controlTwoY = next.y - (following.y - current.y) / 6;

    commands.push(
      `C ${controlOneX.toFixed(2)} ${controlOneY.toFixed(2)}, ${controlTwoX.toFixed(2)} ${controlTwoY.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
    );
  }

  return commands.join(" ");
}

function daysBetween(laterDate: string, earlierDate: string) {
  const later = new Date(`${laterDate}T00:00:00Z`).getTime();
  const earlier = new Date(`${earlierDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return Number.POSITIVE_INFINITY;
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

function buildContinuousTail(points: ChartPoint[]) {
  const latest = points.at(-1);
  if (!latest) return [];

  const tail = [latest];
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const nextNewer = tail[0];
    const candidate = points[index];
    if (daysBetween(nextNewer.label, candidate.label) > MAX_CHART_GAP_DAYS) {
      break;
    }
    tail.unshift(candidate);
  }

  return tail;
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
  navHistory,
  recommendationLabel,
  recommendationHint,
  recommendationTone = "neutral"
}: YieldHistoryChartProps) {
  const [focusedLabel, setFocusedLabel] = useState<string | null>(null);
  const navPoints = buildNavPoints(navHistory);
  const allValues = navPoints.map((point) => point.value);

  if (allValues.length < 2) {
    return (
      <section className="yield-chart-shell">
        <div className="yield-chart-header">
          <div>
            <div className="yield-chart-title">官网万份收益走势</div>
            <div className="yield-chart-subtitle">等待管理人官网积累每日万份收益历史</div>
          </div>
          <div className={toneClassName(recommendationTone)}>{recommendationLabel}</div>
        </div>
        <div className="yield-chart-empty">
          当前还没有足够点位形成官网万份收益曲线；浦发列表只有 7 日年化快照，不进入这张万份收益图。
        </div>
      </section>
    );
  }

  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const padding = Math.max(0.01, (maxValue - minValue) * 0.2);
  const chartMin = Math.max(0, minValue - padding);
  const chartMax = maxValue + padding;
  const timelineLabels = buildTimelineLabels([], navPoints);
  const navDots = buildDots(navPoints, timelineLabels, chartMin, chartMax);
  const trendPath = buildTrendPath(navDots);
  const continuousNavPoints = buildContinuousTail(navPoints);
  const hasContinuousNavTrend = continuousNavPoints.length >= 3;
  const navTrend = summarizeTrend(continuousNavPoints, 0.01);
  const latestNav = lastItem(navPoints)?.value ?? null;
  const navWindowDiff =
    navPoints.length >= 2 && daysBetween(navPoints[navPoints.length - 1].label, navPoints[navPoints.length - 2].label) <= MAX_CHART_GAP_DAYS
      ? navPoints[navPoints.length - 1].value - navPoints[navPoints.length - 2].value
      : null;
  const axisLabels = [chartMax, (chartMax + chartMin) / 2, chartMin];
  const navPointMap = new Map(navPoints.map((point) => [point.label, point.value]));
  const navMomentumMap = new Map<string, number | null>(
    navPoints.map((point, index) => [
      point.label,
      index === 0 || daysBetween(point.label, navPoints[index - 1].label) > MAX_CHART_GAP_DAYS
        ? null
        : point.value - navPoints[index - 1].value
    ])
  );
  const defaultActiveLabel = lastItem(navPoints)?.label ?? timelineLabels[timelineLabels.length - 1];
  const activeLabel = focusedLabel && timelineLabels.includes(focusedLabel) ? focusedLabel : defaultActiveLabel;
  const activeX = timelineX(activeLabel, timelineLabels);
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
          <div className="yield-chart-title">官网万份收益走势</div>
          <div className="yield-chart-subtitle">主线使用管理人官网每日万份收益</div>
        </div>
        <div className={toneClassName(recommendationTone)}>{recommendationLabel}</div>
      </div>

      <div className="yield-chart-meta">
        <span className="yield-chart-legend">
          <span className="yield-chart-dot yield-chart-dot-nav" />
          官网万份收益 {formatPer10k(latestNav)}
        </span>
        <span className="yield-chart-legend">{navWindowDiff === null ? "万份收益动能 --" : `万份收益动能 ${formatSignedPer10k(navWindowDiff)}`}</span>
      </div>

      <div className="yield-chart-frame">
        <svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className="yield-chart-svg" role="img" aria-label="官网万份收益历史折线图">
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
                  {label.toFixed(4)}
                </text>
              </g>
            );
          })}

          <path d={trendPath} className="yield-chart-line yield-chart-line-nav" />

          {navDots.map((point, index) => (
            index === 0 || index === navDots.length - 1 ? (
              <text
                key={`nav-label-${point.label}-${index}`}
                x={point.x}
                y={SVG_HEIGHT - 8}
                textAnchor={index === 0 ? "start" : "end"}
                className="yield-chart-axis"
              >
                {point.shortLabel}
              </text>
            ) : null
          ))}

          <line
            x1={activeX}
            x2={activeX}
            y1={CHART_PADDING.top}
            y2={SVG_HEIGHT - CHART_PADDING.bottom}
            className="yield-chart-focus-line"
          />
          {activeNav ? (
            <circle cx={activeNav.x} cy={activeNav.y} r={4.8} className="yield-chart-focus-point yield-chart-focus-point-nav" />
          ) : null}

          <g transform={`translate(${tooltipX} ${tooltipY})`} className="yield-chart-tooltip">
            <rect width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT} rx={10} />
            <text x={12} y={20} className="yield-chart-tooltip-date">
              {activeLabel}
            </text>
            <text x={12} y={42} className="yield-chart-tooltip-nav">
              官网万份收益 {formatPer10k(navPointMap.get(activeLabel) ?? null)}
            </text>
            <text x={12} y={62} className="yield-chart-tooltip-nav">
              万份收益动能 {formatSignedPer10k(navMomentumMap.get(activeLabel) ?? null)}
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
        <span>
          {!hasContinuousNavTrend
            ? "万份收益曲线已连接可用样本，日频动能继续等样本"
            : navTrend?.rising
              ? "万份收益动能增强"
              : navTrend?.falling
                ? "万份收益动能转弱"
                : "万份收益动能暂无明显拐点"}
        </span>
        <span>{recommendationHint}</span>
      </div>
    </section>
  );
}
