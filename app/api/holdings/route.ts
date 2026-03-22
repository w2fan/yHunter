import { NextResponse } from "next/server";

import { fetchProductByCode } from "@/lib/spdb";
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

    const productCode = body.productCode?.trim();
    if (!productCode) {
      return NextResponse.json({ message: "产品代码不能为空。" }, { status: 400 });
    }

    const matchedProduct = await fetchProductByCode(productCode);
    const productName = body.productName?.trim() || matchedProduct?.productName;

    if (!productName) {
      return NextResponse.json({ message: "没找到这个浦发产品代码，请确认后再试。" }, { status: 404 });
    }

    const holding = await addHolding({
      productCode,
      productName,
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
