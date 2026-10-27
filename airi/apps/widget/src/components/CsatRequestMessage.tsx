import { useState } from "preact/hooks";

interface CsatRequestMessageProps {
  conversationId: string;
  apiUrl: string;
  clientKey: string;
}

const EMOJI_FACES = ["😠", "😟", "😐", "🙂", "😊"];
const EMOJI_LABELS = ["Terrible", "Bad", "Okay", "Good", "Excellent"];

export const CsatRequestMessage = ({
  conversationId,
  apiUrl,
  clientKey,
}: CsatRequestMessageProps) => {
  const [selectedScore, setSelectedScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (selectedScore === null || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        `${apiUrl}/conversations/${conversationId}/csat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({
            score: selectedScore,
            comment: comment.trim() || undefined,
            client_key: clientKey,
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit rating");
      }

      setIsSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to submit. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Thank-you state after submission
  if (isSubmitted) {
    return (
      <div className="message message-agent message-fade-in">
        <div className="csat-container csat-submitted">
          <div className="csat-thankyou-emoji">🎉</div>
          <div className="csat-thankyou-text">Thank you for your feedback!</div>
        </div>
      </div>
    );
  }

  return (
    <div className="message message-agent message-fade-in">
      <div className="csat-container">
        <div className="csat-title">How was your experience?</div>

        <div className="csat-emoji-row">
          {EMOJI_FACES.map((emoji, index) => {
            const score = index + 1;
            const isSelected = selectedScore === score;
            return (
              <button
                key={score}
                type="button"
                className={`csat-emoji-btn ${isSelected ? "csat-emoji-selected" : ""}`}
                onClick={() => setSelectedScore(score)}
                aria-label={`Rate ${score} - ${EMOJI_LABELS[index]}`}
                title={EMOJI_LABELS[index]}
              >
                <span className="csat-emoji">{emoji}</span>
                <span className="csat-emoji-label">{EMOJI_LABELS[index]}</span>
              </button>
            );
          })}
        </div>

        {selectedScore !== null && (
          <div className="csat-feedback-area">
            <textarea
              className="csat-textarea"
              placeholder="Tell us more (optional)..."
              value={comment}
              onInput={(e) =>
                setComment((e.target as HTMLTextAreaElement).value)
              }
              rows={3}
              maxLength={2000}
            />
            <button
              type="button"
              className="csat-submit-btn"
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        )}

        {error && <div className="csat-error">{error}</div>}
      </div>
    </div>
  );
};
