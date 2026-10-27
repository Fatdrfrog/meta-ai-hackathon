import {
  getVertexPlatformAccessToken,
  resolveVertexEmbeddingProjectId,
} from "@/lib/ai/vertex-auth";
import { getVertexProjectIdFromEnv } from "@/lib/ai/vertex-env";

jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: {
    reranker: {
      debug: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    },
  },
}));

import { rankRecordsWithVertexRankingApi } from "./vertex-ranking-api";

jest.mock("@/lib/ai/vertex-auth", () => ({
  getVertexPlatformAccessToken: jest.fn(() => Promise.resolve("fake-token")),
  resolveVertexEmbeddingProjectId: jest.fn(() => Promise.resolve("my-project")),
}));

jest.mock("@/lib/ai/vertex-env", () => ({
  getVertexProjectIdFromEnv: jest.fn(() => "my-project"),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

describe("rankRecordsWithVertexRankingApi", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    jest.mocked(getVertexPlatformAccessToken).mockResolvedValue("fake-token");
    jest
      .mocked(resolveVertexEmbeddingProjectId)
      .mockResolvedValue("my-project");
    jest.mocked(getVertexProjectIdFromEnv).mockReturnValue("my-project");
  });

  it("returns ranked ids and scores on 200", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            records: [
              { id: "1", score: 0.91 },
              { id: "0", score: 0.42 },
            ],
          })
        ),
    });

    const out = await rankRecordsWithVertexRankingApi({
      query: "refund policy",
      records: [
        { id: "0", title: "A", content: "foo" },
        { id: "1", title: "B", content: "bar" },
      ],
      topN: 2,
    });

    expect(out).toEqual([
      { id: "1", score: 0.91 },
      { id: "0", score: 0.42 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("discoveryengine.googleapis.com");
    expect(url).toContain("rankingConfigs/default_ranking_config:rank");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("refund policy");
    expect(body.ignoreRecordDetailsInResponse).toBe(true);
    expect(body.records).toHaveLength(2);
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve("denied"),
    });
    const out = await rankRecordsWithVertexRankingApi({
      query: "q",
      records: [{ id: "0", content: "x" }],
      topN: 1,
    });
    expect(out).toBeNull();
  });
});
