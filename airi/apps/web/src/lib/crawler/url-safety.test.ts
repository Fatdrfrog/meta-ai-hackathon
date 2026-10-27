const mockLookup = jest.fn();
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { CrawlSsrfError, safeCrawlFetch } from "./url-safety";

const originalFetch = global.fetch;
const options = { timeoutMs: 1_000, userAgent: "test-agent" };

describe("safeCrawlFetch", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("ok"));
    global.fetch = mockFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("keeps the crawler's request shape when the caller passes no signal", async () => {
    await safeCrawlFetch("https://example.com/page", options);

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({
      redirect: "manual",
      headers: { "User-Agent": "test-agent" },
    });
    expect(init.signal?.aborted).toBe(false);
  });

  it("leaves the caller's signal on the response so a later abort reaches the body", async () => {
    const caller = new AbortController();

    await safeCrawlFetch("https://example.com/page", {
      ...options,
      signal: caller.signal,
    });
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(false);

    caller.abort(new Error("deadline"));
    expect(init.signal?.aborted).toBe(true);
  });

  it("stops before DNS when the caller's signal is already aborted", async () => {
    const caller = new AbortController();
    const deadline = new Error("deadline");
    caller.abort(deadline);

    await expect(
      safeCrawlFetch("https://example.com/page", {
        ...options,
        signal: caller.signal,
      })
    ).rejects.toBe(deadline);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a private address", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "http://10.0.0.1/admin" },
      })
    );

    await expect(
      safeCrawlFetch("https://example.com/page", options)
    ).rejects.toBeInstanceOf(CrawlSsrfError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
