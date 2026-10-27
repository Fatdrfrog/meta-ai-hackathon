/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";

import type { WhatsAppQrManagerListItem } from "@/lib/whatsapp/qr-entry-points/client";

import type { WhatsAppQrManagerController } from "./use-whatsapp-qr-manager";
import { WhatsAppQrList } from "./whatsapp-qr-list";

jest.mock("next-intl", () => ({
  useFormatter: () => ({ dateTime: () => "Aug 12, 2026" }),
  useTranslations: () => (key: string) => key,
}));

function item(): WhatsAppQrManagerListItem {
  return {
    entryPointId: "entry-1",
    placementName: "Counter",
    status: "ACTIVE",
    version: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    readiness: "ready",
    reconcilePending: false,
    assignment: null,
  };
}

function controller(
  overrides: Partial<WhatsAppQrManagerController> = {}
): WhatsAppQrManagerController {
  return {
    items: [],
    hasCommittedPage: false,
    filters: { query: "", facet: { kind: "all" } },
    setFilters: jest.fn(),
    loading: false,
    error: null,
    canGoPrevious: false,
    canGoNext: false,
    goPrevious: jest.fn(),
    goNext: jest.fn(),
    refresh: jest.fn(async () => undefined),
    ...overrides,
  };
}

function renderList(value: WhatsAppQrManagerController) {
  return render(
    <WhatsAppQrList
      workspaceId="workspace-1"
      sourceOptions={[]}
      controller={value}
      onCreate={jest.fn()}
    />
  );
}

describe("WhatsAppQrList background loading", () => {
  it("uses a skeleton only before the first page has committed", () => {
    const initial = renderList(controller({ loading: true }));
    expect(
      initial.container.querySelector('[aria-label="manager.loading"]')
    ).not.toBeNull();
    initial.unmount();

    const committedEmpty = renderList(
      controller({ loading: true, hasCommittedPage: true })
    );
    expect(
      committedEmpty.container.querySelector('[aria-label="manager.loading"]')
    ).toBeNull();
    expect(screen.getByText("manager.firstEmptyTitle")).not.toBeNull();
  });

  it("marks retained cards busy, disables paging, and keeps progress quiet", () => {
    const { container } = renderList(
      controller({
        items: [item()],
        hasCommittedPage: true,
        loading: true,
        canGoNext: true,
      })
    );

    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    expect(
      (
        screen.getByRole("button", {
          name: "actions.next",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    const status = screen.getByRole("status");
    expect(status.className).toContain("sr-only");
    expect(status.textContent).toBe("manager.refreshing");
    expect(
      Array.from(container.querySelectorAll('[data-slot="badge"]')).some(
        badge => badge.textContent === "manager.refreshing"
      )
    ).toBe(false);
  });
});
