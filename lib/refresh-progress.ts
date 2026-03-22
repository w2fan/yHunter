type RefreshProgress = {
  active: boolean;
  stage: string;
  detail: string | null;
  currentManager: string | null;
  currentProduct: string | null;
  processed: number;
  total: number;
  startedAt: string | null;
  updatedAt: string;
};

const defaultProgress = (): RefreshProgress => ({
  active: false,
  stage: "idle",
  detail: null,
  currentManager: null,
  currentProduct: null,
  processed: 0,
  total: 0,
  startedAt: null,
  updatedAt: new Date().toISOString()
});

const globalKey = "__yh_refresh_progress__";

function getStore(): { value: RefreshProgress } {
  const globalObject = globalThis as typeof globalThis & {
    [globalKey]?: { value: RefreshProgress };
  };

  if (!globalObject[globalKey]) {
    globalObject[globalKey] = { value: defaultProgress() };
  }

  return globalObject[globalKey]!;
}

export function getRefreshProgress(): RefreshProgress {
  return getStore().value;
}

export function startRefreshProgress(stage: string, detail?: string): void {
  getStore().value = {
    active: true,
    stage,
    detail: detail ?? null,
    currentManager: null,
    currentProduct: null,
    processed: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function updateRefreshProgress(
  patch: Partial<Omit<RefreshProgress, "updatedAt" | "startedAt">> & { startedAt?: string | null }
): void {
  const current = getStore().value;
  getStore().value = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

export function finishRefreshProgress(stage = "completed", detail?: string): void {
  const current = getStore().value;
  getStore().value = {
    ...current,
    active: false,
    stage,
    detail: detail ?? current.detail,
    updatedAt: new Date().toISOString()
  };
}

export type { RefreshProgress };
