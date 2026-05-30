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

  function docUrl(name: string) {
    return withTokenQuery(
      `/api/backend/api/download/${sessionId}?doc=${encodeURIComponent(name)}&format=docx`,
      sessionId,
    );
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
                <a
                  href={docUrl(doc.name)}
                  className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium
                             text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  .docx
                </a>
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
