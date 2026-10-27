import {
  buildCompleteInviteSchema,
  scorePasswordStrength,
} from "./complete-invite-schema";

const t = (key: string) => key;
const schema = buildCompleteInviteSchema(t);

function parse(fullName: string, password = "Secure123", confirm = password) {
  return schema.safeParse({ fullName, password, confirmPassword: confirm });
}

function issueMessages(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map(issue => issue.message);
}

describe("complete invite schema", () => {
  it.each([
    "Айгерим Нурланова",
    "Әлия Сұлтанқызы",
    "Ұлжан Өмірбекова",
    "Jean-Luc O'Brien",
    "D’Artagnan",
    "Zoë Ångström",
  ])("accepts the name %s", name => {
    expect(parse(name).success).toBe(true);
  });

  it.each(["John2", "<script>", "Anna@corp", "A"])(
    "rejects the name %s",
    name => {
      expect(parse(name).success).toBe(false);
    }
  );

  it("trims surrounding spaces from the name", () => {
    const result = parse("  Айгерим  ");
    expect(result.success && result.data.fullName).toBe("Айгерим");
  });

  it("returns translation keys for name errors", () => {
    expect(issueMessages(parse("John2"))).toEqual(["validation.nameInvalid"]);
  });

  it("accepts Cyrillic upper and lower case letters in passwords", () => {
    expect(parse("Айгерим", "Пароль2026").success).toBe(true);
  });

  it("requires an uppercase letter, a lowercase letter and a number", () => {
    expect(issueMessages(parse("Айгерим", "пароль2026"))).toEqual([
      "validation.passwordUppercase",
    ]);
    expect(issueMessages(parse("Айгерим", "ПАРОЛЬ2026"))).toEqual([
      "validation.passwordLowercase",
    ]);
    expect(issueMessages(parse("Айгерим", "Парольпароль"))).toEqual([
      "validation.passwordNumber",
    ]);
  });

  it("flags mismatched passwords on the confirmation field", () => {
    const result = parse("Айгерим", "Secure123", "Secure124");
    expect(result.success).toBe(false);
    expect(
      !result.success && result.error.issues.map(issue => issue.path)
    ).toEqual([["confirmPassword"]]);
  });
});

describe("password strength", () => {
  it("scores Cyrillic passwords like Latin ones", () => {
    expect(scorePasswordStrength("Пароль2026").level).toBe(
      scorePasswordStrength("Parole2026").level
    );
  });

  it("rates long mixed passwords as strong", () => {
    expect(scorePasswordStrength("Длинный-Пароль-2026").level).toBe("strong");
  });

  it("rates short passwords as weak", () => {
    expect(scorePasswordStrength("abc").level).toBe("weak");
  });
});
