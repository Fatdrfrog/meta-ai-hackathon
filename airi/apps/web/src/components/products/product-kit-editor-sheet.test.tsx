/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ProductKitRecord } from "@/lib/products/types";
import { installMatchMedia } from "@/test-support/dom-test-utils";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import {
  carouselEditBanner,
  KitCarouselEditBeforeMake,
  ProductKitEditorSheet,
} from "./product-kit-editor-sheet";

// The sheet the kit's editors open in: Paper's frame, Esc and the focus
// back on the button that opened it, and one prefill per source.

const mockPrefills: unknown[] = [];

jest.mock("./product-carousel-editor", () => ({
  ProductCarouselEditor: (props: { prefill: { name: string } }) => {
    mockPrefills.push(props.prefill);
    return <p>Editing {props.prefill.name}</p>;
  },
}));

installMatchMedia();

const WS = "workspace-1";
const ids = ["651f1f77bcf86cd799439011", "651f1f77bcf86cd799439012"];

function SheetWithTrigger() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Edit cards
      </button>
      <ProductKitEditorSheet
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        title="Edit carousel"
        subtitle="Nothing goes to Meta until you press Make."
        banner="This goes to Meta as a new template."
      >
        <input aria-label="Card text" />
      </ProductKitEditorSheet>
    </>
  );
}

test("Esc closes the sheet and the focus goes back to the button that opened it", async () => {
  render(<SheetWithTrigger />);
  const trigger = screen.getByRole("button", { name: "Edit cards" });
  act(() => trigger.focus());
  fireEvent.click(trigger);

  const dialog = await screen.findByRole("dialog", { name: "Edit carousel" });
  expect(dialog).toHaveAccessibleDescription(
    "Nothing goes to Meta until you press Make."
  );
  expect(dialog).toHaveTextContent("This goes to Meta as a new template.");
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

  fireEvent.keyDown(dialog, { key: "Escape" });

  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  expect(document.activeElement).toBe(trigger);
});

test("the scrim behind the sheet is the paper's warm ink, not airi's black", async () => {
  render(<SheetWithTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Edit cards" }));
  await screen.findByRole("dialog", { name: "Edit carousel" });
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  expect(overlay).toHaveClass("scrim");
});

test("Close is the sheet's own button, in English", async () => {
  render(<SheetWithTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Edit cards" }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
});

test("before Make, saved edits open at once, as one prefill across re-renders", async () => {
  mockPrefills.length = 0;
  const saved = {
    name: "my_cards",
    components: [{ type: "BODY" as const, text: "My words" }],
  };
  const sheet = (productIds: string[]) => (
    <KitCarouselEditBeforeMake
      open
      onOpenChange={jest.fn()}
      workspaceId={WS}
      productIds={productIds}
      language="kk"
      draftScope="products:session-1"
      saved={saved}
      drafts={null}
      onDrafts={jest.fn()}
      onSave={jest.fn()}
    />
  );
  global.fetch = jest.fn() as unknown as typeof fetch;
  const view = render(sheet([...ids]));

  expect(await screen.findByText("Editing my_cards")).toBeInTheDocument();
  // A new array of the same products: no new prefill, nothing fetched.
  view.rerender(sheet([...ids]));
  view.rerender(sheet([...ids]));
  expect(new Set(mockPrefills).size).toBe(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test("the banner says why the carousel goes to Meta as a new template", () => {
  const kit = (
    carousel: Partial<NonNullable<ProductKitRecord["parts"]["carousel"]>>
  ): ProductKitRecord => ({
    id: "kit-1",
    createdAt: "2026-11-03T04:14:05.000Z",
    language: "kk",
    productIds: ids,
    importId: null,
    status: "waiting_for_meta",
    pricesChanged: false,
    parts: {
      carousel: {
        state: "submitted",
        templateId: "tpl-1",
        templateName: "products_kit_1",
        cardCount: 2,
        metaStatus: "PENDING",
        metaReason: null,
        approvedAt: null,
        error: null,
        edited: false,
        earlier: [],
        ...carousel,
      },
    },
  });

  expect(carouselEditBanner(kit({}))).toBe(
    "Meta is checking products_kit_1 and won't let it change, so this goes to Meta as a new template. The first one stays in Templates; the kit will show this one."
  );
  expect(carouselEditBanner(kit({ metaStatus: "APPROVED" }))).toBe(
    "This goes to Meta as a new template; products_kit_1 stays approved in Templates. The kit will show the new one."
  );
  expect(carouselEditBanner(kit({ metaStatus: "REJECTED" }))).toBe(
    "Meta turned products_kit_1 down, so this goes to Meta as a new template. The first one stays in Templates; the kit will show this one."
  );
  expect(carouselEditBanner(kit({ state: "failed", metaStatus: null }))).toBe(
    "The first carousel didn't reach Meta. This sends your cards as a new template."
  );
});
