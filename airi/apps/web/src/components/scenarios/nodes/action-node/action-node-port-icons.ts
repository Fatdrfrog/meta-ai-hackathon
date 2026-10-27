import {
  ArrowRight,
  Brain,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardList,
  Clock,
  CreditCard,
  ListChecks,
  MessageSquareText,
  MousePointerClick,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import type { ActionNodePort } from "./action-node-ports";

/** The icon that leads a route row, by what the customer or step does. */
export function resolveActionNodePortIcon(port: ActionNodePort): LucideIcon {
  switch (port.kind) {
    case "branch":
      return port.optionKind === "option" ? ListChecks : MousePointerClick;
    case "form_submitted":
      // The icon of the template's form button.
      return ClipboardList;
    case "continue":
      return ArrowRight;
    case "any_reply":
      return MessageSquareText;
    case "no_reply":
      return Clock;
    case "answer":
      return port.answerMode === "intent" ? Brain : TextQuote;
    case "payment_detected":
      return CreditCard;
    case "success":
      return CircleCheck;
    case "failure":
      return CircleX;
    case "inputs_unmet":
      return CircleAlert;
  }
}
