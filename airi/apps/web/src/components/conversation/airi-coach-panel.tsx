import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CoachingPayload } from "@/hooks/use-coach-typing";
import { airiTypingAtom } from "@/components/conversation/airi-coach-state";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronUp, Loader2, PanelRightClose } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

type AiriCoachPanelProps = {
  coachTips: CoachingPayload | null;
  showTypingIndicator: boolean;
  onApplySuggestedEdit: (
    text: string,
    suggestionId?: string
  ) => Promise<void> | void;
  onDismiss: (suggestionId?: string) => Promise<void> | void;
  onFeedback?: (
    feedback: "helpful" | "not_helpful",
    suggestionId: string
  ) => Promise<void> | void;
  onClose: () => void;
};

/** The coach dock beside the chat: tips, sources and the suggested reply. */
export function AiriCoachPanel({
  coachTips,
  showTypingIndicator,
  onApplySuggestedEdit,
  onDismiss,
  onFeedback,
  onClose,
}: AiriCoachPanelProps) {
  const t = useTranslations("ConversationDetailView");
  const tCoach = useTranslations("AiriCoachPanel");
  const airiIsTyping = useAtomValue(airiTypingAtom);
  const [isApplying, setIsApplying] = useState(false);
  const [hasBeenApplied, setHasBeenApplied] = useState(false);
  const [expandedTip, setExpandedTip] = useState<number | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const suggestionId = coachTips?.suggestionId ?? "";
  const [previousSuggestionId, setPreviousSuggestionId] =
    useState(suggestionId);
  const isBusy = showTypingIndicator || airiIsTyping;

  if (suggestionId && suggestionId !== previousSuggestionId) {
    setHasBeenApplied(false);
    setFeedbackGiven(false);
    setExpandedTip(null);
    setPreviousSuggestionId(suggestionId);
  }

  const sources = coachTips?.sources;
  const hasSources =
    !!sources?.snippet ||
    (sources?.kbArticles?.length || 0) > 0 ||
    (sources?.quickReplies?.length || 0) > 0;

  const renderLoadingState = () => (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{t("airiTyping")}</span>
    </div>
  );

  const renderEmptyState = () => (
    <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-6 text-center">
      <p className="text-sm font-medium">{t("airiSuggestion")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("noData")}</p>
    </div>
  );

  const renderTips = () => {
    if (!coachTips) {
      return isBusy ? renderLoadingState() : renderEmptyState();
    }

    return (
      <>
        {isBusy ? <div className="mb-3">{renderLoadingState()}</div> : null}
        <div
          className={cn(
            "mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground",
            isBusy && "opacity-60"
          )}
        >
          <span>{t("airiSuggestion")}</span>
          {coachTips.languages &&
            coachTips.languages.manager !== coachTips.languages.customer && (
              <Badge
                variant="outline"
                className="h-5 border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] dark:border-amber-800 dark:bg-amber-950"
                title={`Tips are in ${coachTips.languages.manager.toUpperCase()} for you to read. The Apply button will insert the reply in ${coachTips.languages.customer.toUpperCase()} for the customer.`}
              >
                Tips: {coachTips.languages.manager.toUpperCase()} - Reply:{" "}
                {coachTips.languages.customer.toUpperCase()}
              </Badge>
            )}
          {process.env.NODE_ENV === "development" &&
            coachTips.conversationContext && (
              <Badge variant="outline" className="h-4 px-1 py-0 text-[9px]">
                {coachTips.conversationContext.stage}:
                {coachTips.conversationContext.priority}
              </Badge>
            )}
          {process.env.NODE_ENV === "development" && coachTips.agentProfile && (
            <Badge variant="outline" className="h-4 px-1 py-0 text-[8px]">
              {coachTips.agentProfile.skillLevel}
            </Badge>
          )}
          {coachTips.risk && coachTips.risk.maxSeverity > 0 && (
            <>
              <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                Risk {coachTips.risk.maxSeverity}
              </Badge>
              {Array.isArray(coachTips.risk.categories) &&
                coachTips.risk.categories.length > 0 && (
                  <div className="flex items-center gap-1">
                    {coachTips.risk.categories.slice(0, 2).map((cat, i) => (
                      <Badge
                        key={`${cat}-${i}`}
                        variant="outline"
                        className="h-4 px-1 py-0 text-[10px]"
                      >
                        {cat}
                      </Badge>
                    ))}
                    {coachTips.risk.categories.length > 2 && (
                      <Badge
                        variant="outline"
                        className="h-4 px-1 py-0 text-[10px]"
                      >
                        +{coachTips.risk.categories.length - 2}
                      </Badge>
                    )}
                  </div>
                )}
            </>
          )}
        </div>

        <ul
          className={cn(
            "space-y-2",
            isBusy && "pointer-events-none opacity-60"
          )}
        >
          {coachTips.tips.map((tip, i) => (
            <li
              key={`${tip.title}-${i}`}
              className="rounded-md border bg-background/50 p-2 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{tip.title}:</span>
                    {tip.confidence !== undefined && tip.confidence > 0 && (
                      <Badge
                        variant="outline"
                        className="h-4 px-1 py-0 text-[10px]"
                      >
                        {Math.round(tip.confidence * 100)}%
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">{tip.suggestion}</p>
                </div>
                {tip.reasoning && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 flex-shrink-0"
                    onClick={() => setExpandedTip(expandedTip === i ? null : i)}
                  >
                    {expandedTip === i ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </Button>
                )}
              </div>

              {expandedTip === i && tip.reasoning && (
                <div className="mt-2 rounded border border-muted bg-muted/50 p-2 text-xs text-muted-foreground">
                  <strong>{tCoach("whyMatters")}</strong> {tip.reasoning}
                </div>
              )}
            </li>
          ))}
        </ul>

        {hasSources && (
          <div className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
            <div className="mb-1 text-[11px] font-medium">
              {tCoach("sourcesUsed")}
            </div>
            <div className="space-y-1">
              {sources?.snippet && (
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 px-1 py-0 text-[9px]">
                    Q/A
                  </Badge>
                  <span className="truncate">{sources.snippet.question}</span>
                  {sources.snippet.score !== undefined && (
                    <Badge
                      variant="outline"
                      className="h-4 px-1 py-0 text-[9px]"
                    >
                      {Math.round(sources.snippet.score * 100)}%
                    </Badge>
                  )}
                </div>
              )}
              {sources?.kbArticles && sources.kbArticles.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 px-1 py-0 text-[9px]">
                    KB
                  </Badge>
                  {sources.kbArticles.slice(0, 2).map(article => (
                    <span key={article.id} className="truncate">
                      {article.title}
                      {article.similarity !== undefined
                        ? ` (${Math.round(article.similarity * 100)}%)`
                        : ""}
                    </span>
                  ))}
                </div>
              )}
              {sources?.quickReplies && sources.quickReplies.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 px-1 py-0 text-[9px]">
                    Quick replies
                  </Badge>
                  {sources.quickReplies.slice(0, 3).map((reply, idx) => (
                    <span key={`${reply.text}-${idx}`} className="truncate">
                      {reply.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className={cn(
            "mt-3 flex flex-wrap gap-2",
            isBusy && "pointer-events-none opacity-60"
          )}
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={hasBeenApplied || isBusy}
            onClick={() => {
              onClose();
              onDismiss(coachTips.suggestionId);
            }}
          >
            {t("dismiss")}
          </Button>

          {coachTips.suggestedEdit && (
            <Button
              size="sm"
              disabled={isApplying || hasBeenApplied || isBusy}
              onClick={async () => {
                setIsApplying(true);
                try {
                  const textToApply =
                    coachTips.suggestedEditInCustomerLanguage ||
                    coachTips.suggestedEdit ||
                    "";
                  await onApplySuggestedEdit(
                    textToApply,
                    coachTips.suggestionId
                  );
                  setHasBeenApplied(true);
                } catch {
                } finally {
                  setIsApplying(false);
                }
              }}
            >
              {isApplying ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {t("applying")}
                </>
              ) : hasBeenApplied ? (
                t("applied")
              ) : (
                t("applySuggestion")
              )}
            </Button>
          )}
        </div>

        {onFeedback && !feedbackGiven && (
          <div
            className={cn(
              "mt-3 flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground",
              isBusy && "pointer-events-none opacity-60"
            )}
          >
            <span>{tCoach("wasHelpful")}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={async () => {
                setFeedbackGiven(true);
                await onFeedback("helpful", coachTips.suggestionId);
              }}
              className="h-6 px-2 hover:bg-green-50 dark:hover:bg-green-950"
            >
              {tCoach("yes")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={async () => {
                setFeedbackGiven(true);
                await onFeedback("not_helpful", coachTips.suggestionId);
              }}
              className="h-6 px-2 hover:bg-red-50 dark:hover:bg-red-950"
            >
              {tCoach("no")}
            </Button>
          </div>
        )}

        {feedbackGiven && (
          <div className="mt-2 text-center text-xs text-muted-foreground">
            {t("feedbackThanks")}
          </div>
        )}
      </>
    );
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">Airi {t("coach")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {isBusy ? t("airiTyping") : t("airiSuggestion")}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 rounded-full"
          aria-label="Close coach panel"
          onClick={onClose}
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{renderTips()}</div>
    </section>
  );
}
