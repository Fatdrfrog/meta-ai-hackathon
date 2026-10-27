/**
 * @jest-environment node
 */

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: jest.fn() },
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: { findOne: jest.fn() },
}));

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  findWhatsAppQrCodeByReference: jest.fn(),
}));

import { formatWhatsAppQrReference } from "@icecore/scenario-contracts";
import { resolveWhatsAppQrScenarioAnchor } from "./runtime";
import { Scenario } from "@/models/scenario";
import type { WhatsAppQrCodeRecord } from "@/models/whatsapp-qr-code";
import type { WhatsAppQrEntryPointRecord } from "@/models/whatsapp-qr-entry-point";

const REF = "ABCDEFGHJK";
const MARKER = formatWhatsAppQrReference(REF);
const NOW = new Date("2026-08-06T12:00:00.000Z");

function makeCode(
  overrides: Partial<WhatsAppQrCodeRecord> = {}
): WhatsAppQrCodeRecord {
  return {
    codeId: "code-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    referenceCode: REF,
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<WhatsAppQrEntryPointRecord> = {}
): WhatsAppQrEntryPointRecord {
  return {
    entryPointId: "entry-1",
    workspaceId: "workspace-1",
    scenarioId: "507f1f77bcf86cd799439011",
    nodeId: "qr-trigger",
    placementName: "Door",
    sourceId: "source-1",
    status: "ACTIVE",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeActiveScenario(
  entryPointType: "whatsapp_qr" | "message" = "whatsapp_qr"
) {
  return {
    scenarioId: "507f1f77bcf86cd799439011",
    name: "QR Door",
    status: "active",
    nodes: [
      {
        id: "qr-trigger",
        data: {
          kind: "trigger",
          triggerConfig: {
            enabled: true,
            entryPointType,
            entryPointId: "entry-1",
          },
        },
      },
    ],
  };
}

describe("resolveWhatsAppQrScenarioAnchor", () => {
  it("returns none when no reference marker is present", async () => {
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: "Hello there",
        loadCode: jest.fn(),
      })
    ).resolves.toEqual({
      kind: "none",
      effectiveText: "Hello there",
    });
  });

  it("fail-closes on ambiguous multi-reference markers", async () => {
    const other = formatWhatsAppQrReference("ZZZZZZZZZZ");
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}\n${other}\nHelp`,
        loadCode: jest.fn(),
      })
    ).resolves.toEqual({
      kind: "fail_closed",
      effectiveText: "Hi\nHelp",
      reason: "ambiguous_reference",
    });
  });

  it("fail-closes on unknown reference", async () => {
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}`,
        loadCode: async () => null,
      })
    ).resolves.toEqual({
      kind: "fail_closed",
      effectiveText: "Hi",
      reason: "unknown_reference",
    });
  });

  it("fail-closes when routing is disabled", async () => {
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}`,
        loadCode: async () => makeCode({ routingState: "DISABLED" }),
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "routing_disabled",
      codeId: "code-1",
    });
  });

  it("anchors HISTORICAL codes that remain ENABLED + ACTIVE", async () => {
    const result = await resolveWhatsAppQrScenarioAnchor({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      messageText: `Need help\n${MARKER}`,
      loadCode: async () => makeCode({ placementBindingState: "HISTORICAL" }),
      loadEntryPoint: async () => makeEntry(),
      loadScenario: async () => makeActiveScenario(),
    });

    expect(result).toEqual({
      kind: "anchored",
      effectiveText: "Need help",
      scenarioId: "507f1f77bcf86cd799439011",
      nodeId: "qr-trigger",
      entryPointId: "entry-1",
      codeId: "code-1",
      referencePresent: true,
    });
    expect(result).not.toHaveProperty("referenceCode");
  });

  it("anchors CURRENT enabled active codes", async () => {
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Need help\n${MARKER}`,
        loadCode: async () => makeCode(),
        loadEntryPoint: async () => makeEntry(),
        loadScenario: async () => makeActiveScenario(),
      })
    ).resolves.toMatchObject({
      kind: "anchored",
      effectiveText: "Need help",
      scenarioId: "507f1f77bcf86cd799439011",
      nodeId: "qr-trigger",
      referencePresent: true,
    });
  });

  it("fail-closes DETACHED placement without catch-all fallthrough", async () => {
    const loadEntryPoint = jest.fn();
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}`,
        loadCode: async () => makeCode({ placementBindingState: "DETACHED" }),
        loadEntryPoint,
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "not_current",
    });
    expect(loadEntryPoint).not.toHaveBeenCalled();
  });

  it("fail-closes a malformed persisted scenario id before querying Mongoose", async () => {
    const findOne = Scenario.findOne as jest.Mock;

    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Need help\n${MARKER}`,
        loadCode: async () => makeCode(),
        loadEntryPoint: async () =>
          makeEntry({ scenarioId: "not-an-object-id" }),
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "scenario_missing",
      scenarioId: "not-an-object-id",
    });

    expect(findOne).not.toHaveBeenCalled();
  });

  it("fail-closes unassigned or partial legacy entry points before scenario lookup", async () => {
    for (const entryPoint of [
      makeEntry({ scenarioId: undefined, nodeId: undefined }),
      makeEntry({ nodeId: undefined }),
    ]) {
      const loadScenario = jest.fn();
      const loadTriggerNode = jest.fn();

      await expect(
        resolveWhatsAppQrScenarioAnchor({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          messageText: `Need help\n${MARKER}`,
          loadCode: async () => makeCode(),
          loadEntryPoint: async () => entryPoint,
          loadScenario,
          loadTriggerNode,
        })
      ).resolves.toMatchObject({
        kind: "fail_closed",
        reason: "entry_unassigned",
        entryPointId: "entry-1",
      });
      expect(loadScenario).not.toHaveBeenCalled();
      expect(loadTriggerNode).not.toHaveBeenCalled();
    }
  });

  it("fail-closes an explicit unassigned projection with a stale assignment tuple", async () => {
    const loadScenario = jest.fn();
    const loadTriggerNode = jest.fn();

    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Need help\n${MARKER}`,
        loadCode: async () => makeCode(),
        loadEntryPoint: async () =>
          makeEntry({ assignmentState: "unassigned" }),
        loadScenario,
        loadTriggerNode,
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "entry_unassigned",
      entryPointId: "entry-1",
    });
    expect(loadScenario).not.toHaveBeenCalled();
    expect(loadTriggerNode).not.toHaveBeenCalled();
  });

  it("fail-closes inactive scenario and wrong trigger type", async () => {
    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}`,
        loadCode: async () => makeCode(),
        loadEntryPoint: async () => makeEntry(),
        loadScenario: async () => ({
          scenarioId: "507f1f77bcf86cd799439011",
          name: "Draft QR",
          status: "draft",
          nodes: [],
        }),
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "scenario_inactive",
    });

    await expect(
      resolveWhatsAppQrScenarioAnchor({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        messageText: `Hi\n${MARKER}`,
        loadCode: async () => makeCode(),
        loadEntryPoint: async () => makeEntry(),
        loadScenario: async () => makeActiveScenario("message"),
      })
    ).resolves.toMatchObject({
      kind: "fail_closed",
      reason: "trigger_wrong_type",
    });
  });
});
