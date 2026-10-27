jest.mock("@/lib/billing/service", () => ({
  processHalykPostLink: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: jest.fn(),
  },
}));

import { processHalykPostLink } from "@/lib/billing/service";
import { POST } from "./route";

const mockProcessHalykPostLink = processHalykPostLink as jest.Mock;

describe("Halyk postLink route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a structured 400 for malformed JSON callbacks", async () => {
    const response = await POST(
      new Request("https://airi.chat/api/billing/halyk/postlink", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      })
    );

    await expect(response.json()).resolves.toEqual({
      error: "Malformed JSON payload",
    });
    expect(response.status).toBe(400);
    expect(mockProcessHalykPostLink).not.toHaveBeenCalled();
  });
});
