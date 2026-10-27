"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { demoRequestEmailSchema } from "@/lib/landing/demo-request";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

type SubmitState = "idle" | "loading" | "success" | "error";

const HERO_INPUT_CLASS =
  "h-12 min-h-12 min-w-0 sm:flex-1 rounded-xl border border-[#0f100e]/20 bg-[#fbfbf9] px-4 text-sm font-normal text-[#0f100e] shadow-none placeholder:text-[#5d5f58] focus-visible:border-[#d6003a] focus-visible:ring-[#d6003a]/30";

const HERO_BUTTON_CLASS =
  "h-12 shrink-0 rounded-xl border border-[#0f100e]/20 bg-transparent px-4 text-sm font-medium text-[#0f100e] shadow-none hover:bg-[#e8e8e2] hover:text-[#0f100e] disabled:opacity-60";

export function HeroDemoCta({
  focusOnMount = false,
}: {
  focusOnMount?: boolean;
}) {
  const t = useTranslations("LandingDemo.hero");
  const emailRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (focusOnMount) emailRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state === "loading") return;

    const website = String(
      new FormData(e.currentTarget).get("website") ?? ""
    ).slice(0, 200);

    const parsed = demoRequestEmailSchema.safeParse(email);
    if (!parsed.success) {
      setValidationError(t("invalidEmail"));
      setState("idle");
      emailRef.current?.focus();
      return;
    }

    setValidationError(null);
    setState("loading");

    try {
      const res = await fetch("/api/landing/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: parsed.data, website }),
      });

      if (!res.ok) throw new Error("Request failed");
      setState("success");
    } catch {
      setState("error");
    }
  };

  if (state === "success") {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-xl border border-[#0a7d1c]/25 bg-[#d9fdd3] px-4 py-3 text-sm font-medium text-[#0f100e]"
      >
        <Check className="size-5 text-[#0a7d1c]" />
        <span>{t("demoSuccess")}</span>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="relative w-full max-w-xl space-y-2 pt-2"
    >
      <div
        inert
        aria-hidden="true"
        className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden opacity-0"
      >
        <input
          type="text"
          name="website"
          autoComplete="off"
          tabIndex={-1}
          defaultValue=""
        />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          ref={emailRef}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={e => {
            setEmail(e.target.value);
            if (validationError) setValidationError(null);
            if (state === "error") setState("idle");
          }}
          placeholder={t("workEmail")}
          aria-label={t("workEmail")}
          aria-invalid={Boolean(validationError)}
          aria-describedby={
            validationError || state === "error" ? errorId : undefined
          }
          className={HERO_INPUT_CLASS}
        />
        <Button
          type="submit"
          size="lg"
          variant="secondary"
          disabled={state === "loading"}
          aria-label={t("bookDemo")}
          aria-busy={state === "loading"}
          className={HERO_BUTTON_CLASS}
        >
          {state === "loading" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <>
              {t("bookDemo")}
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </div>
      <p
        id={errorId}
        role="alert"
        aria-atomic="true"
        className="text-sm font-semibold text-red-600 empty:hidden"
      >
        {validationError ?? (state === "error" ? t("demoError") : null)}
      </p>
    </form>
  );
}
