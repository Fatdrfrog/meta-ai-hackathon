const mockResolveWhatsAppAccountContext = jest.fn();
const mockConnectDB = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockDeleteOne = jest.fn();
const mockFind = jest.fn();

export {};

jest.mock("@/lib/whatsapp/account/resolution", () => ({
  formatWhatsAppGraphApiError: (error: { message?: string } | undefined) =>
    error?.message || "Graph error",
  resolveWhatsAppAccountContext: (...args: unknown[]) =>
    mockResolveWhatsAppAccountContext(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  connectDB: () => mockConnectDB(),
}));

jest.mock("@/models/whatsapp-welcome-sequence", () => ({
  WhatsAppWelcomeSequenceModel: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function readUrlEncodedBody(body: unknown): Record<string, string> {
  const params = body as URLSearchParams;
  return Object.fromEntries(params.entries());
}

describe("WhatsApp welcome sequence service", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveWhatsAppAccountContext.mockResolvedValue({
      accessToken: "token-1",
      sourceId: "source-1",
      wabaId: "waba-1",
    });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        sequenceId: "seq-1",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        name: "Driver sign-up",
        text: "Welcome",
        autofillMessageContent: "Hello",
        iceBreakers: [{ title: "FAQ 1" }],
        isUsedInAd: false,
        metaCreatedTime: null,
        metaUpdatedTime: null,
        lastSyncedAt: new Date("2026-06-25T00:00:00.000Z"),
      }),
    });
    global.fetch = mockFetch;
    mockFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a sequence with Meta's official multipart fields", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ sequence_id: "seq-1" }));
    const { createWelcomeMessageSequence } = await import(
      "./welcome-sequence-service"
    );

    const result = await createWelcomeMessageSequence("workspace-1", {
      name: "Driver sign-up",
      text: "Welcome",
      autofillMessageContent: "Hello",
      iceBreakers: [{ title: "FAQ 1" }],
    });

    expect(result.id).toBe("seq-1");
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      {
        body: URLSearchParams;
        headers: Record<string, string>;
        method: string;
      },
    ];
    expect(url).toContain("waba-1/welcome_message_sequences");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token-1");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const form = readUrlEncodedBody(init.body);
    expect(form.name).toBe("Driver sign-up");
    expect(JSON.parse(form.welcome_message_sequence)).toEqual({
      text: "Welcome",
      autofill_message: { content: "Hello" },
      ice_breakers: [{ title: "FAQ 1" }],
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", sequenceId: "seq-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          sourceId: "source-1",
          wabaId: "waba-1",
          sequenceId: "seq-1",
        }),
      }),
      { new: true, upsert: true }
    );
  });

  it("does not call Meta when deleting a cached sequence used in an ad", async () => {
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ isUsedInAd: true }),
    });
    const { deleteWelcomeMessageSequence } = await import(
      "./welcome-sequence-service"
    );

    await expect(
      deleteWelcomeMessageSequence("workspace-1", "seq-1")
    ).rejects.toThrow("linked to an active ad");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  it("lists sequences from Meta's documented raw array response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          sequence_id: "seq-raw",
          name: "Basic Triage",
          welcome_message_sequence: {
            text: "Welcome",
            autofill_message: { content: "Hello" },
            ice_breakers: [{ title: "FAQ 1" }],
          },
          is_used_in_ad: false,
        },
      ])
    );
    const { listWelcomeMessageSequences } = await import(
      "./welcome-sequence-service"
    );

    const result = await listWelcomeMessageSequences("workspace-1");

    expect(result.sequences).toHaveLength(1);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", sequenceId: "seq-raw" },
      expect.objectContaining({
        $set: expect.objectContaining({
          name: "Basic Triage",
          text: "Welcome",
          autofillMessageContent: "Hello",
          iceBreakers: [{ title: "FAQ 1" }],
        }),
      }),
      { new: true, upsert: true }
    );
  });

  it("fetches a specific sequence with Meta's sequence_id parameter", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          sequence_id: "seq-specific",
          name: "Appointment Schedule",
          welcome_message_sequence: {
            text: "Pick a time",
          },
          is_used_in_ad: true,
        },
      ])
    );
    const { getWelcomeMessageSequence } = await import(
      "./welcome-sequence-service"
    );

    const result = await getWelcomeMessageSequence(
      "workspace-1",
      "seq-specific"
    );

    expect(result.sequence?.id).toBe("seq-1");
    expect(mockFetch.mock.calls[0][0]).toContain(
      "waba-1/welcome_message_sequences?sequence_id=seq-specific"
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", sequenceId: "seq-specific" },
      expect.objectContaining({
        $set: expect.objectContaining({
          name: "Appointment Schedule",
          text: "Pick a time",
          isUsedInAd: true,
        }),
      }),
      { new: true, upsert: true }
    );
  });

  it("does not call Meta when updating a cached sequence used in an ad", async () => {
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ isUsedInAd: true }),
    });
    const { updateWelcomeMessageSequence } = await import(
      "./welcome-sequence-service"
    );

    await expect(
      updateWelcomeMessageSequence("workspace-1", {
        sequenceId: "seq-1",
        name: "New name",
      })
    ).rejects.toThrow("cannot be updated");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
