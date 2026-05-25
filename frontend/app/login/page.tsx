"use client";

import { useRef, useState } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);

  // If Turnstile is not configured (e.g. self-host without a Cloudflare
  // site key), behave as before — no widget, no token check.
  const turnstileEnabled = TURNSTILE_SITE_KEY.length > 0;
  const submitDisabled = !email.trim() || loading || (turnstileEnabled && !cfToken);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, string> = { email: email.trim().toLowerCase() };
      if (turnstileEnabled && cfToken) body.cf_token = cfToken;

      const res = await fetch("/api/backend/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 422) throw new Error("Введите корректный email");
        if (res.status === 403) throw new Error("Не удалось подтвердить, что вы — не робот. Обновите страницу и попробуйте снова.");
        if (res.status === 503) throw new Error("Сервис временно недоступен — превышен дневной лимит. Попробуйте позже.");
        throw new Error(`Не удалось отправить письмо (HTTP ${res.status}). Попробуйте позже.`);
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Что-то пошло не так");
      // Reset Turnstile so the user can re-challenge if the error was a token issue.
      if (turnstileEnabled) {
        turnstileRef.current?.reset();
        setCfToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">Research Preparation Agent</h1>
          <p className="text-gray-500">Введите email — пришлём ссылку для входа</p>
        </div>

        {sent ? (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-6 text-sm text-green-800 space-y-2">
            <p className="font-semibold">Письмо отправлено на {email}</p>
            <p>Откройте письмо и перейдите по ссылке, чтобы войти. Ссылка действует 15 минут.</p>
            <p className="text-xs text-green-700 pt-2">
              Не пришло? Проверьте папку «Спам» или{" "}
              <button onClick={() => setSent(false)} className="underline">отправить ещё раз</button>.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <input
              type="email"
              autoComplete="email"
              required
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white p-4 text-gray-900 shadow-sm
                         placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {turnstileEnabled && (
              <div className="flex justify-center">
                <Turnstile
                  ref={turnstileRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={(token) => setCfToken(token)}
                  onExpire={() => setCfToken(null)}
                  onError={() => setCfToken(null)}
                  options={{ theme: "light" }}
                />
              </div>
            )}
            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full rounded-xl bg-brand-500 px-6 py-3 text-white font-semibold
                         hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Отправляем..." : "Получить ссылку для входа"}
            </button>
            <p className="text-center text-xs text-gray-500">
              Одна бесплатная сессия исследования на email.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
