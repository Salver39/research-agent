"use client";

import { useState, useEffect, useRef } from "react";
import { useSessionStore } from "@/store/session";

const HUNG_THRESHOLD_S = 60;

interface Props {
  streaming: boolean;
  streamText: string;
  onConfirm: () => void;
  onGenerateMore: () => void;
}

/**
 * Extract hypothesis texts from partial JSON as they stream in.
 * Looks for completed "text": "..." entries in the raw stream.
 */
function parsePartialHypotheses(raw: string): string[] {
  const matches = Array.from(raw.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g));
  return matches.map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, " "));
}

const STEPS = [
  "Читаю бриф и данные компании...",
  "Анализирую паттерны...",
  "Формулирую гипотезы...",
  "Проверяю на фальсифицируемость...",
];

// Shown ONLY for hypotheses grounded in user-uploaded files. Anything else
// (brief, team intuition) has no badge — see hypothesis agent prompt.
const SOURCE_TYPE_LABELS: Record<string, string> = {
  analytics:      "📊 Аналитика",
  feedback:       "💬 Обратная связь",
  past_research:  "📁 Прошлые исследования",
  benchmark:      "🔍 Бенчмарк",
};

const VERIFICATION_METHOD_LABELS: Record<string, string> = {
  deep_interviews:   "Глубинное интервью",
  usability_testing: "Юзабилити-тест",
  survey:            "Опрос",
  concept_test:      "Тест концепции",
  ab_test:           "A/B-тест",
  analytics:         "Аналитика",
  observation:       "Наблюдение",
  desk_research:     "Кабинетное",
};

