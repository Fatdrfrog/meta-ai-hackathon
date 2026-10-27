/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WhatsAppWelcomeSequencesManager } from "./welcome-sequences-manager";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

const messages: Record<string, string> = {
  "actions.cancel": "Cancel",
  "actions.copyId": "Copy sequence ID",
  "actions.create": "Create",
  "actions.delete": "Delete",
  "actions.edit": "Edit",
  "actions.save": "Save",
  "actions.sync": "Sync from Meta",
  "alerts.copied": "Sequence ID copied",
  "alerts.createFailed": "Failed to create welcome message sequence",
  "alerts.deleteConfirm": "Delete welcome sequence {name}?",
  "alerts.deleteFailed": "Failed to delete welcome message sequence",
  "alerts.loadFailed": "Failed to load welcome message sequences",
  "alerts.updateFailed": "Failed to update welcome message sequence",
  "alerts.usedInAdDeleteBlocked":
    "This sequence is linked to an active ad and cannot be deleted.",
  "badges.usedInAd": "Used in ad",
  "dialog.createTitle": "Create welcome sequence",
  "dialog.description": "Meta sends this sequence.",
  "dialog.editTitle": "Edit welcome sequence",
  "empty.description": "Create a sequence once.",
  "empty.title": "No welcome sequences yet",
  "fields.autofill": "Autofill",
  "fields.empty": "Not set",
  "fields.iceBreakers": "FAQs",
  "fields.text": "Text",
  "form.autofill": "Prefilled customer message",
  "form.autofillPlaceholder": "Hello! Can I get more info?",
  "form.iceBreakerPlaceholder": "Quick reply {index}",
  "form.iceBreakers": "FAQ buttons",
  "form.name": "Name",
  "form.namePlaceholder": "Driver sign-up",
  "form.text": "Welcome text",
  "form.textPlaceholder": "Hi! Tell us what you need help with.",
  "preview.empty": "Add content to preview the sequence.",
  "preview.emptyText": "Welcome text is not set.",
  "preview.title": "Preview",
  summary: "{count} sequences synced from Meta",
};

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const template = messages[key] || key;
    if (!values) return template;
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      template
    );
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const originalFetch = global.fetch;
const originalClipboard = navigator.clipboard;
const originalMatchMedia = window.matchMedia;

describe("WhatsAppWelcomeSequencesManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sequences: [
          {
            id: "seq-1",
            name: "Driver sign-up",
            text: "Welcome",
            autofillMessageContent: "Hello",
            iceBreakers: [{ title: "Pricing" }],
            is_used_in_ad: true,
          },
        ],
      }),
    }) as typeof fetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
    installMatchMedia();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("renders synced sequences, copies IDs, and blocks deleting used sequences", async () => {
    render(<WhatsAppWelcomeSequencesManager workspaceId="workspace-1" />);

    expect(await screen.findByText("Driver sign-up")).toBeInTheDocument();
    expect(screen.getByText("Used in ad")).toBeInTheDocument();
    expect(screen.getByText("seq-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy sequence ID" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("seq-1");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Sequence ID copied");

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
