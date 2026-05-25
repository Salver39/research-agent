"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { useSessionStore, Method, MethodPhase, PlannedMethod } from "@/store/session";
import { StreamingDots } from "@/components/StreamingDots";

type MethodPreset = Omit<Method, "name"> & { name: string };

const METHOD_PRESETS: MethodPreset[] = [
  {
    name: "Глубинные интервью",
    method_key: "deep_interviews",
    uncertainty_type: "Проблемная (что болит, почему уходят)",
    rationale:
      "Подходит, когда нужно понять причины, мотивы и барьеры пользователей. Раскрывает неочевидные инсайты, которые сложно получить через количественные методы.",
    participants: 8,
    duration: "45–60 минут на интервью",
    format: "Онлайн / офлайн / смешанный",
  },
  {
    name: "Опрос",
    method_key: "survey",
    uncertainty_type: "Оценочная (насколько хорошо работает)",
    rationale:
      "Подходит, когда гипотезы уже сформулированы и нужно количественно подтвердить или опровергнуть их на большой выборке.",
    participants: 300,
    duration: "8–12 минут на респондента",
    format: "Онлайн",
  },
  {
    name: "Юзабилити-тестирование",
    method_key: "usability_testing",
    uncertainty_type: "Юзабилити (можно ли использовать)",
    rationale:
      "Подходит, когда нужно проверить, способен ли пользователь выполнить ключевые сценарии в продукте без затруднений и где именно возникают проблемы.",
    participants: 6,
    duration: "45–60 минут на сессию",
    format: "Онлайн с демонстрацией экрана",
  },
  {
    name: "A/B тест / concept test",
    method_key: "ab_test",
    uncertainty_type: "Сравнительная (какой вариант лучше)",
    rationale:
      "Подходит, когда нужно сравнить два или более варианта и выбрать тот, что лучше работает на ключевую метрику.",
    participants: 1000,
    duration: "2–4 недели на эксперимент",
    format: "Онлайн",
  },
  {
    name: "Экспресс / guerrilla",
    method_key: "other",
    uncertainty_type: "Срочная / малый бюджет",
    rationale:
      "Подходит, когда нужны быстрые качественные сигналы в условиях ограниченного бюджета и времени. Не даёт статистической значимости.",
    participants: 5,
    duration: "15–20 минут на сессию",
    format: "Офлайн (в поле) или быстрый онлайн",
  },
  {
    name: "Дневниковое исследование",
    method_key: "other",
    uncertainty_type: "Поведенческая (как используют в естественной среде)",
    rationale:
      "Подходит, когда нужно понять реальное поведение во времени, в естественном контексте. Респонденты фиксируют опыт самостоятельно в течение периода.",
    participants: 10,
    duration: "1–2 недели наблюдения",
    format: "Онлайн дневник (мобильное приложение / чат)",
  },
];

const PHASE_LABEL: Record<MethodPhase, string> = {
  qualitative: "Качественный",
  quantitative: "Количественный",
  concept:      "Концепт-тест",
  usability:    "Юзабилити",
};

const PHASE_COLOR: Record<MethodPhase, string> = {
  qualitative:  "bg-amber-100 text-amber-700",
  quantitative: "bg-sky-100 text-sky-700",
  concept:      "bg-violet-100 text-violet-700",
  usability:    "bg-emerald-100 text-emerald-700",
};

// Methods for which we have a dedicated design agent (sampling + scenario can
// be auto-built). Anything outside this set is shown as informational context
// but cannot be picked as the active method.
const SUPPORTED_METHOD_KEYS = new Set<string>([
  "deep_interviews",
  "usability_testing",
  "survey",
]);

function isSupported(method_key: string | undefined): boolean {
  return !!method_key && SUPPORTED_METHOD_KEYS.has(method_key);
}

interface Props {
  streaming: boolean;
  streamText: string;
  onConfirm: () => void;
}

