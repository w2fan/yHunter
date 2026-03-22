import { NextResponse } from "next/server";

import { getRefreshProgress } from "@/lib/refresh-progress";

export async function GET() {
  return NextResponse.json(getRefreshProgress(), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
