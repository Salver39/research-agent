"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { saveAuthToken } from "@/lib/auth";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [message, setMessage] = useState("Завершаем вход...");

  useEffect(() => {
    const token = params.get("auth_token");
    if (!token) {
      setStatus("error");
      setMessage("Ссылка повреждена: отсутствует токен.");
      return;
    }
    saveAuthToken(token);

    (async () => {
      try {
        const res = await fetch("/api/backend/api/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setStatus("error");
          setMessage("Не удалось проверить токен. Попробуйте войти заново.");
          return;
        }
        const data = await res.json();
        if (data.existing_session_id) {
          router.replace(`/session/${data.existing_session_id}`);
        } else {
          router.replace("/");
        }
      } catch {
        setStatus("error");
        setMessage("Ошибка сети. Попробуйте обновить страницу.");
      }
    })();
  }, [params, router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="text-center space-y-3">
        <p className={status === "error" ? "text-red-700" : "text-gray-700"}>{message}</p>
        {status === "error" && (
          <a href="/login" className="inline-block text-brand-600 underline">
            Вернуться к входу
          </a>
        )}
      </div>
    </main>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center"><p className="text-gray-500">Завершаем вход...</p></main>}>
      <CallbackInner />
    </Suspense>
  );
}
