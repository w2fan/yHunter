import { spawnCurlText } from "@/lib/curl";
import type { ManagerNavPoint, ProductMapping, ProductSnapshot } from "@/lib/types";

type ManagerHistoryFetchResult = {
  history: ManagerNavPoint[];
  mapping?: ProductMapping;
};

type ManagerHistoryAdapter = {
  key: string;
  managerName: string;
  supports(product: ProductSnapshot): boolean;
  fetchHistory(product: ProductSnapshot, mapping?: ProductMapping): Promise<ManagerHistoryFetchResult>;
};

type SpdbWmProductRow = {
  PRDC_CD?: string;
  ACCT_DT?: string;
  YLD_7?: string;
  TDY_MLLN_CPS_PRFT?: string;
};

type CmbcwmProductRow = {
  REAL_PRD_CODE?: string;
  PRD_NAME?: string;
  TBPRDEXTEND_DEBT_REGIST_CODE?: string;
};

type CmbcwmDailyRow = {
  ISS_DATE?: string;
  NAV?: string | number;
  TOT_NAV?: string | number;
  INCOME?: string | number;
  WEEK_CLIENTRATE?: string | number;
};

type ResolvedManagerProduct = {
  managerProductCode: string;
  registrationCode?: string;
};

function normalizeNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "string" ? raw.replace(/,/g, "").trim() : String(raw);
  if (!value || value === "0E-8" || value === "0E-12") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  const normalized = value.replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function normalizeRegistrationCode(raw: string | undefined): string | undefined {
  const normalized = raw?.trim().toUpperCase();
  return normalized && /^Z\d{10,}$/.test(normalized) ? normalized : undefined;
}

async function curlText(args: string[], stdin?: string): Promise<string> {
  return spawnCurlText(args, stdin);
}

async function spdbWmSearch<T>(payload: Record<string, unknown>): Promise<T[]> {
  const body = JSON.stringify(payload);
  const stdout = await curlText(
    [
      "-s",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json; charset=utf-8",
      "--data-binary",
      "@-",
      "https://www.spdb-wm.com/api/search"
    ],
    body
  );

  const json = JSON.parse(stdout) as {
    data?: {
      content?: T[];
    };
  };

  return json.data?.content ?? [];
}

async function cmbcwmPost<T>(endpoint: string, data: Record<string, string | number>): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    params.append(key, String(value));
  }

  const stdout = await curlText(
    [
      "-k",
      "-s",
      "-X",
      "POST",
      `https://www.cmbcwm.com.cn/gw/po_web/${endpoint}`,
      "--data",
      params.toString()
    ]
  );

  return JSON.parse(stdout) as T;
}

function normalizeCmbcwmName(value: string): string {
  return value
    .replace(/民生理财/g, "")
    .replace(/民生/g, "")
    .replace(/现金管理/g, "")
    .replace(/理财产品/g, "")
    .replace(/[()（）·\s-]/g, "")
    .trim()
    .toUpperCase();
}

function buildCmbcwmSearchTerms(productName: string): string[] {
  const normalized = productName.replace(/\s+/g, "").trim();
  const compact = normalizeCmbcwmName(normalized);
  const terms = new Set<string>([normalized, compact]);
  const seriesMatch = compact.match(/([\p{Script=Han}A-Z]+?\d+号[A-Z]?)/u)?.[1];
  if (seriesMatch) {
    terms.add(seriesMatch);
    terms.add(seriesMatch.replace(/号/gu, ""));
  }
  const shorterSeries = compact.match(/([\p{Script=Han}A-Z]+?\d+)/u)?.[1];
  if (shorterSeries) {
    terms.add(shorterSeries);
  }
  return [...terms].filter((term) => term.length >= 4);
}

async function findCmbcwmRealProductCode(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  if (mapping?.managerProductCode) {
    return {
      managerProductCode: mapping.managerProductCode,
      registrationCode: normalizeRegistrationCode(mapping.registrationCode)
    };
  }

  const searchTerms = buildCmbcwmSearchTerms(product.productName);
  const targetName = normalizeCmbcwmName(product.productName);
  const productSuffix = product.productName.match(/(\d+号[A-Z])/u)?.[1]?.toUpperCase();

  for (const term of searchTerms) {
    const response = await cmbcwmPost<{ list?: CmbcwmProductRow[] }>("BTAProductQry", {
      code_or_name: term,
      pageNo: 1,
      pageSize: 10
    });

    const rows = response.list ?? [];
    if (rows.length === 0) continue;

    const exact = rows.find((row) => {
      const rowName = normalizeCmbcwmName(row.PRD_NAME ?? "");
      return rowName === targetName || rowName.includes(targetName) || targetName.includes(rowName);
    });

    if (exact?.REAL_PRD_CODE) {
      return {
        managerProductCode: exact.REAL_PRD_CODE,
        registrationCode: normalizeRegistrationCode(exact.TBPRDEXTEND_DEBT_REGIST_CODE)
      };
    }

    if (productSuffix) {
      const close = rows.find((row) => (row.PRD_NAME ?? "").toUpperCase().includes(productSuffix));
      if (close?.REAL_PRD_CODE) {
        return {
          managerProductCode: close.REAL_PRD_CODE,
          registrationCode: normalizeRegistrationCode(close.TBPRDEXTEND_DEBT_REGIST_CODE)
        };
      }
    }
  }

  return null;
}

