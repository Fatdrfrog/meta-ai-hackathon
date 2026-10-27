const mockInit = jest.fn();
const mockCapture = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: mockInit,
    capture: mockCapture,
    captureException: mockCaptureException,
  },
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

function setBrowserHostname(hostname: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { hostname } },
  });
}

// Drain the SDK import and capture promise chain, including its error handler.
const settleCapture = () => new Promise<void>(resolve => setImmediate(resolve));

function resetClientTestEnvironment() {
  jest.resetModules();
  mockInit.mockReset();
  mockCapture.mockReset();
  mockCaptureException.mockReset();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "test-project-key";
  setBrowserHostname("airi.chat");
}

function restoreClientTestEnvironment() {
  jest.restoreAllMocks();
  if (originalKey === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = originalKey;
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
}

describe("captureClientEvent", () => {
  beforeEach(resetClientTestEnvironment);
  afterEach(restoreClientTestEnvironment);

  it("passes events and properties through the existing SDK initialization", async () => {
    const { captureClientEvent } = await import("./client");
    const properties = {
      workspace_id: "workspace-1",
      error_code: "singleFlowRequired",
    };

    expect(
      captureClientEvent("scenario_activation_blocked", properties)
    ).toBeUndefined();
    await settleCapture();

    expect(mockInit).toHaveBeenCalledWith(
      "test-project-key",
      expect.objectContaining({
        consent_persistence_name: "__ph_opt_in_out_test-project-key",
        before_send: expect.any(Function),
      })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "scenario_activation_blocked",
      properties
    );

    captureClientEvent("another_event");
    await settleCapture();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenLastCalledWith("another_event", undefined);
  });

  it("isolates SDK capture failures from the caller and later events", async () => {
    const failure = new Error("SDK capture failed");
    mockCapture.mockImplementationOnce(() => {
      throw failure;
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const { captureClientEvent } = await import("./client");

    expect(() =>
      captureClientEvent("scenario_activation_blocked")
    ).not.toThrow();
    await settleCapture();

    expect(consoleError).toHaveBeenCalledWith(
      "PostHog capture error:",
      failure
    );
    captureClientEvent("next_event");
    await settleCapture();
    expect(mockCapture).toHaveBeenLastCalledWith("next_event", undefined);
  });

  it("isolates SDK initialization failure and permits a later retry", async () => {
    const failure = new Error("SDK initialization failed");
    mockInit.mockImplementationOnce(() => {
      throw failure;
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const { captureClientEvent } = await import("./client");

    expect(() =>
      captureClientEvent("scenario_activation_blocked")
    ).not.toThrow();
    await settleCapture();

    expect(consoleError).toHaveBeenCalledWith(
      "PostHog client load error:",
      failure
    );
    expect(mockCapture).not.toHaveBeenCalled();

    captureClientEvent("retry_event");
    await settleCapture();
    expect(mockInit).toHaveBeenCalledTimes(2);
    expect(mockCapture).toHaveBeenCalledWith("retry_event", undefined);
  });

  it.each([undefined, "", "   "])(
    "does not initialize or capture without a usable project key (%p)",
    async key => {
      if (key === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      else process.env.NEXT_PUBLIC_POSTHOG_KEY = key;
      const { captureClientEvent } = await import("./client");

      captureClientEvent("scenario_activation_blocked");
      await settleCapture();

      expect(mockInit).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    }
  );

  it.each(["localhost", "127.0.0.1", "app.localhost", "airi.local"])(
    "does not initialize or capture on the local host %s",
    async hostname => {
      setBrowserHostname(hostname);
      const { captureClientEvent } = await import("./client");

      captureClientEvent("scenario_activation_blocked");
      await settleCapture();

      expect(mockInit).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    }
  );
});

describe("captureClientException", () => {
  beforeEach(resetClientTestEnvironment);
  afterEach(restoreClientTestEnvironment);

  it("reports an error that an error boundary caught, with its properties", async () => {
    const { captureClientException } = await import("./client");
    const error = new TypeError("Failed to fetch");

    expect(
      captureClientException(error, { error_boundary: "login" })
    ).toBeUndefined();
    await settleCapture();

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      error_boundary: "login",
    });
  });

  it("keeps SDK failures away from the error boundary", async () => {
    const failure = new Error("SDK exception capture failed");
    mockCaptureException.mockImplementationOnce(() => {
      throw failure;
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const { captureClientException } = await import("./client");

    expect(() =>
      captureClientException(new Error("boundary error"))
    ).not.toThrow();
    await settleCapture();

    expect(consoleError).toHaveBeenCalledWith(
      "PostHog exception capture error:",
      failure
    );
  });

  it("does not report from a local host", async () => {
    setBrowserHostname("localhost");
    const { captureClientException } = await import("./client");

    captureClientException(new Error("boundary error"));
    await settleCapture();

    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
