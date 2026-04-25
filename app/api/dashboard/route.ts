import { NextResponse } from "next/server";

import { buildDashboard } from "@/lib/analysis";
import { fetchManagerHistory, hasManagerHistorySupport } from "@/lib/manager-history";
import { supportsCmbCfwebCashHistory } from "@/lib/manager-support";
import { enrichProductMappingsFromSpdb } from "@/lib/product-mapping";
import { finishRefreshProgress, getRefreshProgress, startRefreshProgress, updateRefreshProgress } from "@/lib/refresh-progress";
import { fetchCashManagementProducts, fetchHoldingSnapshots } from "@/lib/spdb";
import { mergeNavHistory, mergeProductMappings, mergeSnapshots, readDb, writeDb } from "@/lib/store";
import type { DbShape, ProductSnapshot } from "@/lib/types";

function isTargetCashProduct(product: ProductSnapshot): boolean {
  return (
    product.riskLevel.includes("R1") &&
    product.currencyType.includes("人民币") &&
    product.deadlineBrandId.includes("日") &&
    product.deadlineBrandId.includes("丰") &&
    product.productStatus === "在售"
  );
}

function normalizeDashboardDb(db: DbShape): DbShape {
  return {
    ...db,
    navHistory: db.navHistory
      .map((point) => {
        if (
          point.source === "spdb_wm" &&
          point.managerCode === "66" &&
          point.annualizedYield !== null &&
          point.annualizedYield < 0.1
        ) {
          return {
            ...point,
            annualizedYield: point.annualizedYield * 100
          };
        }

        return point;
      })
      .filter((point) => point.annualizedYield !== null || point.per10kProfit !== null)
  };
}

function latestSnapshotsByCode(db: DbShape): ProductSnapshot[] {
  const latestByCode = new Map<string, ProductSnapshot>();

  for (const snapshot of db.snapshots) {
    const current = latestByCode.get(snapshot.productCode);
    if (!current || current.capturedAt < snapshot.capturedAt) {
      latestByCode.set(snapshot.productCode, snapshot);
    }
  }

  return [...latestByCode.values()];
}

async function buildCachedDashboardResponse() {
  const rawDb = await readDb();
  const db = normalizeDashboardDb(rawDb);

  if (db.navHistory.length !== rawDb.navHistory.length) {
    await writeDb(db);
  }

  const marketProducts = latestSnapshotsByCode(db).filter(isTargetCashProduct);
  return {
    ...buildDashboard(db, marketProducts),
    lastRefreshSummary: db.lastRefreshSummary
  };
}

