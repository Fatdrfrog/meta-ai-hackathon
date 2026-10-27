/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  installDomPolyfills,
  setTestLocale,
} from "./business-locations-test-utils";
import { CountrySelect, formatCountryOption } from "./country-select";

jest.mock(
  "next-intl",
  () => jest.requireActual("./business-locations-test-utils").nextIntlTestMock
);

beforeAll(() => {
  installDomPolyfills();
});

afterEach(() => {
  setTestLocale("en");
});

function renderSelect(value: string) {
  const onChange = jest.fn();
  render(
    <CountrySelect value={value} onChange={onChange} aria-label="Country" />
  );
  return {
    onChange,
    trigger: screen.getByRole("combobox", { name: "Country" }),
  };
}

it("shows the chosen country by name and code", () => {
  const { trigger } = renderSelect("KZ");
  expect(trigger).toHaveTextContent("Kazakhstan (KZ)");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("shows a placeholder before a country is chosen", () => {
  const { trigger } = renderSelect("");
  expect(trigger).toHaveTextContent("Choose a country");
});

// Rendering and filtering all 249 options in jsdom outlasts the default 5 s
// when the machine is busy.
it("lists every ISO country and finds one by name or code", async () => {
  const user = userEvent.setup();
  const { onChange, trigger } = renderSelect("KZ");

  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findAllByRole("option")).toHaveLength(249);

  await user.type(screen.getByPlaceholderText("Search countries"), "uzbek");
  expect(
    screen.getAllByRole("option").map(option => option.textContent)
  ).toEqual(["Uzbekistan (UZ)"]);

  await user.clear(screen.getByPlaceholderText("Search countries"));
  await user.type(screen.getByPlaceholderText("Search countries"), "kg");
  await user.click(screen.getByRole("option", { name: "Kyrgyzstan (KG)" }));

  expect(onChange).toHaveBeenCalledWith("KG");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
}, 20_000);

it("says when no country matches", async () => {
  const user = userEvent.setup();
  const { trigger } = renderSelect("");

  await user.click(trigger);
  await user.type(screen.getByPlaceholderText("Search countries"), "zzzz");

  expect(screen.getByText("No country found.")).toBeVisible();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

it("labels countries in the app locale", async () => {
  const user = userEvent.setup();
  setTestLocale("ru");
  const { trigger } = renderSelect("KZ");

  expect(trigger).toHaveTextContent("Казахстан (KZ)");
  await user.click(trigger);
  await user.type(screen.getByPlaceholderText("Search countries"), "узбек");
  expect(screen.getByRole("option", { name: "Узбекистан (UZ)" })).toBeVisible();
  expect(formatCountryOption("KZ", "kz")).toBe("Қазақстан (KZ)");
});
