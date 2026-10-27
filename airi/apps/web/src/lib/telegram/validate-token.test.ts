const mockGetMe = jest.fn();

jest.mock("../telegram", () => ({
  getMe: (...args: unknown[]) => mockGetMe(...args),
}));

import { validateTelegramBotToken } from "@/lib/telegram/validate-token";

describe("validateTelegramBotToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns Telegram group visibility capability from getMe", async () => {
    mockGetMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Helper",
      username: "helper_bot",
      can_read_all_group_messages: false,
    });

    const result = await validateTelegramBotToken("123:test");

    expect(result).toEqual({
      valid: true,
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "Helper",
        username: "helper_bot",
        can_read_all_group_messages: false,
      },
    });
  });
});
