import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnCurl, spawnCurlText } from "@/lib/curl";
import { parseCmbCfwebCashProduct, supportsCmbCfwebCashHistory } from "@/lib/manager-support";
import { readDb } from "@/lib/store";
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

type FetchManagerHistoryOptions = {
  onProgress?: (payload: {
    managerName: string;
    productName: string;
    productCode: string;
    processed: number;
    total: number;
  }) => void;
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
  managerProductType?: string;
};

type CmbCfwebResponse<T> = {
  returnCode?: string;
  errorMsg?: string | null;
  body?: T | null;
};

type CmbCfwebDetail = {
  prdCode?: string;
  prdBrief?: string;
  prdName?: string;
  regCode?: string;
  saaCod?: string;
  funCod?: string;
};

type CmbCfwebValueRow = {
  zripNbr?: string;
  zripSnm?: string;
  zsaaCod?: string;
  znavDat?: string;
  znavVal?: string | number;
  znavCtl?: string | number;
  znavPct?: string | number;
  znavChg?: string | number;
};

type CmbCfwebProductRow = {
  prdCode: string;
  prdBrief: string | undefined;
  prdName: string;
  regCode: string | undefined;
};

type CibPfundRow = {
  managerProductCode: string;
  registrationCode?: string;
  productName: string;
};

type SpdbDisclosureDoc = {
  productcode?: string;
  doctitle?: string;
  productdate?: string;
  puburl?: string;
};

type SpdbDisclosureResponse = {
  data?: {
    content?: SpdbDisclosureDoc[];
  };
};

type CiticSearchRow = {
  prodCode?: string;
  prodName?: string;
  prodNameShort?: string;
  productType?: string | number;
  respProductType?: string | number;
  distributorCodes?: string;
  distributorNames?: string;
};

type CiticResponse<T> = {
  code?: string | number;
  msg?: string;
  data?: T | null;
};

type CiticDetail = {
  prodCode?: string;
  prodName?: string;
  prodNameShort?: string;
  registCode?: string;
  productType?: string | number;
  navDate?: string;
  nav?: string | number;
  totalNav?: string | number;
  sevenDaysIncomeRate?: string | number;
  tenThousandIncomeAmt?: string | number;
  outTenThousandIncomeAmt?: string | number;
};

type CiticNavRow = {
  prodCode?: string;
  navDate?: string;
  nav?: string | number;
  totalNav?: string | number;
  sevenDaysIncomeRate?: string | number;
  tenThousandIncomeAmt?: string | number;
  outTenThousandIncomeAmt?: string | number;
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

function normalizeCibPfundName(value: string): string {
  return value.replace(/光大理财/g, "").replace(/份额/g, "").replace(/\s+/g, "").trim().toUpperCase();
}

function parseEwSeriesInfo(value: string): { series: string; share: string | null } | null {
  const match = value.replace(/\s+/g, "").match(/阳光碧乐活(\d+)号([A-Z]+)?/u);
  if (!match) {
    return null;
  }

  return {
    series: match[1],
    share: match[2] ?? null
  };
}

async function curlText(args: string[], stdin?: string): Promise<string> {
  return spawnCurlText(args, stdin);
}

async function spawnText(command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdoutChunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
    });

    if (stdin) {
      child.stdin.write(stdin, "utf8");
    }
    child.stdin.end();
  });
}

