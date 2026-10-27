/** Run from apps/web: node --conditions=react-server --import tsx scripts/test-meta-ads-mcp.ts --workspace-id <uuid> */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--workspace-id" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[1] ?? "")
  ) {
    process.stderr.write(
      "Usage: node --conditions=react-server --import tsx scripts/test-meta-ads-mcp.ts --workspace-id <uuid>\n"
    );
    process.exitCode = 1;
    return;
  }
  // Load credentials only into this process. Do not print env values or tokens.
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { decryptMaybeString } = await import("@/lib/crypto");
  const { getMetaAdsAppConfig } = await import(
    "@/lib/meta-ads/meta-ads-login-config"
  );
  const { extractMetaAdsMcpCredentialFields } = await import(
    "@/lib/meta-ads/meta-ads-mcp-credentials"
  );
  const { runMetaAdsMcpReadTest } = await import(
    "@/lib/meta-ads/mcp/read-test"
  );
  const appConfig = getMetaAdsAppConfig();
  if (!appConfig) throw new Error("app_not_configured");
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id,credentials")
    .eq("workspace_id", args[1])
    .eq("type", "meta_ads")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error("source_unavailable");
  const fields = extractMetaAdsMcpCredentialFields(data.credentials);
  const accessToken = decryptMaybeString(fields.mcp_access_token);
  if (!accessToken || !fields.mcp_user_id)
    throw new Error("mcp_connection_unavailable");
  const result = await runMetaAdsMcpReadTest({
    accessToken,
    appConfig,
    expectedUserId: fields.mcp_user_id,
  });
  process.stdout.write(
    JSON.stringify(
      { workspaceId: args[1], sourceId: data.id, ...result },
      null,
      2
    ) + "\n"
  );
  if (!result.success) process.exitCode = 1;
}

void main().catch(() => {
  // Errors from the database/provider can contain sensitive request context.
  process.stderr.write(
    JSON.stringify({
      success: false,
      code: "operator_setup_failed",
      hint: "Check server environment and the selected workspace's saved MCP connection.",
    }) + "\n"
  );
  process.exitCode = 1;
});
