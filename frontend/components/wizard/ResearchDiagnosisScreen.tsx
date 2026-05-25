"use client";

import { useSessionStore } from "@/store/session";
import { METHOD_LABELS, UNCERTAINTY_OPTIONS } from "@/types/research";

interface Props {
  streaming: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}

export function ResearchDiagnosisScreen({ streaming, onConfirm, onEdit }: Props) {
  const { diagnosis } = useSessionStore();

  if (streaming) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Диагностика исследования</h2>
        <div className="flex items-center gap-3 rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-500" />
          </span>
          <span className="text-sm text-brand-700">Агент анализирует данные...</span>
        </div>
      </div>
    );
  }

  if (!diagnosis) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Диагностика исследования</h2>
        <p className="text-sm text-gray-400">Нет данных для отображения.</p>
      </div>
    );
  }

  const uncertaintyTypes = diagnosis.uncertainty_types ?? [];
  const preliminaryMethods = diagnosis.preliminary_methods ?? [];
  const uncertaintyLabels = [
    ...uncertaintyTypes.map((t) => UNCERTAINTY_OPTIONS.find((o) => o.type === t)?.label ?? t),
    ...(diagnosis.custom_uncertainty ? [diagnosis.custom_uncertainty] : []),
  ];
  const methodLabels = preliminaryMethods.length > 0
    ? preliminaryMethods.map((m) => METHOD_LABELS[m] ?? m)
    : ["Определим на этапе метода"];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Диагностика исследования</h2>
        {diagnosis.summary && (
          <p className="text-sm text-gray-600 mt-1">{diagnosis.summary}</p>
        )}
      </div>

      {/* Цель и задачи исследования */}
      {diagnosis.research_goal && (
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-brand-500 uppercase tracking-wide mb-1">Цель исследования</p>
            <p className="text-sm font-semibold text-gray-900">{diagnosis.research_goal}</p>
          </div>
          {diagnosis.research_tasks?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-brand-500 uppercase tracking-wide mb-1">Задачи исследования</p>
              <ol className="space-y-1 list-decimal list-inside">
                {diagnosis.research_tasks.map((task, i) => (
                  <li key={i} className="text-sm text-gray-700">{task}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {/* Key cards */}
      <div className="space-y-3">
        <DiagCard
          label="Ключевое решение"
          value={diagnosis.decision}
          variant="blue"
        />
        <div className="grid grid-cols-2 gap-3">
          <DiagCard
            label={uncertaintyLabels.length > 1 ? "Типы неопределённости" : "Тип неопределённости"}
            value={uncertaintyLabels.join(" · ")}
            variant="gray"
          />
          <DiagCard
            label={methodLabels.length > 1 ? "Предварительные методы" : "Предварительный метод"}
            value={methodLabels.join(", ")}
            variant="green"
          />
        </div>
      </div>

      {/* Recommendations */}
      {(diagnosis.needed_for_quality ?? []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
            Для качественной подготовки желательно
          </p>
          <ul className="space-y-1.5">
            {diagnosis.needed_for_quality.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-px text-brand-500 font-bold shrink-0">+</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Risks */}
      {(diagnosis.main_risks ?? []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
            Главные риски
          </p>
          <ul className="space-y-1.5">
            {diagnosis.main_risks.map((risk, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-px text-red-400 font-bold shrink-0">!</span>
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={onEdit}
          className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium
                     text-gray-700 hover:bg-gray-50 transition-colors"
        >
          ← Исправить
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white
                     hover:bg-brand-600 transition-colors"
        >
          Подтвердить понимание →
        </button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function DiagCard({
  label, value, variant,
}: { label: string; value: string; variant: "blue" | "gray" | "green" }) {
  const styles = {
    blue:  "bg-brand-50 border-brand-100",
    gray:  "bg-gray-50 border-gray-200",
    green: "bg-green-50 border-green-100",
  };
  return (
    <div className={`rounded-xl border p-4 ${styles[variant]}`}>
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm font-semibold text-gray-900 leading-snug">{value || "—"}</p>
    </div>
  );
}
