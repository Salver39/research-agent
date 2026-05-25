"use client";

import { useState } from "react";
import { authHeaders, withTokenQuery } from "@/lib/auth";

const DOCUMENTS = [
  { name: "Discussion Guide",          icon: "📋" },
  { name: "Рекрутинговый скринер",    icon: "🎯" },
  { name: "Briefing для интервьюера", icon: "📝" },
  { name: "Шаблон инсайтов",          icon: "💡" },
  { name: "Дизайн исследования",      icon: "🗂️" },
  { name: "Чеклист запуска",          icon: "✅" },
];

export function OutputScreen({ sessionId }: { sessionId: string }) {
  const [generating, setGenerating] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [zipUrl, setZipUrl] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/backend/api/download/${sessionId}?format=zip`, {
        headers: authHeaders(sessionId),
      });
      if (!res.ok) throw new Error(`Ошибка генерации: HTTP ${res.status}`);
      const blob = await res.blob();
      setZipUrl(URL.createObjectURL(blob));
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сгенерировать документы");
    } finally {
      setGenerating(false);
    }
  }

  function docUrl(name: string, fmt: string) {
    return withTokenQuery(
      `/api/backend/api/download/${sessionId}?doc=${encodeURIComponent(name)}&format=${fmt}`,
      sessionId,
    );
  }

  async function handlePdfDownload(name: string) {
    setPdfError(null);
    try {
      const url = docUrl(name, "pdf");
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 503) {
          setPdfError("PDF-генерация недоступна. Скачайте .docx.");
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "Ошибка скачивания PDF");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Готовые документы</h2>
        <p className="text-sm text-gray-500 mt-1">
          Исследование подготовлено. Скачайте пакет документов.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {pdfError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {pdfError}
        </div>
      )}

      {!ready && (
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                     hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          {generating ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-spin">⏳</span> Генерация документов...
            </span>
          ) : (
            "Сгенерировать все документы"
          )}
        </button>
      )}

      {ready && (
        <>
          <ul className="space-y-2">
            {DOCUMENTS.map((doc) => (
              <li
                key={doc.name}
                className="flex items-center justify-between rounded-xl border border-gray-200
                           bg-white px-4 py-3"
              >
                <span className="text-sm font-medium text-gray-800 flex items-center gap-2">
                  <span>{doc.icon}</span>
                  {doc.name}
                </span>
                <div className="flex gap-2">
                  <a
                    href={docUrl(doc.name, "docx")}
                    className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium
                               text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    .docx
                  </a>
                  <button
                    onClick={() => handlePdfDownload(doc.name)}
                    className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium
                               text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    .pdf
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <a
            href={zipUrl ?? withTokenQuery(`/api/backend/api/download/${sessionId}?format=zip`, sessionId)}
            download="research_package.zip"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-6 py-3
                       text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
          >
            📦 Скачать всё (ZIP)
          </a>
        </>
      )}
    </div>
  );
}
