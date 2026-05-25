"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/auth";

type FileStatus = "uploading" | "indexing" | "done" | "error" | "deleting";

interface UploadedFile {
  name: string;
  status: FileStatus;
}

interface Props {
  sessionId: string;
  onContinue: () => void;
}

function statusFromServer(serverStatus: unknown): FileStatus {
  if (serverStatus === "indexed") return "done";
  if (serverStatus === "index_failed") return "error";
  // Older entries without a status field — treat as already indexed.
  if (serverStatus == null) return "done";
  return "indexing";
}

export function ContextUploadScreen({ sessionId, onContinue }: Props) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragging, setDragging] = useState(false);

  // Keep latest `files` accessible from the polling interval without
  // restarting it on every state change.
  const filesRef = useRef<UploadedFile[]>([]);
  useEffect(() => { filesRef.current = files; }, [files]);

  // Hydrate the list from the server so files survive retreats and reloads.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/backend/api/session/${sessionId}`, { headers: authHeaders(sessionId) })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const sources = data?.context?.sources ?? [];
        if (sources.length === 0) return;
        setFiles((prev) => {
          const seen = new Set(prev.map((f) => f.name));
          const incoming: UploadedFile[] = sources
            .filter((s: { name?: string }) => s.name && !seen.has(s.name))
            .map((s: { name: string; status?: string }) => ({
              name: s.name,
              status: statusFromServer(s.status),
            }));
          return [...prev, ...incoming];
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  // Poll the server while at least one file is indexing in the background.
  // The interval lives for the lifetime of the screen; it self-skips when
  // no indexing is in progress, so it costs nothing once everything settles.
  useEffect(() => {
    const interval = setInterval(async () => {
      const hasIndexing = filesRef.current.some((f) => f.status === "indexing");
      if (!hasIndexing) return;
      try {
        const res = await fetch(`/api/backend/api/session/${sessionId}`, {
          headers: authHeaders(sessionId),
        });
        if (!res.ok) return;
        const data = await res.json();
        const sources: Array<{ name: string; status?: string }> = data?.context?.sources ?? [];
        const byName = new Map(sources.map((s) => [s.name, s.status]));
        setFiles((prev) =>
          prev.map((f) => {
            if (f.status !== "indexing") return f;
            if (!byName.has(f.name)) return f;
            return { ...f, status: statusFromServer(byName.get(f.name)) };
          })
        );
      } catch {
        /* transient errors — retry on next tick */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [sessionId]);

  async function uploadFile(file: File) {
    setFiles((prev) => [...prev, { name: file.name, status: "uploading" }]);

    const form = new FormData();
    form.append("file", file);

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 120_000);

    try {
      const res = await fetch(`/api/backend/api/upload/${sessionId}`, {
        method: "POST",
        headers: authHeaders(sessionId),
        body: form,
        signal: ctrl.signal,
      });
      // The handler returns 200 once the file is on disk + recorded in state.
      // RAG indexing runs as a BackgroundTask and flips status to "indexed"
      // (or "index_failed") in state.context.sources. Until then the file
      // is not usable by ContextAgent, so we keep it as "indexing" locally
      // and let the polling effect promote it to "done" / "error".
      const nextStatus: FileStatus = res.ok ? "indexing" : "error";
      setFiles((prev) =>
        prev.map((f) => (f.name === file.name ? { ...f, status: nextStatus } : f))
      );
    } catch {
      setFiles((prev) =>
        prev.map((f) => (f.name === file.name ? { ...f, status: "error" } : f))
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function deleteFile(name: string) {
    if (!confirm(`Удалить файл «${name}»?`)) return;
    setFiles((prev) =>
      prev.map((f) => (f.name === name ? { ...f, status: "deleting" } : f))
    );
    try {
      const res = await fetch(
        `/api/backend/api/upload/${sessionId}/${encodeURIComponent(name)}`,
        { method: "DELETE", headers: authHeaders(sessionId) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFiles((prev) => prev.filter((f) => f.name !== name));
    } catch {
      setFiles((prev) =>
        prev.map((f) => (f.name === name ? { ...f, status: "error" } : f))
      );
    }
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      Array.from(e.dataTransfer.files).forEach(uploadFile);
    },
    [sessionId]
  );

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(uploadFile);
  };

  // A file is "in flight" if it would not be safe to start the Context
  // analysis yet: upload still streaming, indexing pending, or delete in
  // progress. Empty list (no files at all) is fine — user can skip.
  const inFlight = files.some(
    (f) => f.status === "uploading" || f.status === "indexing" || f.status === "deleting"
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Данные компании</h2>
        <p className="text-sm text-gray-500 mt-1">
          Загрузите документы — агент найдёт паттерны и сформулирует гипотезы.
          Поддерживаются .pdf, .docx, .txt, .csv
        </p>
      </div>

      {/* Privacy disclaimer */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
        <p className="font-medium">Куда уходят файлы</p>
        <ul className="list-disc list-inside space-y-0.5 text-amber-800">
          <li>Сохраняются на нашем сервере, индексируются локально для поиска по тексту.</li>
          <li>Содержимое релевантных фрагментов отправляется в OpenAI для анализа.</li>
          <li>Не загружайте документы под NDA или с персональными данными клиентов. Для таких задач — <a href="https://github.com/Salver39/research-agent" target="_blank" rel="noreferrer" className="underline">self-host</a>.</li>
        </ul>
      </div>

      {/* Drop zone */}
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed
                    px-6 py-10 cursor-pointer transition-colors
                    ${dragging ? "border-brand-500 bg-brand-50" : "border-gray-200 hover:border-brand-400 hover:bg-gray-50"}`}
      >
        <span className="text-3xl">📂</span>
        <span className="text-sm font-medium text-gray-600">
          Перетащите файлы сюда или нажмите для выбора
        </span>
        <span className="text-xs text-gray-400">до 50 МБ суммарно</span>
        <input
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.csv"
          className="hidden"
          onChange={handleInput}
        />
      </label>

      {/* File list */}
      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((f) => (
            <li
              key={f.name}
              className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-2"
            >
              <span className="text-sm text-gray-700 truncate max-w-xs">{f.name}</span>
              <div className="flex items-center gap-3 ml-3">
                <span className="text-xs">
                  {f.status === "uploading" && <span className="text-gray-400 animate-pulse">Загрузка...</span>}
                  {f.status === "indexing" && <span className="text-brand-500 animate-pulse">Индексируется...</span>}
                  {f.status === "deleting" && <span className="text-gray-400 animate-pulse">Удаление...</span>}
                  {f.status === "done" && <span className="text-green-500">✓ Готово</span>}
                  {f.status === "error" && <span className="text-red-400">✗ Ошибка</span>}
                </span>
                {(f.status === "done" || f.status === "error") && (
                  <button
                    onClick={() => deleteFile(f.name)}
                    aria-label={`Удалить ${f.name}`}
                    title="Удалить"
                    className="text-gray-300 hover:text-red-500 transition-colors text-lg leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-3 items-center">
        <button
          onClick={onContinue}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          Пропустить →
        </button>
        {inFlight && (
          <span className="text-xs text-gray-400">
            Файлы ещё обрабатываются — анализ запустится, когда все будут готовы
          </span>
        )}
        <button
          onClick={onContinue}
          disabled={inFlight}
          title={inFlight ? "Дождитесь окончания индексации" : undefined}
          className="ml-auto rounded-xl bg-brand-500 px-6 py-2 text-sm font-semibold text-white
                     hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Анализировать →
        </button>
      </div>
    </div>
  );
}