export function MethodScreen({ streaming, onConfirm }: Props) {
  const { method, setMethod, methodPlan } = useSessionStore();
  const [override, setOverride] = useState("");

  function handleOverride(name: string) {
    setOverride(name);
    if (!name) {
      // Restore primary from plan — preferring a supported method
      if (methodPlan && methodPlan.methods.length > 0) {
        const supported = methodPlan.methods.filter((m) => isSupported(m.method_key));
        const primary =
          supported.find((m) => m.method_key === methodPlan.primary_method_key) ??
          supported[0] ??
          methodPlan.methods[0];
        setMethod(primary);
      }
      return;
    }
    const preset = METHOD_PRESETS.find((m) => m.name === name);
    if (preset && isSupported(preset.method_key)) setMethod({ ...preset });
  }

  function pickFromPlan(planned: PlannedMethod) {
    if (!isSupported(planned.method_key)) return;
    setOverride("");
    setMethod({ ...planned });
  }

  if (streaming) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">План методов исследования</h2>
        <StreamingDots label="Агент планирует методы..." />
      </div>
    );
  }

  if (!method) return null;

  const planMethods = methodPlan?.methods ?? [];
  const multiStep = planMethods.length > 1;
  const isActive = (m: PlannedMethod) =>
    m.method_key === method.method_key && m.name === method.name;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        {multiStep ? "План методов исследования" : "Метод исследования"}
      </h2>

      {multiStep && methodPlan?.sequence_rationale && (
        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 text-sm text-gray-700">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">
            Очередность
          </p>
          {methodPlan.sequence_rationale}
        </div>
      )}

      {planMethods.length > 0 && (
        <div className="space-y-3">
          {planMethods.map((m) => {
            const active = isActive(m);
            const supported = isSupported(m.method_key);
            const phase = (m.phase ?? "qualitative") as MethodPhase;
            return (
              <button
                key={`${m.order}-${m.method_key}`}
                onClick={() => pickFromPlan(m)}
                disabled={!supported}
                title={!supported ? "Для этого метода нет автоматизации — выборку и сценарий собрать нельзя" : undefined}
                className={clsx(
                  "w-full text-left rounded-xl border-2 p-5 space-y-3 transition-all",
                  !supported
                    ? "border-gray-200 border-dashed bg-gray-50 opacity-70 cursor-not-allowed"
                    : active
                    ? "border-brand-500 bg-brand-50"
                    : "border-gray-200 bg-white hover:border-gray-300"
                )}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    {multiStep && (
                      <span
                        className={clsx(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                          active && supported ? "bg-brand-500 text-white" : "bg-gray-200 text-gray-600"
                        )}
                      >
                        {m.order}
                      </span>
                    )}
                    <p
                      className={clsx(
                        "text-lg font-bold",
                        !supported ? "text-gray-600" : active ? "text-brand-700" : "text-gray-900"
                      )}
                    >
                      {m.name}
                    </p>
                    <span
                      className={clsx(
                        "text-[11px] font-medium px-2 py-0.5 rounded-full",
                        PHASE_COLOR[phase] ?? "bg-gray-100 text-gray-600"
                      )}
                    >
                      {PHASE_LABEL[phase] ?? phase}
                    </span>
                    {!supported && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                        Без автоматизации
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-sm text-gray-700">{m.rationale}</p>
                <div className="flex gap-4 text-xs text-gray-500 pt-1 flex-wrap">
                  <span>Тип: {m.uncertainty_type}</span>
                  <span>·</span>
                  <span>Длительность: {m.duration}</span>
                  <span>·</span>
                  <span>{m.format}</span>
                </div>
                {!supported && (
                  <p className="text-xs text-gray-500 italic">
                    Для этого этапа нет автоматической генерации выборки и сценария — проведите его вручную или замените на поддерживаемый метод.
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Fallback for old sessions without method_plan */}
      {planMethods.length === 0 && (
        <div className="rounded-xl border-2 border-brand-500 bg-brand-50 p-5 space-y-3">
          <p className="text-lg font-bold text-brand-700">{method.name}</p>
          <p className="text-sm text-gray-700">{method.rationale}</p>
          <div className="flex gap-4 text-xs text-gray-500 pt-1">
            <span>Тип: {method.uncertainty_type}</span>
            <span>·</span>
            <span>Длительность: {method.duration}</span>
            <span>·</span>
            <span>{method.format}</span>
          </div>
        </div>
      )}

      {multiStep && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Выборку и сценарий вы построите только для одного метода за раз. Выберите тот,
          который начнёте проводить первым — по умолчанию это шаг №1 из плана.
        </div>
      )}

      {!isSupported(method.method_key) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          У выбранного метода нет автоматизации — выборку и сценарий собрать нельзя. Выберите один из поддерживаемых: Глубинные интервью, Юзабилити-тестирование, Опрос.
        </div>
      )}

      <div className="flex gap-3 items-center">
        <select
          value={override}
          onChange={(e) => handleOverride(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 bg-white"
        >
          <option value="">{planMethods.length > 0 ? "Из плана агента" : "Изменить метод..."}</option>
          {METHOD_PRESETS.map((m) => {
            const supported = isSupported(m.method_key);
            return (
              <option key={m.name} value={m.name} disabled={!supported}>
                {m.name}{!supported ? " (нет автоматизации)" : ""}
              </option>
            );
          })}
        </select>
        <button
          onClick={onConfirm}
          disabled={!isSupported(method.method_key)}
          className="ml-auto rounded-xl bg-brand-500 px-6 py-2 text-sm font-semibold text-white
                     hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Далее →
        </button>
      </div>
    </div>
  );
}
