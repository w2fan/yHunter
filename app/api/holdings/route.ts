import { NextResponse } from "next/server";

import { addHolding, readDb } from "@/lib/store";

export async function GET() {
  const db = await readDb();
  return NextResponse.json(db.holdings);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      productCode?: string;
      productName?: string;
      managerProductCode?: string;
      registrationCode?: string;
      note?: string;
    };

    if (!body.productCode?.trim() || !body.productName?.trim()) {
      return NextResponse.json({ message: "产品代码和名称都不能为空。" }, { status: 400 });
    }

    const holding = await addHolding({
      productCode: body.productCode,
      productName: body.productName,
      managerProductCode: body.managerProductCode,
      registrationCode: body.registrationCode,
      note: body.note
    });

    return NextResponse.json(holding, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json({ message }, { status: 500 });
  }
}
