/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoggerError = jest.fn();
const mockLoad = jest.fn();
const mockCreate = jest.fn();
const mockRemove = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
const mockAssertAiEnabled = jest.fn();
jest.mock("@/lib/products/import-spend", () => ({
  productImportSpend: {
    assertAiEnabled: (...args: unknown[]) => mockAssertAiEnabled(...args),
  },
}));
const aiDisabled = () =>
  Object.assign(new Error("AI is disabled for this company."), {
    code: "workspace_ai_disabled",
  });
const mockSource = jest.fn();
jest.mock("@/lib/products/voices", () => ({
  loadProductVoice: (...args: unknown[]) => mockLoad(...args),
  createProductVoice: (...args: unknown[]) => mockCreate(...args),
  removeProductVoice: (...args: unknown[]) => mockRemove(...args),
  productVoiceSource: (...args: unknown[]) => mockSource(...args),
}));

import { DELETE, GET, POST } from "./route";

const workspaceId = "workspace-1";
const URL_ = `https://local.test/api/workspaces/${workspaceId}/products/voice`;
const context = { params: Promise.resolve({ workspaceId }) };
const IMPORT = "551f1f77bcf86cd799439021";
const voice = {
  state: "pending",
  sourceImportId: IMPORT,
  sourceVideoAt: "2026-11-01T08:00:00.000Z",
  speechSeconds: 42,
  errorCode: null,
  consentAt: "2026-11-03T12:00:00.000Z",
  createdAt: "2026-11-03T12:00:00.000Z",
};

const post = (body: unknown) =>
  POST(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context
  );

function allowRole(role: string) {
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  allowRole("admin");
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockLoad.mockResolvedValue(voice);
  mockCreate.mockResolvedValue({ voice, created: true });
  mockRemove.mockResolvedValue({ removed: true });
  mockAssertAiEnabled.mockResolvedValue(undefined);
});

describe("the workspace's voice", () => {
  it("answers the voice, or null for none", async () => {
    const response = await GET(new Request(URL_), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voice });
    mockLoad.mockResolvedValue(null);
    expect(await (await GET(new Request(URL_), context)).json()).toEqual({
      voice: null,
    });
  });

  it("with the products, also names the video a copy would be made from", async () => {
    const DOLL = "651f1f77bcf86cd799439011";
    const MUG = "651F1F77BCF86CD799439012";
    const source = {
      importId: IMPORT,
      sourceVideoAt: "2026-11-01T08:00:00.000Z",
      speechSeconds: 42,
      productNames: ["Кукла Лол"],
    };
    mockSource.mockResolvedValue(source);
    const response = await GET(
      new Request(`${URL_}?productIds=${DOLL},${MUG}`),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voice, source });
    expect(mockSource).toHaveBeenCalledWith(workspaceId, [
      DOLL,
      MUG.toLowerCase(),
    ]);

    mockSource.mockResolvedValue(null);
    const none = await GET(new Request(`${URL_}?productIds=${DOLL}`), context);
    expect(await none.json()).toEqual({ voice, source: null });

    const bad = await GET(new Request(`${URL_}?productIds=nope`), context);
    expect(bad.status).toBe(400);
    expect(mockSource).toHaveBeenCalledTimes(2);
  });

  it("is for admins with the flag only", async () => {
    allowRole("member");
    expect((await GET(new Request(URL_), context)).status).toBe(403);
    mockFeatureEnabled.mockResolvedValue(false);
    allowRole("admin");
    expect((await post({ consent: true, importId: IMPORT })).status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't be read", async () => {
    mockLoad.mockRejectedValue(new Error("Mongo down"));
    const response = await GET(new Request(URL_), context);
    expect(response.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe("the consent to clone it", () => {
  it("answers 201 with the pending voice, made by the user who ticked", async () => {
    const response = await post({ consent: true, importId: IMPORT });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ voice });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      request: { consent: true, importId: IMPORT },
    });
  });

  it("answers 200 with the voice the workspace already has", async () => {
    mockCreate.mockResolvedValue({ voice, created: false });
    expect((await post({ consent: true, importId: IMPORT })).status).toBe(200);
  });

  it("never clones without the consent tick", async () => {
    const response = await post({ consent: false, importId: IMPORT });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("voice_consent_required");
    expect((await post({ importId: IMPORT })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't one, a missing video and voices not set up", async () => {
    expect((await post({ consent: true, importId: "x" })).status).toBe(400);
    mockCreate.mockResolvedValue({ refused: "import_not_found" });
    expect((await post({ consent: true, importId: IMPORT })).status).toBe(404);
    mockCreate.mockResolvedValue({ refused: "voice_unavailable" });
    const response = await post({ consent: true, importId: IMPORT });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("voice_unavailable");
  });

  it("saves no consent for a company that turned AI off, and says why", async () => {
    mockAssertAiEnabled.mockRejectedValue(aiDisabled());
    const response = await post({ consent: true, importId: IMPORT });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "AI is disabled for this company",
      code: "ai_disabled",
    });
    expect(mockAssertAiEnabled).toHaveBeenCalledWith(workspaceId);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe("Remove my voice", () => {
  it("still removes the voice when the company turned AI off", async () => {
    mockAssertAiEnabled.mockRejectedValue(aiDisabled());
    const response = await DELETE(
      new Request(URL_, { method: "DELETE" }),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voice: null });
    expect(mockRemove).toHaveBeenCalledWith({ workspaceId });
    expect(mockAssertAiEnabled).not.toHaveBeenCalled();
  });

  it("answers with no voice, whether or not there was one", async () => {
    const response = await DELETE(
      new Request(URL_, { method: "DELETE" }),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voice: null });
    expect(mockRemove).toHaveBeenCalledWith({ workspaceId });
    mockRemove.mockResolvedValue({ removed: false });
    expect(
      (await DELETE(new Request(URL_, { method: "DELETE" }), context)).status
    ).toBe(200);
  });

  it("answers 503 when ElevenLabs couldn't delete it", async () => {
    mockRemove.mockResolvedValue({ refused: "voice_unavailable" });
    const response = await DELETE(
      new Request(URL_, { method: "DELETE" }),
      context
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("voice_unavailable");
  });
});
