const mockGetVertexGenAI = jest.fn();

jest.mock("./vertex-genai-client", () => ({
  getVertexGenAI: (...args: unknown[]) => mockGetVertexGenAI(...args),
}));

import {
  downloadVertexVideoResult,
  extractVertexVideoResults,
  pollVertexVideoOperation,
} from "./vertex-video";

describe("vertex-video", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VERTEX_VIDEO_ENABLED: "true",
      VERTEX_VIDEO_MODEL: "",
      VERTEX_VIDEO_LOCATION: "",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("polls video operations through the SDK video operation helper", async () => {
    const getVideosOperation = jest.fn().mockResolvedValue({
      done: true,
      response: { generatedVideos: [] },
    });
    mockGetVertexGenAI.mockResolvedValue({
      operations: { getVideosOperation },
    });

    await expect(
      pollVertexVideoOperation("operations/video-1")
    ).resolves.toEqual(
      expect.objectContaining({
        name: "operations/video-1",
        done: true,
        response: { generatedVideos: [] },
      })
    );

    expect(getVideosOperation).toHaveBeenCalledWith({
      operation: { name: "operations/video-1" },
    });
  });

  it("extracts generated videos and decodes inline video bytes", async () => {
    const bytes = Buffer.from("fake-mp4").toString("base64");
    const results = extractVertexVideoResults({
      generatedVideos: [
        {
          video: {
            videoBytes: bytes,
            mimeType: "video/mp4",
          },
        },
      ],
    });

    expect(results).toEqual([
      {
        videoBytes: bytes,
        mimeType: "video/mp4",
      },
    ]);
    await expect(downloadVertexVideoResult(results[0])).resolves.toEqual({
      buffer: Buffer.from("fake-mp4"),
      mimeType: "video/mp4",
    });
  });
});
