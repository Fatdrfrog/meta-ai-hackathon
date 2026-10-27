import {
  ChevronRightIcon,
  SearchIcon,
  SendTriangleIcon,
} from "../assets/icons";

const DEFAULT_QUICK_REPLIES = [
  "How can I get support?",
  "What are your business hours?",
  "How do I track my order?",
  "Do you offer refunds?",
];

interface WidgetWelcomeProps {
  heroTitle?: string;
  welcomeMessage?: string;
  ctaPrimaryText?: string;
  ctaSecondaryText?: string;
  variant?: "intercom" | "simple";
  onOpenMessages?: () => void;
  onSuggestionSelect?: (text: string) => void;
  onSearchClick?: () => void;
  quickReplies?: string[];
}

export const WidgetWelcome = ({
  heroTitle,
  welcomeMessage = "How can we help you today?",
  ctaPrimaryText = "Send us a message",
  ctaSecondaryText = "We typically reply in a few minutes",
  variant = "intercom",
  onOpenMessages,
  onSuggestionSelect,
  onSearchClick,
  quickReplies = DEFAULT_QUICK_REPLIES,
}: WidgetWelcomeProps) => {
  if (variant === "simple") {
    return (
      <div className="widget-welcome widget-welcome--simple">
        <div className="widget-welcome-hero">
          {heroTitle ? (
            <>
              <h2 className="widget-welcome-hero-title">{heroTitle}</h2>
              <p className="widget-welcome-hero-text">{welcomeMessage}</p>
            </>
          ) : (
            <p className="widget-welcome-hero-text widget-welcome-hero-text--solo">
              {welcomeMessage}
            </p>
          )}
        </div>
        <button
          type="button"
          className="widget-welcome-card widget-welcome-card--action"
          onClick={onOpenMessages}
        >
          <div className="widget-welcome-card-content">
            <span className="widget-welcome-card-title">{ctaPrimaryText}</span>
            <span className="widget-welcome-card-subtitle">
              {ctaSecondaryText}
            </span>
          </div>
          <span className="widget-welcome-card-send-icon" aria-hidden="true">
            <SendTriangleIcon />
          </span>
        </button>
      </div>
    );
  }

  const hasQuickReplies = quickReplies.length > 0;

  return (
    <div className="widget-welcome widget-welcome--intercom">
      <div className="widget-welcome-hero">
        {heroTitle ? (
          <>
            <h2 className="widget-welcome-hero-title">{heroTitle}</h2>
            <p className="widget-welcome-hero-text">{welcomeMessage}</p>
          </>
        ) : (
          <p className="widget-welcome-hero-text widget-welcome-hero-text--solo">
            {welcomeMessage}
          </p>
        )}
      </div>

      <button
        type="button"
        className="widget-welcome-card widget-welcome-card--action"
        onClick={onOpenMessages}
      >
        <div className="widget-welcome-card-content">
          <span className="widget-welcome-card-title">{ctaPrimaryText}</span>
          <span className="widget-welcome-card-subtitle">
            {ctaSecondaryText}
          </span>
        </div>
        <span className="widget-welcome-card-send-icon" aria-hidden="true">
          <SendTriangleIcon />
        </span>
      </button>

      {hasQuickReplies && (
        <div className="widget-welcome-card widget-welcome-card--questions">
          <button
            type="button"
            className="widget-welcome-search-header"
            onClick={() => onSearchClick?.()}
          >
            <span className="widget-welcome-search-header-text">
              Search for help
            </span>
            <span
              className="widget-welcome-search-header-icon"
              aria-hidden="true"
            >
              <SearchIcon />
            </span>
          </button>
          <div className="widget-welcome-chips">
            {quickReplies.map((question, idx) => (
              <button
                key={`${question}-${idx}`}
                type="button"
                className="widget-welcome-chip-row"
                onClick={() => onSuggestionSelect?.(question)}
              >
                <span className="widget-welcome-chip-text">{question}</span>
                <span className="widget-welcome-chip-arrow" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
