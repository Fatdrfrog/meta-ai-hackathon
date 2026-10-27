import { ChatIcon } from "../assets/icons";

interface WidgetBubbleProps {
  onClick: () => void;
  disabled?: boolean;
  isOpen?: boolean;
  bubbleMode?: "icon" | "text" | "svg";
  bubbleText?: string;
  bubbleSvgUrl?: string;
}

export const WidgetBubble = ({
  onClick,
  disabled = false,
  isOpen = false,
  bubbleMode = "icon",
  bubbleText,
  bubbleSvgUrl,
}: WidgetBubbleProps) => {
  const bubbleModeClass =
    bubbleMode === "text"
      ? "widget-bubble--text"
      : bubbleMode === "svg"
        ? "widget-bubble--svg"
        : "widget-bubble--icon";

  const renderBubbleContent = () => {
    if (bubbleMode === "svg" && bubbleSvgUrl) {
      return (
        <img
          src={bubbleSvgUrl}
          alt=""
          className="widget-bubble-image"
          loading="lazy"
          decoding="async"
        />
      );
    }

    if (bubbleMode === "text" && bubbleText) {
      return <span className="widget-bubble-text">{bubbleText}</span>;
    }

    return <ChatIcon />;
  };

  return (
    <button
      className={`widget-bubble ${bubbleModeClass} ${disabled ? "disabled" : ""} ${isOpen ? "is-open" : ""}`}
      onClick={onClick}
      type="button"
      aria-label={disabled ? "Loading chat..." : "Open chat"}
      disabled={disabled}
    >
      <div className="widget-bubble-icon">{renderBubbleContent()}</div>
    </button>
  );
};
