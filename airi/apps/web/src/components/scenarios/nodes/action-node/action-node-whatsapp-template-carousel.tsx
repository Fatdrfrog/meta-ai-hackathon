"use client";

import { TemplateCarouselPreview } from "@/components/whatsapp-templates/template-carousel-preview";
import type { WhatsAppTemplateButtonBranchOption } from "@/lib/scenarios/whatsapp-template-button-branches";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  CarouselOptionHandleRail,
  useCarouselOptionHandleRail,
} from "../../builders/whatsapp/service-message/carousel-option-handle-rail-view";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import type { ActionNodeBranchState } from "./action-node-state";
import { prefixCardLabel } from "./action-node-utils";
import { WhatsAppTemplateButtonBranchHandle } from "./action-node-whatsapp-template-section-ui";

/** Before the first layout read, the first card shows its dots. */
const FIRST_CARD_IDS: readonly string[] = ["0"];

function cardButtonKey(cardIndex: number, buttonIndex: number): string {
  return `${cardIndex}:${buttonIndex}`;
}

/**
 * The template's carousel as the customer sees it. On the canvas, each
 * card's quick reply has its own route: every card in view shows its dots,
 * and connected routes of the cards scrolled away gather on the node's edge.
 */
export function ActionNodeWhatsAppTemplateCarousel({
  components,
  showPorts,
  savedBranchesById,
  connectedPayloads,
  createNodeFromSourceHandle,
  refreshNodeInternals,
  onViewportChange,
}: {
  components: WhatsAppComponent[];
  /** Route dots render on the canvas only. */
  showPorts: boolean;
  savedBranchesById: ActionNodeBranchState["savedTemplateButtonBranchesById"];
  connectedPayloads: ActionNodeBranchState["connectedTemplateButtonPayloads"];
  createNodeFromSourceHandle?: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  refreshNodeInternals?: () => void;
  onViewportChange?: () => void;
}) {
  const t = useTranslations("Scenarios");
  const cardBranches = useMemo(() => {
    const byButton = new Map<string, WhatsAppTemplateButtonBranchOption>();
    for (const branch of savedBranchesById.values()) {
      if (branch.cardIndex === undefined) continue;
      byButton.set(cardButtonKey(branch.cardIndex, branch.index), branch);
    }
    return byButton;
  }, [savedBranchesById]);
  const branchesByPayload = useMemo(
    () =>
      new Map(
        Array.from(cardBranches.values(), branch => [branch.payload, branch])
      ),
    [cardBranches]
  );
  const {
    wrapRef,
    activeCardIds: railActiveCardIds,
    hiddenConnectionClusters,
    handleViewportChange,
  } = useCarouselOptionHandleRail({
    enabled: showPorts,
    layoutKey: components,
    connectedOptionIds: connectedPayloads,
    onViewportChange,
  });
  const activeCardIds =
    railActiveCardIds.length > 0 ? railActiveCardIds : FIRST_CARD_IDS;

  const renderHandle = (branch: WhatsAppTemplateButtonBranchOption) => (
    <WhatsAppTemplateButtonBranchHandle
      buttonLabel={prefixCardLabel(branch.cardIndex, branch.label, t)}
      savedBranch={branch}
      connectedPayloads={connectedPayloads}
      createNodeFromSourceHandle={createNodeFromSourceHandle}
      refreshNodeInternals={refreshNodeInternals}
    />
  );

  return (
    <div ref={wrapRef} className="relative overflow-visible">
      <TemplateCarouselPreview
        components={components}
        onViewportChange={handleViewportChange}
        renderButtonRoute={
          showPorts
            ? ({ cardIndex, buttonIndex }) => {
                const branch = cardBranches.get(
                  cardButtonKey(cardIndex, buttonIndex)
                );
                if (!branch) return null;
                return {
                  optionId: branch.payload,
                  handle: activeCardIds.includes(String(cardIndex))
                    ? renderHandle(branch)
                    : null,
                };
              }
            : undefined
        }
      />
      {showPorts ? (
        <CarouselOptionHandleRail
          clusters={hiddenConnectionClusters}
          renderHandle={optionId => {
            const branch = branchesByPayload.get(optionId);
            return branch ? renderHandle(branch) : null;
          }}
        />
      ) : null}
    </div>
  );
}