async function spdbWmSearch<T>(payload: Record<string, unknown>): Promise<T[]> {
  const body = JSON.stringify(payload);
  const stdout = await curlText(
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

async function buildCmbCfwebHeaders(): Promise<string[]> {
  const appId = "LB50.22_CFWebUI";
  const timeSpan = Date.now().toString();
  const keyHex = Buffer.from("5qwBGju73JAXid4D", "utf8").toString("hex");
  const signature = (
    await spawnText("openssl", ["enc", "-sm4-ecb", "-K", keyHex, "-nosalt", "-base64"], `${appId}|${timeSpan}`)
  ).replace(/\s+/g, "");

  return [
    "-H",
    `appId: ${appId}`,
    "-H",
    `timespan: ${timeSpan}`,
    "-H",
    `signature: ${signature}`,
    "-H",
    "X-B3-BusinessId: CFWebUI",
    "-H",
    "Content-Type: application/json;charset=UTF-8"
  ];
}

async function cmbCfwebPost<T>(path: string, data: unknown = {}): Promise<T> {
  const stdout = await curlText(
    [
      "-s",
      "--connect-timeout",
      "8",
      "--max-time",
      "20",
      "-X",
      "POST",
      ...(await buildCmbCfwebHeaders()),
      "--data-binary",
      "@-",
      `https://cfweb.paas.cmbchina.com/api${path}`
    ],
    JSON.stringify(data)
  );

  return JSON.parse(stdout) as T;
}

let cachedCibPfundRows: CibPfundRow[] | null = null;
let cachedCmbCfwebEwRows: CmbCfwebProductRow[] | null = null;
const cachedSpdbDisclosureDocs = new Map<string, SpdbDisclosureDoc[]>();
const cachedSpdbReportPoints = new Map<string, ManagerNavPoint[]>();
const cachedSpdbRelatedCodes = new Map<string, string[]>();
const cachedCiticSearchRows = new Map<string, CiticSearchRow[]>();

function normalizeCiticName(value: string): string {
  return value
    .replace(/信银理财/g, "")
    .replace(/现金管理型理财产品/g, "")
    .replace(/现金管理类理财产品/g, "")
    .replace(/理财产品/g, "")
    .replace(/产品/g, "")
    .replace(/（[^）]+）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[·\s-]/g, "")
    .trim()
    .toUpperCase();
}

function buildCiticSearchTerms(productName: string): string[] {
  const normalized = productName.replace(/\s+/g, "").trim();
  const compact = normalizeCiticName(normalized);
  const terms = new Set<string>([normalized, compact]);
  const seriesMatch = normalized.match(/(日盈象天天利\d+号(?:（[^）]+）)?[A-Z])/u)?.[1];
  if (seriesMatch) {
    terms.add(seriesMatch);
    terms.add(seriesMatch.replace(/信银理财/gu, ""));
    terms.add(seriesMatch.replace(/[（）()]/gu, ""));
  }
  return [...terms].filter((term) => term.length >= 4);
}

async function citicGet<T>(path: string, params: Record<string, string | number>): Promise<CiticResponse<T>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }

  const stdout = await curlText([
    "-s",
    "--connect-timeout",
    "8",
    "--max-time",
    "20",
    `https://wechat.citic-wealth.com${path}?${query.toString()}`
  ]);
  return JSON.parse(stdout) as CiticResponse<T>;
}

async function searchCiticProducts(term: string): Promise<CiticSearchRow[]> {
  const cached = cachedCiticSearchRows.get(term);
  if (cached) {
    return cached;
  }

  const response = await citicGet<CiticSearchRow[]>("/cms.product/api/custom/productInfo/search", { key: term });
  const rows = response.data ?? [];
  cachedCiticSearchRows.set(term, rows);
  return rows;
}

