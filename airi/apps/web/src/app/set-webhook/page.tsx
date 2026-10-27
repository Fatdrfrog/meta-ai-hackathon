"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

export default function SetWebhookPage() {
  const t = useTranslations("SetWebhookPage");

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen overflow-hidden bg-slate-950 p-6">
      {/* Decorative premium background elements */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse duration-[8000ms]"></div>
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse duration-[10000ms]"></div>

      <div className="relative w-full max-w-lg p-8 md:p-10 bg-slate-900/50 border border-slate-800/80 backdrop-blur-xl rounded-2xl shadow-2xl text-center">
        {/* Animated warning/transition icon */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 mb-6 animate-bounce duration-[3000ms]">
          <svg
            className="w-8 h-8"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        <h1 className="text-2xl md:text-3xl font-bold text-slate-100 tracking-tight mb-4">
          {t("title")}
        </h1>

        <p className="mb-8 text-base text-slate-400 leading-relaxed max-w-md mx-auto">
          {t("description")}
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Link
            href="/"
            className="w-full sm:w-auto px-8 py-3.5 font-semibold text-slate-950 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-350 hover:to-amber-450 rounded-xl shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20 active:scale-98 transition-all duration-200"
          >
            {t("setWebhook")}
          </Link>
        </div>
      </div>
    </div>
  );
}