export function HypothesesScreen({ streaming, streamText, onConfirm, onGenerateMore }: Props) {
  const { hypotheses, setHypotheses } = useSessionStore();
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [secsSinceChunk, setSecsSinceChunk] = useState(0);
  const [isHung, setIsHung] = useState(false);
  const lastChunkAt = useRef<number>(Date.now());

  // Reset timer on every new incoming chunk
  useEffect(() => {
    if (!streaming) return;
    lastChunkAt.current = Date.now();
    setIsHung(false);
    setSecsSinceChunk(0);
  }, [streamText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tick while streaming
  useEffect(() => {
    if (!streaming) {
      setIsHung(false);
      setSecsSinceChunk(0);
      return;
    }
    lastChunkAt.current = Date.now();
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - lastChunkAt.current) / 1000);
      setSecsSinceChunk(secs);
      if (secs >= HUNG_THRESHOLD_S) setIsHung(true);
    }, 1000);
    return () => clearInterval(interval);
  }, [streaming]);

  // While streaming — show partial hypotheses as they appear
  if (streaming || (hypotheses.length === 0 && streamText === "")) {
    const partial = parsePartialHypotheses(streamText);
    const stepIndex = Math.min(
      Math.floor((partial.length / 5) * STEPS.length),
      STEPS.length - 1
    );
    const isConnecting = streamText.length === 0;

    return (
      <div className="space-y-5">
        <h2 className="text-xl font-semibold text-gray-900">Гипотезы</h2>

        {/* ── Hung warning ───────────────────────────────────────────────── */}
        {isHung && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" viewBox="0 0 16 16" fill="none">
              <path d="M8 6v3M8 11h.01M2 13h12L8 3 2 13z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">
                Нет ответа уже {secsSinceChunk} сек.
              </p>
              <p className="text-xs text-amber-600 mt-0.5">
                Агент формирует много гипотез — это может занять несколько минут. Подождите ещё немного. Если ответа так и не будет, вернитесь на шаг назад и попробуйте снова.
              </p>
            </div>
          </div>
        )}

        {/* ── Connecting state ───────────────────────────────────────────── */}
        {isConnecting ? (
          <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
            <span className="relative flex h-8 w-8">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-300 opacity-60" />
              <span className="relative inline-flex h-8 w-8 rounded-full bg-brand-500 items-center justify-center">
                <svg className="h-4 w-4 text-white" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v2M8 11v2M3 8H1M15 8h-2M5.05 5.05 3.64 3.64M12.36 12.36l-1.41-1.41M5.05 10.95l-1.41 1.41M12.36 3.64l-1.41 1.41" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </span>
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-800">Агент думает...</p>
              <p className="text-xs text-gray-400 mt-1">
                {secsSinceChunk > 0 ? `${secsSinceChunk} сек.` : "Отправляю запрос"}
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* ── Active streaming state ─────────────────────────────────── */}
            <div className="flex items-center gap-3 rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-500" />
              </span>
              <span className="text-sm text-brand-700">{STEPS[stepIndex]}</span>
              {partial.length > 0 && (
                <span className="ml-auto text-xs font-medium text-brand-500">
                  {partial.length} гипотез
                </span>
              )}
              {secsSinceChunk >= 5 && !isHung && (
                <span className="ml-auto text-xs text-gray-400">{secsSinceChunk} сек.</span>
              )}
            </div>

            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                    i <= stepIndex ? "bg-brand-500" : "bg-gray-100"
                  }`}
                />
              ))}
            </div>

            {partial.length > 0 && (
              <ul className="space-y-3">
                {partial.map((text, i) => (
                  <li
                    key={i}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
                  >
                    <div className="flex gap-3 items-start">
                      <div className="mt-1 h-4 w-4 rounded border-2 border-gray-200 shrink-0" />
                      <p className="text-sm text-gray-700">{text}</p>
                    </div>
                  </li>
                ))}
                <li className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-4">
                  <div className="flex gap-3 items-start">
                    <div className="mt-1 h-4 w-4 rounded border-2 border-gray-100 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-gray-200 rounded animate-pulse w-full" />
                      <div className="h-3 bg-gray-200 rounded animate-pulse w-3/4" />
                    </div>
                  </div>
                </li>
              </ul>
            )}

            {partial.length === 0 && (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                    <div className="flex gap-3 items-start">
                      <div className="mt-1 h-4 w-4 rounded border-2 border-gray-100 shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${70 + i * 8}%`, animationDelay: `${i * 150}ms` }} />
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${50 + i * 5}%`, animationDelay: `${i * 150 + 75}ms` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // Empty state after streaming — show retry
  if (hypotheses.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Гипотезы</h2>
        <p className="text-sm text-gray-500">Не удалось получить гипотезы. Попробуйте сгенерировать снова.</p>
        <button
          onClick={onGenerateMore}
          className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                     hover:bg-brand-600 transition-colors"
        >
          Сгенерировать гипотезы →
        </button>
      </div>
    );
  }

  // Done — show confirmed hypotheses
  function togglePriority(id: string) {
    setHypotheses(
      hypotheses.map((h) =>
        h.id === id ? { ...h, priority: h.priority === 1 ? 0 : 1 } : h
      )
    );
  }

  function deleteHypothesis(id: string) {
    setHypotheses(hypotheses.filter((h) => h.id !== id));
  }

  function addHypothesis() {
    const text = newText.trim();
    if (!text) return;
    const id = `custom_${Date.now()}`;
    setHypotheses([
      ...hypotheses,
      { id, text, source: "добавлено вручную", priority: 1, falsifiable: true },
    ]);
    setNewText("");
    setAdding(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Гипотезы</h2>
        <p className="text-sm text-gray-500 mt-1">
          Отметьте гипотезы для проверки. Можно добавить свою или удалить лишние.
        </p>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
        <p className="text-sm font-semibold text-amber-800">Выбирайте только то, что проверяется исследованием</p>
        <p className="text-xs text-amber-700">
          Гипотезы, которые можно проверить через аналитику или данные — отмечать не нужно.
          Оставьте только те, ответ на которые требует разговора с пользователем или наблюдения за ним.
        </p>
      </div>

      <ul className="space-y-3">
        {hypotheses.map((h) => (
          <li
            key={h.id}
            onClick={() => togglePriority(h.id)}
            className={`rounded-xl border px-4 py-4 flex gap-3 items-start cursor-pointer transition-colors group
              ${h.priority === 1
                ? "border-brand-500 bg-brand-50"
                : "border-gray-200 bg-white hover:bg-gray-50"}`}
          >
            <input
              type="checkbox"
              checked={h.priority === 1}
              onChange={() => togglePriority(h.id)}
              onClick={(e) => e.stopPropagation()}
              className="mt-1 accent-brand-500 shrink-0"
            />
            <div className="flex-1 space-y-2">
              <p className="text-sm text-gray-900">{h.text}</p>
              {h.verification_methods && h.verification_methods.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {h.verification_methods.map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5
                                 text-xs font-medium text-indigo-700 border border-indigo-100"
                    >
                      {VERIFICATION_METHOD_LABELS[m] ?? m}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {h.source_type && SOURCE_TYPE_LABELS[h.source_type] && (
                  <p className="text-xs text-brand-500">
                    {SOURCE_TYPE_LABELS[h.source_type]}
                  </p>
                )}
                {h.verification_method && (
                  <p className="text-xs text-gray-400">
                    <span className="font-medium text-gray-500">Как:</span> {h.verification_method}
                  </p>
                )}
              </div>
              {h.action_if_confirmed && (
                <p className="text-xs text-green-600">
                  <span className="font-medium">Если подтвердится:</span> {h.action_if_confirmed}
                </p>
              )}
              {h.source_type === "analytics" && (
                <p className="text-xs text-amber-600 font-medium">
                  ⚠ Можно проверить аналитикой - выбирать не рекомендуется
                </p>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); deleteHypothesis(h.id); }}
              className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400
                         transition-opacity text-lg leading-none shrink-0 mt-0.5"
              title="Удалить"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {/* Add hypothesis form */}
      {adding ? (
        <div className="rounded-xl border-2 border-brand-300 bg-white p-4 space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-600">Гипотеза — утверждение, а не вопрос</p>
            <p className="text-xs text-gray-400">Укажи субъекта (кто), поведение или убеждение (что) и контекст (где/когда)</p>
          </div>
          <textarea
            autoFocus
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addHypothesis();
              if (e.key === "Escape") { setAdding(false); setNewText(""); }
            }}
            placeholder="Например: Пользователи с заказами от 5 000 ₽ ожидают доставку в тот же день и уходят к конкурентам, если её нет"
            className="w-full rounded-lg border border-gray-200 p-3 text-sm text-gray-900
                       placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500
                       resize-none min-h-[80px]"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAdding(false); setNewText(""); }}
              className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={addHypothesis}
              disabled={!newText.trim()}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white
                         hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Добавить
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full rounded-xl border-2 border-dashed border-gray-200 px-4 py-3 text-sm
                     text-gray-400 hover:border-brand-300 hover:text-brand-500 hover:bg-brand-50
                     transition-colors text-left"
        >
          + Добавить свою гипотезу
        </button>
      )}

      <button
        onClick={onGenerateMore}
        disabled={streaming}
        className="w-full rounded-xl border border-brand-200 bg-brand-50 px-6 py-3 text-sm
                   font-medium text-brand-600 hover:bg-brand-100 disabled:opacity-40
                   disabled:cursor-not-allowed transition-colors"
      >
        {streaming ? "Генерирую..." : "✦ Сгенерировать ещё гипотезы"}
      </button>

      {(() => {
        const selectedCount = hypotheses.filter((h) => h.priority === 1).length;
        const MIN_SELECTED = 3;
        const canProceed = selectedCount >= MIN_SELECTED && !streaming;
        return (
          <div className="space-y-2">
            <button
              onClick={onConfirm}
              disabled={!canProceed}
              className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                         hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Далее → {selectedCount > 0 && `(${selectedCount} выбрано)`}
            </button>
            {selectedCount < MIN_SELECTED && (
              <p className="text-xs text-gray-500 text-center">
                Выберите минимум {MIN_SELECTED} гипотезы — осталось {MIN_SELECTED - selectedCount}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}
