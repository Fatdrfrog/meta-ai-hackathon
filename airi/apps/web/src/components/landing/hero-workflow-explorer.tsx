"use client";

import {
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ArrowUpRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { HeroFeatureCardPreview } from "./hero-feature-card-previews";
import { HERO_WORKFLOWS, type HeroWorkflow } from "./hero-workflow-definitions";
import { landingDisplayFont } from "./landing-display-font";
import s from "./landing-workflow-studio.module.css";

export function HeroWorkflowExplorer({
  initialWorkflow,
}: {
  initialWorkflow: HeroWorkflow;
}) {
  const t = useTranslations("LandingDemo.featureCards");
  const dialogT = useTranslations("Dialog");
  const [selected, setSelected] = useState(initialWorkflow);
  const storyRef = useRef<HTMLElement>(null);
  const selectWorkflow = (workflow: HeroWorkflow) => {
    setSelected(workflow);
    if (storyRef.current) storyRef.current.scrollTop = 0;
  };
  return (
    <DialogContent
      className={cn(s.explorer, landingDisplayFont.variable)}
      data-landing-workflow-explorer
      showCloseButton={false}
    >
      <div className={s.explorerTopbar}>
        <DialogHeader className={s.explorerHeader}>
          <DialogTitle>{t("explorerTitle")}</DialogTitle>
          <DialogDescription>{t("explorerDescription")}</DialogDescription>
        </DialogHeader>
        <DialogClose className={s.explorerClose} aria-label={dialogT("close")}>
          <X size={20} aria-hidden />
        </DialogClose>
      </div>
      <div className={s.workflowChooser}>
        <NativeSelect
          aria-label={t("workflowLabel")}
          aria-controls="workflow-detail"
          value={selected.id}
          onChange={event => {
            const workflow = HERO_WORKFLOWS.find(
              item => item.id === event.target.value
            );
            if (workflow) selectWorkflow(workflow);
          }}
        >
          {HERO_WORKFLOWS.map(workflow => (
            <NativeSelectOption key={workflow.id} value={workflow.id}>
              {workflow.number} · {t(`cards.${workflow.id}.badge`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className={s.explorerLayout}>
        <nav className={s.workflowNav} aria-label={t("workflowLabel")}>
          {HERO_WORKFLOWS.map(workflow => (
            <button
              key={workflow.id}
              type="button"
              aria-pressed={selected.id === workflow.id}
              onClick={() => selectWorkflow(workflow)}
            >
              <span>{workflow.number}</span>
              <span>{t(`cards.${workflow.id}.badge`)}</span>
              <ArrowUpRight size={15} aria-hidden />
            </button>
          ))}
        </nav>
        <section
          id="workflow-detail"
          ref={storyRef}
          data-vaul-no-drag
          className={s.explorerStory}
          aria-labelledby="workflow-detail-title"
        >
          <div className={s.explorerCopy}>
            <p className={s.exampleLabel}>{t("example")}</p>
            <h3 id="workflow-detail-title">
              {t(`cards.${selected.id}.title`)}
            </h3>
            <p>{t(`cards.${selected.id}.detail`)}</p>
          </div>
          <div
            key={selected.id}
            className={s.explorerPreview}
            data-tone={selected.tone}
          >
            <HeroFeatureCardPreview kind={selected.preview} interactive />
          </div>
          <p className={s.exampleDisclaimer}>{t("reviewNote")}</p>
        </section>
      </div>
    </DialogContent>
  );
}
