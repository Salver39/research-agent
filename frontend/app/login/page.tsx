"use client";

import { useState } from "react";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/backend/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!res.ok) {
        if (res.status === 422) throw new Error("Введите корректный email");
        throw new Error(`Не удалось отправить письмо (HTTP ${res.status}). Попробуйте позже.`);
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Что-то пошло не так");
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
            <button
              type="submit"
              disabled={!email.trim() || loading}
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
