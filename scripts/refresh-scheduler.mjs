import { refreshDashboard } from "./refresh-dashboard.mjs";

const DEFAULT_REFRESH_AT = "09:20,16:20,22:20";

function parseRefreshTimes(value) {
  return value.split(",").map((item) => {
    const trimmed = item.trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid YHUNTER_REFRESH_AT value: ${value}`);
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      throw new Error(`Invalid YHUNTER_REFRESH_AT value: ${value}`);
    }

    return { hour, minute };
  });
}

function nextRunDate(now = new Date()) {
  const times = parseRefreshTimes(process.env.YHUNTER_REFRESH_AT ?? DEFAULT_REFRESH_AT);
  const candidates = times
    .map(({ hour, minute }) => {
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate <= now) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    })
    .sort((left, right) => left.getTime() - right.getTime());

  const next = candidates[0];
  if (!next) {
    throw new Error("No refresh times configured");
  }

  return next;
}

let running = false;

async function runOnce() {
  if (running) {
    console.log("[refresh-scheduler] previous refresh is still running, skip this tick");
    return;
  }

  running = true;
  try {
    await refreshDashboard();
  } finally {
    running = false;
  }
}

function scheduleNext() {
  const next = nextRunDate();
  const delayMs = next.getTime() - Date.now();
  console.log(`[refresh-scheduler] next refresh at ${next.toString()}`);

  setTimeout(async () => {
    try {
      await runOnce();
    } catch (error) {
      console.error("[refresh-scheduler] refresh failed:", error);
    } finally {
      scheduleNext();
    }
  }, delayMs);
}

if (process.env.YHUNTER_REFRESH_ON_START === "1") {
  runOnce()
    .catch((error) => {
      console.error("[refresh-scheduler] startup refresh failed:", error);
    })
    .finally(scheduleNext);
} else {
  scheduleNext();
}
