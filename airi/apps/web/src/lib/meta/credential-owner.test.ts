import {
  attributeMetaCredentialOwner,
  getMetaCredentialOwner,
} from "./credential-owner";

describe("Meta credential ownership", () => {
  it("annotates extensible provider errors without replacing them", () => {
    const error = new Error("source token rejected");

    expect(attributeMetaCredentialOwner(error, "source_token")).toBe(error);
    expect(getMetaCredentialOwner(error)).toBe("source_token");
  });

  it("preserves metadata and cause when a provider error is frozen", () => {
    const original = Object.freeze(
      Object.assign(new Error("configured app rejected"), {
        status: 401,
        metaError: { code: 190 },
      })
    );

    const attributed = attributeMetaCredentialOwner(
      original,
      "configured_app"
    ) as Error & {
      cause?: unknown;
      status?: number;
      metaError?: { code?: number };
    };

    expect(attributed).not.toBe(original);
    expect(attributed.cause).toBe(original);
    expect(attributed.status).toBe(401);
    expect(attributed.metaError?.code).toBe(190);
    expect(getMetaCredentialOwner(attributed)).toBe("configured_app");
  });
});
