"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authBearer, getAuthToken, saveOwnerToken } from "@/lib/auth";
import { validateClarity, type ClarityField } from "@/lib/validateClarity";

type Step = 1 | 2 | 3;

const FIELD_TO_STEP: Record<ClarityField, Step> = {
  business_goal: 1,
  business_context: 2,
  task: 3,
  decision: 3,
};

export default function LandingScreen() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [businessGoal, setBusinessGoal] = useState("");
  const [businessContext, setBusinessContext] = useState("");
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clarityIssues, setClarityIssues] = useState<Partial<Record<ClarityField, string>>>({});

  useEffect(() => {
    const authMode = (process.env.NEXT_PUBLIC_AUTH_MODE ?? "disabled").toLowerCase();
    if (authMode !== "required") {
      setAuthReady(true);
      return;
    }
    const token = getAuthToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/backend/api/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (data.existing_session_id) {
            if (data.existing_owner_token) {
              saveOwnerToken(data.existing_session_id, data.existing_owner_token);
            }
            router.replace(`/session/${data.existing_session_id}`);
            return;
          }
        }
        setAuthReady(true);
      } catch {
        setAuthReady(true);
      }
    })();
  }, [router]);

  async function handleStart() {
    if (!task.trim()) return;
    setLoading(true);
    setError(null);
    setClarityIssues({});
    try {
      const clarity = await validateClarity({
        business_goal: businessGoal,
        business_context: businessContext,
        task,
      });
      if (!clarity.ok) {
        setClarityIssues(clarity.issues);
        const firstBad = (Object.keys(clarity.issues) as ClarityField[])[0];
        if (firstBad && FIELD_TO_STEP[firstBad]) setStep(FIELD_TO_STEP[firstBad]);
        setLoading(false);
        return;
      }

      const res = await fetch("/api/backend/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authBearer() },
        body: JSON.stringify({ business_goal: businessGoal, business_context: businessContext, task }),
      });
      if (res.status === 409) {
        const data = await res.json();
        const existing = data?.detail?.existing_session_id ?? data?.existing_session_id;
        if (existing) {
          router.replace(`/session/${existing}`);
          return;
        }
        throw new Error("У вас уже есть сессия — обновите страницу.");
      }
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.owner_token) saveOwnerToken(data.session_id, data.owner_token);
      router.push(`/session/${data.session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать сессию. Проверьте подключение.");
      setLoading(false);
    }
  }

  if (!authReady) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Проверяем вход...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">Research Preparation Agent</h1>
          <p className="text-gray-500">
            Агент подготовит полный пакет документов для UX-исследования
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          {([1, 2, 3] as Step[]).map((s) => (
            <div
              key={s}
              className={`h-1.5 flex-1 rounded-full transition-colors ${s <= step ? "bg-brand-500" : "bg-gray-200"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Бизнес цель</label>
              <p className="text-sm text-gray-500 mb-3">Какого бизнес-результата хочет достичь команда?</p>
              <textarea
                className={`w-full rounded-xl border bg-white p-4 text-gray-900 shadow-sm
                           placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500
                           resize-none min-h-[120px] ${clarityIssues.business_goal ? "border-red-300" : "border-gray-200"}`}
                placeholder="Например: увеличить конверсию в оплату в B2B-сегменте на 15% к Q3"
                value={businessGoal}
                onChange={(e) => {
                  setBusinessGoal(e.target.value);
                  if (clarityIssues.business_goal) setClarityIssues((p) => ({ ...p, business_goal: undefined }));
                }}
                autoFocus
              />
              {clarityIssues.business_goal && (
                <p className="mt-2 text-sm text-red-600">{clarityIssues.business_goal}</p>
              )}
            </div>
            <button
              onClick={() => setStep(2)}
              disabled={!businessGoal.trim()}
              className="w-full rounded-xl bg-brand-500 px-6 py-3 text-white font-semibold
                         hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Далее →
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Бизнес контекст</label>
              <p className="text-sm text-gray-500 mb-3">
                Опишите ситуацию в продукте или бизнесе, из-за которой появилась задача.
              </p>
              <textarea
                className={`w-full rounded-xl border bg-white p-4 text-gray-900 shadow-sm
                           placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500
                           resize-none min-h-[140px] ${clarityIssues.business_context ? "border-red-300" : "border-gray-200"}`}
                placeholder="Например: в последнем квартале конверсия упала с 8% до 5%. Команда запустила новый онбординг, но причины падения неизвестны."
                value={businessContext}
                onChange={(e) => {
                  setBusinessContext(e.target.value);
                  if (clarityIssues.business_context) setClarityIssues((p) => ({ ...p, business_context: undefined }));
                }}
                autoFocus
              />
              {clarityIssues.business_context && (
                <p className="mt-2 text-sm text-red-600">{clarityIssues.business_context}</p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                className="flex-1 rounded-xl border border-gray-200 px-6 py-3 text-gray-700 font-semibold
                           hover:bg-gray-50 transition-colors"
              >
                ← Назад
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={!businessContext.trim()}
                className="flex-[2] rounded-xl bg-brand-500 px-6 py-3 text-white font-semibold
                           hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Далее →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Что хотим исследовать</label>
              <p className="text-sm text-gray-500 mb-3">
                Опишите объект исследования — что именно нужно понять у пользователей.
              </p>
              <textarea
                className={`w-full rounded-xl border bg-white p-4 text-gray-900 shadow-sm
                           placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500
                           resize-none min-h-[140px] ${clarityIssues.task ? "border-red-300" : "border-gray-200"}`}
                placeholder="Например: хотим понять, почему пользователи не завершают онбординг после регистрации..."
                value={task}
                onChange={(e) => {
                  setTask(e.target.value);
                  if (clarityIssues.task) setClarityIssues((p) => ({ ...p, task: undefined }));
                }}
                autoFocus
              />
              {clarityIssues.task && (
                <p className="mt-2 text-sm text-red-600">{clarityIssues.task}</p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setStep(2); setLoading(false); }}
                className="flex-1 rounded-xl border border-gray-200 px-6 py-3 text-gray-700 font-semibold
                           hover:bg-gray-50 transition-colors"
              >
                ← Назад
              </button>
              <button
                onClick={handleStart}
                disabled={!task.trim() || loading}
                className="flex-[2] rounded-xl bg-brand-500 px-6 py-3 text-white font-semibold
                           hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? "Проверяем формулировки..." : "Начать исследование →"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