const spdbWmAdapter: ManagerHistoryAdapter = {
  key: "spdb_wm",
  managerName: "浦银理财",
  supports(product) {
    return product.taCode === "66";
  },
  async fetchHistory(product) {
    const fetchedAt = new Date().toISOString();
    const rows = await spdbWmSearch<SpdbWmProductRow>({
      chlid: 1002,
      cutsize: 150,
      dynexpr: [],
      dynidx: 1,
      extopt: [],
      orderby: "",
      page: 1,
      size: 20,
      searchword: `(PRDC_CD = '${product.productCode}')`
    });

    const row = rows.find((item) => item.PRDC_CD === product.productCode) ?? rows[0];
    const navDate = formatDate(row?.ACCT_DT);

    if (!row || !navDate) {
      return { history: [] };
    }

    return {
      history: [
        {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: null,
          totalNav: null,
          annualizedYield: normalizeNumber(row.YLD_7),
          per10kProfit: normalizeNumber(row.TDY_MLLN_CPS_PRFT),
          fetchedAt,
          source: "spdb_wm"
        }
      ]
    };
  }
};

const cmbcwmAdapter: ManagerHistoryAdapter = {
  key: "cmbcwm",
  managerName: "民生理财有限责任公司",
  supports(product) {
    return product.taCode === "MS";
  },
  async fetchHistory(product, mapping) {
    const resolved = await findCmbcwmRealProductCode(product, mapping);
    if (!resolved) {
      return { history: [] };
    }

    const fetchedAt = new Date().toISOString();
    const response = await cmbcwmPost<{
      isJXGL?: string;
      list?: CmbcwmDailyRow[];
      btaDailyAddFieldList?: CmbcwmDailyRow[];
    }>("BTADailyQry", {
      chart_type: 1,
      real_prd_code: resolved.managerProductCode,
      begin_date: "",
      end_date: "",
      pageNo: 1,
      pageSize: 400
    });

    const rows =
      response.isJXGL === "1" && (response.btaDailyAddFieldList?.length ?? 0) > 0
        ? response.btaDailyAddFieldList ?? []
        : response.list ?? [];

    type CmbcwmPoint = Omit<ManagerNavPoint, "source"> & { source: "cmbcwm" };

    const history = rows
      .map((row) => {
        const navDate = formatDate(row.ISS_DATE);
        if (!navDate) return null;

        const point: CmbcwmPoint = {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: normalizeNumber(row.NAV),
          totalNav: normalizeNumber(row.TOT_NAV),
          annualizedYield: (() => {
            const value = normalizeNumber(row.WEEK_CLIENTRATE);
            return value === null ? null : value * 100;
          })(),
          per10kProfit: normalizeNumber(row.INCOME),
          fetchedAt,
          source: "cmbcwm"
        };

        return point;
      })
      .filter((point): point is CmbcwmPoint => point !== null);

    return {
      history,
      mapping: {
        managerProductCode: resolved.managerProductCode,
        registrationCode: resolved.registrationCode ?? mapping?.registrationCode,
        source: "manager_site"
      }
    };
  }
};

const adapters: ManagerHistoryAdapter[] = [spdbWmAdapter, cmbcwmAdapter];

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await worker(current));
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export function hasManagerHistorySupport(product: ProductSnapshot): boolean {
  return adapters.some((adapter) => adapter.supports(product));
}

export async function fetchManagerHistory(
  products: ProductSnapshot[],
  productMappings: Record<string, ProductMapping> = {}
): Promise<{ history: ManagerNavPoint[]; discoveredMappings: Record<string, ProductMapping> }> {
  const uniqueProducts = products.filter(
    (product, index, array) => array.findIndex((item) => item.productCode === product.productCode) === index
  );

  const supported = uniqueProducts
    .map((product) => ({
      product,
      adapter: adapters.find((adapter) => adapter.supports(product)) ?? null
    }))
    .filter((item): item is { product: ProductSnapshot; adapter: ManagerHistoryAdapter } => Boolean(item.adapter));

  const chunks = await mapWithConcurrency(supported, 1, async ({ product, adapter }) => {
    try {
      return {
        productCode: product.productCode,
        result: await adapter.fetchHistory(product, productMappings[product.productCode])
      };
    } catch {
      return {
        productCode: product.productCode,
        result: { history: [] } satisfies ManagerHistoryFetchResult
      };
    }
  });

  return {
    history: chunks.flatMap((chunk) => chunk.result.history),
    discoveredMappings: Object.fromEntries(
      chunks
        .filter((chunk) => chunk.result.mapping)
        .map((chunk) => [chunk.productCode, chunk.result.mapping as ProductMapping])
    )
  };
}
