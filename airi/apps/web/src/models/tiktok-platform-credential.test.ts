import type { Schema } from "mongoose";

import { EncryptedStringSchema } from "./encrypted-string-schema";
import {
  ensureTikTokPlatformCredentialIndexes,
  TikTokPlatformCredential,
} from "./tiktok-platform-credential";

function nestedSchema(schema: Schema, path: string): Schema {
  return (schema.path(path) as unknown as { schema: Schema }).schema;
}

const encrypted = {
  iv: Buffer.alloc(12, 1).toString("base64"),
  tag: Buffer.alloc(16, 2).toString("base64"),
  ciphertext: Buffer.from("secret").toString("base64"),
};
const validRecord = {
  key: "primary",
  generation: "a".repeat(32),
  encryptedAccessToken: encrypted,
  selectedAdvertiserId: "123456789",
  authorizedAdvertiserCount: 1,
  grantedScopes: ["18000000"],
  connectedByUserId: "user-1",
  connectedAt: new Date("2026-08-13T00:00:00.000Z"),
  lastValidatedAt: null,
  status: "connected",
  lastErrorCode: null,
};

describe("TikTokPlatformCredential", () => {
  it("stores only one strict encrypted credential shape", () => {
    const record = new TikTokPlatformCredential(validRecord);
    expect(record.validateSync()).toBeUndefined();
    expect(TikTokPlatformCredential.schema.get("strict")).toBe("throw");
    expect(TikTokPlatformCredential.schema.path("accessToken")).toBeUndefined();
    expect(
      nestedSchema(TikTokPlatformCredential.schema, "encryptedAccessToken")
    ).toBe(EncryptedStringSchema);
    expect(TikTokPlatformCredential.schema.indexes()).toContainEqual([
      { key: 1 },
      expect.objectContaining({
        unique: true,
        name: "tiktok_platform_credential_key_unique",
      }),
    ]);
  });

  const invalidDocuments: Array<[string, Record<string, unknown>]> = [
    ["non-primary key", { key: "secondary" }],
    ["non-hex generation", { generation: "not-a-generation" }],
    ["blank advertiser", { selectedAdvertiserId: " " }],
    ["nonnumeric advertiser", { selectedAdvertiserId: "advertiser-1" }],
    ["zero advertisers", { authorizedAdvertiserCount: 0 }],
    ["too many advertisers", { authorizedAdvertiserCount: 501 }],
    ["fractional advertisers", { authorizedAdvertiserCount: 1.5 }],
    [
      "too many scopes",
      {
        grantedScopes: Array.from({ length: 101 }, (_, index) => String(index)),
      },
    ],
    ["oversized scope", { grantedScopes: ["s".repeat(129)] }],
    ["blank connecting user", { connectedByUserId: " " }],
    ["unsupported status", { status: "pending" }],
    ["unsupported safe error", { lastErrorCode: "raw_provider_message" }],
    [
      "malformed encryption",
      { encryptedAccessToken: { iv: "x", tag: "y", ciphertext: "z" } },
    ],
  ];

  it.each(invalidDocuments)("rejects %s", (_name, change) => {
    const document = new TikTokPlatformCredential({
      ...validRecord,
      ...change,
    });
    expect(document.validateSync()).toBeDefined();
  });

  it("rejects plaintext token fields in strict throw mode", () => {
    expect(
      () =>
        new TikTokPlatformCredential({
          ...validRecord,
          accessToken: "plaintext",
        })
    ).toThrow();
  });

  it("ensures the singleton index once across concurrent callers", async () => {
    const createIndex = jest
      .spyOn(TikTokPlatformCredential.collection, "createIndex")
      .mockResolvedValue("tiktok_platform_credential_key_unique");

    await Promise.all([
      ensureTikTokPlatformCredentialIndexes(),
      ensureTikTokPlatformCredentialIndexes(),
    ]);

    expect(createIndex).toHaveBeenCalledTimes(1);
    expect(createIndex).toHaveBeenCalledWith(
      { key: 1 },
      {
        background: true,
        name: "tiktok_platform_credential_key_unique",
        unique: true,
      }
    );
    createIndex.mockRestore();
  });
});
