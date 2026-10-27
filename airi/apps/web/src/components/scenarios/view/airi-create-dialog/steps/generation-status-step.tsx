"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { SourceMentionText } from "../shared";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type GenerationStatusStepWizardKey =
  | "submittedPrompt"
  | "isInitialDraftHandoff"
  | "generatorStatus"
  | "answers"
  | "followUpQuestions"
  | "followUpDrafts"
  | "setFollowUpDrafts"
  | "handleAddAnswers";

export function AiriCreateDialogGenerationStatusStep({
  wizard,
}: AiriCreateDialogStepProps<GenerationStatusStepWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const {
    submittedPrompt,
    isInitialDraftHandoff,
    generatorStatus,
    answers,
    followUpQuestions,
    followUpDrafts,
    setFollowUpDrafts,
    handleAddAnswers,
  } = wizard;

  return (
    <>
      {submittedPrompt && !isInitialDraftHandoff ? (
        <Message from="user">
          <MessageContent className="whitespace-pre-wrap">
            <SourceMentionText text={submittedPrompt} context="message" />
          </MessageContent>
        </Message>
      ) : null}

      {generatorStatus === "planning" && !isInitialDraftHandoff ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="max-w-[92%]">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span>{t("generation.planningTitle")}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {isInitialDraftHandoff
                  ? t("generation.planningHandoff")
                  : t("generation.planningChecking")}
              </div>
            </div>
          </MessageContent>
        </Message>
      ) : null}

      {generatorStatus === "media_queued" ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="max-w-[92%]">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span>{t("generation.generatingMedia")}</span>
            </div>
          </MessageContent>
        </Message>
      ) : null}

      {answers.length > 0 ? (
        <Message from="user">
          <MessageContent className="max-w-[88%]">
            <div className="space-y-2">
              {answers.map((item, index) => (
                <div key={`${item.question}-${index}`}>
                  <div className="text-xs opacity-80">{item.question}</div>
                  <div>{item.answer}</div>
                </div>
              ))}
            </div>
          </MessageContent>
        </Message>
      ) : null}

      {followUpQuestions.length > 0 ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="max-w-[92%] border border-amber-200 bg-amber-50/70 text-foreground dark:border-amber-900/50 dark:bg-amber-950/30">
            <div className="space-y-3">
              <div className="font-semibold">{t("generation.moreContext")}</div>
              {followUpQuestions.map(item => (
                <div key={item.question} className="space-y-1.5">
                  <Label className="text-xs font-medium">{item.question}</Label>
                  {item.context ? (
                    <div className="text-xs text-muted-foreground">
                      {item.context}
                    </div>
                  ) : null}
                  <Textarea
                    value={followUpDrafts[item.question] || ""}
                    onChange={event =>
                      setFollowUpDrafts(current => ({
                        ...current,
                        [item.question]: event.target.value,
                      }))
                    }
                    rows={2}
                    className="bg-background"
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddAnswers}
              >
                {t("generation.addAnswers")}
              </Button>
            </div>
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
}
