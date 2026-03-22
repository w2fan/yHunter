import { spawnCurlText } from "@/lib/curl";
import type { Holding, ProductSnapshot } from "@/lib/types";

const SEARCH_URL = "https://per.spdb.com.cn/api/search";
const CHANNEL_ID = 1075;
const PAGE_SIZE = 100;

type SpdbProduct = {
  ProductCode?: string;
  ProductName?: string;
  DeadlineBrandID?: string;
  DeadlineBrandiD?: string;
  RiskLevel?: string;
  CurrencyType?: string;
  ChannelDisIncomeRate?: string;
  IncomeRateDes?: string;
  TACode?: string;
  TAName?: string;
  ProductStatus?: string;
  IndiIPOMinAmnt?: string;
  IncomeDates?: string;
  IPOApplFlag?: string;
};

type SearchResponse = {
  code: number;
  message: string;
  data?: {
    totalPages?: number;
    content?: SpdbProduct[];
  };
};

const metadata =
  "ProductCode|ProductName|DeadlineBrandiD|IncomeDates|RiskLevel|CurrencyType|IndiIPOMinAmnt|TACode|TAName|ChannelDisIncomeRate|IncomeRateDes|ProductStatus|IPOApplFlag";

function normalizeRate(raw?: string): number | null {
  if (!raw) return null;
  const firstPart = raw.split("-")[0]?.replace(/[％%]/g, "").trim();
  const parsed = Number.parseFloat(firstPart ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function mapProduct(raw: SpdbProduct, capturedAt: string): ProductSnapshot | null {
  const productCode = raw.ProductCode?.trim();
  const productName = raw.ProductName?.trim();
  if (!productCode || !productName) return null;

  return {
    productCode,
    productName,
    deadlineBrandId: raw.DeadlineBrandID?.trim() || raw.DeadlineBrandiD?.trim() || "",
    riskLevel: raw.RiskLevel?.trim() || "",
    currencyType: raw.CurrencyType?.trim() || "",
    incomeRate: normalizeRate(raw.ChannelDisIncomeRate),
    incomeRateDisplay: raw.ChannelDisIncomeRate?.trim() || "--",
    incomeRateLabel: raw.IncomeRateDes?.trim() || "收益率",
    taCode: raw.TACode?.trim() || "",
    taName: raw.TAName?.trim() || "",
    productStatus: raw.ProductStatus?.trim() || "",
    minAmount: raw.IndiIPOMinAmnt?.trim() || "--",
    incomeDates: raw.IncomeDates?.trim() || "--",
    ipoApplFlag: raw.IPOApplFlag?.trim(),
    capturedAt,
    capturedDate: capturedAt.slice(0, 10),
    source: "spdb"
  };
}

async function invokeSpdbSearch(searchword: string, page = 1, size = PAGE_SIZE): Promise<SearchResponse> {
  const payload = JSON.stringify({
    metadata,
    chlid: CHANNEL_ID,
    page,
    size,
    searchword
  });

  const stdout = await spawnCurlText(
    [
      "-s",
      "-k",
      "--tlsv1.2",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json; charset=utf-8",
      "--data-binary",
      "@-",
      SEARCH_URL
    ],
    payload
  );

  return JSON.parse(stdout) as SearchResponse;
}

function isTargetCashProduct(product: ProductSnapshot): boolean {
  return (
    product.riskLevel.includes("R1") &&
    product.currencyType.includes("人民币") &&
    product.deadlineBrandId.includes("日") &&
    product.deadlineBrandId.includes("丰") &&
    product.productStatus === "在售"
  );
}

export async function fetchCashManagementProducts(): Promise<ProductSnapshot[]> {
  const capturedAt = new Date().toISOString();
  const firstPage = await invokeSpdbSearch("(RiskLevel=R1低风险)", 1);
  const totalPages = firstPage.data?.totalPages ?? 1;
  const firstRows = firstPage.data?.content ?? [];

  const restPages = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => invokeSpdbSearch("(RiskLevel=R1低风险)", index + 2))
  );

  const rows = [
    ...firstRows,
    ...restPages.flatMap((page) => page.data?.content ?? [])
  ];

  return rows
    .map((row) => mapProduct(row, capturedAt))
    .filter((row): row is ProductSnapshot => Boolean(row))
    .filter(isTargetCashProduct);
}

async function fetchHoldingByCode(holding: Holding): Promise<ProductSnapshot | null> {
  const capturedAt = new Date().toISOString();
  const escapedCode = holding.productCode.replace(/'/g, "");
  const response = await invokeSpdbSearch(`ProductCode='%${escapedCode}%'`, 1, 20);
  const rows = response.data?.content ?? [];
  const exact = rows.find((row) => row.ProductCode?.trim() === holding.productCode) ?? rows[0];
  return exact ? mapProduct(exact, capturedAt) : null;
}

export async function fetchProductByCode(productCode: string): Promise<ProductSnapshot | null> {
  const capturedAt = new Date().toISOString();
  const escapedCode = productCode.trim().replace(/'/g, "");
  if (!escapedCode) return null;

  const response = await invokeSpdbSearch(`ProductCode='%${escapedCode}%'`, 1, 20);
  const rows = response.data?.content ?? [];
  const exact = rows.find((row) => row.ProductCode?.trim() === escapedCode) ?? rows[0];
  return exact ? mapProduct(exact, capturedAt) : null;
}

export async function fetchHoldingSnapshots(holdings: Holding[]): Promise<ProductSnapshot[]> {
  const results = await Promise.all(holdings.map((holding) => fetchHoldingByCode(holding)));
  return results.filter((item): item is ProductSnapshot => Boolean(item));
}
