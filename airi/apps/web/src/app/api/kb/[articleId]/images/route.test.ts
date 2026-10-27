const mockArticle = jest.fn();
const mockReserve = jest.fn();
const mockUpload = jest.fn();
jest.mock("@/lib/supabase/auth-helpers", () => ({
  getAuthenticatedUser: async () => ({ user: { id: "user" } }),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) =>
      table === "kb_articles"
        ? { select: () => ({ eq: () => ({ single: () => mockArticle() }) }) }
        : {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: { id: "attachment" },
                  error: null,
                }),
              }),
            }),
          },
  }),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockUpload(...args),
        getPublicUrl: () => ({
          data: { publicUrl: "https://storage.test/image" },
        }),
      }),
    },
  },
}));
jest.mock("@icecore/airi-runtime/storage-quota", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/storage-quota");
  return {
    ...actual,
    storeSupabaseWorkspaceBuffer: (params: object) =>
      actual.storeSupabaseWorkspaceBuffer({
        ...params,
        quota: {
          reserve: (...args: unknown[]) => mockReserve(...args),
          settle: async () => {},
        },
      }),
  };
});
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import { POST } from "./route";

const request = () => {
  const body = new FormData();
  body.set("file", new File(["image"], "image.png", { type: "image/png" }));
  return new Request("http://localhost/api/kb/article/images", {
    method: "POST",
    body,
  }) as never;
};
beforeEach(() => {
  jest.clearAllMocks();
  mockArticle.mockResolvedValue({ data: { workspace_id: "workspace" } });
  mockReserve.mockResolvedValue({ _id: "reservation", status: "reserved" });
  mockUpload.mockResolvedValue({ error: null });
});
it("requires an accessible article before company admission", async () => {
  mockArticle.mockResolvedValueOnce({ data: null });
  expect(
    (
      await POST(request(), {
        params: Promise.resolve({ articleId: "article" }),
      })
    ).status
  ).toBe(404);
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
});
it("reserves actual image bytes against the article workspace", async () => {
  expect(
    (
      await POST(request(), {
        params: Promise.resolve({ articleId: "article" }),
      })
    ).status
  ).toBe(201);
  expect(mockReserve).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      bucket: "kb-attachments",
      bytes: 5,
    })
  );
});
it("stops KB image writes when the company budget is full", async () => {
  mockReserve.mockRejectedValueOnce(
    new StorageQuotaError("company_storage_limit_exceeded", "Storage is full")
  );
  expect(
    (
      await POST(request(), {
        params: Promise.resolve({ articleId: "article" }),
      })
    ).status
  ).toBe(409);
  expect(mockUpload).not.toHaveBeenCalled();
});
