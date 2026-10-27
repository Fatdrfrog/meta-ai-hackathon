import { buildMetaAdsSkillCatalogOption } from "./meta-skill-catalog";
import {
  AIRI_CHAT_META_SKILL_LABEL,
  buildAiriChatMetaSkillRef,
  buildAiriChatSourceOptionId,
  hasAiriChatMetaSkill,
  normalizeAiriChatSelectedSources,
} from "./source-types";

describe("@meta skill catalog", () => {
  it.each([
    { outcome: "success", selectedAccountEnabled: false, recovery: "rollout" },
    {
      outcome: "unreachable",
      selectedAccountEnabled: true,
      recovery: "settings",
    },
    {
      outcome: "unauthorized",
      selectedAccountEnabled: true,
      recovery: "reconnect",
    },
  ])("offers $recovery recovery for $outcome account availability", fixture => {
    const now = new Date().toISOString();
    const option = buildMetaAdsSkillCatalogOption({
      channelSources: [
        {
          id: "source-1",
          type: "meta_ads",
          credentials: {
            mcp_access_token: "token",
            mcp_scope: "ads_mcp_management ads_read",
            mcp_scopes_verified_at: now,
            mcp_never_expires: true,
            mcp_connection_id: "connection-1",
            mcp_user_id: "user-1",
            selected_ad_account_id: "act_123",
            mcp_ad_account_ids: ["act_123"],
            mcp_selected_ad_account: { id: "act_123", currency: "USD" },
            mcp_assets_checked_at: now,
            mcp_provider_probe: {
              checkedAt: now,
              outcome: fixture.outcome,
              selectedAccountEnabled: fixture.selectedAccountEnabled,
              warnings: [],
            },
          },
        },
      ],
    });
    expect(option).toMatchObject({
      disabled: true,
      metaAdsMcp: {
        canRead: false,
        canWrite: false,
        recovery: fixture.recovery,
      },
    });
  });

  it("exposes a disabled @meta skill when Meta Ads is missing", () => {
    const meta = buildMetaAdsSkillCatalogOption({
      channelSources: [],
      query: "meta",
    });
    expect(meta).toMatchObject({
      id: buildAiriChatSourceOptionId(buildAiriChatMetaSkillRef()),
      group: "Skills",
      label: AIRI_CHAT_META_SKILL_LABEL,
      disabled: true,
    });
  });

  it("exposes a disabled @meta skill when Ads MCP is not enabled", () => {
    const meta = buildMetaAdsSkillCatalogOption({
      channelSources: [
        {
          id: "source-1",
          type: "meta_ads",
          name: "Meta Ads",
          credentials: {
            access_token: { iv: "iv", tag: "tag", ciphertext: "cipher" },
          },
        },
      ],
      query: null,
    });
    expect(meta?.disabled).toBe(true);
    expect(meta?.description).toMatch(/Connect and verify Ads MCP/i);
  });

  it("keeps @meta disabled when only an unverified MCP token is present", () => {
    const meta = buildMetaAdsSkillCatalogOption({
      channelSources: [
        {
          id: "source-1",
          type: "meta_ads",
          name: "Meta Ads",
          credentials: {
            access_token: { iv: "iv", tag: "tag", ciphertext: "cipher" },
            mcp_access_token: {
              iv: "mcp-iv",
              tag: "mcp-tag",
              ciphertext: "mcp-cipher",
            },
          },
        },
      ],
    });
    expect(meta?.disabled).toBe(true);
  });

  it.each([
    ["ads_mcp_management ads_read", /reporting.*read-only/i],
    ["ads_mcp_management ads_management", /confirmed campaign changes/i],
  ])("enables @meta with verified minimal grants: %s", (scope, description) => {
    const now = new Date();
    const meta = buildMetaAdsSkillCatalogOption({
      channelSources: [
        {
          id: "source-1",
          type: "meta_ads",
          credentials: {
            access_token: "graph-token",
            mcp_access_token: "mcp-token",
            mcp_scope: scope,
            mcp_scopes_verified_at: now.toISOString(),
            mcp_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
            mcp_connection_id: "connection-1",
            mcp_user_id: "user-1",
            selected_ad_account_id: "act_123",
            mcp_ad_account_ids: ["act_123"],
            mcp_selected_ad_account: { id: "act_123", currency: "KZT" },
            mcp_assets_checked_at: now.toISOString(),
            mcp_provider_probe: {
              checkedAt: now.toISOString(),
              outcome: "success",
              warnings: [],
            },
          },
        },
      ],
    });
    expect(meta?.disabled).toBe(false);
    expect(meta?.description).toMatch(description);
  });

  it("normalizes skill refs and detects @meta selection", () => {
    const refs = normalizeAiriChatSelectedSources([
      { kind: "skill", skillId: "meta", label: "Meta Ads" },
    ]);
    expect(refs).toEqual([buildAiriChatMetaSkillRef()]);
    expect(hasAiriChatMetaSkill(refs)).toBe(true);
  });

  it.each(["success", "unreachable"])(
    "keeps a previously verified connection selectable after an old %s check",
    outcome => {
      const stale = new Date(Date.now() - 3_600_000).toISOString();
      const meta = buildMetaAdsSkillCatalogOption({
        channelSources: [
          {
            id: "source-1",
            type: "meta_ads",
            credentials: {
              mcp_access_token: "mcp-token",
              mcp_scope: "ads_mcp_management ads_read",
              mcp_scopes_verified_at: stale,
              mcp_never_expires: true,
              mcp_connection_id: "connection-1",
              mcp_user_id: "user-1",
              selected_ad_account_id: "act_123",
              mcp_ad_account_ids: ["act_123"],
              mcp_selected_ad_account: { id: "act_123", currency: "KZT" },
              mcp_assets_checked_at: stale,
              mcp_provider_probe: {
                checkedAt: stale,
                outcome,
                warnings: [],
              },
            },
          },
        ],
      });
      expect(meta?.disabled).toBe(false);
      expect(meta?.description).toMatch(/checked.*before/i);
    }
  );
});

it("does not promise an automatic retry while a provider outage is cooling down", () => {
  const now = new Date().toISOString();
  const option = buildMetaAdsSkillCatalogOption({
    channelSources: [
      {
        id: "source-1",
        type: "meta_ads",
        credentials: {
          mcp_access_token: "token",
          mcp_scope: "ads_mcp_management ads_read",
          mcp_scopes_verified_at: now,
          mcp_never_expires: true,
          mcp_connection_id: "connection-1",
          mcp_user_id: "user-1",
          selected_ad_account_id: "act_123",
          mcp_ad_account_ids: ["act_123"],
          mcp_selected_ad_account: { id: "act_123", currency: "USD" },
          mcp_assets_checked_at: now,
          mcp_provider_probe: {
            checkedAt: now,
            outcome: "unreachable",
            warnings: [],
          },
        },
      },
    ],
  });
  expect(option?.disabled).toBe(true);
  expect(option?.description).not.toMatch(/checked.*before/i);
});
