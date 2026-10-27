import {
  InstagramSendError,
  readInstagramGraphFailure,
  toInstagramSendError,
  type InstagramSendFailureContext,
} from "@/lib/instagram/send-errors";

function graphResponse(status: number, body: unknown): Response {
  return {
    status,
    statusText: "Error",
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

async function classify(
  error: Record<string, unknown>,
  context: InstagramSendFailureContext = { kind: "dm" },
  status = 400
) {
  const failure = await readInstagramGraphFailure(
    graphResponse(status, { error }),
    "https://graph.instagram.com/v25.0/me/messages"
  );
  return toInstagramSendError(failure, context);
}

describe("toInstagramSendError", () => {
  it.each([
    [
      "outside-window subcode",
      { code: 10, error_subcode: 2534022, message: "Outside window" },
      { kind: "dm" },
      "instagram_outside_allowed_window",
    ],
    [
      "outside-window subcode on a private reply",
      { code: 10, error_subcode: 2534022, message: "Outside window" },
      { kind: "private_reply" },
      "instagram_outside_allowed_window",
    ],
    [
      "expired token",
      { code: 190, message: "Error validating access token" },
      { kind: "dm" },
      "instagram_token_invalid",
    ],
    [
      "rate limit",
      { code: 613, message: "Calls to this api have exceeded the rate limit." },
      { kind: "dm" },
      "instagram_rate_limited",
    ],
    [
      "unavailable recipient",
      { code: 551, message: "This person isn't available right now." },
      { kind: "dm" },
      "instagram_recipient_unavailable",
    ],
    [
      "permission error with the HUMAN_AGENT tag",
      { code: 200, message: "(#200) Permissions error" },
      { kind: "dm", usedHumanAgentTag: true },
      "instagram_human_agent_not_approved",
    ],
    [
      "permission error without the tag",
      { code: 200, message: "(#200) Permissions error" },
      { kind: "dm" },
      "instagram_permission_missing",
    ],
    [
      "permission error on a comment reply",
      { code: 10, message: "Application does not have permission" },
      { kind: "comment_reply" },
      "instagram_comments_permission_missing",
    ],
    [
      "rejected attachment",
      { code: 100, message: "Upload attachment failure." },
      { kind: "dm", isAttachment: true },
      "instagram_attachment_rejected",
    ],
  ] as const)("classifies %s", async (_label, error, context, expected) => {
    const result = await classify(error, context);
    expect(result).toBeInstanceOf(InstagramSendError);
    expect(result.code).toBe(expected);
  });

  it("keeps Meta's sentence but never the raw JSON for unknown errors", async () => {
    const result = await classify({
      code: 1,
      message: "An unknown error occurred",
      fbtrace_id: "trace",
    });

    expect(result.code).toBe("instagram_send_failed");
    expect(result.message).toBe(
      "Instagram rejected the message: An unknown error occurred"
    );
    expect(result.httpStatus).toBe(502);
  });

  it("handles non-JSON error bodies", async () => {
    const failure = await readInstagramGraphFailure(
      graphResponse(502, "<html>Bad gateway</html>"),
      "https://graph.instagram.com/v25.0/me/messages"
    );

    const result = toInstagramSendError(failure, { kind: "dm" });
    expect(result.code).toBe("instagram_send_failed");
    expect(result.message).toBe("Instagram rejected the message.");
  });
});
