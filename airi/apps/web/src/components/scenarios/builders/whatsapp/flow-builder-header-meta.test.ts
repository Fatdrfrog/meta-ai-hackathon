import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";
import { getFlowBuilderHeaderMeta } from "./flow-builder-header-meta";

function releasedConfig(
  providerStatus: "BLOCKED" | "DRAFT" | "PUBLISHED"
): WhatsAppFlowConfig {
  const editableConfig: WhatsAppFlowConfig = {
    templateId: "appointment_booking",
    ctaText: "Book",
    screens: [],
    metaFlowId: "legacy-flow",
    metaFlowName: "Legacy name",
    metaFlowStatus: "PUBLISHED",
  };
  return {
    ...editableConfig,
    managedProvisioning: {
      operationId: "operation-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 2,
      contentDigest: createWhatsAppFlowEditableContentDigest(editableConfig),
      flowId: "managed-flow",
      flowName: "Managed name",
      providerStatus,
    },
  };
}

describe("getFlowBuilderHeaderMeta", () => {
  const t = (key: string) => key;

  it.each([
    { reconciledStatus: "BLOCKED" as const, expectedStatus: "BLOCKED" },
    { reconciledStatus: "DRAFT" as const, expectedStatus: "DRAFT" },
  ])(
    "prefers reconciled $reconciledStatus over stale provider-list metadata",
    ({ reconciledStatus, expectedStatus }) => {
      expect(
        getFlowBuilderHeaderMeta(
          releasedConfig(reconciledStatus),
          [
            {
              id: "managed-flow",
              name: "Provider list name",
              status: "PUBLISHED",
            },
          ],
          t
        )
      ).toEqual({
        displayFlowName: "Provider list name",
        displayFlowStatus: expectedStatus,
      });
    }
  );

  it("uses durable managed truth when the provider list has not loaded", () => {
    expect(
      getFlowBuilderHeaderMeta(releasedConfig("PUBLISHED"), undefined, t)
    ).toEqual({
      displayFlowName: "Managed name",
      displayFlowStatus: "PUBLISHED",
    });
  });

  it("prefers fresh provider-list status over stale legacy status", () => {
    expect(
      getFlowBuilderHeaderMeta(
        {
          templateId: "appointment_booking",
          ctaText: "Book",
          screens: [],
          metaFlowId: "flow-1",
          metaFlowName: "Stored name",
          metaFlowStatus: "PUBLISHED",
        },
        [{ id: "flow-1", name: "Fresh name", status: "DRAFT" }],
        t
      )
    ).toEqual({
      displayFlowName: "Fresh name",
      displayFlowStatus: "DRAFT",
    });
  });

  it("refreshes a provider reference from the current provider list", () => {
    expect(
      getFlowBuilderHeaderMeta(
        {
          templateId: "provider_reference",
          ctaText: "Book",
          screens: [],
          providerReference: {
            flowId: "flow-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            flowName: "Stored name",
            providerStatus: "PUBLISHED",
          },
        },
        [{ id: "flow-1", name: "Renamed in Meta", status: "BLOCKED" }],
        t
      )
    ).toEqual({
      displayFlowName: "Renamed in Meta",
      displayFlowStatus: "BLOCKED",
    });
  });

  it("keeps provider status separate from unpublished local changes", () => {
    expect(
      getFlowBuilderHeaderMeta(
        {
          templateId: "appointment_booking",
          ctaText: "Edited CTA",
          screens: [],
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 1,
            contentDigest: "a".repeat(64),
            flowId: "flow-1",
            providerStatus: "PUBLISHED",
          },
        },
        undefined,
        t
      )
    ).toEqual({
      displayFlowName: "flowTemplateAppointmentTitle",
      displayFlowStatus: "PUBLISHED",
      hasUnpublishedChanges: true,
    });
  });
});
