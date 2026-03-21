import { NextResponse } from "next/server";

import { removeHolding } from "@/lib/store";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const removed = await removeHolding(id);

  if (!removed) {
    return NextResponse.json({ message: "未找到该持仓。" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
