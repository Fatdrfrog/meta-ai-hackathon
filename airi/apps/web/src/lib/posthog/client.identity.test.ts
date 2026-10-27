let mockConsent = "granted";
let mockDistinctId = "anonymous";
let mockUserState = "anonymous";
const mockIdentify = jest.fn((id: string) => {
  mockDistinctId = id;
  mockUserState = "identified";
});
const mockReset = jest.fn(() => {
  mockConsent = "pending";
  mockDistinctId = "anonymous";
  mockUserState = "anonymous";
});
const mockInit = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: mockInit,
    identify: mockIdentify,
    reset: mockReset,
    get_distinct_id: () => mockDistinctId,
    get_property: () => mockUserState,
    get_explicit_consent_status: () => mockConsent,
    opt_in_capturing: () => {
      mockConsent = "granted";
    },
    opt_out_capturing: () => {
      mockConsent = "denied";
    },
  },
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockConsent = "granted";
  mockDistinctId = "anonymous";
  mockUserState = "anonymous";
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "test-project";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { hostname: "airi.chat" } },
  });
});
afterEach(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = originalKey;
});

it("identifies an initial authenticated user using the imported SDK", async () => {
  const client = await import("./client");
  await client.setPostHogUser?.({ id: "user-a", email: "a@example.com" });
  expect(mockIdentify).toHaveBeenCalledWith("user-a", {
    email: "a@example.com",
  });
});

it.each(["pending", "denied"])(
  "does not identify while consent is %s and identifies after acceptance",
  async consent => {
    mockConsent = consent;
    const client = await import("./client");
    await client.setPostHogUser?.({ id: "user-a" });
    expect(mockIdentify).not.toHaveBeenCalled();
    mockConsent = "granted";
    await client.syncPostHogIdentity?.();
    expect(mockIdentify).toHaveBeenCalledWith("user-a", { email: undefined });
  }
);

it.each(["granted", "denied"])(
  "clears user/device identity at logout and preserves %s consent",
  async consent => {
    const client = await import("./client");
    await client.setPostHogUser?.({ id: "user-a" });
    mockConsent = consent;
    await client.setPostHogUser?.(null, { reset: true });
    expect(mockReset).toHaveBeenCalledWith(true);
    expect(mockDistinctId).toBe("anonymous");
    expect(mockConsent).toBe(consent);
  }
);

it("does not identify a stale user when logout wins the SDK import race", async () => {
  const client = await import("./client");
  await Promise.all([
    client.setPostHogUser?.({ id: "user-a" }),
    client.setPostHogUser?.(null, { reset: true }),
  ]);
  expect(mockIdentify).not.toHaveBeenCalled();
  expect(mockReset).toHaveBeenCalledTimes(1);
});

it("clears the previous account before identifying a different account", async () => {
  const client = await import("./client");
  await client.setPostHogUser?.({ id: "user-a" });
  await client.setPostHogUser?.({ id: "user-b" });
  expect(mockReset).toHaveBeenCalledTimes(1);
  expect(mockDistinctId).toBe("user-b");
  expect(mockConsent).toBe("granted");
});
