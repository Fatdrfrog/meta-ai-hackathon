import {
  buildMetaAdsMcpCredentialFields,
  extractMetaAdsMcpCredentialFields,
  mergeMetaAdsCredentialsWithMcp,
  mergeMetaAdsMcpReadinessEvidence,
} from "./meta-ads-mcp-credentials";
import { buildMetaAdsCredentials } from "./meta-ads-source";

const encrypted = { iv: "iv", tag: "tag", ciphertext: "ciphertext" };
const mcpEncrypted = {
  iv: "mcp-iv",
  tag: "mcp-tag",
  ciphertext: "mcp-ciphertext",
};

describe("meta-ads MCP credentials", () => {
  it("merges mcp fields onto existing Graph credentials without wiping access_token", () => {
    const existing = buildMetaAdsCredentials({
      encryptedAccessToken: encrypted,
      scope: "ads_read",
      userId: "user-graph",
    });
    const mcp = buildMetaAdsMcpCredentialFields({
      encryptedMcpAccessToken: mcpEncrypted,
      scope: "ads_mcp_management",
      userId: "user-mcp",
    });
    const merged = mergeMetaAdsCredentialsWithMcp({ existing, mcp });
    expect(merged.access_token).toEqual(encrypted);
    expect(merged.scope).toBe("ads_read");
    expect(merged.mcp_access_token).toEqual(mcpEncrypted);
    expect(merged.mcp_scope).toBe("ads_mcp_management");
  });

  it("extracts only mcp credential fields", () => {
    expect(
      extractMetaAdsMcpCredentialFields({
        access_token: encrypted,
        mcp_access_token: mcpEncrypted,
        mcp_scope: "ads_management",
        junk: true,
      })
    ).toEqual({
      mcp_access_token: mcpEncrypted,
      mcp_scope: "ads_management",
    });
  });

  it("preserves verified non-expiry and rejects truthy non-boolean claims", () => {
    expect(
      extractMetaAdsMcpCredentialFields({ mcp_never_expires: true })
    ).toEqual({ mcp_never_expires: true });
    expect(
      extractMetaAdsMcpCredentialFields({ mcp_never_expires: "true" })
    ).toEqual({});
    expect(
      buildMetaAdsMcpCredentialFields({
        encryptedMcpAccessToken: mcpEncrypted,
        neverExpires: true,
        expiresAt: null,
      })
    ).toMatchObject({ mcp_never_expires: true, mcp_expires_at: null });
  });

  it("does not transfer non-expiry evidence to a new token or probe", () => {
    const existing = {
      access_token: encrypted,
      mcp_access_token: mcpEncrypted,
      mcp_connection_id: "old-connection",
      mcp_never_expires: true,
    };
    const next = mergeMetaAdsCredentialsWithMcp({
      existing,
      mcp: {
        mcp_access_token: encrypted,
        mcp_connection_id: "new-connection",
        mcp_expires_at: null,
      },
    });
    expect(next).not.toHaveProperty("mcp_never_expires");
    expect(
      mergeMetaAdsMcpReadinessEvidence({
        existing: next,
        expectedConnectionId: "old-connection",
        evidence: { mcp_never_expires: true },
      })
    ).toBeNull();
    expect(
      mergeMetaAdsMcpReadinessEvidence({
        existing,
        expectedConnectionId: "old-connection",
        evidence: { mcp_expires_at: null },
      })
    ).not.toHaveProperty("mcp_never_expires");
  });
});
