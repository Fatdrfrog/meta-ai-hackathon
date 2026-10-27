"use client";

import { Button } from "@/components/ui/button";
import { publicTemplateReadinessSchema } from "@/lib/landing/template-request";
import { ArrowUpRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { TemplateRequestDialog } from "./template-request-dialog";

export function LandingTemplateCta({ templateId }: { templateId: string }) {
  const t = useTranslations("LandingDemo.templates");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [readiness, setReadiness] = useState<
    "loading" | "ready" | "unavailable" | "error"
  >("loading");

  async function openRequest() {
    setOpen(true);
    setReadiness("loading");
    try {
      const response = await fetch(
        `/api/landing/template-request?locale=${encodeURIComponent(locale)}`
      );
      if (!response.ok) throw new Error("Readiness unavailable");
      const result = publicTemplateReadinessSchema.parse(await response.json());
      setReadiness(
        result.readyTemplateIds.includes(templateId)
          ? "ready"
          : result.unavailableTemplateIds.includes(templateId)
            ? "error"
            : "unavailable"
      );
    } catch {
      setReadiness("error");
    }
  }

  return (
    <div className="mt-5">
      <Button
        ref={openerRef}
        type="button"
        variant="outline"
        size="sm"
        data-template-id={templateId}
        onClick={openRequest}
        className="h-auto min-h-10 max-w-full whitespace-normal text-left"
      >
        {t("landingCta")}
        <ArrowUpRight className="size-4 shrink-0" aria-hidden />
      </Button>
      {open && (
        <TemplateRequestDialog
          templateId={open ? templateId : null}
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => openerRef.current?.focus());
          }}
          source="landing"
          ready={readiness === "ready"}
          readinessLoading={readiness === "loading"}
          readinessUnavailable={readiness === "error"}
        />
      )}
    </div>
  );
}
