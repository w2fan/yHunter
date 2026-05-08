import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "打榜理财猎手",
  description: "跟踪浦发代销现金管理类理财产品，识别打榜阶段并辅助调仓。"
};

const clientErrorScript = `
(function () {
  function text(value) {
    if (value === undefined || value === null) return "";
    return String(value);
  }

  function showError(message) {
    var existing = document.getElementById("client-error-overlay");
    if (existing) {
      existing.textContent = message;
      return;
    }

    var box = document.createElement("pre");
    box.id = "client-error-overlay";
    box.textContent = message;
    box.style.position = "fixed";
    box.style.left = "12px";
    box.style.right = "12px";
    box.style.top = "12px";
    box.style.zIndex = "2147483647";
    box.style.margin = "0";
    box.style.padding = "12px";
    box.style.border = "1px solid rgba(179, 51, 29, 0.35)";
    box.style.borderRadius = "10px";
    box.style.background = "rgba(255, 252, 246, 0.98)";
    box.style.color = "#b3331d";
    box.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    box.style.whiteSpace = "pre-wrap";
    box.style.boxShadow = "0 12px 28px rgba(64, 40, 12, 0.18)";
    document.body.appendChild(box);
  }

  function report(payload) {
    var message = "页面脚本错误\\n" + text(payload.message || payload.reason || "未知错误");
    if (payload.source) message += "\\n" + text(payload.source) + ":" + text(payload.lineno || 0) + ":" + text(payload.colno || 0);
    if (payload.stack) message += "\\n" + text(payload.stack);
    showError(message);

    try {
      navigator.sendBeacon(
        "/api/client-errors",
        new Blob([JSON.stringify({
          message: payload.message || payload.reason,
          source: payload.source,
          lineno: payload.lineno,
          colno: payload.colno,
          stack: payload.stack,
          userAgent: navigator.userAgent,
          url: location.href
        })], { type: "application/json" })
      );
    } catch (error) {
      try {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: payload.message || payload.reason,
            source: payload.source,
            lineno: payload.lineno,
            colno: payload.colno,
            stack: payload.stack,
            userAgent: navigator.userAgent,
            url: location.href
          }),
          keepalive: true
        });
      } catch {}
    }
  }

  window.addEventListener("error", function (event) {
    report({
      message: event.message,
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    report({
      message: reason && reason.message ? reason.message : text(reason),
      stack: reason && reason.stack ? reason.stack : undefined
    });
  });
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <script dangerouslySetInnerHTML={{ __html: clientErrorScript }} />
        {children}
      </body>
    </html>
  );
}