function normalizeSpdbSeriesName(value: string): string {
  return value
    .replace(/浦银理财/g, "")
    .replace(/现金管理产品/g, "")
    .replace(/理财产品/g, "")
    .replace(/理财计划/g, "")
    .replace(/产品/g, "")
    .replace(/（[^）]+）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[A-Z]$/u, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

async function loadCibPfundRows(): Promise<CibPfundRow[]> {
  if (cachedCibPfundRows) {
    return cachedCibPfundRows;
  }

  const html = await curlText(["-s", "https://wealth.cib.com.cn/new/xxcx/pfund.html"]);
  const rows = [...html.matchAll(/<tr>\s*<td>(EWEW[^<]+)<\/td>\s*<td>[^<]*<\/td>\s*<td>(Z\d+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>[^<]*<\/td>\s*<td>(光大理财)<\/td>/g)].map(
    (match) => ({
      managerProductCode: match[1].replace(/^EWEW/u, "EW").trim().toUpperCase(),
      registrationCode: normalizeRegistrationCode(match[2]),
      productName: match[3].trim()
    })
  );

  cachedCibPfundRows = rows;
  return rows;
}

async function loadCmbCfwebEwRows(): Promise<CmbCfwebProductRow[]> {
  if (cachedCmbCfwebEwRows) {
    return cachedCmbCfwebEwRows;
  }

  const productNumbers = Array.from({ length: 251 }, (_, index) => 30000 + index);
  const rows = await mapWithConcurrency(productNumbers, 8, async (productNumber) => {
    const managerProductCode = `GD${String(productNumber).padStart(6, "0")}`;

    try {
      const response = await cmbCfwebPost<CmbCfwebResponse<CmbCfwebProductRow[]>>(
        `/ProductInfo/getProductByPrdCode?prdCode=${encodeURIComponent(managerProductCode)}`
      );

      const row = response.body?.[0];
      if (!row?.prdCode || !/阳光碧乐活/u.test(row.prdName ?? "")) {
        return null;
      }

      const productName = row.prdName?.trim();
      if (!productName) {
        return null;
      }

      return {
        prdCode: row.prdCode.trim().toUpperCase(),
        prdBrief: row.prdBrief,
        prdName: productName,
        regCode: normalizeRegistrationCode(row.regCode)
      } satisfies CmbCfwebProductRow;
    } catch {
      return null;
    }
  });

  const discoveredRows = rows.filter((row): row is CmbCfwebProductRow => row !== null);
  cachedCmbCfwebEwRows = discoveredRows;
  return discoveredRows;
}

async function searchSpdbDisclosureDocs(productCode: string): Promise<SpdbDisclosureDoc[]> {
  const cached = cachedSpdbDisclosureDocs.get(productCode);
  if (cached) {
    return cached;
  }

  const stdout = await curlText(
    [
      "-s",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json; charset=utf-8",
      "--data-binary",
      "@-",
      "https://per.spdb.com.cn/api/search"
    ],
    JSON.stringify({
      metadata: "productcode|doctitle|productdate|puburl",
      chlid: 1072,
      page: 1,
      size: 50,
      searchword: `productcode=${productCode}`
    })
  );

  const rows = (JSON.parse(stdout) as SpdbDisclosureResponse).data?.content ?? [];
  cachedSpdbDisclosureDocs.set(productCode, rows);
  return rows;
}

async function findRelatedSpdbProductCodes(product: ProductSnapshot): Promise<string[]> {
  const cached = cachedSpdbRelatedCodes.get(product.productCode);
  if (cached) {
    return cached;
  }

  const db = await readDb();
  const latestByCode = new Map<string, ProductSnapshot>();
  for (const snapshot of db.snapshots) {
    if (snapshot.taCode !== "66") continue;
    const current = latestByCode.get(snapshot.productCode);
    if (!current || current.capturedAt < snapshot.capturedAt) {
      latestByCode.set(snapshot.productCode, snapshot);
    }
  }

  const targetSeries = normalizeSpdbSeriesName(product.productName);
  const relatedCodes = [...latestByCode.values()]
    .filter((snapshot) => normalizeSpdbSeriesName(snapshot.productName) === targetSeries)
    .map((snapshot) => snapshot.productCode);

  const uniqueCodes = [...new Set([product.productCode, ...relatedCodes])];
  cachedSpdbRelatedCodes.set(product.productCode, uniqueCodes);
  return uniqueCodes;
}

async function resolvePdfUrl(url: string): Promise<string | null> {
  const html = await curlText(["-s", "--connect-timeout", "8", "--max-time", "20", "-L", url]);
  const match = html.match(/URL=([^"'>\s]+)/i);
  return match?.[1] ?? (url.toLowerCase().endsWith(".pdf") ? url : null);
}

async function parsePdfText(pdfBuffer: Buffer): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "yh-spdb-report-"));
  const pdfPath = path.join(tempDir, "report.pdf");

  try {
    await writeFile(pdfPath, pdfBuffer);
    return await spawnText("node", [path.join(process.cwd(), "scripts/parse-pdf.cjs"), pdfPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractSpdbReportPoint(
  product: ProductSnapshot,
  doc: SpdbDisclosureDoc,
  relatedCodes: string[]
): Promise<ManagerNavPoint | null> {
  if (!doc.puburl) {
    return null;
  }

  const pdfUrl = await resolvePdfUrl(doc.puburl);
  if (!pdfUrl) {
    return null;
  }

  const pdfBuffer = await spawnCurl(["-s", "--connect-timeout", "8", "--max-time", "25", "-L", pdfUrl]);
  const text = await parsePdfText(pdfBuffer);
  const periodMatch = text.match(/报告期（\s*(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})\s*）/u);
  const navDate = periodMatch?.[2] ?? formatDate(doc.productdate);
  if (!navDate) {
    return null;
  }

  const titleCodes = [...(doc.doctitle?.matchAll(/\b(\d{10})\b/g) ?? [])].map((match) => match[1]);
  const codeCandidates = [...new Set([product.productCode, doc.productcode ?? "", ...relatedCodes, ...titleCodes].filter(Boolean))];
  const extractSectionNumber = (label: string) => {
    const sectionIndex = text.indexOf(label);
    if (sectionIndex < 0) return null;
    const section = text.slice(sectionIndex, sectionIndex + 2_500);

    for (const code of codeCandidates) {
      const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = section.match(new RegExp(`${escapedCode}(?:-[A-Z0-9]+)?\\s*[:：]\\s*([0-9.\\-]+)`, "i"));
      const value = normalizeNumber(match?.[1]);
      if (value !== null) {
        return value;
      }
    }

    return null;
  };

  const nav = extractSectionNumber("产品份额净值");
  const totalNav = extractSectionNumber("累计净值");
  const per10kProfit = extractSectionNumber("每万份收益");
  const annualizedYieldRaw = extractSectionNumber("七日年化收益率");
  const annualizedYield = annualizedYieldRaw === null ? null : annualizedYieldRaw * 100;

  if (nav === null && totalNav === null && per10kProfit === null && annualizedYield === null) {
    return null;
  }

  return {
    productCode: product.productCode,
    productName: product.productName,
    managerCode: product.taCode,
    managerName: product.taName,
    navDate,
    nav,
    totalNav,
    annualizedYield,
    per10kProfit,
    fetchedAt: new Date().toISOString(),
    source: "spdb_report"
  };
}

async function fetchSpdbCashReportHistory(product: ProductSnapshot): Promise<ManagerNavPoint[]> {
  const cached = cachedSpdbReportPoints.get(product.productCode);
  if (cached) {
    return cached;
  }

  const relatedCodes = await findRelatedSpdbProductCodes(product);
  const docs = (
    await mapWithConcurrency(relatedCodes, 4, async (code) => {
      try {
        return await searchSpdbDisclosureDocs(code);
      } catch {
        return [];
      }
    })
  )
    .flat()
    .filter((doc, index, array) => array.findIndex((item) => item.puburl === doc.puburl) === index);

  const reportDocs = docs
    .filter((doc) => /定期报告/u.test(doc.doctitle ?? ""))
    .sort((left, right) => (left.productdate ?? "").localeCompare(right.productdate ?? ""));

  const points = (
    await mapWithConcurrency(reportDocs, 2, async (doc) => {
      try {
        return await extractSpdbReportPoint(product, doc, relatedCodes);
      } catch {
        return null;
      }
    })
  ).filter((point): point is ManagerNavPoint => point !== null);

  cachedSpdbReportPoints.set(product.productCode, points);
  return points;
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

function extractTrailingShareClass(productName: string): string | null {
  const normalized = productName.replace(/\s+/g, "").trim().toUpperCase();
  const match = normalized.match(/([A-Z]+)$/u);
  return match?.[1] ?? null;
}

function resolveCmbcwmProductRow(
  rows: CmbcwmProductRow[],
  product: ProductSnapshot
): ResolvedManagerProduct | null {
  if (rows.length === 0) {
    return null;
  }

  const targetName = normalizeCmbcwmName(product.productName);
  const trailingShareClass = extractTrailingShareClass(product.productName);
  const registrationCode = normalizeRegistrationCode(
    rows.find((row) => normalizeCmbcwmName(row.PRD_NAME ?? "") === targetName)?.TBPRDEXTEND_DEBT_REGIST_CODE
  );

  const exact =
    rows.find((row) => {
      const rowName = normalizeCmbcwmName(row.PRD_NAME ?? "");
      return rowName === targetName || rowName.includes(targetName) || targetName.includes(rowName);
    }) ??
    (trailingShareClass
      ? rows.find((row) => (row.PRD_NAME ?? "").replace(/\s+/g, "").toUpperCase().endsWith(trailingShareClass))
      : null);

  if (exact?.REAL_PRD_CODE) {
    return {
      managerProductCode: exact.REAL_PRD_CODE,
      registrationCode:
        normalizeRegistrationCode(exact.TBPRDEXTEND_DEBT_REGIST_CODE) ?? registrationCode
    };
  }

  return null;
}

function buildCmbCfwebFunCodeCandidates(product: ProductSnapshot, mapping?: ProductMapping): string[] {
  const candidates = new Set<string>();
  const mappedCode = mapping?.managerProductCode?.trim().toUpperCase();
  if (mappedCode) {
    candidates.add(mappedCode);
  }

  const parsed = parseCmbCfwebCashProduct(product.productName);
  if (!parsed?.seriesNumber || !parsed.shareClass) {
    return [...candidates];
  }

  const { seriesNumber } = parsed;
  const shareClass = parsed.shareClass.toUpperCase();
  const baseCode = `${seriesNumber.length >= 3 ? "8" : "88"}${seriesNumber}`;

  candidates.add(`${baseCode}${shareClass}`);
  candidates.add(`${baseCode}A`);

  if (shareClass !== "D") candidates.add(`${baseCode}D`);
  if (shareClass !== "F") candidates.add(`${baseCode}F`);
  if (shareClass !== "G") candidates.add(`${baseCode}G`);

  return [...candidates];
}

async function findCmbCfwebPublicProduct(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  const candidates = buildCmbCfwebFunCodeCandidates(product, mapping);
  if (candidates.length === 0) {
    return null;
  }

  for (const funCod of candidates) {
    const response = await cmbCfwebPost<CmbCfwebResponse<{ totalRecord?: number; data?: CmbCfwebValueRow[] }>>(
      "/ProductValue/getSAValueByPrdCodeOrTypeCode",
      { funCod, saaCod: "D07" }
    );

    const row = response.body?.data?.[0];
    if (!row) continue;

    const detail = await cmbCfwebPost<CmbCfwebResponse<CmbCfwebDetail>>(
      `/ProductInfo/getSAProductDetailInfo?saaCod=D07&funCod=${encodeURIComponent(funCod)}`
    );

    return {
      managerProductCode: funCod,
      registrationCode: normalizeRegistrationCode(detail.body?.regCode) ?? normalizeRegistrationCode(mapping?.registrationCode)
    };
  }

  return null;
}

async function findCmbCfwebEwProduct(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  const mappedCode = mapping?.managerProductCode?.trim().toUpperCase();
  if (mappedCode?.startsWith("GD")) {
    return {
      managerProductCode: mappedCode,
      registrationCode: normalizeRegistrationCode(mapping?.registrationCode)
    };
  }

  const registrationCode = normalizeRegistrationCode(mapping?.registrationCode);
  const rows = await loadCmbCfwebEwRows();

  if (registrationCode) {
    const byRegistrationCode = rows.find((row) => normalizeRegistrationCode(row.regCode) === registrationCode);
    if (byRegistrationCode?.prdCode) {
      return {
        managerProductCode: byRegistrationCode.prdCode,
        registrationCode: normalizeRegistrationCode(byRegistrationCode.regCode) ?? registrationCode
      };
    }
  }

  const targetName = normalizeCibPfundName(product.productName);
  const exact = rows.find((row) => normalizeCibPfundName(row.prdName ?? "") === targetName);
  if (exact?.prdCode) {
    return {
      managerProductCode: exact.prdCode,
      registrationCode: normalizeRegistrationCode(exact.regCode) ?? registrationCode
    };
  }

  const targetSeries = parseEwSeriesInfo(product.productName);
  if (!targetSeries) {
    return null;
  }

  const sameSeriesRows = rows.filter((row) => {
    const seriesInfo = parseEwSeriesInfo(row.prdName ?? "");
    return seriesInfo?.series === targetSeries.series;
  });

  if (sameSeriesRows.length === 0) {
    return null;
  }

  const sharePriority = ["D", "A", "K", "H", "J", "G", "F", "E", "R", "S"];
  const bestRow = sameSeriesRows
    .map((row) => ({
      row,
      share: parseEwSeriesInfo(row.prdName ?? "")?.share ?? null
    }))
    .sort((left, right) => {
      const leftPriority = left.share ? sharePriority.indexOf(left.share) : Number.MAX_SAFE_INTEGER;
      const rightPriority = right.share ? sharePriority.indexOf(right.share) : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority;
    })[0]?.row;

  if (!bestRow?.prdCode) {
    return null;
  }

  return {
    managerProductCode: bestRow.prdCode,
    registrationCode: normalizeRegistrationCode(bestRow.regCode) ?? registrationCode
  };
}

async function findCmbcwmRealProductCode(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  const mappedCode = mapping?.managerProductCode?.trim().toUpperCase();
  const registrationCode = normalizeRegistrationCode(mapping?.registrationCode);
  const trailingShareClass = extractTrailingShareClass(product.productName);

  if (mappedCode && (!trailingShareClass || mappedCode.endsWith(trailingShareClass))) {
    return {
      managerProductCode: mappedCode,
      registrationCode
    };
  }

  const searchTerms = buildCmbcwmSearchTerms(product.productName);
  if (mappedCode) {
    searchTerms.unshift(mappedCode);
  }

  for (const term of searchTerms) {
    const response = await cmbcwmPost<{ list?: CmbcwmProductRow[] }>("BTAProductQry", {
      code_or_name: term,
      pageNo: 1,
      pageSize: 10
    });

    const rows = response.list ?? [];
    if (rows.length === 0) continue;

    const resolved = resolveCmbcwmProductRow(rows, product);
    if (resolved) {
      return {
        ...resolved,
        registrationCode: resolved.registrationCode ?? registrationCode
      };
    }
  }

  return null;
}

async function findCibPfundProduct(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  const mappedCode = mapping?.managerProductCode?.trim().toUpperCase();
  if (mappedCode) {
    return {
      managerProductCode: mappedCode.replace(/^EWEW/u, "EW"),
      registrationCode: normalizeRegistrationCode(mapping?.registrationCode)
    };
  }

  const targetName = normalizeCibPfundName(product.productName);
  const rows = await loadCibPfundRows();
  const exact = rows.find((row) => normalizeCibPfundName(row.productName) === targetName);
  if (!exact) {
    return null;
  }

  return {
    managerProductCode: exact.managerProductCode,
    registrationCode: exact.registrationCode
  };
}

async function findCiticProduct(
  product: ProductSnapshot,
  mapping?: ProductMapping
): Promise<ResolvedManagerProduct | null> {
  const mappedCode = mapping?.managerProductCode?.trim().toUpperCase();
  if (mappedCode?.startsWith("AM")) {
    return {
      managerProductCode: mappedCode,
      registrationCode: normalizeRegistrationCode(mapping?.registrationCode),
      managerProductType: "4"
    };
  }

  const targetName = normalizeCiticName(product.productName);
  const searchTerms = buildCiticSearchTerms(product.productName);

  for (const term of searchTerms) {
    const rows = await searchCiticProducts(term);
    if (rows.length === 0) continue;

    const eligibleRows = rows.filter((row) => {
      const distributors = `${row.distributorCodes ?? ""}|${row.distributorNames ?? ""}`;
      const isSpdbDistributed = /(^|,|\|)009($|,|\|)/u.test(distributors) || /浦发银行/u.test(distributors);
      const isCashLike = String(row.productType ?? "") === "4" || String(row.respProductType ?? "") === "3";
      return isSpdbDistributed && isCashLike;
    });

    const exact =
      eligibleRows.find((row) => normalizeCiticName(row.prodNameShort ?? row.prodName ?? "") === targetName) ??
      eligibleRows.find((row) => normalizeCiticName(row.prodName ?? "") === targetName) ??
      eligibleRows.find((row) => {
        const rowName = normalizeCiticName(row.prodNameShort ?? row.prodName ?? "");
        return rowName.includes(targetName) || targetName.includes(rowName);
      });

    if (exact?.prodCode) {
      return {
        managerProductCode: exact.prodCode.trim().toUpperCase(),
        managerProductType: String(exact.productType ?? "4"),
        registrationCode: normalizeRegistrationCode(mapping?.registrationCode)
      };
    }
  }

  return null;
}

async function fetchCmbCfwebValueRows(funCod: string): Promise<CmbCfwebValueRow[]> {
  const response = await cmbCfwebPost<CmbCfwebResponse<{ totalRecord?: number; data?: CmbCfwebValueRow[] }>>(
    "/ProductValue/getSAValueByPageOrDate",
    { funCod, saaCod: "D07", pageNo: 1, pageSize: 400 }
  );

  return response.body?.data ?? [];
}

async function fetchCiticDetail(prodCode: string, prodType: string): Promise<CiticDetail | null> {
  const response = await citicGet<CiticDetail>("/cms.product/api/custom/productInfo/getTAProductDetail", {
    prodCode,
    prodType
  });

  return response.data ?? null;
}

async function fetchCiticNavRows(prodCode: string): Promise<CiticNavRow[]> {
  const units = ["12", "6", "3", "1"];

  for (const queryUnit of units) {
    try {
      const response = await citicGet<{ productNavList?: CiticNavRow[] }>(
        "/cms.product/api/custom/productInfo/getTAProductNav",
        { prodCode, queryUnit }
      );

      const rows = (response.data?.productNavList ?? []).filter((row) => formatDate(row.navDate));
      if (rows.length > 0) {
        return rows.sort((left, right) => String(right.navDate ?? "").localeCompare(String(left.navDate ?? "")));
      }
    } catch {
      continue;
    }
  }

  return [];
}

const spdbWmAdapter: ManagerHistoryAdapter = {
  key: "spdb_wm",
  managerName: "浦银理财",
  supports(product) {
    return product.taCode === "66";
  },
  async fetchHistory(product) {
    const fetchedAt = new Date().toISOString();
    const reportHistory = await fetchSpdbCashReportHistory(product);
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
      return { history: reportHistory };
    }

    return {
      history: [
        ...reportHistory,
        {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: null,
          totalNav: null,
          annualizedYield: (() => {
            const value = normalizeNumber(row.YLD_7);
            return value === null ? null : value * 100;
          })(),
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

const cmbCfwebAdapter: ManagerHistoryAdapter = {
  key: "cmb_cfweb",
  managerName: "招银理财有限责任公司",
  supports(product) {
    return product.taCode === "ZY" && supportsCmbCfwebCashHistory(product.productName);
  },
  async fetchHistory(product, mapping) {
    const resolved = await findCmbCfwebPublicProduct(product, mapping);
    if (!resolved) {
      return { history: [] };
    }

    const rows = await fetchCmbCfwebValueRows(resolved.managerProductCode);
    const fetchedAt = new Date().toISOString();
    type CmbCfwebPoint = Omit<ManagerNavPoint, "source"> & { source: "cmb_cfweb" };

    const history = rows
      .map((row) => {
        const navDate = formatDate(row.znavDat);
        if (!navDate) return null;

        const point: CmbCfwebPoint = {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: normalizeNumber(row.znavVal),
          totalNav: normalizeNumber(row.znavCtl),
          annualizedYield: normalizeNumber(row.znavPct),
          per10kProfit: normalizeNumber(row.znavChg),
          fetchedAt,
          source: "cmb_cfweb"
        };

        return point;
      })
      .filter((point): point is CmbCfwebPoint => point !== null);

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

const cmbCfwebEwAdapter: ManagerHistoryAdapter = {
  key: "cmb_cfweb_ew",
  managerName: "光大理财有限责任公司",
  supports(product) {
    return product.taCode === "EW" && /阳光碧乐活/u.test(product.productName);
  },
  async fetchHistory(product, mapping) {
    const resolved = await findCmbCfwebEwProduct(product, mapping);
    if (!resolved) {
      const fallback = await findCibPfundProduct(product, mapping);
      if (!fallback) {
        return { history: [] };
      }

      return {
        history: [],
        mapping: {
          managerProductCode: fallback.managerProductCode,
          registrationCode: fallback.registrationCode ?? mapping?.registrationCode,
          source: "partner_site"
        }
      };
    }

    const rows = await fetchCmbCfwebValueRows(resolved.managerProductCode);
    const fetchedAt = new Date().toISOString();
    type CmbCfwebPoint = Omit<ManagerNavPoint, "source"> & { source: "cmb_cfweb" };

    const history = rows
      .map((row) => {
        const navDate = formatDate(row.znavDat);
        if (!navDate) return null;

        const point: CmbCfwebPoint = {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: normalizeNumber(row.znavVal),
          totalNav: normalizeNumber(row.znavCtl),
          annualizedYield: normalizeNumber(row.znavPct),
          per10kProfit: normalizeNumber(row.znavChg),
          fetchedAt,
          source: "cmb_cfweb"
        };

        return point;
      })
      .filter((point): point is CmbCfwebPoint => point !== null);

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

const cibPfundAdapter: ManagerHistoryAdapter = {
  key: "cib_pfund",
  managerName: "光大理财有限责任公司",
  supports(product) {
    return product.taCode === "EW" && /阳光碧乐活/u.test(product.productName);
  },
  async fetchHistory(product, mapping) {
    const resolved = await findCibPfundProduct(product, mapping);
    if (!resolved) {
      return { history: [] };
    }

    return {
      history: [],
      mapping: {
        managerProductCode: resolved.managerProductCode,
        registrationCode: resolved.registrationCode ?? mapping?.registrationCode,
        source: "partner_site"
      }
    };
  }
};

const citicWealthAdapter: ManagerHistoryAdapter = {
  key: "citic_wealth",
  managerName: "信银理财有限责任公司",
  supports(product) {
    return product.taCode === "ZX" && /日盈象天天利/u.test(product.productName);
  },
  async fetchHistory(product, mapping) {
    const resolved = await findCiticProduct(product, mapping);
    if (!resolved) {
      return { history: [] };
    }

    const detail = await fetchCiticDetail(resolved.managerProductCode, resolved.managerProductType ?? "4");
    const rows = await fetchCiticNavRows(resolved.managerProductCode);
    const fetchedAt = new Date().toISOString();
    type CiticPoint = Omit<ManagerNavPoint, "source"> & { source: "citic_wealth" };

    const history = rows
      .map((row) => {
        const navDate = formatDate(row.navDate);
        if (!navDate) return null;

        const point: CiticPoint = {
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: normalizeNumber(row.nav),
          totalNav: normalizeNumber(row.totalNav),
          annualizedYield: (() => {
            const value = normalizeNumber(row.sevenDaysIncomeRate);
            return value === null ? null : value * 100;
          })(),
          per10kProfit: normalizeNumber(row.outTenThousandIncomeAmt ?? row.tenThousandIncomeAmt),
          fetchedAt,
          source: "citic_wealth"
        };

        return point;
      })
      .filter((point): point is CiticPoint => point !== null);

    if (history.length === 0 && detail) {
      const navDate = formatDate(detail.navDate);
      if (navDate) {
        history.push({
          productCode: product.productCode,
          productName: product.productName,
          managerCode: product.taCode,
          managerName: product.taName,
          navDate,
          nav: normalizeNumber(detail.nav),
          totalNav: normalizeNumber(detail.totalNav),
          annualizedYield: (() => {
            const value = normalizeNumber(detail.sevenDaysIncomeRate);
            return value === null ? null : value * 100;
          })(),
          per10kProfit: normalizeNumber(detail.outTenThousandIncomeAmt ?? detail.tenThousandIncomeAmt),
          fetchedAt,
          source: "citic_wealth"
        });
      }
    }

    return {
      history,
      mapping: {
        managerProductCode: resolved.managerProductCode,
        registrationCode: normalizeRegistrationCode(detail?.registCode) ?? resolved.registrationCode ?? mapping?.registrationCode,
        source: "manager_site"
      }
    };
  }
};

const adapters: ManagerHistoryAdapter[] = [
  spdbWmAdapter,
  cmbcwmAdapter,
  cmbCfwebAdapter,
  cmbCfwebEwAdapter,
  cibPfundAdapter,
  citicWealthAdapter
];

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

async function expandProductsWithRelatedSpdbSeries(products: ProductSnapshot[]): Promise<ProductSnapshot[]> {
  const spdbTargets = products.filter((product) => product.taCode === "66");
  if (spdbTargets.length === 0) {
    return products;
  }

  const db = await readDb();
  const latestByCode = new Map<string, ProductSnapshot>();
  for (const snapshot of db.snapshots) {
    if (snapshot.taCode !== "66") continue;
    const current = latestByCode.get(snapshot.productCode);
    if (!current || current.capturedAt < snapshot.capturedAt) {
      latestByCode.set(snapshot.productCode, snapshot);
    }
  }

  const targetSeries = new Set(spdbTargets.map((product) => normalizeSpdbSeriesName(product.productName)));
  const relatedProducts = [...latestByCode.values()].filter((snapshot) =>
    targetSeries.has(normalizeSpdbSeriesName(snapshot.productName))
  );

  return [...products, ...relatedProducts];
}

export function hasManagerHistorySupport(product: ProductSnapshot): boolean {
  return adapters.some((adapter) => adapter.supports(product));
}

export async function fetchManagerHistory(
  products: ProductSnapshot[],
  productMappings: Record<string, ProductMapping> = {},
  options: FetchManagerHistoryOptions = {}
): Promise<{
  history: ManagerNavPoint[];
  discoveredMappings: Record<string, ProductMapping>;
  summary: {
    totalProducts: number;
    succeededProducts: number;
    failedProducts: number;
  };
}> {
  const expandedProducts = await expandProductsWithRelatedSpdbSeries(products);
  const uniqueProducts = expandedProducts.filter(
    (product, index, array) => array.findIndex((item) => item.productCode === product.productCode) === index
  );

  const supported = uniqueProducts
    .map((product) => ({
      product,
      adapter: adapters.find((adapter) => adapter.supports(product)) ?? null
    }))
    .filter((item): item is { product: ProductSnapshot; adapter: ManagerHistoryAdapter } => Boolean(item.adapter));

  let processed = 0;
  const chunks = await mapWithConcurrency(supported, 1, async ({ product, adapter }) => {
    options.onProgress?.({
      managerName: adapter.managerName,
      productName: product.productName,
      productCode: product.productCode,
      processed,
      total: supported.length
    });

    try {
      processed += 1;
      return {
        productCode: product.productCode,
        result: await adapter.fetchHistory(product, productMappings[product.productCode])
      };
    } catch (error) {
      console.error(
        `[manager-history] ${adapter.managerName} ${product.productCode} ${product.productName} failed:`,
        error
      );
      processed += 1;
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
    ),
    summary: {
      totalProducts: supported.length,
      succeededProducts: chunks.filter((chunk) => chunk.result.history.length > 0 || chunk.result.mapping).length,
      failedProducts: chunks.filter((chunk) => chunk.result.history.length === 0 && !chunk.result.mapping).length
    }
  };
}
