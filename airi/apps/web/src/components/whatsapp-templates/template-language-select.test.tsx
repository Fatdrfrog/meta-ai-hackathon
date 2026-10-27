/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { installResizeObserver } from "@/test-support/dom-test-utils";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SUPPORTED_LANGUAGES } from "@icecore/shared/constants/whatsapp-templates";
import { TemplateLanguageSelect } from "./template-language-select";

beforeAll(() => {
  installResizeObserver();
  // cmdk scrolls the active option into view; Radix checks pointer capture.
  const noop = (): void => {};
  for (const [name, value] of Object.entries({
    scrollIntoView: noop,
    hasPointerCapture: (): boolean => false,
    setPointerCapture: noop,
    releasePointerCapture: noop,
  })) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value,
    });
  }
});

function renderSelect(value: string) {
  const onChange = jest.fn();
  const onBlur = jest.fn();
  render(
    <>
      <label htmlFor="template-language">Language</label>
      <TemplateLanguageSelect
        id="template-language"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
      />
    </>
  );
  return {
    onChange,
    onBlur,
    trigger: screen.getByRole("combobox", { name: "Language" }),
  };
}

function optionNames() {
  return screen.getAllByRole("option").map(option => option.textContent);
}

it("shows the chosen language with its code", () => {
  const { trigger } = renderSelect("kk");
  expect(trigger).toHaveTextContent("Kazakh");
  expect(trigger).toHaveTextContent("kk");
});

it("keeps a stored language code that Meta does not list", () => {
  // Meta takes Tagalog as "fil"; an old "tl" stays visible instead of blank.
  const { trigger } = renderSelect("tl");
  expect(trigger).toHaveTextContent("tl");
});

it("lists the main markets first, then every other language by name", async () => {
  const user = userEvent.setup();
  const { trigger } = renderSelect("en");

  await user.click(trigger);
  const names = (await screen.findAllByRole("option")).map(
    option => option.textContent
  );

  expect(names.slice(0, 7)).toEqual([
    "Englishen",
    "English (US)en_US",
    "English (UK)en_GB",
    "Russian · Русскийru",
    "Kazakh · Қазақ тіліkk",
    "Uzbek · Oʻzbekchauz",
    "Afrikaansaf",
  ]);
  expect(names.at(-1)).toBe("Zulu · isiZuluzu");
}, 20_000);

it("lists every template language and finds one by name, own name or code", async () => {
  const user = userEvent.setup();
  const { onChange, onBlur, trigger } = renderSelect("en");

  await user.click(trigger);
  expect(await screen.findAllByRole("option")).toHaveLength(
    SUPPORTED_LANGUAGES.length
  );
  const search = screen.getByPlaceholderText("form.langSearch");

  await user.type(search, "kaz");
  expect(optionNames()).toEqual(["Kazakh · Қазақ тіліkk"]);

  await user.clear(search);
  await user.type(search, "рус");
  expect(optionNames()).toEqual([
    "Russian · Русскийru",
    "Belarusian · Беларускаяbe_BY",
  ]);

  await user.clear(search);
  await user.type(search, "pt_br");
  await user.click(
    screen.getByRole("option", { name: /Portuguese \(Brazil\)/ })
  );

  expect(onChange).toHaveBeenCalledWith("pt_BR");
  expect(onBlur).toHaveBeenCalled();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
}, 20_000);

it("says when no language matches", async () => {
  const user = userEvent.setup();
  const { trigger } = renderSelect("");

  expect(trigger).toHaveTextContent("form.langPlaceholder");
  await user.click(trigger);
  await user.type(screen.getByPlaceholderText("form.langSearch"), "zzzz");

  expect(screen.getByText("form.langEmpty")).toBeVisible();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
