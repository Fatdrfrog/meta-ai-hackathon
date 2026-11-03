/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StageLedger } from "./product-stage-ledger";
import type { LedgerRow } from "./product-stage-model";

// "What you said": the owner's own words, product by product, with the name
// and price the models made of them and where each photo is.

const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  key: "cup",
  moment: 2,
  quote: "мына кружка бес жүз теңге",
  onScreen: false,
  name: "Кружка Web UMN",
  price: "500\u00a0₸",
  priceDoubt: false,
  photo: "made",
  ...overrides,
});

const ledger = () => screen.getByRole("region", { name: "What you said" });
const rows = () => within(ledger()).getAllByRole("listitem");

test("credits who heard and priced it, and lays out each product's line", () => {
  render(<StageLedger rows={[row()]} />);

  expect(
    within(ledger()).getByRole("heading", { name: "What you said" })
  ).toBeInTheDocument();
  expect(
    within(ledger()).getByText("Heard by Scribe, priced by Muse Spark")
  ).toBeInTheDocument();
  const [line] = rows();
  expect(within(line!).getByText("0:02")).toBeInTheDocument();
  // The owner's words in «», in their own direction.
  const quote = within(line!).getByTitle("«мына кружка бес жүз теңге»");
  expect(quote).toHaveTextContent(/^«мына кружка бес жүз теңге»$/);
  expect(quote).toHaveAttribute("dir", "auto");
  expect(within(line!).getByText("Кружка Web UMN")).toHaveAttribute(
    "dir",
    "auto"
  );
  expect(within(line!).getByText("500 ₸")).not.toHaveAttribute("data-doubt");
  expect(line!.querySelector('[data-photo="made"]')).toHaveTextContent(
    "Photo made"
  );
  // Nothing to expand with one product.
  expect(within(ledger()).queryByRole("button")).not.toBeInTheDocument();
});

