import { TelegramDraftReveal } from "@/lib/telegram";

const fetchMock = jest.fn();

function telegramOk() {
  return { ok: true, json: async () => ({ ok: true, result: true }) };
}

function sentDraftBodies() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)),
  }));
}

describe("TelegramDraftReveal", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(telegramOk());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("shows the rendered reply once and reports the first draft", async () => {
    const onFirstDraft = jest.fn();
    const reveal = new TelegramDraftReveal({
      chatId: "12345",
      botToken: "bot-token",
      onFirstDraft,
      renderText: text => ({ text: `<b>Airi:</b> ${text}`, parseMode: "HTML" }),
    });

    await reveal.commit("Hello");
    await reveal.commit("Hello again");

    const [draft] = sentDraftBodies();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(draft.url).toBe(
      "https://api.telegram.org/botbot-token/sendMessageDraft"
    );
    expect(draft.body).toMatchObject({
      chat_id: 12345,
      text: "<b>Airi:</b> Hello",
      parse_mode: "HTML",
    });
    expect(draft.body.draft_id).toEqual(expect.any(Number));
    expect(onFirstDraft).toHaveBeenCalledTimes(1);
  });

  it("caps the draft at Telegram's text limit", async () => {
    const reveal = new TelegramDraftReveal({
      chatId: 1,
      botToken: "bot-token",
      renderText: text => ({ text }),
    });

    await reveal.commit("x".repeat(5000));

    expect(sentDraftBodies()[0].body.text).toHaveLength(4000);
  });

  it("sends nothing for blank text or after dispose", async () => {
    const blank = new TelegramDraftReveal({
      chatId: 1,
      botToken: "bot-token",
      renderText: text => ({ text }),
    });
    await blank.commit("   ");

    const disposed = new TelegramDraftReveal({
      chatId: 1,
      botToken: "bot-token",
      renderText: text => ({ text }),
    });
    disposed.dispose();
    await disposed.commit("Hello");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lets a failed draft break the reply", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    });
    const onFirstDraft = jest.fn();
    const reveal = new TelegramDraftReveal({
      chatId: 1,
      botToken: "bot-token",
      onFirstDraft,
      renderText: text => ({ text }),
    });

    await expect(reveal.commit("Hello")).resolves.toBeUndefined();
    expect(onFirstDraft).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric chat id", () => {
    expect(
      () =>
        new TelegramDraftReveal({
          chatId: "@channel",
          renderText: text => ({ text }),
        })
    ).toThrow("numeric chat_id");
  });
});
