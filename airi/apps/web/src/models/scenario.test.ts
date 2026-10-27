/**
 * @jest-environment node
 */

import { Scenario, SCENARIO_LIST_ORDER_INDEX_KEYS } from "./scenario";

describe("Scenario WhatsApp Flow source indexes", () => {
  it("indexes managed and provider-reference source bindings for both owners", () => {
    const indexedPaths = new Set(
      Scenario.schema.indexes().flatMap(([fields]) => Object.keys(fields))
    );

    expect(
      indexedPaths.has(
        "nodes.data.actionFlowConfig.managedProvisioning.sourceId"
      )
    ).toBe(true);
    expect(
      indexedPaths.has(
        "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.managedProvisioning.sourceId"
      )
    ).toBe(true);
    expect(
      indexedPaths.has("nodes.data.actionFlowConfig.providerReference.sourceId")
    ).toBe(true);
    expect(
      indexedPaths.has(
        "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.providerReference.sourceId"
      )
    ).toBe(true);
  });

  it("indexes the server-owned WhatsApp QR detach retry marker", () => {
    expect(
      Scenario.schema.path("whatsappQrDetachPendingNodeIds")
    ).toBeDefined();
    expect(Scenario.schema.path("whatsappQrDetachNextRetryAt")).toBeDefined();

    expect(Scenario.schema.indexes()).toContainEqual([
      { whatsappQrDetachNextRetryAt: 1, _id: 1 },
      expect.objectContaining({
        name: "scenario_whatsapp_qr_detach_retry_due",
        partialFilterExpression: {
          whatsappQrDetachNextRetryAt: { $type: "date" },
        },
      }),
    ]);
  });

  it("indexes the scenario list's live rows in its cursor order", () => {
    const listIndex = Scenario.schema
      .indexes()
      .find(
        ([fields]) =>
          Object.keys(fields).join(",") === "workspaceId,deletedAt,priority,_id"
      );
    expect(listIndex?.[0]).toEqual({
      workspaceId: 1,
      deletedAt: 1,
      priority: -1,
      _id: 1,
    });
    // ensureIndexes builds the index from the same keys.
    expect(listIndex?.[0]).toEqual(SCENARIO_LIST_ORDER_INDEX_KEYS);
    // The index it complements stays defined.
    expect(Scenario.schema.indexes()).toContainEqual([
      { workspaceId: 1, deletedAt: 1, updatedAt: -1 },
      expect.anything(),
    ]);
  });

  it("indexes immutable workspace-scoped WhatsApp QR migration scans", () => {
    expect(Scenario.schema.indexes()).toContainEqual([
      { workspaceId: 1, _id: 1 },
      expect.objectContaining({
        name: "whatsapp_qr_scenario_migration_scan_v1",
      }),
    ]);
  });
});
