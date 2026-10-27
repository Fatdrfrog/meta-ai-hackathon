"use client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

export function ArticleInteractions(props: {
  articleId: string;
  companySlug?: string;
}) {
  const { articleId } = props;
  const [sending, setSending] = useState(false);
  const [voteSent, setVoteSent] = useState<null | 1 | -1>(null);
  const viewSentRef = useRef(false);
  const t = useTranslations("KnowledgeBase.feedback");

  useEffect(() => {
    viewSentRef.current = false;
  }, [articleId]);

  useEffect(() => {
    if (viewSentRef.current) return;

    const controller = new AbortController();
    viewSentRef.current = true;

    const viewsUrl = `/api/kb/${articleId}/views`;

    fetch(viewsUrl, {
      method: "POST",
      signal: controller.signal,
    }).catch(() => {
      viewSentRef.current = false;
    });

    return () => {
      controller.abort();
    };
  }, [articleId]);

  async function sendFeedback(vote: 1 | -1) {
    if (sending || voteSent) return;
    setSending(true);
    try {
      const feedbackUrl = `/api/kb/${articleId}/feedback`;

      await fetch(feedbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article_id: articleId, vote }),
      });
      setVoteSent(vote);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="mt-8 flex items-center gap-3"
      role="group"
      aria-label="Article feedback"
    >
      <span className="text-sm text-muted-foreground">{t("wasHelpful")}</span>
      <button
        onClick={() => sendFeedback(1)}
        disabled={sending || voteSent !== null}
        className="px-3 py-1 border rounded hover:bg-accent disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        aria-label={t("yes")}
      >
        {t("yes")}
      </button>
      <button
        onClick={() => sendFeedback(-1)}
        disabled={sending || voteSent !== null}
        className="px-3 py-1 border rounded hover:bg-accent disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        aria-label={t("no")}
      >
        {t("no")}
      </button>
      {voteSent !== null ? (
        <span
          className="text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {t("thanks")}
        </span>
      ) : null}
    </div>
  );
}
