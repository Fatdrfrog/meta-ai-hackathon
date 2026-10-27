import type { GenerativeAIInputKind } from "@icecore/scenario-contracts";

export type { GenerativeAIInputKind };

export type GenerativeAIInboundCandidate = {
  messageId: string;
  kind: string | null;
  textOrCaption: string | null;
  whatsappMediaId: string | null;
  declaredMimeType: string | null;
  fileName: string | null;
  /**
   * Set only when this message completed a prompt-input collector: the words
   * that collector read (text or caption, then audio and video analysis). A
   * text-mode action it resumes accepts them even from a voice note, video or
   * captioned image.
   */
  promptInputAnswerText?: string | null;
};

export type GenerativeAIInboundDescriptor = {
  messageId: string;
  kind: GenerativeAIInputKind;
  textOrCaption: string | null;
  whatsappMediaId: string | null;
  declaredMimeType: string | null;
  fileName: string | null;
};

export type GenerativeAIInboundClassification =
  | { status: "compatible"; input: GenerativeAIInboundDescriptor }
  | { status: "wrong_type"; expectedInputKind: GenerativeAIInputKind }
  | { status: "missing_owned_media"; expectedInputKind: "image" };

export type GenerativeAIInboundDisposition =
  | GenerativeAIInboundClassification
  | {
      status: "waiting_for_compatible_input";
      expectedInputKind: GenerativeAIInputKind;
    };
