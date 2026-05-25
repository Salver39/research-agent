import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Preparation Agent",
  description: "AI-система подготовки UX-исследований",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-gray-50">{children}</body>
    </html>
  );
}
