import { ClientErrorBoundary } from "@/components/client-error-boundary";
import HomePage from "@/components/home-page";
import { execSync } from "node:child_process";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function getAppVersion() {
  const envVersion = process.env.YHUNTER_VERSION || process.env.GITHUB_SHA;
  if (envVersion) {
    return envVersion.slice(0, 7);
  }

  try {
    return execSync("git rev-parse --short=7 HEAD", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "local";
  }
}

export default function Page() {
  return (
    <ClientErrorBoundary>
      <HomePage appVersion={getAppVersion()} />
    </ClientErrorBoundary>
  );
}