async function refreshDashboardResponse() {
  startRefreshProgress("starting", "准备刷新市场快照和管理人历史");

  try {
    const rawDb = await readDb();
    const db = normalizeDashboardDb(rawDb);
    if (db.navHistory.length !== rawDb.navHistory.length) {
      await writeDb(db);
    }

    updateRefreshProgress({
      stage: "market_snapshot",
      detail: "正在刷新浦发市场快照",
      currentManager: "浦发银行",
      currentProduct: null
    });
    const marketProducts = await fetchCashManagementProducts();

    updateRefreshProgress({
      stage: "holding_snapshot",
      detail: "正在刷新持仓快照",
      currentManager: "浦发银行",
      currentProduct: null
    });
    const holdingProducts = await fetchHoldingSnapshots(db.holdings);
    const syncedAt = new Date().toISOString();

    let mergedDb = await mergeSnapshots([...marketProducts, ...holdingProducts], syncedAt);
    const roughDashboard = buildDashboard(mergedDb, marketProducts);
    const marketMap = new Map(marketProducts.map((product) => [product.productCode, product]));
    const holdingMap = new Map(holdingProducts.map((product) => [product.productCode, product]));
    const mappingTargets = [
      ...db.holdings
        .map((holding) => holdingMap.get(holding.productCode) ?? marketMap.get(holding.productCode))
        .filter((product): product is NonNullable<typeof product> => Boolean(product)),
      ...roughDashboard.candidates.map((candidate) => candidate.product).slice(0, 12)
    ];

    if (mappingTargets.length > 0) {
      updateRefreshProgress({
        stage: "mapping",
        detail: "正在补齐浦发产品映射",
        currentManager: "浦发银行",
        currentProduct: null
      });
      const discoveredMappings = await enrichProductMappingsFromSpdb(mappingTargets, mergedDb.productMappings);
      if (Object.keys(discoveredMappings).length > 0) {
        mergedDb = await mergeProductMappings(discoveredMappings);
      }
    }

    const managerTargets = [
      ...mergedDb.holdings
        .map((holding) => holdingMap.get(holding.productCode) ?? marketMap.get(holding.productCode))
        .filter((product): product is NonNullable<typeof product> => Boolean(product)),
      ...roughDashboard.candidates
        .map((candidate) => candidate.product)
        .filter((product) => hasManagerHistorySupport(product)),
      ...marketProducts.filter((product) => product.taCode === "EW" && /阳光碧乐活/u.test(product.productName)),
      ...marketProducts
        .filter((product) => product.taCode === "66")
        .sort((left, right) => (right.incomeRate ?? -Infinity) - (left.incomeRate ?? -Infinity))
        .slice(0, 12),
      ...marketProducts
        .filter((product) => product.taCode === "ZY" && supportsCmbCfwebCashHistory(product.productName))
        .sort((left, right) => (right.incomeRate ?? -Infinity) - (left.incomeRate ?? -Infinity)),
      ...marketProducts
        .filter((product) => product.taCode === "ZX" && /日盈象天天利/u.test(product.productName))
        .sort((left, right) => (right.incomeRate ?? -Infinity) - (left.incomeRate ?? -Infinity))
        .slice(0, 12)
    ];

    if (managerTargets.length > 0) {
      updateRefreshProgress({
        stage: "manager_history",
        detail: "正在刷新管理人官网历史",
        currentManager: null,
        currentProduct: null,
        processed: 0,
        total: managerTargets.length
      });
      const { history, discoveredMappings, summary } = await fetchManagerHistory(managerTargets, mergedDb.productMappings, {
        onProgress: ({ managerName, productName, processed, total }) => {
          updateRefreshProgress({
            stage: "manager_history",
            detail: `正在刷新${managerName}`,
            currentManager: managerName,
            currentProduct: productName,
            processed,
            total
          });
        }
      });
      if (Object.keys(discoveredMappings).length > 0) {
        mergedDb = await mergeProductMappings(discoveredMappings);
      }
      updateRefreshProgress({
        stage: "saving",
        detail: "正在写入本地分析结果",
        currentManager: null,
        currentProduct: null,
        processed: managerTargets.length,
        total: managerTargets.length
      });
      mergedDb = await mergeNavHistory(history);
      mergedDb.lastSyncedAt = syncedAt;
      mergedDb.lastRefreshSummary = {
        ...summary,
        completedAt: syncedAt
      };
      await writeDb(mergedDb);
    } else {
      mergedDb.lastSyncedAt = syncedAt;
      mergedDb.lastRefreshSummary = {
        totalProducts: 0,
        succeededProducts: 0,
        failedProducts: 0,
        completedAt: syncedAt
      };
      await writeDb(mergedDb);
    }

    const dashboard = {
      ...buildDashboard(mergedDb, marketProducts),
      lastRefreshSummary: mergedDb.lastRefreshSummary
    };
    finishRefreshProgress("completed", "刷新完成");
    return NextResponse.json(dashboard);
  } catch (error) {
    console.error("[api/dashboard] refresh failed:", error);
    const progress = getRefreshProgress();
    const baseMessage = error instanceof Error ? error.message : "未知错误";
    const location = progress.currentProduct
      ? `${progress.currentManager ?? "管理人官网"} / ${progress.currentProduct}`
      : progress.currentManager ?? progress.detail;
    const message = location ? `刷新失败：${baseMessage}（卡在 ${location}）` : `刷新失败：${baseMessage}`;
    finishRefreshProgress("failed", message);
    return NextResponse.json({ message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const dashboard = await buildCachedDashboardResponse();
    return NextResponse.json(dashboard, {
      headers: {
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取缓存失败";
    return NextResponse.json({ message }, { status: 500 });
  }
}

export async function POST() {
  const progress = getRefreshProgress();
  if (progress.active) {
    const message = progress.currentProduct
      ? `已有刷新任务进行中（当前：${progress.currentManager ?? "管理人官网"} / ${progress.currentProduct}）`
      : "已有刷新任务进行中";
    return NextResponse.json({ message }, { status: 409 });
  }
  return refreshDashboardResponse();
}
