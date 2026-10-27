/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockList = jest.fn();
const mockSave = jest.fn();
const mockCreate = jest.fn();
const mockLoggerError = jest.fn();

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
jest.mock("@/models/business-location", () => ({ BusinessLocation: {} }));
jest.mock("@/lib/business-locations/store", () => ({
  listBusinessLocations: (...args: unknown[]) => mockList(...args),
}));
jest.mock("@/lib/business-locations/save", () => ({
  ...jest.requireActual("@/lib/business-locations/save"),
  saveBusinessLocations: (...args: unknown[]) => mockSave(...args),
  createBusinessLocation: (...args: unknown[]) => mockCreate(...args),
}));

import {
  BusinessLocationKeyTakenError,
  BusinessLocationsLimitError,
} from "@/lib/business-locations/save";
import type {
  BusinessLocationInput,
  BusinessLocationRecord,
} from "@/lib/business-locations/types";
import { GET, POST, PUT } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const url = `https://local.test/api/workspaces/${workspaceId}/business-locations`;

const abayInput: BusinessLocationInput = {
  key: "kz_almaty_abay",
  name: "Abay",
  country: "kz",
  city: "Almaty",
  address: "Abay Ave 10",
  tags: ["Flagship"],
  latitude: "43.238949",
  longitude: 76.889709,
};

const abayOffice = {
  key: "kz_almaty_abay",
  name: "Abay",
  country: "KZ",
  city: "Almaty",
  cityKey: "almaty",
  address: "Abay Ave 10",
  tags: ["flagship"],
  latitude: 43.238949,
  longitude: 76.889709,
  sortOrder: 0,
};

const abayRecord: BusinessLocationRecord = {
  ...abayOffice,
  isActive: true,
  updatedAt: "2026-10-05T09:30:00.000Z",
};

const getRequest = () => new Request(url);
const putRequest = (body: unknown) =>
  new Request(url, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const postRequest = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body) });

function allowRole(role: string) {
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role },
  });
}

function expectNoDataAccess() {
  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  allowRole("admin");
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockList.mockResolvedValue([abayRecord]);
  mockSave.mockResolvedValue({ created: 1, updated: 0, deactivated: 0 });
  mockCreate.mockResolvedValue(abayRecord);
});

describe("business locations API access", () => {
  test.each([401, 403])(
    "passes a denied membership (%s) through before the flag or any data",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      for (const response of [
        await GET(getRequest(), context),
        await PUT(putRequest({ offices: [abayInput] }), context),
        await POST(postRequest({ office: abayInput }), context),
      ]) {
        expect(response.status).toBe(status);
      }
      expect(mockMembership).toHaveBeenCalledWith(workspaceId);
      expect(mockFeatureEnabled).not.toHaveBeenCalled();
      expectNoDataAccess();
    }
  );

  it("answers 404 feature_disabled while the flag is off, before any read", async () => {
    mockFeatureEnabled.mockResolvedValue(false);

    for (const response of [
      await GET(getRequest(), context),
      await PUT(putRequest({ offices: [abayInput] }), context),
      await POST(postRequest({ office: abayInput }), context),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Feature disabled",
        code: "feature_disabled",
      });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(mockFeatureEnabled).toHaveBeenCalledWith(
      workspaceId,
      "scenario_location_routing"
    );
    expectNoDataAccess();
  });

  it("treats a failed flag read as off", async () => {
    mockFeatureEnabled.mockRejectedValue(new Error("flags unavailable"));

    expect((await GET(getRequest(), context)).status).toBe(404);
    expectNoDataAccess();
  });

  test.each(["owner", "member", "viewer", ""])(
    "role %j reads but cannot write",
    async role => {
      allowRole(role);

      const read = await GET(getRequest(), context);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ offices: [abayRecord] });

      for (const response of [
        await PUT(putRequest({ offices: [abayInput] }), context),
        await POST(postRequest({ office: abayInput }), context),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "Workspace manager access required",
          code: "manager_required",
        });
      }
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  test.each(["admin", "manager"])("role %s reads the offices", async role => {
    allowRole(role);

    const response = await GET(getRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offices: [abayRecord] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith(workspaceId);
  });
});

