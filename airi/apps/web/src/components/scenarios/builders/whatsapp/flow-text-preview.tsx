import type { WhatsAppFlowTextType } from "@icecore/scenario-contracts";
import { cn } from "@/lib/utils";

const TEXT_CLASSES: Record<WhatsAppFlowTextType, string> = {
  TextHeading: "text-lg font-semibold leading-snug",
  TextSubheading: "text-base font-medium leading-snug",
  TextBody: "text-sm leading-relaxed",
  TextCaption: "text-xs leading-relaxed text-muted-foreground",
};

/** Literal screen content only; text blocks never create answer controls. */
export function FlowTextPreview({
  type,
  text,
  className,
}: {
  type: WhatsAppFlowTextType;
  text: string;
  className?: string;
}) {
  const Component =
    type === "TextHeading" ? "h4" : type === "TextSubheading" ? "h5" : "p";
  return (
    <Component
      className={cn(
        "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
        TEXT_CLASSES[type],
        className
      )}
    >
      {text}
    </Component>
  );
}
