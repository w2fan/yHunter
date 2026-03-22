import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DbShape, Holding, ManagerNavPoint, ProductMapping, ProductSnapshot } from "@/lib/types";

const DATA_DIR = process.env.YHUNTER_DATA_DIR
  ? path.resolve(process.env.YHUNTER_DATA_DIR)
  : path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const defaultDb: DbShape = {
  holdings: [],
  snapshots: [],
  navHistory: [],
  productMappings: {},
  lastSyncedAt: null
};

export async function readDb(): Promise<DbShape> {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    const rawMappings = parsed.productMappings ?? {};
    const productMappings = Object.fromEntries(
      Object.entries(rawMappings).map(([productCode, value]) => {
        if (typeof value === "string") {
          return [productCode, { managerProductCode: value }];
        }
        return [productCode, value ?? {}];
      })
    );
    return {
      holdings: parsed.holdings ?? [],
      snapshots: parsed.snapshots ?? [],
      navHistory: parsed.navHistory ?? [],
      productMappings,
      lastSyncedAt: parsed.lastSyncedAt ?? null
    };
  } catch {
    await writeDb(defaultDb);
    return structuredClone(defaultDb);
  }
}

export async function writeDb(db: DbShape): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function normalizeRegistrationCode(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

function mergeProductMapping(
  current: ProductMapping | undefined,
  next: { managerProductCode?: string; registrationCode?: string; source?: ProductMapping["source"] }
): ProductMapping | undefined {
  const merged: ProductMapping = {
    managerProductCode: next.managerProductCode ?? current?.managerProductCode,
    registrationCode: next.registrationCode ?? current?.registrationCode,
    source: next.source ?? current?.source
  };

  if (!merged.managerProductCode && !merged.registrationCode) {
    return undefined;
  }

  return merged;
}

export async function addHolding(input: Omit<Holding, "id" | "addedAt">): Promise<Holding> {
  const db = await readDb();
  const productCode = input.productCode.trim();
  const productName = input.productName.trim();
  const managerProductCode = input.managerProductCode?.trim() || undefined;
  const registrationCode = normalizeRegistrationCode(input.registrationCode);

  const existing = db.holdings.find((item) => item.productCode === productCode);
  if (existing) {
    let changed = false;
    const mergedMapping = mergeProductMapping(db.productMappings[productCode], {
      managerProductCode,
      registrationCode,
      source: "manual"
    });
    if (JSON.stringify(mergedMapping ?? null) !== JSON.stringify(db.productMappings[productCode] ?? null)) {
      if (mergedMapping) {
        db.productMappings[productCode] = mergedMapping;
      } else {
        delete db.productMappings[productCode];
      }
      changed = true;
    }
    if (registrationCode && existing.registrationCode !== registrationCode) {
      existing.registrationCode = registrationCode;
      changed = true;
    }
    if (managerProductCode && existing.managerProductCode !== managerProductCode) {
      existing.managerProductCode = managerProductCode;
      changed = true;
    }
    if (changed) {
      await writeDb(db);
      return {
        ...existing,
        managerProductCode: managerProductCode ?? existing.managerProductCode,
        registrationCode: registrationCode ?? existing.registrationCode
      };
    }
    return existing;
  }

  const holding: Holding = {
    id: crypto.randomUUID(),
    productCode,
    productName,
    managerProductCode,
    registrationCode,
    note: input.note?.trim() || undefined,
    addedAt: new Date().toISOString()
  };

  db.holdings = [holding, ...db.holdings];
  const mergedMapping = mergeProductMapping(db.productMappings[productCode], {
    managerProductCode,
    registrationCode,
    source: "manual"
  });
  if (mergedMapping) {
    db.productMappings[productCode] = mergedMapping;
  }
  await writeDb(db);
  return holding;
}

export async function removeHolding(id: string): Promise<boolean> {
  const db = await readDb();
  const next = db.holdings.filter((item) => item.id !== id);
  const changed = next.length !== db.holdings.length;

  if (changed) {
    db.holdings = next;
    await writeDb(db);
  }

  return changed;
}

export async function mergeSnapshots(nextSnapshots: ProductSnapshot[], syncedAt: string): Promise<DbShape> {
  const db = await readDb();
  const seen = new Set(
    db.snapshots.map((item) => `${item.productCode}:${item.capturedDate}:${item.incomeRateDisplay}`)
  );

  for (const snapshot of nextSnapshots) {
    const key = `${snapshot.productCode}:${snapshot.capturedDate}:${snapshot.incomeRateDisplay}`;
    if (!seen.has(key)) {
      db.snapshots.push(snapshot);
      seen.add(key);
    }
  }

  db.lastSyncedAt = syncedAt;
  await writeDb(db);
  return db;
}

export async function mergeProductMappings(nextMappings: Record<string, ProductMapping>): Promise<DbShape> {
  const db = await readDb();
  let changed = false;

  for (const [productCode, nextMapping] of Object.entries(nextMappings)) {
    const normalizedNext = mergeProductMapping(db.productMappings[productCode], {
      managerProductCode: nextMapping.managerProductCode?.trim() || undefined,
      registrationCode: normalizeRegistrationCode(nextMapping.registrationCode),
      source: nextMapping.source
    });

    if (!normalizedNext) {
      continue;
    }

    if (JSON.stringify(normalizedNext) !== JSON.stringify(db.productMappings[productCode] ?? null)) {
      db.productMappings[productCode] = normalizedNext;
      changed = true;
    }

    const holding = db.holdings.find((item) => item.productCode === productCode);
    if (holding) {
      if (normalizedNext.managerProductCode && holding.managerProductCode !== normalizedNext.managerProductCode) {
        holding.managerProductCode = normalizedNext.managerProductCode;
        changed = true;
      }
      if (normalizedNext.registrationCode && holding.registrationCode !== normalizedNext.registrationCode) {
        holding.registrationCode = normalizedNext.registrationCode;
        changed = true;
      }
    }
  }

  if (changed) {
    await writeDb(db);
  }

  return db;
}

export async function mergeNavHistory(nextHistory: ManagerNavPoint[]): Promise<DbShape> {
  const db = await readDb();
  const seen = new Set(
    db.navHistory.map(
      (item) =>
        `${item.source}:${item.productCode}:${item.navDate}:${item.annualizedYield ?? "null"}:${item.per10kProfit ?? "null"}:${item.nav ?? "null"}:${item.totalNav ?? "null"}`
    )
  );

  for (const point of nextHistory) {
    const key =
      `${point.source}:${point.productCode}:${point.navDate}:` +
      `${point.annualizedYield ?? "null"}:${point.per10kProfit ?? "null"}:` +
      `${point.nav ?? "null"}:${point.totalNav ?? "null"}`;
    if (!seen.has(key)) {
      db.navHistory.push(point);
      seen.add(key);
    }
  }

  await writeDb(db);
  return db;
}
