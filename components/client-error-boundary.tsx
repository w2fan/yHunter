"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type ClientErrorBoundaryProps = {
  children: ReactNode;
};

type ClientErrorBoundaryState = {
  message: string | null;
  stack: string | null;
};

function reportClientError(error: Error, info?: ErrorInfo) {
  try {
    const payload = JSON.stringify({
      message: error.message,
      stack: error.stack,
      componentStack: info?.componentStack,
      userAgent: navigator.userAgent,
      url: location.href
    });

    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/client-errors", new Blob([payload], { type: "application/json" }));
      return;
    }

    void fetch("/api/client-errors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: payload,
      keepalive: true
    });
  } catch {
    // The visual fallback below is the important part if reporting fails.
  }
}

export class ClientErrorBoundary extends Component<ClientErrorBoundaryProps, ClientErrorBoundaryState> {
  state: ClientErrorBoundaryState = {
    message: null,
    stack: null
  };

  static getDerivedStateFromError(error: Error): ClientErrorBoundaryState {
    return {
      message: error.message || "页面脚本渲染失败",
      stack: error.stack ?? null
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(error, info);
  }

  render() {
    if (this.state.message) {
      return (
        <main className="page-shell">
          <div className="page-inner">
            <section className="panel client-error-panel">
              <h1>页面脚本出错了</h1>
              <p>Safari 没有把错误吞掉，这次抓到了。请把下面这段贴给我，我继续往下修。</p>
              <pre>{[this.state.message, this.state.stack].filter(Boolean).join("\n")}</pre>
            </section>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
