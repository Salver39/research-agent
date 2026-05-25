"use client";

import { useSessionStore } from "@/store/session";

interface Props {
  streaming: boolean;
  streamText: string;
  onConfirm: () => void;
}

export function BriefScreen({ streaming, streamText, onConfirm }: Props) {
  const { brief } = useSessionStore();

  if (streaming) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Бриф исследования</h2>
        <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap font-mono">
          {streamText}
          <span className="animate-pulse">▍</span>
        </div>
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Бриф исследования</h2>
        <p className="text-gray-400 text-sm">Агент формирует бриф...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Бриф исследования</h2>

      <div className="space-y-4">
        <Field label="Ключевой вопрос" value={brief.research_question} />
        <Field label="Какое решение будет принято" value={brief.decision} required />
        <Field label="Ограничения" value={brief.constraints} />
        <Field label="Что уже известно" value={brief.known} />
      </div>

      <div className="flex gap-3 pt-2">
        <button
          className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium
                     text-gray-700 hover:bg-gray-50 transition-colors"
          onClick={() => window.history.back()}
        >
          ← Изменить
        </button>
        <button
          onClick={onConfirm}
          disabled={!brief.decision?.trim()}
          className="flex-1 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium
                     text-white hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Подтвердить →
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, required }: { label: string; value: string; required?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </p>
      <p className="text-gray-800 text-sm">{value || "—"}</p>
    </div>
  );
}
