"use client";

import { useSessionStore } from "@/store/session";
import { StreamingDots } from "@/components/StreamingDots";

interface Props {
  streaming: boolean;
  streamText: string;
  onConfirm: () => void;
  onRetry: () => void;
}

export function SamplingScreen({ streaming, streamText, onConfirm, onRetry }: Props) {
  const { sample } = useSessionStore();

  if (streaming) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Выборка</h2>
        <StreamingDots label="Агент формирует выборку..." />
      </div>
    );
  }

  if (!sample) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Выборка</h2>
        <p className="text-sm text-gray-400">Не удалось получить результат.</p>
        <button
          onClick={onRetry}
          className="w-full rounded-xl border border-brand-500 px-6 py-3 text-sm font-semibold
                     text-brand-600 hover:bg-brand-50 transition-colors"
        >
          Попробовать ещё раз
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-900">Выборка</h2>
        <span className="text-sm font-medium text-brand-600 bg-brand-50 px-3 py-1 rounded-full">
          Всего: {sample.total_size} участников
        </span>
      </div>

      {/* Segments */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Сегменты</p>
        <div className="space-y-2">
          {sample.segments.map((seg, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white px-4 py-3 flex gap-3 items-start">
              <span className="text-xs font-bold text-brand-500 mt-0.5 shrink-0">{seg.size}</span>
              <div>
                <p className="text-sm font-medium text-gray-900">{seg.name}</p>
                <p className="text-xs text-gray-500">{seg.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Criteria */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Включаем</p>
          <ul className="space-y-1">
            {sample.criteria.include.map((c, i) => (
              <li key={i} className="text-xs text-gray-700 flex gap-1"><span className="text-green-500">✓</span>{c}</li>
            ))}
          </ul>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Исключаем</p>
          <ul className="space-y-1">
            {sample.criteria.exclude.map((c, i) => (
              <li key={i} className="text-xs text-gray-700 flex gap-1"><span className="text-red-400">✗</span>{c}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Screener — hidden for survey method (its own screener lives inside the questionnaire) */}
      {sample.screener && sample.screener.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Скринер-вопросы</p>
          <ol className="space-y-1">
            {sample.screener.map((q, i) => (
              <li key={i} className="text-sm text-gray-700">{i + 1}. {q}</li>
            ))}
          </ol>
        </div>
      )}

      <button
        onClick={onConfirm}
        className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                   hover:bg-brand-600 transition-colors"
      >
        Собрать дизайн исследования →
      </button>
    </div>
  );
}
