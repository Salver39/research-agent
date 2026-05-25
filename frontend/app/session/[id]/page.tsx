"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSE } from "@/hooks/useSSE";
import { useSessionStore } from "@/store/session";
import { authHeaders } from "@/lib/auth";
import type { DiagnosticAnswers, Diagnosis } from "@/types/research";
import { CONSTRAINT_LABELS, SOURCE_LABELS } from "@/types/research";
import { ClarifyScreen } from "@/components/wizard/ClarifyScreen";
import { ResearchDiagnosisScreen } from "@/components/wizard/ResearchDiagnosisScreen";
import { BriefScreen } from "@/components/wizard/BriefScreen";
import { ContextUploadScreen } from "@/components/wizard/ContextUploadScreen";
import { HypothesesScreen } from "@/components/wizard/HypothesesScreen";
import { MethodScreen } from "@/components/wizard/MethodScreen";
import { SamplingScreen } from "@/components/wizard/SamplingScreen";
import { DesignScreen } from "@/components/wizard/DesignScreen";
import { OutputScreen } from "@/components/wizard/OutputScreen";
import { StreamingDots } from "@/components/StreamingDots";

const STAGES = [
  "intake", "clarify", "brief", "context",
  "hypothesis", "method", "sampling", "design", "done",
] as const;
type Stage = typeof STAGES[number];

const STAGE_LABELS: Record<string, string> = {
  intake:     "Диагностика",
  clarify:    "Результат диагностики",
  brief:      "Бриф исследования",
  context:    "Данные компании",
  hypothesis: "Гипотезы",
  method:     "Метод исследования",
  sampling:   "Выборка",
  design:     "Дизайн исследования",
  done:       "Готовые документы",
};

function stageIndex(s: string) {
  const i = STAGES.indexOf(s as Stage);
  return i === -1 ? 0 : i;
}

async function advance(id: string, body: object = {}) {
  const res = await fetch(`/api/backend/api/session/${id}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(id) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Advance failed: HTTP ${res.status}`);
  return res.json() as Promise<{ stage: string }>;
}

