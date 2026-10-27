import { validateScenarioGraph } from "@/lib/scenarios/graph-validation";
import { DEMO_SCENARIO_PRESET_ID } from "@/lib/scenarios/scenario-presets";
import {
  buildDemoScenarioSeed,
  getConnectedScenarioActionSources,
  getConnectedScenarioSourceMentions,
  getScenarioSourceCapabilities,
  hasConnectedScenarioSources,
  isDemoScenarioAutoCreatePending,
  shouldAutoCreateDemoScenario,
} from "./scenario-onboarding";

const t = (key: string) => key;
const READABLE_HORIZONTAL_GAP = 140;
const TRIGGER_NODE_WIDTH = 360;
const CONTEXT_NODE_WIDTH = 360;

describe("scenario onboarding", () => {
  it("builds a valid demo scenario seed", () => {
    const seed = buildDemoScenarioSeed({
      contextOptions: [],
      t,
    });

    const triggerNodes = seed.initialFlow.nodes.filter(
      node => node.data?.kind === "trigger"
    );
    const contextNode = seed.initialFlow.nodes.find(
      node => node.data?.kind === "context"
    );
    const actionNode = seed.initialFlow.nodes.find(
      node => node.data?.kind === "action"
    );

    expect(seed.name).toBe("scenarioOnboardingDemoName");
    expect(seed.presetId).toBe(DEMO_SCENARIO_PRESET_ID);
    expect(triggerNodes).toHaveLength(1);
    expect(triggerNodes[0]?.data).toMatchObject({
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        keywordMatchMode: "contains",
        messageMatchMode: "any",
        onlyNewCustomers: false,
      },
    });
    expect(triggerNodes[0]?.data).not.toHaveProperty("triggerType");
    expect(contextNode?.data?.contextSources).toEqual([
      {
        optionId: "conversation_timeline",
        selectionMode: "all",
        itemIds: [],
      },
      {
        optionId: "answer_snippets",
        selectionMode: "all",
        itemIds: [],
      },
    ]);
    expect(actionNode?.data?.actionType).toBe("reply");
    expect(actionNode?.data?.actionWhatsAppServiceMessage).toMatchObject({
      version: 1,
      message: {
        kind: "text",
        body: {
          mode: "ai",
          instruction: "scenarioOnboardingDemoReplyInstruction",
        },
      },
    });
    expect(
      (contextNode?.position.x ?? 0) -
        ((triggerNodes[0]?.position.x ?? 0) + TRIGGER_NODE_WIDTH)
    ).toBeGreaterThanOrEqual(READABLE_HORIZONTAL_GAP);
    expect(
      (actionNode?.position.x ?? 0) -
        ((contextNode?.position.x ?? 0) + CONTEXT_NODE_WIDTH)
    ).toBeGreaterThanOrEqual(READABLE_HORIZONTAL_GAP);
    expect(
      validateScenarioGraph(seed.initialFlow.nodes, seed.initialFlow.edges)
    ).toBeNull();
  });

  it("detects connected scenario sources from configured integrations and email", () => {
    expect(hasConnectedScenarioSources([])).toBe(false);
    expect(
      hasConnectedScenarioSources([
        { type: "telegram", credentials: { bot_token: "" } },
      ])
    ).toBe(false);
    expect(
      hasConnectedScenarioSources([
        { type: "telegram", credentials: { bot_token: "123:abc" } },
      ])
    ).toBe(true);
    // The Scenarios page selects `credentials->bot_token`, which is now encrypted.
    expect(
      hasConnectedScenarioSources([
        {
          type: "telegram",
          credentials: {
            bot_token: { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" },
          },
        },
      ])
    ).toBe(true);
    expect(
      hasConnectedScenarioSources([{ type: "whatsapp", credentials: {} }])
    ).toBe(true);
    expect(
      hasConnectedScenarioSources([{ type: "canva", credentials: {} }])
    ).toBe(true);
    expect(
      hasConnectedScenarioSources([
        {
          type: "email",
          credentials: {
            status: "active",
            email_address: "support@example.com",
          },
        },
      ])
    ).toBe(true);
  });

  it("keeps source mentions limited to channels used by scenario creation", () => {
    expect(
      getConnectedScenarioSourceMentions([
        { type: "telegram", credentials: { bot_token: "" } },
        { type: "whatsapp", credentials: {} },
        { type: "canva", credentials: {} },
        {
          type: "email",
          credentials: {
            status: "active",
            email_address: "support@example.com",
          },
        },
      ])
    ).toEqual(["whatsapp", "email", "canva"]);
  });

  it("exposes only connected message sources for action-node source picking", () => {
    expect(
      getConnectedScenarioActionSources([
        { type: "telegram", credentials: { bot_token: "" } },
        { type: "whatsapp", credentials: {} },
        {
          type: "instagram",
          credentials: { instagram_business_account_id: "ig-1" },
        },
        { type: "web_widget", credentials: {} },
        { type: "canva", credentials: {} },
        {
          type: "email",
          credentials: {
            status: "active",
            email_address: "support@example.com",
          },
        },
      ])
    ).toEqual(["whatsapp", "instagram", "web_widget", "email"]);

    expect(
      getConnectedScenarioActionSources([
        { type: "telegram", credentials: { bot_token: "123:abc" } },
      ])
    ).toEqual(["telegram"]);
  });

  it("exposes WhatsApp session choices only when a WhatsApp source is available", () => {
    expect(getScenarioSourceCapabilities([])).toEqual({
      hasWhatsApp: false,
      hasWhatsAppCoexistence: false,
      hasMetaAds: false,
    });

    expect(
      getScenarioSourceCapabilities([
        {
          type: "whatsapp",
          credentials: {
            embedded_signup_flow: "coexistence",
            phone_number_id: "phone-1",
          },
        },
      ])
    ).toEqual({
      hasWhatsApp: true,
      hasWhatsAppCoexistence: true,
      hasMetaAds: false,
    });

    expect(
      getScenarioSourceCapabilities([
        {
          type: "meta_ads",
          credentials: {
            access_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
          },
        },
      ])
    ).toEqual({
      hasWhatsApp: false,
      hasWhatsAppCoexistence: false,
      hasMetaAds: true,
    });
  });

  it("reports a pending demo only while the auto-create can still run", () => {
    expect(
      isDemoScenarioAutoCreatePending({
        hasConnectedSources: false,
        demoCreateFailed: false,
        scenarioCreateLocked: false,
      })
    ).toBe(true);
    // A plan limit stops the auto-create effect, so nothing is pending.
    expect(
      isDemoScenarioAutoCreatePending({
        hasConnectedSources: false,
        demoCreateFailed: false,
        scenarioCreateLocked: true,
      })
    ).toBe(false);
    expect(
      isDemoScenarioAutoCreatePending({
        hasConnectedSources: false,
        demoCreateFailed: true,
        scenarioCreateLocked: false,
      })
    ).toBe(false);
    expect(
      isDemoScenarioAutoCreatePending({
        hasConnectedSources: true,
        demoCreateFailed: false,
        scenarioCreateLocked: false,
      })
    ).toBe(false);
  });

  it("auto-creates the demo only for the first empty no-source load", () => {
    expect(
      shouldAutoCreateDemoScenario({
        attempted: false,
        hasConnectedSources: false,
        loadingScenarios: false,
        scenarioCount: 0,
      })
    ).toBe(true);
    expect(
      shouldAutoCreateDemoScenario({
        attempted: true,
        hasConnectedSources: false,
        loadingScenarios: false,
        scenarioCount: 0,
      })
    ).toBe(false);
    expect(
      shouldAutoCreateDemoScenario({
        attempted: false,
        hasConnectedSources: true,
        loadingScenarios: false,
        scenarioCount: 0,
      })
    ).toBe(false);
    expect(
      shouldAutoCreateDemoScenario({
        attempted: false,
        hasConnectedSources: false,
        loadingScenarios: true,
        scenarioCount: 0,
      })
    ).toBe(false);
    expect(
      shouldAutoCreateDemoScenario({
        attempted: false,
        hasConnectedSources: false,
        loadingScenarios: false,
        scenarioCount: 1,
      })
    ).toBe(false);
  });
});