describe("GET", () => {
  it("logs a failed read and answers 503 load_failed", async () => {
    const failure = new Error("private connection string");
    mockList.mockRejectedValue(failure);

    const response = await GET(getRequest(), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Offices could not be loaded",
      code: "load_failed",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[BusinessLocations API] GET failed",
      failure,
      { event: "business_locations.get_failed", workspaceId }
    );
  });

  it("answers 503 when Mongo can't be reached", async () => {
    mockConnect.mockRejectedValue(new Error("timeout"));

    expect((await GET(getRequest(), context)).status).toBe(503);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("PUT", () => {
  it("upserts the validated offices for a manager and returns the catalog", async () => {
    allowRole("manager");

    const response = await PUT(
      putRequest({
        offices: [
          abayInput,
          {
            ...abayInput,
            key: "kz_almaty_dostyk",
            isActive: false,
            sortOrder: 3,
          },
        ],
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      offices: [abayRecord],
      summary: { created: 1, updated: 0, deactivated: 0 },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockSave).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      rows: [
        { office: abayOffice, isActive: true, sortOrder: undefined },
        {
          office: { ...abayOffice, key: "kz_almaty_dostyk", sortOrder: 3 },
          isActive: false,
          sortOrder: 3,
        },
      ],
      deactivateMissing: false,
    });
    expect(mockConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockSave.mock.invocationCallOrder[0]
    );
    expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockList.mock.invocationCallOrder[0]
    );
  });

  it("passes deactivateMissing through", async () => {
    mockSave.mockResolvedValue({ created: 0, updated: 1, deactivated: 4 });

    const response = await PUT(
      putRequest({ offices: [abayInput], deactivateMissing: true }),
      context
    );

    expect(response.status).toBe(200);
    expect((await response.json()).summary).toEqual({
      created: 0,
      updated: 1,
      deactivated: 4,
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ deactivateMissing: true })
    );
  });

  it("lists every refused office with its index and issues", async () => {
    const response = await PUT(
      putRequest({
        offices: [
          abayInput,
          { ...abayInput, key: "kz_almaty_typo", latitude: "91" },
          {
            ...abayInput,
            key: "bad key",
            mapUrl: "http://maps.google.com",
            tags: Array.from({ length: 11 }, (_, index) => `tag ${index}`),
          },
        ],
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Some offices are invalid",
      code: "invalid_offices",
      rows: [
        { index: 1, key: "kz_almaty_typo", issues: ["latitude_invalid"] },
        {
          index: 2,
          key: null,
          issues: ["key_invalid", "map_url_invalid", "tags_too_many"],
        },
      ],
    });
    expectNoDataAccess();
  });

  it("refuses keys that appear twice", async () => {
    const response = await PUT(
      putRequest({
        offices: [
          abayInput,
          { ...abayInput, key: " kz_almaty_abay " },
          { ...abayInput, key: "kz_almaty_dostyk" },
          { ...abayInput, key: "kz_almaty_dostyk" },
          { ...abayInput, key: "kz_almaty_dostyk" },
        ],
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Office keys must be unique",
      code: "duplicate_keys",
      keys: ["kz_almaty_abay", "kz_almaty_dostyk"],
    });
    expectNoDataAccess();
  });

  it("refuses a body over 1 MB with 413", async () => {
    const response = await PUT(
      putRequest({
        offices: [abayInput],
        padding: "x".repeat(1_048_576),
      }),
      context
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large",
      code: "body_too_large",
    });
    expectNoDataAccess();
  });

  test.each([
    ["broken JSON", "{"],
    ["no offices", { offices: [] }],
    ["offices that aren't a list", { offices: abayInput }],
    [
      "more than 500 offices",
      {
        offices: Array.from({ length: 501 }, (_, index) => ({
          ...abayInput,
          key: `office_${index}`,
        })),
      },
    ],
    ["an unknown envelope field", { offices: [abayInput], workspaceId: "x" }],
    [
      "a non-boolean deactivateMissing",
      { offices: [abayInput], deactivateMissing: "yes" },
    ],
    ["an office that isn't an object", { offices: [abayInput, "abay"] }],
    ["an office that is a list", { offices: [[abayInput]] }],
    [
      "an unknown office field",
      { offices: [{ ...abayInput, workspaceId: "x" }] },
    ],
    ["a numeric address", { offices: [{ ...abayInput, address: 10 }] }],
    ["a numeric phone", { offices: [{ ...abayInput, phone: 77270000000 }] }],
    ["a string isActive", { offices: [{ ...abayInput, isActive: "false" }] }],
  ])("answers 400 invalid_request for %s", async (_label, body) => {
    const response = await PUT(putRequest(body), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
    expectNoDataAccess();
  });

  it("accepts a cleared optional field sent as null", async () => {
    const response = await PUT(
      putRequest({ offices: [{ ...abayInput, address: null, phone: null }] }),
      context
    );

    expect(response.status).toBe(200);
    const [{ office }] = mockSave.mock.calls[0][0].rows;
    expect(office).toEqual({ ...abayOffice, address: undefined });
    expect(office).not.toHaveProperty("address");
    expect(office).not.toHaveProperty("phone");
  });

  test.each([
    ["office_limit", 500],
    ["record_limit", 2000],
  ] as const)("answers 409 %s with the limit", async (code, limit) => {
    mockSave.mockRejectedValue(new BusinessLocationsLimitError(code, limit));

    const response = await PUT(putRequest({ offices: [abayInput] }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code,
      limit,
    });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("answers 409 save_conflict to a duplicate-key race", async () => {
    mockSave.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
    );

    const response = await PUT(putRequest({ offices: [abayInput] }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Offices changed while saving; try again",
      code: "save_conflict",
    });
  });

  it("logs any other failure and answers 503 save_failed", async () => {
    const failure = new Error("private connection string");
    mockSave.mockRejectedValue(failure);

    const response = await PUT(putRequest({ offices: [abayInput] }), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Offices could not be saved",
      code: "save_failed",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[BusinessLocations API] PUT failed",
      failure,
      { event: "business_locations.put_failed", workspaceId }
    );
  });
});

describe("POST", () => {
  it("creates one office for a manager and answers 201 with the catalog", async () => {
    const response = await POST(
      postRequest({ office: { ...abayInput, isActive: false } }),
      context
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      office: abayRecord,
      offices: [abayRecord],
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      office: abayOffice,
      isActive: false,
      sortOrder: undefined,
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("lists a refused office's issues at index 0", async () => {
    const response = await POST(
      postRequest({
        office: { ...abayInput, name: " ", country: "Kazakhstan" },
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Some offices are invalid",
      code: "invalid_offices",
      rows: [
        {
          index: 0,
          key: "kz_almaty_abay",
          issues: ["name_missing", "country_invalid"],
        },
      ],
    });
    expectNoDataAccess();
  });

  test.each([
    ["no office", {}],
    ["an office list", { offices: [abayInput] }],
    ["an unknown office field", { office: { ...abayInput, id: "x" } }],
  ])("answers 400 invalid_request for %s", async (_label, body) => {
    const response = await POST(postRequest(body), context);

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_request");
    expectNoDataAccess();
  });

  it("answers 409 office_key_taken for a key already in the catalog", async () => {
    mockCreate.mockRejectedValue(
      new BusinessLocationKeyTakenError("kz_almaty_abay")
    );

    const response = await POST(postRequest({ office: abayInput }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An office with this key already exists",
      code: "office_key_taken",
    });
  });

  it("answers 409 with the limit when the catalog is full", async () => {
    mockCreate.mockRejectedValue(
      new BusinessLocationsLimitError("office_limit", 500)
    );

    const response = await POST(postRequest({ office: abayInput }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "office_limit", limit: 500 })
    );
  });

  it("logs any other failure and answers 503 save_failed", async () => {
    const failure = new Error("private connection string");
    mockCreate.mockRejectedValue(failure);

    const response = await POST(postRequest({ office: abayInput }), context);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("save_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[BusinessLocations API] POST failed",
      failure,
      { event: "business_locations.post_failed", workspaceId }
    );
  });
});
