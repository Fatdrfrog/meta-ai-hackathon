/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import * as nextIntl from "next-intl";
import { enUS } from "date-fns/locale";
import { DateRangeControl } from "./date-range-control";
import { Calendar } from "./calendar";
import userEvent from "@testing-library/user-event";

jest.mock("next-intl", () =>
  jest
    .requireActual("@/test-support/next-intl-test-utils")
    .createMessagesNextIntlMock()
);

const messages = {
  DateRangeControl: {
    last7Days: "Последние 7 дней",
    last30Days: "Последние 30 дней",
    last90Days: "Последние 90 дней",
    thisWeek: "Эта неделя",
    last12Months: "Последние 12 месяцев",
    select: "Выберите период",
    customRange: "Произвольный период",
    previousMonth: "Предыдущий месяц",
    nextMonth: "Следующий месяц",
  },
};

describe("DateRangeControl", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["en", "Oct", "Mo"],
    ["ru", "окт.", "пн"],
    ["kz", "қаз", "дс"],
  ])(
    "uses the selected %s locale for icon-free calendar months and weekdays",
    (locale, month, weekday) => {
      const originalToLocaleString = Date.prototype.toLocaleString;
      jest.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
        this: Date,
        locales,
        options
      ) {
        return originalToLocaleString.call(
          this,
          locales === "default" ? "ru-RU" : locales,
          options
        );
      });
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Calendar
            iconFree
            captionLayout="dropdown"
            defaultMonth={new Date(2025, 9, 1)}
          />
        </NextIntlClientProvider>
      );

      const monthDropdown = screen.getAllByRole(
        "combobox"
      )[0] as HTMLSelectElement;
      expect(monthDropdown.value).toBe("9");
      expect(
        within(monthDropdown).getByRole("option", { name: month })
      ).toBeTruthy();
      expect(screen.getByText(weekday).closest("th")).not.toBeNull();
    }
  );

  it("preserves an explicit caller locale in an icon-free calendar", () => {
    render(
      <NextIntlClientProvider locale="ru" messages={messages}>
        <Calendar
          iconFree
          locale={enUS}
          captionLayout="dropdown"
          defaultMonth={new Date(2025, 9, 1)}
        />
      </NextIntlClientProvider>
    );

    expect(
      within(screen.getAllByRole("combobox")[0]).getByRole("option", {
        name: "Oct",
      })
    ).toBeTruthy();
    expect(screen.getByText("Mo").closest("th")).not.toBeNull();
  });

  it("keeps default calendars independent of the app locale provider", () => {
    jest.spyOn(nextIntl, "useLocale").mockImplementation(() => {
      throw new Error("No app locale provider");
    });
    const { container } = render(
      <Calendar defaultMonth={new Date(2025, 9, 1)} />
    );

    expect(screen.getByText("October 2025")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("uses visible localized calendar navigation without icons and retains keyboard month changes", async () => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="ru" messages={messages}>
        <DateRangeControl
          iconFree
          value={{
            preset: "30d",
            from: new Date(2025, 0, 15),
            to: new Date(2025, 1, 15),
          }}
          onChange={jest.fn()}
        />
      </NextIntlClientProvider>
    );
    expect(document.querySelector("svg")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Последние 30 дней" }));
    expect(document.querySelector("svg")).toBeNull();
    const next = screen.getByRole("button", { name: "Следующий месяц" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/февраль/i)).not.toBeNull();
    await user.click(screen.getByText("Предыдущий месяц"));
    expect(screen.getByText(/январь/i)).not.toBeNull();
  });

  it("removes caption dropdown chevrons only for an icon-free Calendar", () => {
    const { container } = render(
      <NextIntlClientProvider locale="ru" messages={messages}>
        <Calendar
          iconFree
          captionLayout="dropdown"
          defaultMonth={new Date(2025, 0, 1)}
        />
      </NextIntlClientProvider>
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getByText("Следующий месяц")).not.toBeNull();
  });

  it("uses Russian preset copy and Russian calendar month and weekday names", () => {
    render(
      <NextIntlClientProvider locale="ru" messages={messages}>
        <DateRangeControl
          value={{
            preset: "30d",
            from: new Date(2025, 0, 15),
            to: new Date(2025, 1, 15),
          }}
          onChange={jest.fn()}
        />
      </NextIntlClientProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /Последние 30 дней/ }));

    expect(screen.getAllByText("Последние 7 дней").length).toBeGreaterThan(0);
    expect(screen.getByText(/январь/i)).not.toBeNull();
    expect(screen.getByText("пн")).not.toBeNull();
  });

  it("renders five responsive presets and emits this week without client-owned dates", () => {
    const onChange = jest.fn();
    render(
      <NextIntlClientProvider locale="ru" messages={messages}>
        <DateRangeControl
          value={{ preset: "all", from: null, to: null }}
          onChange={onChange}
        />
      </NextIntlClientProvider>
    );

    const trigger = screen.getByRole("button", {
      name: /Последние 12 месяцев/,
    });
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain("sm:w-[260px]");
    expect(trigger.querySelector('[data-icon="inline-start"]')).not.toBeNull();

    fireEvent.click(trigger);
    expect(
      [
        "Последние 7 дней",
        "Последние 30 дней",
        "Последние 90 дней",
        "Эта неделя",
        "Последние 12 месяцев",
      ].every(
        label => screen.getAllByRole("button", { name: label }).length > 0
      )
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Эта неделя" }));
    expect(onChange).toHaveBeenCalledWith({
      preset: "this_week",
      from: null,
      to: null,
    });
  });
});
