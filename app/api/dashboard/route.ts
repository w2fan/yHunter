import { NextResponse } from "next/server";

import { buildDashboard } from "@/lib/analysis";
import { fetchManagerHistory, hasManagerHistorySupport } from "@/lib/manager-history";
import { enrichProductMappingsFromSpdb } from "@/lib/product-mapping";
import { fetchCashManagementProducts, fetchHoldingSnapshots } from "@/lib/spdb";
import { mergeNavHistory, mergeProductMappings, mergeSnapshots, readDb, writeDb } from "@/lib/store";

export async function GET() {
  try {
    const rawDb = await readDb();
    const db = {
      ...rawDb,
      navHistory: rawDb.navHistory.filter(
        (point) => point.annualizedYield !== null || point.per10kProfit !== null
      )
    };
    if (db.navHistory.length !== rawDb.navHistory.length) {
      await writeDb(db);
    }
    const marketProducts = await fetchCashManagementProducts();
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
        .filter((product) => hasManagerHistorySupport(product))
        .slice(0, 12)
    ];

    if (managerTargets.length > 0) {
      const { history, discoveredMappings } = await fetchManagerHistory(managerTargets, mergedDb.productMappings);
      if (Object.keys(discoveredMappings).length > 0) {
        mergedDb = await mergeProductMappings(discoveredMappings);
      }
      mergedDb = await mergeNavHistory(history);
      mergedDb.lastSyncedAt = syncedAt;
      await writeDb(mergedDb);
    }

    const dashboard = buildDashboard(mergedDb, marketProducts);
    return NextResponse.json(dashboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ message }, { status: 500 });
  }
}