async function retreat(id: string) {
  const res = await fetch(`/api/backend/api/session/${id}/retreat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(id) },
  });
  if (!res.ok) throw new Error(`Retreat failed: HTTP ${res.status}`);
  return res.json() as Promise<{ stage: string }>;
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const store = useSessionStore();
  const [contextStreamed, setContextStreamed] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const initialized = useRef(false);
  const advancedToClarity = useRef(false);
  const diagnosticAnswersRef = useRef<DiagnosticAnswers | null>(null);
  const appendHypothesesRef = useRef(false);

  const storeRef = useRef(store);
  useEffect(() => { storeRef.current = store; }, [store]);

  const { text: sseText, streaming, error: sseError, stream, clearText } = useSSE(id, {
    onDone: useCallback(
      (full: string) => {
        const s = storeRef.current;
        try {
          const cleaned = full.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const d = JSON.parse(cleaned);
          if (d.summary && d.needed_for_quality) {
            const diag: Diagnosis = { ...(diagnosticAnswersRef.current ?? {}), ...d } as Diagnosis;
            s.setDiagnosis(diag);
            s.setStage("clarify");
          } else if (d.research_question) {
            s.setBrief(d);
            s.setStage("brief");
          } else if (d.hypotheses) {
            const fresh = d.hypotheses.map((h: any) => ({ ...h, priority: 0 }));
            if (appendHypothesesRef.current) {
              s.setHypotheses([...s.hypotheses, ...fresh]);
              appendHypothesesRef.current = false;
            } else {
              s.setHypotheses(fresh);
            }
          } else if (Array.isArray(d.methods) && d.methods.length > 0) {
            s.setMethodPlan(d);
            const supportedKeys = new Set(["deep_interviews", "usability_testing", "survey"]);
            const supported = d.methods.filter((m: any) => supportedKeys.has(m.method_key));
            const primaryKey = d.primary_method_key;
            const primary =
              supported.find((m: any) => m.method_key === primaryKey) ??
              supported[0] ??
              d.methods.find((m: any) => m.method_key === primaryKey) ??
              d.methods[0];
            if (primary) s.setMethod(primary);
          } else if (d.name && d.rationale) {
            s.setMethod(d);
          } else if (d.segments) {
            s.setSample(d);
          } else if (d.guide_blocks || d.tasks || d.pre_interview || d.main_blocks) {
            s.setDesign(d);
          } else if (d.patterns) {
            setContextStreamed(true);
          }
        } catch (e) { console.error("[onDone] parse error", e, "\nraw:", full); }
      },
      []
    ),
  });

  useEffect(() => {
    if (!id || initialized.current) return;
    initialized.current = true;
    store.setSessionId(id);
    fetch(`/api/backend/api/session/${id}`, { headers: authHeaders(id) })
      .then((r) => r.json())
      .then((data) => {
        const stage = data.stage ?? "intake";
        store.setStage(stage);
        if (data.brief) store.setBrief(data.brief);
        if (data.hypotheses?.length) store.setHypotheses(data.hypotheses);
        if (data.method) store.setMethod(data.method);
        if (data.method_plan) store.setMethodPlan(data.method_plan);
        if (data.sample) store.setSample(data.sample);
        if (data.design) store.setDesign(data.design);
        if (data.diagnosis) store.setDiagnosis(data.diagnosis);
        if (stage !== "intake") {
          advancedToClarity.current = true;
        }
      })
      .catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function onBack() {
    try {
      setApiError(null);
      const { stage: newStage } = await retreat(id);
      store.setStage(newStage as Stage);
      store.clearStreamText();
      if (newStage === "context") setContextStreamed(false);
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка навигации"); }
  }

  async function onClarifySubmit(answers: DiagnosticAnswers) {
    try {
      setApiError(null);
      diagnosticAnswersRef.current = answers;
      store.setDiagnosis(null);
      store.clearStreamText();

      if (!advancedToClarity.current) {
        await advance(id);
        advancedToClarity.current = true;
      }

      store.setStage("clarify");
      stream(JSON.stringify(answers));
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка отправки"); }
  }

  function onDiagnosisEdit() {
    store.setDiagnosis(null);
    store.setStage("intake");
  }

  async function onDiagnosisConfirm() {
    try {
      setApiError(null);
      const diag = store.diagnosis;
      if (!diag) return;

      const brief = {
        research_question: diag.summary || diag.decision,
        decision: diag.decision,
        constraints: (diag.constraints ?? []).map((c) => CONSTRAINT_LABELS[c]).join(", ") || "не указано",
        known: (diag.available_sources ?? []).map((s) => SOURCE_LABELS[s]).join(", ") || "не указано",
      };

      await advance(id, {
        brief,
        method_patch: {
          uncertainty_types: diag.uncertainty_types ?? [],
          preliminary_methods: diag.preliminary_methods ?? [],
        },
      });
      await advance(id);

      store.setBrief(brief);
      clearText();
      store.setStage("context");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка подтверждения"); }
  }

  async function onBriefConfirm() {
    try {
      setApiError(null);
      await advance(id, { brief: store.brief });
      clearText();
      store.setStage("context");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка подтверждения брифа"); }
  }

  async function onContextContinue() {
    store.setStage("context");
    stream("analyze");
  }

  async function onContextDone() {
    try {
      setApiError(null);
      await advance(id);
      store.setStage("hypothesis");
      stream("generate");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка перехода"); }
  }

  function onHypothesesGenerateMore() {
    appendHypothesesRef.current = true;
    stream("append");
  }

  async function onHypothesesConfirm() {
    try {
      setApiError(null);
      await advance(id, { hypotheses: store.hypotheses });
      store.setStage("method");
      stream("select");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка перехода"); }
  }

  async function onMethodConfirm() {
    try {
      setApiError(null);
      const m = store.method;
      await advance(id, m ? { method_patch: { name: m.name, method_key: m.method_key } } : {});
      // Drop sample/design from the previous method so SamplingScreen does not
      // flash stale data between the stage flip and the new stream's [DONE].
      store.setSample(null);
      store.setDesign(null);
      store.setStage("sampling");
      stream("generate");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка перехода"); }
  }

  function onSamplingRetry() {
    store.setSample(null);
    stream("generate");
  }

  async function onSamplingConfirm() {
    try {
      setApiError(null);
      await advance(id);
      store.setStage("design");
      stream("build");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка перехода"); }
  }

  function onDesignRetry() {
    store.setDesign(null);
    stream("build");
  }

  async function onDesignConfirm() {
    try {
      setApiError(null);
      await advance(id);
      store.setStage("done");
    } catch (e) { setApiError(e instanceof Error ? e.message : "Ошибка перехода"); }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <ProgressBar
          current={stageIndex(store.stage)}
          total={STAGES.length}
          label={STAGE_LABELS[store.stage] ?? store.stage}
        />

        {!["intake", "clarify", "done"].includes(store.stage) && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors w-fit"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none">
              <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Предыдущий шаг
          </button>
        )}

        {(sseError || apiError) && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            <strong>Ошибка агента:</strong> {sseError || apiError}
          </div>
        )}

        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm min-h-[300px]">
          <Screen
            stage={store.stage}
            streaming={streaming}
            sseText={sseText}
            contextStreamed={contextStreamed}
            sessionId={id}
            onClarifySubmit={onClarifySubmit}
            onDiagnosisConfirm={onDiagnosisConfirm}
            onDiagnosisEdit={onDiagnosisEdit}
            onBriefConfirm={onBriefConfirm}
            onContextContinue={onContextContinue}
            onContextDone={onContextDone}
            onHypothesesGenerateMore={onHypothesesGenerateMore}
            onHypothesesConfirm={onHypothesesConfirm}
            onMethodConfirm={onMethodConfirm}
            onSamplingConfirm={onSamplingConfirm}
            onSamplingRetry={onSamplingRetry}
            onDesignConfirm={onDesignConfirm}
            onDesignRetry={onDesignRetry}
          />
        </div>
      </div>
    </main>
  );
}

// ── Screen router ─────────────────────────────────────────────────────────────

interface SP {
  stage: string; streaming: boolean; sseText: string;
  contextStreamed: boolean; sessionId: string;
  onClarifySubmit: (a: DiagnosticAnswers) => void;
  onDiagnosisConfirm: () => void;
  onDiagnosisEdit: () => void;
  onBriefConfirm: () => void;
  onContextContinue: () => void;
  onContextDone: () => void;
  onHypothesesGenerateMore: () => void;
  onHypothesesConfirm: () => void;
  onMethodConfirm: () => void;
  onSamplingConfirm: () => void;
  onSamplingRetry: () => void;
  onDesignConfirm: () => void;
  onDesignRetry: () => void;
}

function Screen(p: SP) {
  const { stage, streaming, sseText } = p;

  if (stage === "intake") {
    return <ClarifyScreen onSubmit={p.onClarifySubmit} />;
  }
  if (stage === "clarify") {
    return (
      <ResearchDiagnosisScreen
        streaming={streaming}
        onConfirm={p.onDiagnosisConfirm}
        onEdit={p.onDiagnosisEdit}
      />
    );
  }
  if (stage === "brief") {
    return <BriefScreen streaming={streaming} streamText={sseText} onConfirm={p.onBriefConfirm} />;
  }
  if (stage === "context") {
    if (!p.contextStreamed && !streaming && sseText === "") {
      return <ContextUploadScreen sessionId={p.sessionId} onContinue={p.onContextContinue} />;
    }
    if (streaming) return <ContextAnalyzing />;
    return <ContextResult sseText={sseText} onDone={p.onContextDone} />;
  }
  if (stage === "hypothesis") {
    return <HypothesesScreen streaming={streaming} streamText={sseText} onConfirm={p.onHypothesesConfirm} onGenerateMore={p.onHypothesesGenerateMore} />;
  }
  if (stage === "method") {
    return <MethodScreen streaming={streaming} streamText={sseText} onConfirm={p.onMethodConfirm} />;
  }
  if (stage === "sampling") {
    return <SamplingScreen streaming={streaming} streamText={sseText} onConfirm={p.onSamplingConfirm} onRetry={p.onSamplingRetry} />;
  }
  if (stage === "design") {
    return <DesignScreen streaming={streaming} streamText={sseText} onConfirm={p.onDesignConfirm} onRetry={p.onDesignRetry} />;
  }
  if (stage === "done") return <OutputScreen sessionId={p.sessionId} />;

  return (
    <div className="space-y-2">
      <h2 className="text-xl font-semibold text-gray-900">{STAGE_LABELS[stage] ?? stage}</h2>
      <p className="text-sm text-gray-400">Этот экран появится в следующей итерации.</p>
    </div>
  );
}

// ── Context sub-screens ───────────────────────────────────────────────────────

function ContextAnalyzing() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">Анализ данных компании</h2>
      <StreamingDots label="Агент анализирует документы..." />
    </div>
  );
}

function ContextResult({ sseText, onDone }: { sseText: string; onDone: () => void }) {
  let patterns: { text: string; source: string }[] = [];
  let summary = "";
  try {
    const d = JSON.parse(sseText);
    patterns = d.patterns ?? [];
    summary = d.summary ?? "";
  } catch { /* still raw */ }

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold text-gray-900">Найденные паттерны</h2>
      {summary && <p className="text-sm text-gray-600">{summary}</p>}
      {patterns.length === 0 && (
        <p className="text-sm text-gray-400">Документов нет — агент будет работать только с брифом.</p>
      )}
      <ul className="space-y-2">
        {patterns.map((p, i) => (
          <li key={i} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 space-y-1">
            <p className="text-sm text-gray-800">{p.text}</p>
            <p className="text-xs text-brand-500">Источник: {p.source}</p>
          </li>
        ))}
      </ul>
      <button
        onClick={onDone}
        className="w-full rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
      >
        Сформировать гипотезы →
      </button>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-gray-400">
        <span className="font-medium text-gray-600">{label}</span>
        <span>Шаг {current + 1} из {total}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full bg-brand-500 transition-all duration-500"
          style={{ width: `${((current + 1) / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
