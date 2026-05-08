import { NextResponse } from "next/server";

type ClientErrorPayload = {
  message?: unknown;
  source?: unknown;
  lineno?: unknown;
  colno?: unknown;
  stack?: unknown;
  userAgent?: unknown;
  url?: unknown;
};

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

export async function POST(request: Request) {
  let payload: ClientErrorPayload = {};

  try {
    payload = (await request.json()) as ClientErrorPayload;
  } catch {
    payload = {};
  }

  console.error("[client-error]", {
    message: text(payload.message, 500),
    source: text(payload.source, 300),
    lineno: payload.lineno,
    colno: payload.colno,
    stack: text(payload.stack, 1500),
    userAgent: text(payload.userAgent, 500),
    url: text(payload.url, 500)
  });

  return NextResponse.json({ ok: true });
}
