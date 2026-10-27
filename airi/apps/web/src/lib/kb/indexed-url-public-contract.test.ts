import {
  buildIndexedUrlPublicError,
  toPublicIndexedUrlFailure,
} from "@/lib/kb/indexed-url-public-contract";

describe("indexed URL public contract", () => {
  it("builds stable route errors from public error codes", () => {
    expect(buildIndexedUrlPublicError("training_start_failed")).toEqual({
      code: "training_start_failed",
      error: "We couldn't start training. Please try again.",
    });
  });

  it("sanitizes internal failures as generic indexing failures", () => {
    expect(
      toPublicIndexedUrlFailure("permission denied for table kb_indexed_urls")
    ).toEqual({
      failure_code: "generic",
      error_message: "Indexing failed.",
    });
  });

  it("classifies missing readable content without exposing diagnostics", () => {
    expect(toPublicIndexedUrlFailure("No indexable content found")).toEqual({
      failure_code: "no_content",
      error_message: "No readable content was found.",
    });
  });

  it("classifies timeout failures without exposing diagnostics", () => {
    expect(toPublicIndexedUrlFailure("activity timed out")).toEqual({
      failure_code: "timeout",
      error_message: "Indexing timed out.",
    });
  });
});
