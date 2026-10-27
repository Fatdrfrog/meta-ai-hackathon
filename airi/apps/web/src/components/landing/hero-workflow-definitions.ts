export type HeroCardPreviewKind =
  | "carousel"
  | "knowledge"
  | "reminders"
  | "smartChat"
  | "analytics"
  | "meta"
  | "ads"
  | "assets"
  | "voice";

export type HeroWorkflowId =
  | "interactive"
  | "followUp"
  | "knowledge"
  | "smartChat"
  | "analytics"
  | "ads"
  | "meta"
  | "assets"
  | "voice";

export type HeroWorkflow = {
  id: HeroWorkflowId;
  preview: HeroCardPreviewKind;
  number: string;
  tone: "linen" | "forest" | "paper" | "rose";
};

/** One story order for the columns, mobile reader and full workflow explorer. */
export const HERO_WORKFLOWS: readonly HeroWorkflow[] = [
  { id: "interactive", preview: "carousel", number: "01", tone: "linen" },
  { id: "analytics", preview: "analytics", number: "02", tone: "paper" },
  { id: "knowledge", preview: "knowledge", number: "03", tone: "paper" },
  { id: "smartChat", preview: "smartChat", number: "04", tone: "linen" },
  { id: "ads", preview: "ads", number: "05", tone: "paper" },
  { id: "followUp", preview: "reminders", number: "06", tone: "forest" },
  { id: "meta", preview: "meta", number: "07", tone: "rose" },
  { id: "assets", preview: "assets", number: "08", tone: "linen" },
  { id: "voice", preview: "voice", number: "09", tone: "forest" },
];

export const HERO_WORKFLOW_COLUMNS = [
  HERO_WORKFLOWS.filter((_, index) => index < 6 && index % 2 === 0),
  HERO_WORKFLOWS.filter((_, index) => index < 6 && index % 2 === 1),
] as const;
