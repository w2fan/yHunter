export type Holding = {
  id: string;
  productCode: string;
  productName: string;
  managerProductCode?: string;
  registrationCode?: string;
  note?: string;
  addedAt: string;
};

export type ProductMapping = {
  managerProductCode?: string;
  registrationCode?: string;
  source?: "manual" | "spdb_pdf" | "manager_site" | "partner_site";
};

export type ProductSnapshot = {
  productCode: string;
  productName: string;
  deadlineBrandId: string;
  riskLevel: string;
  currencyType: string;
  incomeRate: number | null;
  incomeRateDisplay: string;
  incomeRateLabel: string;
  taCode: string;
  taName: string;
  productStatus: string;
  minAmount: string;
  incomeDates: string;
  ipoApplFlag?: string;
  capturedAt: string;
  capturedDate: string;
  source: "spdb";
};

export type ManagerNavPoint = {
  productCode: string;
  productName: string;
  managerCode: string;
  managerName: string;
  navDate: string;
  nav: number | null;
  totalNav: number | null;
  annualizedYield: number | null;
  per10kProfit: number | null;
  fetchedAt: string;
  source: "spdb_wm" | "spdb_report" | "cmbcwm" | "cmb_cfweb" | "cib_pfund" | "citic_wealth";
};

export type DbShape = {
  holdings: Holding[];
  snapshots: ProductSnapshot[];
  navHistory: ManagerNavPoint[];
  productMappings: Record<string, ProductMapping>;
  lastSyncedAt: string | null;
  lastRefreshSummary: {
    totalProducts: number;
    succeededProducts: number;
    failedProducts: number;
    completedAt: string;
  } | null;
};

export type HoldingInsight = {
  holding: Holding;
  latest: ProductSnapshot | null;
  latestHistory: ProductSnapshot[];
  navHistory: ManagerNavPoint[];
  performanceSamples: number;
  marketGap: number | null;
  peakDrawdown: number | null;
  sevenDayChange: number | null;
  recentAnnualized: number | null;
  priorAnnualized: number | null;
  acceleration: number | null;
  signal: "sell" | "watch" | "hold" | "insufficient_data";
  confidence: "low" | "medium" | "high";
  reasons: string[];
};

export type CandidateInsight = {
  product: ProductSnapshot;
  latestHistory: ProductSnapshot[];
  navHistory: ManagerNavPoint[];
  performanceSamples: number;
  score: number;
  stage: "fresh_spike" | "warming_up" | "mature" | "fading";
  confidence: "low" | "medium" | "high";
  reasons: string[];
  marketPremium: number | null;
  recentChange: number | null;
  recentAnnualized: number | null;
  priorAnnualized: number | null;
  acceleration: number | null;
  firstSeenAt: string | null;
};

export type DashboardData = {
  generatedAt: string;
  lastSyncedAt: string | null;
  lastRefreshSummary: DbShape["lastRefreshSummary"];
  marketSummary: {
    totalProducts: number;
    averageYield: number | null;
    medianYield: number | null;
    highestYield: number | null;
  };
  holdings: HoldingInsight[];
  candidates: CandidateInsight[];
};
