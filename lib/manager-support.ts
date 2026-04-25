export type CmbCfwebCashProductInfo = {
  normalizedName: string;
  shareClass: string | null;
  family: "zhaoying_ririjin" | "zhaoying_ririxin" | "zhaoying_chaozhaojin" | "zhaorui_heding_rikai";
  seriesNumber: string | null;
};

function normalizeManagerProductName(productName: string): string {
  return productName.replace(/\s+/g, "").trim();
}

export function supportsCmbCfwebCashHistory(productName: string): boolean {
  return parseCmbCfwebCashProduct(productName) !== null;
}

export function parseCmbCfwebCashProduct(productName: string): CmbCfwebCashProductInfo | null {
  const normalizedName = normalizeManagerProductName(productName);

  const seriesMatch = normalizedName.match(
    /^(招赢日日(金|欣)|招睿和鼎.*?日开)(\d+)号(?:现金管理类理财计划)?([A-Z]+)$/u
  );

  if (seriesMatch) {
    const [, familyToken, ririVariant, seriesNumber, shareClass] = seriesMatch;
    return {
      normalizedName,
      shareClass,
      family:
        familyToken.startsWith("招睿和鼎")
          ? "zhaorui_heding_rikai"
          : ririVariant === "金"
            ? "zhaoying_ririjin"
            : "zhaoying_ririxin",
      seriesNumber
    };
  }

  const nonSeriesMatch = normalizedName.match(
    /^(招赢日日欣(?:.*?现金管理类)?|招赢朝招金.*?现金管理类)(?:理财计划)?([A-Z]+)$/u
  );

  if (nonSeriesMatch) {
    const [, familyToken, shareClass] = nonSeriesMatch;
    return {
      normalizedName,
      shareClass,
      family: familyToken.startsWith("招赢朝招金") ? "zhaoying_chaozhaojin" : "zhaoying_ririxin",
      seriesNumber: null
    };
  }

  return null;
}
