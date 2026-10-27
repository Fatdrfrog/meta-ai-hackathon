import { Conversation } from "../conversation";

describe("Conversation language source validation", () => {
  it("accepts google_cloud as the durable customer language source", async () => {
    const conversation = new Conversation({
      workspaceId: "workspace-1",
      airi_last_customer_language_source: "google_cloud",
    });

    await expect(conversation.validate()).resolves.toBeUndefined();
  });

  it("repairs unsupported language values when an existing conversation is hydrated", async () => {
    const conversation = Conversation.hydrate({
      workspaceId: "workspace-1",
      preferred_language: "uk",
      airi_last_customer_language: "uk",
      airi_last_customer_language_at: new Date("2026-08-03T00:00:00.000Z"),
      airi_last_customer_language_source: "google_cloud",
    });

    expect(conversation.preferred_language).toBe("en");
    expect(conversation.airi_last_customer_language).toBeNull();
    expect(conversation.airi_last_customer_language_at).toBeNull();
    expect(conversation.airi_last_customer_language_source).toBeNull();
    expect(conversation.isModified("preferred_language")).toBe(true);
    expect(conversation.isModified("airi_last_customer_language")).toBe(true);
    await expect(conversation.validate()).resolves.toBeUndefined();
  });

  it("uses a valid recent language when repairing an unsupported preference", async () => {
    const conversation = Conversation.hydrate({
      workspaceId: "workspace-1",
      preferred_language: "uk",
      airi_last_customer_language: "ru",
      airi_last_customer_language_at: new Date("2026-08-03T00:00:00.000Z"),
      airi_last_customer_language_source: "google_cloud",
    });

    expect(conversation.preferred_language).toBe("ru");
    expect(conversation.airi_last_customer_language).toBe("ru");
    await expect(conversation.validate()).resolves.toBeUndefined();
  });

  it("canonicalizes legacy Kazakh locale aliases while hydrating", async () => {
    const conversation = Conversation.hydrate({
      workspaceId: "workspace-1",
      preferred_language: "kk-KZ",
      airi_last_customer_language: "kk",
      airi_last_customer_language_at: new Date("2026-08-03T00:00:00.000Z"),
      airi_last_customer_language_source: "google_cloud",
    });

    expect(conversation.preferred_language).toBe("kz");
    expect(conversation.airi_last_customer_language).toBe("kz");
    expect(conversation.airi_last_customer_language_source).toBe(
      "google_cloud"
    );
    await expect(conversation.validate()).resolves.toBeUndefined();
  });

  it("does not repair language fields excluded by a projection", () => {
    const conversation = Conversation.hydrate(
      { workspaceId: "workspace-1" },
      { workspaceId: 1 }
    );

    expect(conversation.isSelected("preferred_language")).toBe(false);
    expect(conversation.isSelected("airi_last_customer_language")).toBe(false);
    expect(conversation.isModified("preferred_language")).toBe(false);
    expect(conversation.isModified("airi_last_customer_language")).toBe(false);
  });

  it("does not guess a preferred fallback when recent language was omitted by projection", () => {
    const conversation = Conversation.hydrate(
      {
        workspaceId: "workspace-1",
        preferred_language: "uk",
      },
      { preferred_language: 1 }
    );

    expect(conversation.isSelected("preferred_language")).toBe(true);
    expect(conversation.isSelected("airi_last_customer_language")).toBe(false);
    expect(conversation.preferred_language).toBe("uk");
    expect(conversation.isModified("preferred_language")).toBe(false);
  });

  it("clears stale recent-language metadata even when metadata was omitted by projection", () => {
    const conversation = Conversation.hydrate(
      {
        workspaceId: "workspace-1",
        airi_last_customer_language: "uk",
      },
      { airi_last_customer_language: 1 }
    );

    expect(conversation.airi_last_customer_language).toBeNull();
    expect(conversation.airi_last_customer_language_at).toBeNull();
    expect(conversation.airi_last_customer_language_source).toBeNull();
    expect(conversation.isModified("airi_last_customer_language")).toBe(true);
    expect(conversation.isModified("airi_last_customer_language_at")).toBe(
      true
    );
    expect(conversation.isModified("airi_last_customer_language_source")).toBe(
      true
    );
  });

  it("still rejects unsupported languages assigned to new conversations", async () => {
    const conversation = new Conversation({
      workspaceId: "workspace-1",
      preferred_language: "uk",
      airi_last_customer_language: "uk",
    });

    await expect(conversation.validate()).rejects.toMatchObject({
      errors: {
        preferred_language: expect.anything(),
        airi_last_customer_language: expect.anything(),
      },
    });
  });
});
