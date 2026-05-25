"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { UncertaintyType, AvailableSource, ConstraintType, Platform, DiagnosticAnswers } from "@/types/research";
import {
  UNCERTAINTY_OPTIONS, METHOD_LABELS,
  uncertaintiesToMethods,
  SOURCE_OPTIONS, CONSTRAINT_OPTIONS, PLATFORM_OPTIONS,
} from "@/types/research";
import { validateClarity } from "@/lib/validateClarity";

interface Props {
  onSubmit: (answers: DiagnosticAnswers) => void;
}

const STEP_LABELS = ["Решение", "Неопределённость", "Контекст"];

export function ClarifyScreen({ onSubmit }: Props) {
  const [step, setStep] = useState(0);
  const [decision, setDecision] = useState("");
  const [uncertaintyTypes, setUncertaintyTypes] = useState<UncertaintyType[]>([]);
  const [customUncertainty, setCustomUncertainty] = useState("");
  const [sources, setSources] = useState<Set<AvailableSource>>(new Set());
  const [customSources, setCustomSources] = useState("");
  const [constraints, setConstraints] = useState<Set<ConstraintType>>(new Set());
  const [customConstraints, setCustomConstraints] = useState("");
  const [platform, setPlatform] = useState<Platform | null>(null);

  function toggleSource(s: AvailableSource) {
    setSources((prev) => {
      const next = new Set(prev);
      if (s === "nothing") return new Set<AvailableSource>(["nothing"]);
      next.delete("nothing");
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  function toggleConstraint(c: ConstraintType) {
    setConstraints((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }

  function toggleUncertainty(t: UncertaintyType) {
    setUncertaintyTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  }

  const hasUncertainty = uncertaintyTypes.length > 0 || customUncertainty.trim().length > 0;
  const canSubmit = hasUncertainty && platform !== null;

  function handleSubmit() {
    if (!canSubmit || platform === null) return;
    onSubmit({
      decision,
      uncertainty_types: uncertaintyTypes,
      custom_uncertainty: customUncertainty.trim() || undefined,
      preliminary_methods: uncertaintiesToMethods(uncertaintyTypes),
      available_sources: Array.from(sources),
      custom_sources: customSources.trim() || undefined,
      constraints: Array.from(constraints),
      custom_constraints: customConstraints.trim() || undefined,
      platform,
    });
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Диагностика исследования</h2>
        <p className="text-sm text-gray-500 mt-1">
          Шаг {step + 1} из {STEP_LABELS.length} — {STEP_LABELS[step]}
        </p>
      </div>

      {/* Step progress */}
      <div className="flex gap-2">
        {STEP_LABELS.map((_, i) => (
          <div
            key={i}
            className={clsx(
              "h-1 flex-1 rounded-full transition-colors duration-300",
              i <= step ? "bg-brand-500" : "bg-gray-200"
            )}
          />
        ))}
      </div>

      {step === 0 && (
        <StepDecision value={decision} onChange={setDecision} onNext={() => setStep(1)} />
      )}

      {step === 1 && (
        <StepUncertainty
          selected={uncertaintyTypes}
          onToggle={toggleUncertainty}
          customText={customUncertainty}
          onCustomChange={setCustomUncertainty}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <StepContext
          sources={sources}
          customSources={customSources}
          onCustomSourcesChange={setCustomSources}
          constraints={constraints}
          customConstraints={customConstraints}
          onCustomConstraintsChange={setCustomConstraints}
          platform={platform}
          onPlatformChange={setPlatform}
          onToggleSource={toggleSource}
          onToggleConstraint={toggleConstraint}
          onBack={() => setStep(1)}
          onSubmit={handleSubmit}
          canSubmit={canSubmit}
        />
      )}
    </div>
  );
}

// ── Step 1: Decision ──────────────────────────────────────────────────────────

function StepDecision({
  value, onChange, onNext,
}: { value: string; onChange: (v: string) => void; onNext: () => void }) {
  const [issue, setIssue] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleNext() {
    if (!value.trim()) return;
    setChecking(true);
    setIssue(null);
    try {
      const clarity = await validateClarity({ decision: value });
      if (!clarity.ok && clarity.issues.decision) {
        setIssue(clarity.issues.decision);
        return;
      }
      onNext();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-gray-900">
          Какое решение команда хочет принять по итогам исследования?
        </p>
        <p className="text-xs text-gray-400">
          Исследование должно помогать принять конкретное продуктовое решение.
        </p>
      </div>

      <textarea
        autoFocus
        className={clsx(
          "w-full rounded-xl border bg-white p-4 text-sm text-gray-900",
          "placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500",
          "resize-none min-h-[120px]",
          issue ? "border-red-300" : "border-gray-200",
        )}
        placeholder="Например: запустить ли новый онбординг для B2B-пользователей или отложить до Q3"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (issue) setIssue(null);
        }}
      />

      {issue && <p className="text-sm text-red-600">{issue}</p>}

      <button
        onClick={handleNext}
        disabled={!value.trim() || checking}
        className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white
                   hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {checking ? "Проверяем формулировку..." : "Далее →"}
      </button>
    </div>
  );
}

// ── Step 2: Uncertainty types (multi-select) ──────────────────────────────────

function StepUncertainty({
  selected, onToggle, customText, onCustomChange, onBack, onNext,
}: {
  selected: UncertaintyType[];
  onToggle: (v: UncertaintyType) => void;
  customText: string;
  onCustomChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const selectedMethods = uncertaintiesToMethods(selected);
  const hasAny = selected.length > 0 || customText.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-gray-900">
          Что сейчас мешает принять это решение?
        </p>
        <p className="text-xs text-gray-400">
          Можно выбрать несколько вариантов — на их основе определятся методы исследования.
        </p>
      </div>

      <div className="grid gap-2">
        {UNCERTAINTY_OPTIONS.map((opt) => {
          const isSelected = selected.includes(opt.type);
          return (
            <button
              key={opt.type}
              onClick={() => onToggle(opt.type)}
              className={clsx(
                "rounded-xl border px-4 py-3 text-sm text-left transition-all",
                isSelected
                  ? "border-brand-500 bg-brand-50 text-brand-700 font-medium ring-1 ring-brand-500"
                  : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={clsx(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                    isSelected
                      ? "border-brand-500 bg-brand-500 text-white"
                      : "border-gray-300 bg-white"
                  )}
                >
                  {isSelected && (
                    <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none">
                      <path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="flex-1">{opt.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom variant */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-gray-500">Или опишите своими словами</p>
        <textarea
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900
                     placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500
                     resize-none min-h-[72px]"
          placeholder="Например: не понимаем, почему пользователи не возвращаются после первой покупки"
          value={customText}
          onChange={(e) => onCustomChange(e.target.value)}
        />
      </div>

      {/* Selected methods preview */}
      {(selectedMethods.length > 0 || customText.trim()) && (
        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 space-y-1.5">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
            Предварительные методы
          </p>
          <div className="flex flex-wrap gap-2">
            {selectedMethods.map((m) => (
              <span
                key={m}
                className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700"
              >
                {METHOD_LABELS[m]}
              </span>
            ))}
            {customText.trim() && selectedMethods.length === 0 && (
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                Определим на этапе метода
              </span>
            )}
            {customText.trim() && selectedMethods.length > 0 && (
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                + свой вариант
              </span>
            )}
          </div>
        </div>
      )}

      {!hasAny && (
        <p className="text-xs text-center text-gray-400">
          Выберите хотя бы один вариант или опишите своими словами
        </p>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium
                     text-gray-700 hover:bg-gray-50 transition-colors"
        >
          ← Назад
        </button>
        <button
          onClick={onNext}
          disabled={!hasAny}
          className="flex-1 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white
                     hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Далее →
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Context ───────────────────────────────────────────────────────────

function StepContext({
  sources, customSources, onCustomSourcesChange,
  constraints, customConstraints, onCustomConstraintsChange,
  platform, onPlatformChange,
  onToggleSource, onToggleConstraint, onBack, onSubmit, canSubmit,
}: {
  sources: Set<AvailableSource>;
  customSources: string;
  onCustomSourcesChange: (v: string) => void;
  constraints: Set<ConstraintType>;
  customConstraints: string;
  onCustomConstraintsChange: (v: string) => void;
  platform: Platform | null;
  onPlatformChange: (p: Platform) => void;
  onToggleSource: (s: AvailableSource) => void;
  onToggleConstraint: (c: ConstraintType) => void;
  onBack: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-900">Что уже есть?</p>
        <div className="flex flex-wrap gap-2">
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => onToggleSource(opt.type)}
              className={clsx(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                sources.has(opt.type)
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={customSources}
          onChange={(e) => onCustomSourcesChange(e.target.value)}
          placeholder="Добавьте своё (через запятую)"
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900
                     placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-900">Ограничения</p>
        <div className="flex flex-wrap gap-2">
          {CONSTRAINT_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => onToggleConstraint(opt.type)}
              className={clsx(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                constraints.has(opt.type)
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={customConstraints}
          onChange={(e) => onCustomConstraintsChange(e.target.value)}
          placeholder="Добавьте своё (через запятую)"
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900
                     placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-900">
          Платформа <span className="text-red-500">*</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {PLATFORM_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => onPlatformChange(opt.type)}
              className={clsx(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                platform === opt.type
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium
                     text-gray-700 hover:bg-gray-50 transition-colors"
        >
          ← Назад
        </button>
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="flex-1 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white
                     hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Получить диагноз →
        </button>
      </div>
    </div>
  );
}
