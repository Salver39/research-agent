"use client";

import React, { useState, useEffect, useRef } from "react";
import { useSessionStore } from "@/store/session";

const HUNG_THRESHOLD_S = 90;

interface Props {
  streaming: boolean;
  streamText: string;
  onConfirm: () => void;
  onRetry: () => void;
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function DesignScreen({ streaming, streamText, onConfirm, onRetry }: Props) {
  const { design, brief, method, sample, hypotheses } = useSessionStore();
  const [includeSus, setIncludeSus] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  // Hypotheses the user selected (priority=1) that the active method cannot
  // verify — surfaced as a warning so it's obvious they need a separate
  // method to cover them.
  const excludedFromScenario = (hypotheses ?? [])
    .filter((h) => h.priority === 1)
    .filter((h) => {
      const methods = h.verification_methods ?? [];
      if (!Array.isArray(methods) || methods.length === 0) return false;
      return !!method?.method_key && !methods.includes(method.method_key);
    });

  useEffect(() => {
    if (!streaming) {
      setElapsed(0);
      startedAt.current = null;
      return;
    }
    startedAt.current = Date.now();
    const interval = setInterval(() => {
      if (startedAt.current) {
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [streaming]);

  if (streaming) {
    const isHung = elapsed >= HUNG_THRESHOLD_S;

    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Дизайн исследования</h2>

        <div className="flex items-center justify-between rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-brand-700">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-500" />
            </span>
            Агент собирает дизайн и discussion guide...
          </div>
          <span className="text-sm font-mono text-brand-500">{formatTime(elapsed)}</span>
        </div>

        {isHung && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" viewBox="0 0 16 16" fill="none">
              <path d="M8 6v3M8 11h.01M2 13h12L8 3 2 13z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">
                Генерация занимает больше времени, чем обычно
              </p>
              <p className="text-xs text-amber-600 mt-0.5">
                Это нормально при большом количестве гипотез. Подождите ещё немного.
                Если ответа не будет, нажмите кнопку ниже.
              </p>
              <button
                onClick={onRetry}
                className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium
                           text-amber-700 hover:bg-amber-50 transition-colors"
              >
                Перезапустить генерацию
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!design) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Дизайн исследования</h2>
        <p className="text-sm text-gray-500">Не удалось сгенерировать дизайн. Попробуйте ещё раз.</p>
        <button
          onClick={onRetry}
          className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
        >
          Сгенерировать снова →
        </button>
      </div>
    );
  }

  const checks = design.quality_checks ?? {};

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Дизайн исследования</h2>

      {/* Summary card */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2 text-sm">
        <Row label="Вопрос" value={brief?.research_question} />
        <Row label="Метод" value={method?.name} />
        <Row label="Участников" value={sample?.total_size?.toString()} />
        <Row label="Длительность" value={design.total_duration} />
      </div>

      {/* Quality checks */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(checks).map(([key, ok]) => (
          <span
            key={key}
            className={`text-xs px-2 py-1 rounded-full font-medium
              ${ok ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"}`}
          >
            {ok ? "✓" : "✗"} {LABELS[key] ?? key}
          </span>
        ))}
      </div>

      {/* Excluded hypotheses — cannot be verified by the active method */}
      {excludedFromScenario.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
          <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
            Не включены в сценарий
          </p>
          <p className="text-sm text-amber-800">
            Метод «{method?.name}» не подходит для проверки этих гипотез — для них нужен отдельный метод исследования.
          </p>
          <ul className="space-y-1 pt-1">
            {excludedFromScenario.map((h) => (
              <li key={h.id} className="text-sm text-amber-900 flex gap-2">
                <span className="text-amber-500 shrink-0">•</span>
                <span>
                  <span className="font-mono text-xs text-amber-600 mr-1">{h.id}</span>
                  {h.text}
                  {h.verification_methods && h.verification_methods.length > 0 && (
                    <span className="block text-xs text-amber-600 mt-0.5">
                      Проверяется через: {h.verification_methods.join(", ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Usability format */}
      {design.tasks && (
        <div className="space-y-4">

          {/* Методологическая шапка */}
          {design.meta && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-3">
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Методологическая шапка</p>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Цель исследования</p>
                <p className="text-sm text-gray-800">{design.meta.goal}</p>
              </div>
              {design.meta.tasks && design.meta.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Задачи исследования</p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {design.meta.tasks.map((t, i) => (
                      <li key={i} className="text-sm text-gray-800">{t}</li>
                    ))}
                  </ol>
                </div>
              )}
              {design.meta.audience && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Целевая аудитория</p>
                  <p className="text-sm text-gray-800">{design.meta.audience}</p>
                </div>
              )}
              {design.meta.estimated_time && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Оценочное время</p>
                  <p className="text-sm text-gray-800">{design.meta.estimated_time}</p>
                </div>
              )}
            </div>
          )}

          {design.pre_interview && (
            <Section title="Преинтервью">
              <ul className="space-y-1">
                {design.pre_interview.questions.map((q, i) => (
                  <li key={i} className="text-sm text-gray-700">— {q}</li>
                ))}
              </ul>
            </Section>
          )}
          {design.tasks.map((task, i) => (
            <details key={i} className="rounded-xl border border-gray-200 bg-white group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <span className="text-sm font-medium text-gray-900">{i + 1}. {task.title}</span>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                {task.hypothesis_text && (
                  <div className="rounded-lg bg-green-50 border border-green-100 px-3 py-2 space-y-0.5">
                    <p className="text-xs font-semibold text-green-600 uppercase tracking-wide">Гипотеза</p>
                    <p className="text-sm text-green-800">{task.hypothesis_text}</p>
                  </div>
                )}
                {task.scenario && (
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Легенда</p>
                    <p className="text-sm text-gray-600 italic">{task.scenario}</p>
                  </div>
                )}
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Задание</p>
                  <p className="text-sm font-semibold text-gray-900">{task.task}</p>
                </div>
                {task.observe && (
                  <p className="text-xs text-gray-400 italic border-l-2 border-gray-200 pl-2">{task.observe}</p>
                )}
                {task.followup?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Follow-up</p>
                    <ul className="space-y-1">
                      {task.followup.map((q, j) => (
                        <li key={j} className="text-sm text-gray-700">— {q}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {task.success_criteria && (
                  <p className="text-xs text-green-600">✓ {task.success_criteria}</p>
                )}
              </div>
            </details>
          ))}
          {design.sus && (
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">SUS-шкала</p>
                <button
                  onClick={() => setIncludeSus((v) => !v)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                    includeSus
                      ? "bg-brand-50 text-brand-600 hover:bg-brand-100"
                      : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                  }`}
                >
                  {includeSus ? "Включена" : "Отключена"}
                </button>
              </div>
              {includeSus && (
                <>
                  <p className="text-xs text-gray-400">{design.sus.scale}</p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {design.sus.statements.map((s, i) => (
                      <li key={i} className="text-sm text-gray-700">{s}</li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
          {design.closing?.questions && (
            <Section title="Завершение">
              <ul className="space-y-1">
                {design.closing.questions.map((q, i) => (
                  <li key={i} className="text-sm text-gray-700">— {q}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}

      {/* Interview format: meta + intro + guide_blocks */}
      {design.guide_blocks && (
        <div className="space-y-4">

          {/* Методологическая шапка */}
          {design.meta && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-3">
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Методологическая шапка</p>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Цель исследования</p>
                <p className="text-sm text-gray-800">{design.meta.goal}</p>
              </div>
              {design.meta.tasks && design.meta.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Задачи исследования</p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {design.meta.tasks.map((t, i) => (
                      <li key={i} className="text-sm text-gray-800">{t}</li>
                    ))}
                  </ol>
                </div>
              )}
              {design.meta.audience && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Целевая аудитория</p>
                  <p className="text-sm text-gray-800">{design.meta.audience}</p>
                </div>
              )}
            </div>
          )}

          {/* Вступление */}
          {design.intro && (
            <details className="rounded-xl border border-gray-200 bg-white group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-brand-500 w-12 shrink-0">{design.intro.duration}</span>
                  <span className="text-sm font-medium text-gray-900">Вступление</span>
                </div>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                <ol className="space-y-2 list-decimal list-inside">
                  {design.intro.items.map((item, i) => (
                    <li key={i} className="text-sm text-gray-700">{item}</li>
                  ))}
                </ol>
              </div>
            </details>
          )}

          {/* Блоки гайда */}
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Сценарий</p>
          {design.guide_blocks.map((block, i) => (
            <details key={i} className="rounded-xl border border-gray-200 bg-white group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-brand-500 w-12 shrink-0">{block.duration}</span>
                  <span className="text-sm font-medium text-gray-900">{block.title}</span>
                </div>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                <p className="text-xs text-gray-500 italic">{block.goal}</p>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Вопросы</p>
                  <ul className="space-y-1">
                    {block.questions.map((q, j) => (
                      <li key={j} className="text-sm text-gray-700">— {q}</li>
                    ))}
                  </ul>
                </div>
                {block.probes && block.probes.length > 0 && (
                  <div className="space-y-1 border-l-2 border-brand-100 pl-3">
                    <p className="text-xs font-semibold text-brand-400 uppercase tracking-wide">Зондирующие</p>
                    <ul className="space-y-1">
                      {block.probes.map((p, j) => (
                        <li key={j} className="text-xs text-gray-500">↳ {p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          ))}

          {/* Завершение */}
          {design.closing?.questions && (
            <details className="rounded-xl border border-gray-200 bg-white group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-brand-500 w-12 shrink-0">5 мин</span>
                  <span className="text-sm font-medium text-gray-900">Завершение</span>
                </div>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                <ul className="space-y-1">
                  {design.closing.questions.map((q, i) => (
                    <li key={i} className="text-sm text-gray-700">— {q}</li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </div>
      )}

      {/* Survey format: meta + intro + screener + warmup + main_blocks + open + demographics + closing */}
      {design.main_blocks && (
        <div className="space-y-4">

          {/* Методологическая шапка */}
          {design.meta && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-3">
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Методологическая шапка</p>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Цель опроса</p>
                <p className="text-sm text-gray-800">{design.meta.goal}</p>
              </div>
              {design.meta.tasks && design.meta.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Задачи</p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {design.meta.tasks.map((t, i) => (
                      <li key={i} className="text-sm text-gray-800">{t}</li>
                    ))}
                  </ol>
                </div>
              )}
              {design.meta.audience && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Целевая аудитория</p>
                  <p className="text-sm text-gray-800">{design.meta.audience}</p>
                </div>
              )}
              {design.meta.estimated_time && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Время прохождения</p>
                  <p className="text-sm text-gray-800">{design.meta.estimated_time}</p>
                </div>
              )}
            </div>
          )}

          {/* Вступительный экран */}
          {design.intro && (
            <details className="rounded-xl border border-gray-200 bg-white group">
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <span className="text-sm font-medium text-gray-900">
                  {design.intro.title || "Вступительный экран"}
                </span>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                <ul className="space-y-1">
                  {design.intro.items.map((item, i) => (
                    <li key={i} className="text-sm text-gray-700">— {item}</li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          {/* Скринер */}
          {design.screener && design.screener.questions.length > 0 && (
            <SurveySection title="Скринер" subtitle={design.screener.goal}>
              {design.screener.questions.map((q) => (
                <SurveyQuestionCard key={q.id} q={q} showQualifying />
              ))}
            </SurveySection>
          )}

          {/* Разогрев */}
          {design.warmup && design.warmup.questions.length > 0 && (
            <SurveySection title="Разогрев" subtitle={design.warmup.goal}>
              {design.warmup.questions.map((q) => (
                <SurveyQuestionCard key={q.id} q={q} />
              ))}
            </SurveySection>
          )}

          {/* Основные блоки */}
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Основная часть</p>
          {design.main_blocks.map((block, i) => (
            <details key={i} className="rounded-xl border border-gray-200 bg-white group" open>
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none">
                <span className="text-sm font-medium text-gray-900">{block.title}</span>
                <span className="text-gray-400 text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                {block.hypothesis_text && (
                  <div className="rounded-lg bg-green-50 border border-green-100 px-3 py-2 space-y-0.5">
                    <p className="text-xs font-semibold text-green-600 uppercase tracking-wide">Гипотеза</p>
                    <p className="text-sm text-green-800">{block.hypothesis_text}</p>
                  </div>
                )}
                {block.questions.map((q) => (
                  <SurveyQuestionCard key={q.id} q={q} />
                ))}
              </div>
            </details>
          ))}

          {/* Открытые вопросы */}
          {design.open_questions && design.open_questions.length > 0 && (
            <SurveySection title="Открытые вопросы">
              {design.open_questions.map((q) => (
                <SurveyQuestionCard key={q.id} q={q} />
              ))}
            </SurveySection>
          )}

          {/* Демография */}
          {design.demographics && design.demographics.length > 0 && (
            <SurveySection title="Демография">
              {design.demographics.map((q) => (
                <SurveyQuestionCard key={q.id} q={q} />
              ))}
            </SurveySection>
          )}

          {/* Маршрутизация */}
          {design.routing && design.routing.length > 0 && (
            <SurveySection title="Маршрутизация (skip logic)">
              <ul className="space-y-2">
                {design.routing.map((r, i) => (
                  <li key={i} className="text-sm text-gray-700">
                    <span className="font-medium">Если {r.if_question}</span> = {(r.if_answer_in ?? []).join(" / ")} →{" "}
                    <span className="font-medium">{r.skip_to}</span>
                    {r.reason && <span className="text-gray-400"> ({r.reason})</span>}
                  </li>
                ))}
              </ul>
            </SurveySection>
          )}

          {/* Финальный экран */}
          {design.closing?.items && (
            <SurveySection title={design.closing.title || "Финальный экран"}>
              <ul className="space-y-1">
                {design.closing.items.map((item, i) => (
                  <li key={i} className="text-sm text-gray-700">— {item}</li>
                ))}
              </ul>
            </SurveySection>
          )}
        </div>
      )}

      <button
        onClick={onConfirm}
        className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                   hover:bg-brand-600 transition-colors"
      >
        Сгенерировать документы →
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 space-y-2">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium">{value || "—"}</span>
    </div>
  );
}

const LABELS: Record<string, string> = {
  has_decision: "Есть decision",
  method_matches_uncertainty: "Метод обоснован",
  hypotheses_covered: "Гипотезы покрыты",
  no_leading_questions: "Нет leading questions",
  // usability
  all_hypotheses_covered: "Все гипотезы покрыты",
  no_hypothetical_questions: "Нет гипотетических вопросов",
  no_or_questions: "Нет вопросов с «или»",
  general_to_specific: "От общего к частному",
  experience_based_tasks: "Опора на реальный опыт",
  has_success_criteria: "Есть критерии успеха",
  // interview
  no_closed_questions: "Нет закрытых вопросов",
  has_emotion_questions: "Есть вопросы про эмоции",
  has_alternative_questions: "Есть вопросы про альтернативы",
  experience_based: "Опора на реальный опыт",
  has_closing_open_question: "Открытый вопрос в финале",
  // survey
  screener_not_leading: "Скринер не наводящий",
  demographics_at_end: "Демография в конце",
  no_double_barreled: "Нет «два в одном»",
  no_leading: "Нет наводящих",
  no_hypothetical_future: "Нет фантазий о будущем",
  no_double_negatives: "Нет двойных отрицаний",
  time_period_where_needed: "Временной период указан",
  scales_symmetric: "Шкалы симметричны",
  scales_consistent_direction: "Шкалы единого направления",
  open_questions_max_two: "Не более 2 открытых",
  estimated_time_under_12min: "Время ≤ 12 мин",
  options_non_overlapping: "Варианты не пересекаются",
};

const SURVEY_TYPE_LABELS: Record<string, string> = {
  single_choice: "Одиночный выбор",
  multi_choice: "Множественный выбор",
  likert_5: "Шкала 1–5",
  likert_7: "Шкала 1–7",
  ranking: "Ранжирование",
  numeric: "Число",
  open: "Открытый",
};

const MEASUREMENT_LABELS: Record<string, string> = {
  behavior: "Поведение",
  frequency: "Частота",
  importance: "Важность",
  satisfaction: "Удовлетворённость",
  intention: "Намерение",
  priority: "Приоритет",
  barriers: "Барьеры",
  awareness: "Осведомлённость",
  segment: "Сегмент",
  screener: "Скринер",
  context: "Контекст",
};

function SurveySection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 space-y-3">
      <div>
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{title}</p>
        {subtitle && <p className="text-xs text-gray-500 italic mt-0.5">{subtitle}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SurveyQuestionCard({
  q,
  showQualifying = false,
}: {
  q: import("@/store/session").SurveyQuestion;
  showQualifying?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900 flex-1">
          <span className="font-mono text-xs text-gray-400 mr-2">{q.id}</span>
          {q.text}
          {q.required && <span className="text-red-400 ml-1">*</span>}
        </p>
        <div className="flex shrink-0 flex-wrap gap-1 justify-end">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 font-medium">
            {SURVEY_TYPE_LABELS[q.type] ?? q.type}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">
            {MEASUREMENT_LABELS[q.measurement_type] ?? q.measurement_type}
          </span>
        </div>
      </div>
      {q.time_period && (
        <p className="text-xs text-gray-500">Период: {q.time_period}</p>
      )}
      {q.unit && (
        <p className="text-xs text-gray-500">Единица: {q.unit}</p>
      )}
      {q.options && q.options.length > 0 && (
        <ul className="space-y-0.5 pl-2">
          {q.options.map((opt, i) => (
            <li key={i} className="text-sm text-gray-700">○ {opt}</li>
          ))}
        </ul>
      )}
      {q.scale && (
        <div className="text-xs text-gray-500 space-y-0.5">
          <p className="font-medium">{q.scale.type}</p>
          {Object.entries(q.scale.labels).map(([k, v]) => (
            <p key={k}>{k} — {v}</p>
          ))}
        </div>
      )}
      {showQualifying && q.qualifying_answers && q.qualifying_answers.length > 0 && (
        <p className="text-xs text-green-600">
          ✓ Проходит дальше: {q.qualifying_answers.join(", ")}
        </p>
      )}
      {q.randomize_options && (
        <p className="text-[10px] text-gray-400 italic">варианты рандомизируются</p>
      )}
    </div>
  );
}
