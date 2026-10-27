const mockInit = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: mockInit },
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

async function config() {
  const { loadPostHogClient } = await import("./client");
  await loadPostHogClient();
  return mockInit.mock.calls[0][1];
}

beforeEach(() => {
  jest.resetModules();
  mockInit.mockReset();
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

it("removes credentials and nested redirect queries before capturing the current URL", async () => {
  const options = await config();
  expect(
    options.get_current_url?.(
      "https://airi.chat/login?next=%2Fauth%2Fjoined%3Ftoken%3Dsecret&email=a%40example.com#access_token=secret"
    )
  ).toBe("https://airi.chat/login");
});

it("redacts current, referrer and initial person URLs without changing business properties", async () => {
  const options = await config();
  const event = {
    event: "$pageview",
    properties: {
      $current_url: "https://airi.chat/auth/joined?token=secret",
      $referrer: "https://airi.chat/login?email=a%40example.com",
      $set_once: {
        $initial_current_url: "https://airi.chat/?invite_token=secret",
        $initial_referrer: "https://airi.chat/login#access_token=secret",
      },
      workspace_id: "workspace-1",
      $elements: [{ attr__href: "/auth/joined?token=secret" }],
    },
    $set_once: {
      $initial_current_url: "https://airi.chat/?next=%2Fauth%3Ftoken%3Dsecret",
    },
  };
  const result = options.before_send(event);
  expect(result.properties.$current_url).toBe("https://airi.chat/auth/joined");
  expect(result.properties.$referrer).toBe("https://airi.chat/login");
  expect(result.properties.$set_once).toEqual({
    $initial_current_url: "https://airi.chat/",
    $initial_referrer: "https://airi.chat/login",
  });
  expect(result.$set_once.$initial_current_url).toBe("https://airi.chat/");
  expect(result.properties.$elements[0].attr__href).toBe("/auth/joined");
  expect(result.properties.workspace_id).toBe("workspace-1");
});

it("redacts replay URL metadata, captured request URLs and DOM href attributes", async () => {
  const options = await config();
  const recording = options.session_recording;
  expect(
    recording?.maskCapturedNetworkRequestFn?.({
      name: "https://airi.chat/auth/joined?token=secret",
    })
  ).toEqual({ name: "https://airi.chat/auth/joined" });
  expect(
    recording?.maskAttributeFn?.("href", "/auth/joined?token=secret", undefined)
  ).toBe("/auth/joined");
  expect(
    recording?.maskAttributeFn?.("class", "button-primary", undefined)
  ).toBe("button-primary");
});

it("preserves SDK timestamps when redacting the event payload", async () => {
  const options = await config();
  const timestamp = new Date("2026-10-09T10:00:00.000Z");
  const event = {
    event: "$pageview",
    timestamp,
    properties: { $current_url: "https://airi.chat/?token=secret" },
  };
  expect(options.before_send(event).timestamp).toBe(timestamp);
});

it("omits replay request and response credentials even if remote body capture is enabled", async () => {
  const options = await config();
  const result = options.session_recording.maskCapturedNetworkRequestFn({
    name: "https://airi.chat/api/team/invite-link/accept?token=secret",
    method: "POST",
    status: 200,
    requestHeaders: { authorization: "Bearer secret" },
    requestBody: '{"token":"secret"}',
    responseHeaders: { location: "/auth/joined?token=secret" },
    responseBody: '{"inviteUrl":"/auth/joined?token=secret"}',
  });
  expect(result).toEqual({
    name: "https://airi.chat/api/team/invite-link/accept",
    method: "POST",
    status: 200,
  });
});

it("masks DOM values that can contain a hidden invite token", async () => {
  const options = await config();
  expect(
    options.session_recording.maskAttributeFn("value", "secret", undefined)
  ).toBe("[redacted]");
});
