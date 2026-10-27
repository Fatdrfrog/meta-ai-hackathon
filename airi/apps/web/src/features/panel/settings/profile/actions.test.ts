const mockCreateClient = jest.fn();
const mockSyncProfile = jest.fn();
const mockRevalidate = jest.fn();
const mockUpload = jest.fn();
const mockUpdateUser = jest.fn();
const mockAdminStorage = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: { from: (...args: unknown[]) => mockAdminStorage(...args) },
  },
}));
jest.mock("@/lib/auth/user-profile-sync", () => ({
  syncPublicUserProfile: (...args: unknown[]) => mockSyncProfile(...args),
}));
jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidate(...args),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import { updateProfile } from "./actions";
import { MAX_AVATAR_BYTES } from "./schema";

const previousState = { success: false, error: null };
const user = {
  id: "user-1",
  email: "name@example.com",
  user_metadata: {
    full_name: "Old Name",
    avatar_url: "https://example.com/old.png",
  },
};
function form(name: string, avatar?: File | string) {
  const data = new FormData();
  data.set("fullName", name);
  if (avatar) data.set("avatar", avatar);
  return data;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpload.mockResolvedValue({ error: null });
  mockUpdateUser.mockResolvedValue({ data: { user }, error: null });
  mockSyncProfile.mockResolvedValue(undefined);
  mockAdminStorage.mockReturnValue({
    upload: mockUpload,
    getPublicUrl: () => ({
      data: { publicUrl: "https://example.com/new.png" },
    }),
  });
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user } }),
      updateUser: mockUpdateUser,
    },
    storage: {
      from: () => ({
        upload: mockUpload,
        getPublicUrl: () => ({
          data: { publicUrl: "https://example.com/new.png" },
        }),
      }),
    },
  });
});

it("rejects whitespace-only names on the server before saving", async () => {
  expect(await updateProfile(previousState, form("   "))).toEqual({
    success: false,
    error: "fullNameRequired",
  });
  expect(mockCreateClient).not.toHaveBeenCalled();
});

it("rejects malformed, unsupported and oversized avatars before uploading", async () => {
  expect(
    await updateProfile(previousState, form("Name", "not a file"))
  ).toEqual({ success: false, error: "avatarTypeError" });
  expect(
    await updateProfile(
      previousState,
      form("Name", new File(["image"], "file.svg", { type: "image/svg+xml" }))
    )
  ).toEqual({ success: false, error: "avatarTypeError" });
  expect(
    await updateProfile(
      previousState,
      form(
        "Name",
        new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], "large.png", {
          type: "image/png",
        })
      )
    )
  ).toEqual({ success: false, error: "avatarSizeError" });
  expect(mockUpload).not.toHaveBeenCalled();
});

it("trims the name and synchronizes the public profile used by the team", async () => {
  expect(await updateProfile(previousState, form("  New Name  "))).toEqual({
    success: true,
    error: null,
  });
  expect(mockUpdateUser).toHaveBeenCalledWith({
    data: { full_name: "New Name", avatar_url: user.user_metadata.avatar_url },
  });
  expect(mockSyncProfile).toHaveBeenCalledWith({
    ...user,
    user_metadata: {
      full_name: "New Name",
      avatar_url: user.user_metadata.avatar_url,
    },
  });
  expect(mockRevalidate).toHaveBeenCalledWith("/", "layout");
});

it("replaces one owned avatar through the service client and mirrors the new URL", async () => {
  expect(
    await updateProfile(
      previousState,
      form("Name", new File(["image"], "misleading.exe", { type: "image/png" }))
    )
  ).toEqual({ success: true, error: null });
  expect(mockUpload).toHaveBeenCalledWith("user-1/profile", expect.any(File), {
    upsert: true,
    contentType: "image/png",
    cacheControl: "0",
  });
  expect(mockAdminStorage).toHaveBeenCalledWith("avatars");
  expect(mockSyncProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      user_metadata: {
        full_name: "Name",
        avatar_url: "https://example.com/new.png",
      },
    })
  );
});

it("does not use service storage before authenticating the owner", async () => {
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: null } }) },
  });
  expect(
    await updateProfile(
      previousState,
      form("Name", new File(["image"], "file.png", { type: "image/png" }))
    )
  ).toEqual({
    success: false,
    error: "profileUnavailable",
  });
  expect(mockAdminStorage).not.toHaveBeenCalled();
});

it("does not report success when upload or public profile synchronization fails", async () => {
  mockUpload.mockResolvedValue({ error: { message: "storage unavailable" } });
  expect(
    await updateProfile(
      previousState,
      form("Name", new File(["image"], "file.png", { type: "image/png" }))
    )
  ).toEqual({ success: false, error: "profileUploadError" });
  expect(mockUpdateUser).not.toHaveBeenCalled();
  mockSyncProfile.mockRejectedValue(new Error("database unavailable"));
  expect(await updateProfile(previousState, form("Name"))).toEqual({
    success: false,
    error: "profileSyncError",
  });
  expect(mockRevalidate).not.toHaveBeenCalled();
});