test.each([
  ["made", "Photo made"],
  ["making", "Making photo"],
  ["waiting", "Next in line"],
  ["unmade", "No photo"],
  ["noView", "No clear view"],
] as const)("a photo that's %s says %s", (photo, words) => {
  render(<StageLedger rows={[row({ photo })]} />);
  const state = rows()[0]!.querySelector("[data-photo]")!;
  expect(state).toHaveAttribute("data-photo", photo);
  expect(state).toHaveTextContent(words);
  // Its mark is drawn, not read.
  expect(state.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

test("the price in the owner's words is set apart; words without one read plain", () => {
  render(
    <StageLedger
      rows={[
        row(),
        row({
          key: "panel",
          quote: "Шенжірелердің бағасы небәри он бес мың бес жүзден басталады",
        }),
        row({ key: "hello", quote: "Сәлеметсіздер ме" }),
      ]}
    />
  );
  const [cup, panel, hello] = rows();
  // Paper's quote: the price words at 500, in ink.
  expect(within(cup!).getByText("бес жүз теңге")).toHaveClass(
    "ledgerSaidPrice"
  );
  expect(within(panel!).getByText("он бес мың бес жүзден")).toHaveClass(
    "ledgerSaidPrice"
  );
  expect(hello!.querySelector(".ledgerSaidPrice")).toBeNull();
  expect(within(hello!).getByText("«Сәлеметсіздер ме»")).toBeInTheDocument();
});

test("the product's own words stay out of the price set apart", () => {
  render(
    <StageLedger
      rows={[
        // Grapes, not "a hundred": only the price is in ink.
        row({ key: "grapes", name: "Жүзім", quote: "жүзім бес жүз теңге" }),
        // «Two cradles from five thousand»: the row's name keeps «бесік» out.
        row({ key: "cradle", name: "Бесік", quote: "екі бесік бес мыңнан" }),
      ]}
    />
  );
  const [grapes, cradle] = rows();
  expect(grapes!.querySelector(".ledgerSaidPrice")).toHaveTextContent(
    /^бес жүз теңге$/
  );
  expect(cradle!.querySelector(".ledgerSaidPrice")).toHaveTextContent(
    /^бес мыңнан$/
  );
  expect(
    within(cradle!).getByTitle("«екі бесік бес мыңнан»")
  ).toHaveTextContent(/^«екі бесік бес мыңнан»$/);
});

test("on a phone a long name wraps rather than being cut, its photo's state on a line of its own", () => {
  // «Есімі жазылған медаль ілгіш» needs 199 px and had 103 at 375 px, cut
  // to «Есімі жазыл…», its full name only in a tooltip touch can't reach.
  const css = readFileSync(join(__dirname, "product-stage.module.css"), "utf8");
  const rule = (selector: string, from = 0) => {
    const start = css.indexOf(`${selector} {`, from);
    return css.slice(start, css.indexOf("}", start));
  };
  const wide = css.indexOf("@container ledger (min-width: 36rem)");
  const narrowName = rule(".ledgerName");
  expect(narrowName).not.toMatch(/white-space: nowrap|text-overflow/);
  expect(narrowName).toMatch(/overflow-wrap: anywhere/);
  expect(rule(".ledgerPhoto")).toMatch(/grid-row: 3;/);
  // Wide, a name gets two lines rather than an ellipsis on one.
  expect(rule("  .ledgerName", wide)).toMatch(/-webkit-line-clamp: 2/);
});

test("a price in doubt is marked; a missing one and missing words say so", () => {
  render(
    <StageLedger
      rows={[
        row({ key: "a", priceDoubt: true, price: "5\u00a0₸" }),
        row({ key: "b", price: null, quote: null, moment: null }),
      ]}
    />
  );
  const [doubtful, bare] = rows();
  const price = doubtful!.querySelector("[data-doubt]")!;
  expect(price).toHaveTextContent("5 ₸");
  expect(within(doubtful!).getByText("Check this price")).toHaveClass(
    "sr-only"
  );
  expect(within(bare!).getByText("No price")).toHaveAttribute("data-none");
  expect(bare!.querySelector("[title]")).toHaveAttribute(
    "title",
    "Кружка Web UMN"
  );
});

test("words read on screen are marked as such, not as heard", () => {
  render(
    <StageLedger rows={[row({ quote: "500 ₸ бастап", onScreen: true })]} />
  );
  const [line] = rows();
  expect(within(line!).getByText("Written on screen:")).toHaveClass("sr-only");
  expect(line).toHaveTextContent("Written on screen: «500 ₸ бастап»");
});

test("a long list opens and closes all its rows", () => {
  const many = Array.from({ length: 10 }, (_, n) =>
    row({ key: `p${n}`, name: `Product ${n}` })
  );
  render(<StageLedger rows={many} />);

  // Every row is there for the stylesheet to show or leave out by width.
  expect(rows()).toHaveLength(10);
  const list = within(ledger()).getByRole("list");
  const more = within(ledger()).getByRole("button", { name: "Show all 10" });
  // Past the wide column's eight, too: not only on a phone.
  expect(more).toHaveAttribute("data-more", "all");
  expect(more).toHaveAttribute("aria-controls", list.id);
  expect(list).not.toHaveAttribute("data-expanded");

  fireEvent.click(more);
  expect(list).toHaveAttribute("data-expanded");
  const fewer = within(ledger()).getByRole("button", { name: "Show fewer" });
  expect(fewer).toHaveAttribute("aria-expanded", "true");

  fireEvent.click(fewer);
  expect(list).not.toHaveAttribute("data-expanded");
});

test("five to eight rows only fold on a phone", () => {
  render(
    <StageLedger
      rows={Array.from({ length: 6 }, (_, n) => row({ key: `p${n}` }))}
    />
  );
  expect(
    within(ledger()).getByRole("button", { name: "Show all 6" })
  ).toHaveAttribute("data-more", "narrow");
});
