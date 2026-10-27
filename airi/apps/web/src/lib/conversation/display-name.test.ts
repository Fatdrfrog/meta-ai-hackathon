import { getConversationTitle, getNameInitials } from "./display-name";

const unnamed = { customer: "Клиент", group: "Группа Telegram" };

describe("getConversationTitle", () => {
  it("prefers the manager's rename", () => {
    expect(
      getConversationTitle(
        {
          channel: "whatsapp",
          rename: "  VIP Aigerim  ",
          user: { _id: "wa_77001234567", firstName: "Aigerim" },
        },
        unnamed
      )
    ).toBe("VIP Aigerim");
  });

  it("uses a Telegram group's own title before the sender's name", () => {
    expect(
      getConversationTitle(
        {
          channel: "telegram",
          user: { _id: "tg_1", firstName: "Bob" },
          chat: { type: "supergroup", title: "Support group" },
        },
        unnamed
      )
    ).toBe("Support group");
  });

  it("parses the stored 'Customer (wa_…)' chat title instead of showing it raw", () => {
    expect(
      getConversationTitle(
        {
          channel: "whatsapp",
          chat: { title: "Customer (wa_77001234567)" },
        },
        unnamed
      )
    ).toBe("77001234567");
  });

  it("falls back to the client name with the WhatsApp number", () => {
    expect(
      getConversationTitle(
        {
          channel: "whatsapp",
          rename: " ",
          user: { _id: "wa_77001234567", firstName: "Aigerim" },
        },
        unnamed
      )
    ).toBe("Aigerim (77001234567)");
  });
});

describe("getConversationTitle placeholders", () => {
  it("shows the translated customer placeholder when nothing names the customer", () => {
    expect(getConversationTitle({ channel: "web_widget" }, unnamed)).toBe(
      "Клиент"
    );
    expect(
      getConversationTitle({ channel: "whatsapp", user: {} }, unnamed)
    ).toBe("Клиент");
  });

  it("shows the translated group placeholder for an untitled Telegram group", () => {
    expect(
      getConversationTitle(
        { channel: "telegram", chat: { type: "supergroup" } },
        unnamed
      )
    ).toBe("Группа Telegram");
  });
});

describe("getNameInitials", () => {
  it.each([
    ["Aigerim Nurlanovna", "AN"],
    ["aigerim (77001234567)", "A"],
    ["Ádám Éva Kovács", "ÁÉ"],
    ["+7 700 123 4567", "7"],
    ["   ", "?"],
  ])("%s -> %s", (name, initials) => {
    expect(getNameInitials(name)).toBe(initials);
  });
});
