import {
  buildWhatsAppFlowEndpointTopology,
  parseWhatsAppFlowEndpointTopology,
} from "@icecore/scenario-contracts";
import { generateFlowJson } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import {
  buildFlowEndpointTokenFromConfig,
  decodeFlowEndpointToken,
} from "@/lib/whatsapp/flows/endpoint-token";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";

const config = sanitizeWhatsAppFlowConfig({
  templateId: "flow",
  ctaText: "Open",
  flowNavigationMode: "data_endpoint",
  screens: [
    {
      id: "S1",
      title: "Start",
      fields: [
        {
          id: "choice",
          label: "Choice",
          fieldType: "RadioButtonsGroup",
          options: [
            { id: "to_second", title: "Second" },
            { id: "to_third", title: "Third" },
          ],
        },
      ],
    },
    { id: "S2", title: "Second", fields: [] },
    { id: "S3", title: "Third", fields: [] },
  ],
  screenRoutes: { S1: ["S2", "S3"], S2: ["S1"] },
  flowBranchRules: {
    S1: { choice: { to_second: "S2", to_third: "S3" } },
  },
});

if (!config) throw new Error("test fixture must sanitize");

describe("WhatsApp Flow endpoint topology", () => {
  it("keeps Meta Flow JSON, legacy airi1, and endpoint topology in parity", () => {
    const topology = buildWhatsAppFlowEndpointTopology(config);
    const json = generateFlowJson(config);
    const token = decodeFlowEndpointToken(
      buildFlowEndpointTokenFromConfig(config)!
    );

    expect(topology).toEqual({
      version: 1,
      initialScreenId: "S_ONE",
      screens: ["S_ONE", "S_TWO", "S_THREE"],
      routing: { S_ONE: ["S_TWO", "S_THREE"], S_TWO: ["S_ONE"], S_THREE: [] },
      branches: {
        S_ONE: { choice: { to_second: "S_TWO", to_third: "S_THREE" } },
      },
    });
    expect(json.version).toBe("7.3");
    expect(json.routing_model).toEqual(topology.routing);
    expect(token).toEqual({
      v: topology.version,
      screens: topology.screens,
      routing: topology.routing,
      branches: topology.branches,
    });
  });

  it("rejects invalid route and branch topology instead of silently changing it", () => {
    expect(() =>
      buildWhatsAppFlowEndpointTopology({
        ...config,
        screenRoutes: { S_ONE: ["MISSING"] },
      })
    ).toThrow("unknown target");
    expect(() =>
      buildWhatsAppFlowEndpointTopology({
        ...config,
        screenRoutes: { S_ONE: ["S_TWO", "S_TWO"] },
      })
    ).toThrow("duplicate target");
    expect(() =>
      buildWhatsAppFlowEndpointTopology({
        ...config,
        flowBranchRules: { S_ONE: { choice: { to_second: "S_ONE" } } },
      })
    ).toThrow("not allowed");
  });

  it("rejects invalid external endpoint payloads and bounded oversized topology", () => {
    expect(() => parseWhatsAppFlowEndpointTopology({ version: 1 })).toThrow();
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: "A",
        screens: ["A", "B"],
        routing: { A: ["B", "B"], B: [] },
        branches: {},
      })
    ).toThrow("duplicate target");
    const routing = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => {
        const screen = `S${index}`;
        return [screen, [`S${(index + 1) % 6}`, `S${(index + 2) % 6}`]];
      })
    );
    const screens = Object.keys(routing);
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: "S0",
        screens,
        routing,
        branches: {},
      })
    ).toThrow("routing edge limit");
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: "A",
        screens: ["A", "B"],
        routing: { A: ["B"], B: [] },
        branches: {
          A: {
            choice: Object.fromEntries(
              Array.from({ length: 11 }, (_, index) => [`option_${index}`, "B"])
            ),
          },
        },
      })
    ).toThrow("branch limit");
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: "A",
        screens: Array.from({ length: 21 }, (_, index) => `S${index}`),
        routing: {},
        branches: {},
      })
    ).toThrow("screen limit");
    const largeId = "A".repeat(9_000);
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: largeId,
        screens: [largeId, "B"],
        routing: { [largeId]: ["B"], B: [] },
        branches: {},
      })
    ).toThrow("byte limit");
  });

  it("rejects data_endpoint configs with fewer than two screens", () => {
    expect(() =>
      buildWhatsAppFlowEndpointTopology({
        templateId: "flow",
        ctaText: "Open",
        flowNavigationMode: "data_endpoint",
        screens: [{ id: "ONLY", title: "Only", fields: [] }],
      })
    ).toThrow("at least two screens");
  });

  it("does not discard an explicit terminal route", () => {
    expect(() =>
      buildWhatsAppFlowEndpointTopology({
        ...config,
        screenRoutes: { S_THREE: ["S_ONE"] },
        flowBranchRules: undefined,
      })
    ).toThrow("terminal screen");
  });

  it("rejects unknown and oversized raw topology input before normalization", () => {
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: "A",
        screens: ["A", "B"],
        routing: { A: ["B"], B: [] },
        branches: {},
        ignored: "x".repeat(20_000),
      })
    ).toThrow("unknown topology member");

    const paddedId = `${" ".repeat(9_000)}A`;
    expect(() =>
      parseWhatsAppFlowEndpointTopology({
        version: 1,
        initialScreenId: paddedId,
        screens: [paddedId, "B"],
        routing: { A: ["B"], B: [] },
        branches: {},
      })
    ).toThrow("raw byte limit");
  });

  it("rejects reserved property keys before they can reach downstream routing", () => {
    expect(() =>
      parseWhatsAppFlowEndpointTopology(
        JSON.parse(
          '{"version":1,"initialScreenId":"__proto__","screens":["__proto__","B"],"routing":{"__proto__":["B"],"B":[]},"branches":{}}'
        )
      )
    ).toThrow("reserved key");
  });
});
