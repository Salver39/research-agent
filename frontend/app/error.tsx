"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <h2 className="text-xl font-semibold text-gray-900">Что-то пошло не так</h2>
        <p className="text-sm text-gray-500">{error.message}</p>
        <button
          onClick={reset}
          className="rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    </main>
  );
}
