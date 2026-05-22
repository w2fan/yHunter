import { pathToFileURL } from "node:url";

function dashboardUrl() {
  const baseUrl = process.env.YHUNTER_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  return new URL("/api/dashboard", baseUrl).toString();
}

export async function refreshDashboard() {
  const startedAt = new Date();
  const url = dashboardUrl();
  console.log(`[refresh-dashboard] ${startedAt.toISOString()} POST ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`refresh failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  const summary = payload?.lastRefreshSummary;
  const completedAt = new Date();
  console.log(
    [
      `[refresh-dashboard] ${completedAt.toISOString()} done in ${completedAt.getTime() - startedAt.getTime()}ms`,
      summary
        ? `products=${summary.totalProducts} succeeded=${summary.succeededProducts} failed=${summary.failedProducts}`
        : "summary=unavailable"
    ].join(" ")
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshDashboard().catch((error) => {
    console.error("[refresh-dashboard] failed:", error);
    process.exitCode = 1;
  });
}
