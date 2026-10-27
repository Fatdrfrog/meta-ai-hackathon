import { encryptString } from "@/lib/crypto";
import {
  buildElevenLabsCredentials,
  resolveWorkspaceElevenLabsGenerationAccess,
  toPublicElevenLabsCredentials,
} from "./elevenlabs-source";
function client(data: unknown, error: unknown = null) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data, error }),
  };
  return { from: () => query } as never;
}
const originalKey = process.env.ELEVENLABS_API_KEY;
beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "platform-key";
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalKey;
});
it("does not switch payer when the source lookup fails", async () => {
  await expect(
    resolveWorkspaceElevenLabsGenerationAccess({
      supabase: client(null, { message: "database unavailable" }),
      workspaceId: "workspace-1",
    })
  ).rejects.toThrow();
});
it("does not switch payer when an existing customer source has missing credentials", async () => {
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: client({ id: "source-1", credentials: {} }),
    workspaceId: "workspace-1",
  });
  expect(access.available).toBe(false);
  expect(access.apiKey).toBeNull();
  expect(access.reason).toBe("source_required");
});
it("does not fall back when a specifically requested source is missing", async () => {
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: client(null),
    workspaceId: "workspace-1",
    sourceId: "source-deleted",
  });
  expect(access.available).toBe(false);
  expect(access.apiKey).toBeNull();
});
it("requires customer credentials for callers without platform admission", async () => {
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: client(null),
    workspaceId: "workspace-1",
  });
  expect(access).toMatchObject({
    available: false,
    reason: "source_required",
    apiKey: null,
  });
});
it("uses configured customer credentials", async () => {
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: client({
      id: "source-1",
      credentials: { api_key: "customer-key" },
    }),
    workspaceId: "workspace-1",
  });
  expect(access).toMatchObject({
    credentialSource: "workspace_source",
    apiKey: "customer-key",
  });
});

it("reads an encrypted key and an older plain-text key alike", async () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "test-encryption-secret";
  try {
    const encrypted = encryptString("customer-key-1234");
    expect(JSON.stringify(encrypted)).not.toContain("customer-key");
    const access = await resolveWorkspaceElevenLabsGenerationAccess({
      supabase: client({ id: "source-1", credentials: { api_key: encrypted } }),
      workspaceId: "workspace-1",
    });
    expect(access).toMatchObject({
      credentialSource: "workspace_source",
      apiKey: "customer-key-1234",
    });
    expect(toPublicElevenLabsCredentials({ api_key: encrypted })).toMatchObject(
      { has_api_key: true, key_label: "****1234" }
    );
    expect(
      buildElevenLabsCredentials({ api_key: "legacy-plain-key" }).apiKey
    ).toBe("legacy-plain-key");
  } finally {
    if (originalSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = originalSecret;
  }
});

it("allows platform resolution only for an explicitly metered caller", async () => {
  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase: client(null),
    workspaceId: "workspace-1",
    allowPlatform: true,
  });
  expect(access).toMatchObject({
    available: true,
    credentialSource: "platform",
    apiKey: "platform-key",
  });
});
