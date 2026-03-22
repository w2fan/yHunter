import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnCurl } from "@/lib/curl";
import type { ProductMapping, ProductSnapshot } from "@/lib/types";

const SEARCH_URL = "https://per.spdb.com.cn/api/search";

type SpdbDocument = {
  productcode?: string;
  doctitle?: string;
  productdate?: string;
  puburl?: string;
};

type SearchResponse = {
  code: number;
  message: string;
  data?: {
    content?: SpdbDocument[];
  };
};

const PRODUCT_DOC_CHANNEL = 1073;

function normalizeRegistrationCode(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^Z\d{10,}$/.test(normalized) ? normalized : undefined;
}

function normalizeManagerProductCode(value?: string, productCode?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === productCode) {
    return undefined;
  }
  if (!/^[A-Z0-9][A-Z0-9_-]{5,}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

async function spdbSearchDocuments(productCode: string): Promise<SpdbDocument[]> {
  const payload = JSON.stringify({
    metadata: "productcode|doctitle|productdate|puburl",
    chlid: PRODUCT_DOC_CHANNEL,
    page: 1,
    size: 20,
    searchword: `productcode=${productCode}`
  });

  const stdout = await curlText([
    "-s",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json; charset=utf-8",
    "--data-binary",
    "@-",
    SEARCH_URL
  ], payload);

  const json = JSON.parse(stdout) as SearchResponse;
  return json.data?.content ?? [];
}

async function extractCodesFromPdf(url: string, productCode: string): Promise<ProductMapping | null> {
  const pdfUrl = await resolvePdfUrl(url);
  if (!pdfUrl) {
    return null;
  }

  const pdfBuffer = await curlBinary(["-s", "-L", pdfUrl]);
  const text = await parsePdfText(pdfBuffer);
  const registrationCode = normalizeRegistrationCode(text.match(/Z\d{10,}/)?.[0]);
  const managerCodeMatch =
    text.match(/产品代码\s*[:：]?\s*([A-Z0-9_-]{6,})/i) ??
    text.match(/产品\/份额销售代码\s*[:：]?\s*([A-Z0-9_-]{6,})/i);
  const managerProductCode = normalizeManagerProductCode(managerCodeMatch?.[1], productCode);

  if (!registrationCode && !managerProductCode) {
    return null;
  }

  return {
    managerProductCode,
    registrationCode,
    source: "spdb_pdf"
  };
}

async function resolvePdfUrl(url: string): Promise<string | null> {
  const html = await curlText(["-s", "-L", url]);
  const refreshMatch = html.match(/URL=([^"'>\s]+)/i);
  return refreshMatch?.[1] ?? (url.toLowerCase().endsWith(".pdf") ? url : null);
}

async function curlText(args: string[], stdin?: string): Promise<string> {
  const stdout = await curl(args, stdin);
  return stdout.toString("utf8");
}

async function curlBinary(args: string[], stdin?: string): Promise<Buffer> {
  return curl(args, stdin);
}

async function curl(args: string[], stdin?: string): Promise<Buffer> {
  return spawnCurl(args, stdin);
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

async function parsePdfText(pdfBuffer: Buffer): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "yh-spdb-pdf-"));
  const pdfPath = path.join(tempDir, "mapping.pdf");

  try {
    await writeFile(pdfPath, pdfBuffer);
    return await spawnText("node", [path.join(process.cwd(), "scripts/parse-pdf.cjs"), pdfPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function pickBestDocument(documents: SpdbDocument[], productCode: string): SpdbDocument | null {
  const normalized = documents
    .filter((item) => item.productcode === productCode && item.puburl)
    .sort((a, b) => (b.productdate ?? "").localeCompare(a.productdate ?? ""));

  return (
    normalized.find((item) => item.doctitle?.includes("产品说明书")) ??
    normalized.find((item) => item.doctitle?.includes("风险揭示书")) ??
    normalized[0] ??
    null
  );
}

export async function enrichProductMappingsFromSpdb(
  products: ProductSnapshot[],
  existingMappings: Record<string, ProductMapping>
): Promise<Record<string, ProductMapping>> {
  const targets = products.filter((product) => {
    const mapping = existingMappings[product.productCode];
    return !mapping?.registrationCode || !mapping?.managerProductCode;
  });

  const uniqueTargets = targets.filter(
    (product, index, array) => array.findIndex((item) => item.productCode === product.productCode) === index
  );

  const mappingEntries = await Promise.all(
    uniqueTargets.map(async (product) => {
      try {
        const documents = await spdbSearchDocuments(product.productCode);
        const selected = pickBestDocument(documents, product.productCode);
        if (!selected?.puburl) {
          return null;
        }

        const extracted = await extractCodesFromPdf(selected.puburl, product.productCode);
        if (!extracted) {
          return null;
        }

        return [product.productCode, extracted] as const;
      } catch {
        return null;
      }
    })
  );

  return Object.fromEntries(mappingEntries.filter((entry): entry is readonly [string, ProductMapping] => Boolean(entry)));
}
