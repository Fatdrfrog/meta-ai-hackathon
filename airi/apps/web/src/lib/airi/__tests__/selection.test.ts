import { evaluateActiveSelectionReplyConsistency } from "@/lib/airi/reply/generation/selection-reply-consistency";
import {
  applyAiriSelectionTransition,
  buildGroundedReplyOptionPayload,
} from "@/lib/airi/reply/selection";

describe("pinned selection (memory + reply consistency)", () => {
  it("keeps the current pin when turn understanding emits keep_existing", () => {
    const selection = applyAiriSelectionTransition({
      transition: { action: "keep_existing" },
      existingSelection: {
        kind: "offer",
        label: "QazInnovation guide",
        normalizedLabel: "qazinnovation guide",
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      },
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        intentAnchor: "QazInnovation guide",
      },
      messages: [
        {
          id: "1",
          direction: "outbound",
          text: "The QazInnovation guide costs 7000 KZT. Do you want it?",
        },
        {
          id: "2",
          direction: "inbound",
          text: "Let's proceed",
        },
      ],
    });

    expect(selection).toEqual(
      expect.objectContaining({
        label: "QazInnovation guide",
        sourceIds: ["kb-guide"],
      })
    );
  });

  it("clears the previous pin when turn understanding emits switch_selection but there is no fresh grounded replacement yet", () => {
    const selection = applyAiriSelectionTransition({
      transition: {
        action: "switch_selection",
        selectionLabel: "other package",
      },
      existingSelection: {
        kind: "offer",
        label: "QazInnovation guide",
        normalizedLabel: "qazinnovation guide",
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      },
      lastGrounding: {
        sourceKind: "none",
        sourceIds: [],
        intentAnchor: null,
      },
      messages: [
        {
          id: "1",
          direction: "outbound",
          text: "The QazInnovation guide costs 7000 KZT. Do you want it?",
        },
        {
          id: "2",
          direction: "inbound",
          text: "No, I want the other package instead",
        },
      ],
    });

    expect(selection).toBeNull();
  });

  it("persists a selected option emitted by turn understanding", () => {
    const selection = applyAiriSelectionTransition({
      transition: { action: "select_offer", selectionLabel: "БесТірек" },
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-options", "doc-options"],
        intentAnchor: "available programs",
      },
      messages: [
        {
          id: "1",
          direction: "outbound",
          text: [
            "Есть варианты:",
            "1. **QazInnovation Grant** — грант для инноваций.",
            "2. **БесТірек** — программа поддержки бизнеса.",
          ].join("\n"),
        },
        {
          id: "2",
          direction: "inbound",
          text: "А вторая какая?",
        },
      ],
    });

    expect(selection).toEqual(
      expect.objectContaining({
        label: "БесТірек",
        sourceIds: ["kb-options", "doc-options"],
      })
    );
  });

  it("persists a yes confirmation after a single grounded offer question", () => {
    const selection = applyAiriSelectionTransition({
      transition: { action: "select_offer", selectionLabel: "БесТірек" },
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-bestirek", "doc-bestirek"],
        intentAnchor: "БесТірек",
      },
      messages: [
        {
          id: "1",
          direction: "outbound",
          text: "Подскажите, вас интересует именно грант «БесТірек» для обучения в AlmaU?",
        },
        {
          id: "2",
          direction: "inbound",
          text: "Да",
        },
      ],
    });

    expect(selection).toEqual(
      expect.objectContaining({
        label: "БесТірек",
        sourceIds: ["kb-bestirek", "doc-bestirek"],
      })
    );
  });

  it("locks to the explicit grounded option payload instead of reusing broad last-grounding ids", () => {
    const selection = applyAiriSelectionTransition({
      transition: { action: "none" },
      existingSelection: {
        kind: "offer",
        label: "Old package",
        normalizedLabel: "old package",
        sourceKind: "kb",
        sourceIds: ["kb-old-package"],
        quotedPriceText: "10000 KZT",
        quotedPriceAmount: 10000,
        quotedPriceCurrency: "KZT",
      },
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-broad-overview", "doc-broad-overview"],
        intentAnchor: "available programs",
      },
      quickReplyPayload: buildGroundedReplyOptionPayload({
        id: "kb-qazinnovation-guide",
        label: "QazInnovation guide",
        selectionKind: "offer",
        sourceKind: "kb",
        sourceIds: ["kb-qazinnovation-guide", "doc-qazinnovation-guide"],
        sourceRecordId: "kb-qazinnovation-guide",
        sourceDocumentId: "doc-qazinnovation-guide",
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      }),
      messages: [
        {
          id: "1",
          direction: "outbound",
          text: "Choose an option",
        },
        {
          id: "2",
          direction: "inbound",
          text: "QazInnovation guide",
        },
      ],
    });

    expect(selection).toEqual(
      expect.objectContaining({
        label: "QazInnovation guide",
        sourceIds: ["kb-qazinnovation-guide", "doc-qazinnovation-guide"],
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      })
    );
  });

  it("flags replies that drift to a different selected offer label even when the price is absent", () => {
    const consistency = evaluateActiveSelectionReplyConsistency({
      reply: "The Winner package includes a full submission service.",
      selection: {
        kind: "offer",
        label: "QazInnovation guide",
        normalizedLabel: "qazinnovation guide",
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      },
    });

    expect(consistency.isConsistent).toBe(false);
    expect(consistency.repairInstruction).toContain(
      "SELECTION CONSISTENCY REPAIR:"
    );
  });
});
