/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import { act, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

jest.mock("@xyflow/react", () => ({
  Handle: ({ id }: { id: string }) => (
    <span data-testid="route-anchor" data-handle-id={id} />
  ),
  MarkerType: { ArrowClosed: "ArrowClosed" },
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));
jest.mock("./action-node-whatsapp-service-message-section", () => ({
  ActionNodeWhatsAppServiceMessageSection: () => <p>service-message editor</p>,
}));
jest.mock("./action-node-whatsapp-template-section", () => ({
  ActionNodeWhatsAppTemplateSection: () => <p>template editor</p>,
}));

import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import {
  resolveActionNodeBranchState,
  resolveActionNodeModeState,
} from "./action-node-state";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import {
  LazyActionNodeWhatsAppServiceMessageSection,
  LazyActionNodeWhatsAppTemplateSection,
  LazyTelegramReplyBuilder,
} from "./lazy-action-node-sections";
import { listLazySectionRouteHandles } from "./lazy-section-route-handles";

type AnchorProps = {
  routeAnchorHandleIds?: readonly string[];
  onRouteAnchorsRemoved?: () => void;
};
const ServiceMessageSection =
  LazyActionNodeWhatsAppServiceMessageSection as unknown as ComponentType<AnchorProps>;
const TelegramBuilder =
  LazyTelegramReplyBuilder as unknown as ComponentType<AnchorProps>;
const TemplateSection =
  LazyActionNodeWhatsAppTemplateSection as unknown as ComponentType<
    AnchorProps & { loadingLabel: string }
  >;

const anchorIds = () =>
  screen
    .queryAllByTestId("route-anchor")
    .map(anchor => anchor.getAttribute("data-handle-id"));

describe("lazy action node section route anchors", () => {
  it("anchors the section's linked routes until it loads, then asks for a measurement", async () => {
    const choice = buildWhatsAppSessionChoiceSourceHandleId("yes");
    const onRouteAnchorsRemoved = jest.fn();
    render(
      <ServiceMessageSection
        routeAnchorHandleIds={[choice]}
        onRouteAnchorsRemoved={onRouteAnchorsRemoved}
      />
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(anchorIds()).toEqual([choice]);
    expect(onRouteAnchorsRemoved).not.toHaveBeenCalled();

    await act(() => scenarioEditorChunks.whatsAppServiceMessageSection.load());
    expect(screen.getByText("service-message editor")).toBeInTheDocument();
    expect(anchorIds()).toEqual([]);
    expect(onRouteAnchorsRemoved).toHaveBeenCalledTimes(1);
  });

  it("draws no anchor outside the canvas", async () => {
    render(<TelegramBuilder />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(anchorIds()).toEqual([]);
    await act(() => scenarioEditorChunks.telegramReplyBuilder.load());
  });

  it("assigns each linked route to the section that draws its dot", () => {
    const choice = buildWhatsAppSessionChoiceSourceHandleId("yes");
    const flowOption = buildFlowBranchSourceHandleId("plan", "pro");
    const templateButton = buildWhatsAppTemplateButtonSourceHandleId(1);
    const telegram = buildTelegramBranchSourceHandleId("buy");
    const drawnByNode = buildWhatsAppSessionChoiceSourceHandleId("no");

    expect(
      listLazySectionRouteHandles(
        [
          "right-source",
          choice,
          flowOption,
          templateButton,
          telegram,
          drawnByNode,
        ],
        [drawnByNode]
      )
    ).toEqual({
      serviceMessage: [choice, flowOption],
      template: [flowOption, templateButton],
      telegram: [telegram],
    });
  });

  describe("a template's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    const formTemplate = (
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: "1571793974235171" },
          ],
        },
      ],
      uiConnections: { sourceHandleIds: [FORM_SUBMITTED] },
      ...extra,
    });
    // Where the expanded node anchors a linked route: on the node itself, or
    // in the template section's placeholder while the section downloads.
    const anchorsOf = (data: ActionNodeTestData) => {
      const nodeData = createActionEditorTestData(data);
      const { hiddenActionSourceHandles } = resolveActionNodeBranchState({
        id: "action-1",
        mode: resolveActionNodeModeState(nodeData),
        nodeData,
        renderMode: "expanded",
        t: key => key,
      });
      const { template } = listLazySectionRouteHandles(
        nodeData.uiConnections.sourceHandleIds,
        hiddenActionSourceHandles
      );
      return {
        node: hiddenActionSourceHandles.filter(id => id === FORM_SUBMITTED),
        section: template,
      };
    };

    it("is anchored once: by the template section, or by the node of a bulk send", () => {
      expect(anchorsOf(formTemplate())).toEqual({
        node: [],
        section: [FORM_SUBMITTED],
      });
      expect(
        anchorsOf(formTemplate({ uiBulkPrimaryWhatsAppTemplate: true }))
      ).toEqual({
        node: [FORM_SUBMITTED],
        section: [],
      });
    });

    it("keeps its anchor while the template section loads, then leaves it to the FLOW row", async () => {
      const onRouteAnchorsRemoved = jest.fn();
      render(
        <TemplateSection
          loadingLabel="loadingItems"
          routeAnchorHandleIds={anchorsOf(formTemplate()).section}
          onRouteAnchorsRemoved={onRouteAnchorsRemoved}
        />
      );

      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(anchorIds()).toEqual([FORM_SUBMITTED]);

      await act(() => scenarioEditorChunks.whatsAppTemplateSection.load());
      expect(screen.getByText("template editor")).toBeInTheDocument();
      expect(anchorIds()).toEqual([]);
      expect(onRouteAnchorsRemoved).toHaveBeenCalledTimes(1);
    });
  });
});
