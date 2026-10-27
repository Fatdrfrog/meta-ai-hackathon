import {
  isAiriChatMessageStopped,
  readAiriChatMessageMetadata,
} from "./airi-chat-message-metadata";

describe("readAiriChatMessageMetadata", () => {
  it("parses each field of a message's metadata once", () => {
    const metadata: Record<string, unknown> = {
      selectedSources: [{ label: "Sales" }],
    };
    const parse = jest.fn(
      (value: Record<string, unknown> | null | undefined) =>
        Array.isArray(value?.selectedSources) ? value.selectedSources.length : 0
    );

    expect(readAiriChatMessageMetadata(metadata, "sources", parse)).toBe(1);
    expect(readAiriChatMessageMetadata(metadata, "sources", parse)).toBe(1);
    expect(parse).toHaveBeenCalledTimes(1);

    // Another field, or another message, is parsed on its own.
    readAiriChatMessageMetadata(metadata, "other", () => null);
    readAiriChatMessageMetadata({ ...metadata }, "sources", parse);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("parses missing metadata without caching it", () => {
    const parse = jest.fn(() => []);
    readAiriChatMessageMetadata(null, "sources", parse);
    readAiriChatMessageMetadata(undefined, "sources", parse);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe("isAiriChatMessageStopped", () => {
  it("is true only for a stopped run's message", () => {
    expect(isAiriChatMessageStopped({ cancelled: true })).toBe(true);
    expect(isAiriChatMessageStopped({ cancelled: "true" })).toBe(false);
    expect(isAiriChatMessageStopped({ failed: true })).toBe(false);
    expect(isAiriChatMessageStopped(null)).toBe(false);
  });
});
