/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { SWRConfig } from "swr";
import { CustomerDetailSheet } from "./customer-detail-sheet";

jest.mock("next-intl", () =>
  jest.requireActual("./leads-i18n.test-mock").mockLeadsTranslations()
);

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

function SheetHarness({ open }: { open: boolean }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <button type="button">Acme buyer card</button>
      <CustomerDetailSheet
        workspaceId="workspace-1"
        customerId={open ? "customer-1" : null}
        open={open}
        onOpenChange={() => undefined}
      />
    </SWRConfig>
  );
}

describe("CustomerDetailSheet", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        customer: { _id: "customer-1", displayName: "Acme buyer" },
        linkedConversations: [],
      }),
    })) as jest.Mock;
  });

  it("returns focus to the card or row that opened it", async () => {
    // Radix focuses a Dialog trigger on close; this sheet has none, so focus
    // used to fall to <body> and keyboard users lost their place.
    const { rerender } = render(<SheetHarness open={false} />);
    const opener = screen.getByRole("button", { name: "Acme buyer card" });
    opener.focus();

    rerender(<SheetHarness open />);
    await waitFor(() => {
      expect(document.activeElement).not.toBe(opener);
    });

    rerender(<SheetHarness open={false} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });
});
