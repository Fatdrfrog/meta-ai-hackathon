const mockEvents: string[] = [];
const mockAfter = jest.fn();
let mockSchedulePostHogFlush: ((flush: () => Promise<void>) => void) | null =
  null;
jest.mock("next/server", () => ({
  after: (...args: unknown[]) => mockAfter(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  configureServerPostHogRequestFlush: (
    schedule: (flush: () => Promise<void>) => void
  ) => {
    mockSchedulePostHogFlush = schedule;
  },
}));

jest.mock("@opentelemetry/api-logs", () => ({
  logs: {
    setGlobalLoggerProvider: () => {
      mockEvents.push("posthog-logger");
    },
  },
}));

jest.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

jest.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: () => ({}),
}));

jest.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {},
}));

jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  configureMediaApiCreativeAssetReadUrlPort: () => {
    mockEvents.push("media-port");
  },
}));

import { register } from "./instrumentation";

const ORIGINAL_NEXT_RUNTIME = process.env.NEXT_RUNTIME;

afterEach(() => {
  mockAfter.mockReset();
  mockSchedulePostHogFlush = null;
  mockEvents.length = 0;
  if (ORIGINAL_NEXT_RUNTIME === undefined) {
    delete process.env.NEXT_RUNTIME;
  } else {
    process.env.NEXT_RUNTIME = ORIGINAL_NEXT_RUNTIME;
  }
});

describe("web instrumentation registration", () => {
  it("connects server event delivery to the active Next request lifetime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await register();

    expect(mockSchedulePostHogFlush).not.toBeNull();
    const flush = async () => undefined;
    mockSchedulePostHogFlush!(flush);
    expect(mockAfter).toHaveBeenCalledWith(flush);
  });

  it("registers the PostHog logger and media read port in Node", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(mockEvents).toEqual(["posthog-logger", "media-port"]);
  });

  it("does not load Node-only instrumentation in the Edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(mockEvents).toEqual([]);
    expect(mockSchedulePostHogFlush).toBeNull();
  });
});
