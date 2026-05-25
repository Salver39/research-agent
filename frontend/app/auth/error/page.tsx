"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

const REASONS: Record<string, string> = {
  expired: "Срок действия ссылки истёк (15 минут). Запросите новую.",
  consumed: "Ссылка уже была использована. Запросите новую, если нужно войти ещё раз.",
  invalid: "Ссылка недействительна. Возможно, она повреждена при копировании.",
};

function ErrorInner() {
  const params = useSearchParams();
  const reason = params.get("reason") ?? "";
  const message = REASONS[reason] ?? "Не удалось войти по ссылке. Попробуйте ещё раз.";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Не удалось войти</h1>
        <p className="text-gray-600">{message}</p>
        <a
          href="/login"
          className="inline-block rounded-xl bg-brand-500 px-6 py-3 text-white font-semibold hover:bg-brand-600 transition-colors"
        >
          Запросить новую ссылку
        </a>
      </div>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center"><p className="text-gray-500">...</p></main>}>
      <ErrorInner />
    </Suspense>
  );
}
