/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageSwitcher } from "./language-switcher";

const refresh = jest.fn();
const push = jest.fn();
const setLocale = jest.fn((_locale: string) => Promise.resolve());

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => "/airichat/kb/article-1",
  useSearchParams: () => new URLSearchParams("view=docs"),
}));

jest.mock("next-intl", () => ({
  useLocale: () => "ru",
  useTranslations: () => (key: string) =>
    ({
      changeLanguage: "Change language",
      kazakh: "Kazakh",
      english: "English",
      russian: "Russian",
    })[key] ?? key,
}));

jest.mock("@/app/actions", () => ({
  setLocale: (locale: string) => setLocale(locale),
}));

jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});

describe("LanguageSwitcher", () => {
  beforeEach(() => {
    refresh.mockClear();
    push.mockClear();
    setLocale.mockClear();
  });

  it("disables article languages that are not available and uses the resolved active locale", () => {
    render(
      <LanguageSwitcher activeLocale="en" availableLocales={["en", "kz"]} />
    );

    expect(screen.getByRole("button", { name: "English" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Russian" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Kazakh" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Russian" }));
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("allows all supported locales when no article availability limit is provided", () => {
    render(<LanguageSwitcher activeLocale="en" />);

    expect(
      screen.getAllByRole("button").map(button => button.textContent)
    ).toEqual(["Change language", "Kazakh", "English", "Russian"]);
    expect(screen.getByRole("button", { name: "English" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Russian" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Kazakh" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Russian" }));

    expect(setLocale).toHaveBeenCalledWith("ru");
  });

  it("writes locale to the current URL when syncSearchParam is enabled", async () => {
    render(<LanguageSwitcher activeLocale="en" syncSearchParam />);

    fireEvent.click(screen.getByRole("button", { name: "Russian" }));

    await waitFor(() => {
      expect(setLocale).toHaveBeenCalledWith("ru");
      expect(push).toHaveBeenCalledWith(
        "/airichat/kb/article-1?view=docs&locale=ru"
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
