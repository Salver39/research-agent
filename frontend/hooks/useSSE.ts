"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/auth";

interface UseSSEOptions {
  onDone?: (fullText: string) => void;
}

export function useSSE(sessionId: string, options: UseSSEOptions = {}) {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onDoneRef = useRef(options.onDone);
  useEffect(() => { onDoneRef.current = options.onDone; }, [options.onDone]);

  const stream = useCallback(
    async (
      userInput: string,
      opts: { idleMs?: number } = {},
    ) => {
      const idleMs = opts.idleMs ?? 60_000;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Single idle timeout — backend emits a heartbeat comment every 20s
      // while waiting on the model, so even the long reasoning phase keeps
      // resetting this timer. A real hang (no bytes for `idleMs`) aborts
      // quickly — no static "expected duration" window.
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      function bumpIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctrl.abort(), idleMs);
      }
      bumpIdleTimer();

      setText("");
      setStreaming(true);
      setError(null);

      let accumulated = "";
      let doneFired = false;

      function finish() {
        if (doneFired) return;
        doneFired = true;
        setStreaming(false);
        onDoneRef.current?.(accumulated);
      }

      function processLine(line: string): boolean {
        if (!line.startsWith("data: ")) return false;
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          finish();
          return true;
        }
        if (payload.startsWith("[ERROR]")) {
          if (doneFired) return true;
          doneFired = true;
          const msg = payload.slice(8).replace(/^"|"$/g, "");
          setError(msg);
          setStreaming(false);
          return true;
        }
        try {
          accumulated += JSON.parse(payload);
        } catch {
          accumulated += payload;
        }
        setText(accumulated);
        return false;
      }

      try {
        // SSE bypass: Next.js dev rewrites buffer streaming responses (the
        // built-in proxy never flushes until the upstream closes), which kills
        // long agent streams. When NEXT_PUBLIC_BACKEND_URL is set, hit the
        // backend directly — backend CORS already allows the frontend origin.
        // In prod (no env var) we fall back to the proxy path; production
        // proxies (Vercel/nginx) handle SSE correctly.
        const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "/api/backend";
        const res = await fetch(`${base}/api/stream/${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
          body: JSON.stringify({ user_input: userInput }),
          signal: ctrl.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (value && value.length > 0) bumpIdleTimer();
          if (done) {
            buffer += decoder.decode();
          } else {
            buffer += decoder.decode(value, { stream: true });
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (processLine(line)) return;
          }

          if (done) {
            if (buffer.trim()) processLine(buffer);
            finish();
            break;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.name === "AbortError") {
            setError("Агент не отвечает. Попробуйте ещё раз.");
          } else {
            setError(err.message);
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        setStreaming(false);
      }
    },
    [sessionId]
  );

  const clearText = useCallback(() => setText(""), []);

  return { text, streaming, error, stream, clearText };
}
