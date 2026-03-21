import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "打榜理财猎手",
  description: "跟踪浦发代销现金管理类理财产品，识别打榜阶段并辅助调仓。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
