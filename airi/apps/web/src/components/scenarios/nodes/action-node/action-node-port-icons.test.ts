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
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import type { ActionNodePort } from "./action-node-ports";

function port(fields: Partial<ActionNodePort>): ActionNodePort {
  return {
    handleId: "handle",
    kind: "continue",
    label: "Then",
    connected: false,
    ...fields,
  };
}

describe("resolveActionNodePortIcon", () => {
  it.each<[string, Partial<ActionNodePort>, LucideIcon]>([
    [
      "a tapped button",
      { kind: "branch", optionKind: "button" },
      MousePointerClick,
    ],
    ["a picked option", { kind: "branch", optionKind: "option" }, ListChecks],
    ["a branch of unknown kind", { kind: "branch" }, MousePointerClick],
    ["a submitted form", { kind: "form_submitted" }, ClipboardList],
    ["the continue route", { kind: "continue" }, ArrowRight],
    ["any reply", { kind: "any_reply" }, MessageSquareText],
    ["no reply", { kind: "no_reply", detail: "30 min" }, Clock],
    ["a words answer", { kind: "answer", answerMode: "exact" }, TextQuote],
    ["a meaning answer", { kind: "answer", answerMode: "intent" }, Brain],
    ["an answer of unknown mode", { kind: "answer" }, TextQuote],
    ["a confirmed payment", { kind: "payment_detected" }, CreditCard],
    ["an AI result", { kind: "success" }, CircleCheck],
    ["an AI failure", { kind: "failure" }, CircleX],
    ["missing details", { kind: "inputs_unmet" }, CircleAlert],
  ])("uses the right icon for %s", (_name, fields, icon) => {
    expect(resolveActionNodePortIcon(port(fields))).toBe(icon);
  });
});
