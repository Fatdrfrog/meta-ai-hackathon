/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  EmailContentEditor,
  type EmailContentValue,
} from "./email-content-editor";

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

function ControlledEditor() {
  const [value, setValue] = useState<EmailContentValue>({
    subject: "Hello {{recipientName}}",
    markdown: "Hi {{recipientName}}",
  });

  return (
    <EmailContentEditor
      idPrefix="test-email"
      workspaceId="workspace-1"
      value={value}
      onChange={setValue}
      variables={["recipientName", "workspaceUrl"]}
      previewVariables={{
        recipientName: "Founder",
        workspaceUrl: "https://app.airi.chat",
      }}
    />
  );
}

function ControlledDraftEditor() {
  const [value, setValue] = useState<EmailContentValue>({
    subject: "Default subject",
    markdown: "Default body",
  });

  return (
    <EmailContentEditor
      idPrefix="draft-email"
      workspaceId="workspace-1"
      value={value}
      onChange={setValue}
      draftStorageKey="email-draft:workspace-1"
    />
  );
}

function dispatchPaste(
  element: HTMLElement,
  clipboardData: {
    items?: Array<{
      kind: string;
      type: string;
      getAsFile?: () => File | null;
    }>;
    files?: File[];
  }
) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: clipboardData.items ?? [],
      files: clipboardData.files ?? [],
    },
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

describe("EmailContentEditor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        image: { url: "https://cdn.example.com/email/hero.png" },
      }),
    })) as jest.Mock;
    window.requestAnimationFrame = callback => {
      callback(0);
      return 0;
    };
  });

  it("inserts links, uploaded images, variables, and renders a preview", async () => {
    jest.spyOn(window, "prompt").mockReturnValue("https://example.com");
    const { container } = render(<ControlledEditor />);
    const body = screen.getByLabelText("Body markdown") as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(body.value).toContain("[Link](https://example.com)");

    fireEvent.click(screen.getByRole("button", { name: "{{workspaceUrl}}" }));
    expect(body.value).toContain("{{workspaceUrl}}");

    const upload = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    fireEvent.change(upload, {
      target: {
        files: [
          new File(["image"], "hero] image).png", {
            type: "image/png",
          }),
        ],
      },
    });

    await waitFor(() =>
      expect(body.value).toContain(
        "![hero image](https://cdn.example.com/email/hero.png)"
      )
    );
    expect(body.value).not.toContain("![hero] image).png]");
    expect(screen.getByText("Hello Founder")).toBeTruthy();
  });

  it("uploads pasted clipboard images into the email markdown body", async () => {
    render(<ControlledEditor />);
    const body = screen.getByLabelText("Body markdown") as HTMLTextAreaElement;
    const image = new File(["image"], "clipboard.png", {
      type: "image/png",
    });

    body.focus();
    const event = dispatchPaste(body, {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => image,
        },
      ],
    });

    await waitFor(() =>
      expect(body.value).toContain(
        "![clipboard](https://cdn.example.com/email/hero.png)"
      )
    );
    expect(event.defaultPrevented).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/email-assets",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      })
    );
  });

  it("uploads dropped images into the email markdown body", async () => {
    render(<ControlledEditor />);
    const body = screen.getByLabelText("Body markdown") as HTMLTextAreaElement;
    const image = new File(["image"], "drop.png", { type: "image/png" });

    fireEvent.drop(body, {
      dataTransfer: {
        files: [image],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ],
        types: ["Files"],
      },
    });

    await waitFor(() =>
      expect(body.value).toContain(
        "![drop](https://cdn.example.com/email/hero.png)"
      )
    );
  });

  it("keeps the upload input label-backed so the icon can open the native picker", () => {
    const { container } = render(<ControlledEditor />);
    const upload =
      container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(upload).not.toBeNull();
    expect(upload?.id).toBe("test-email-image-upload");
    expect(upload?.accept).toContain(".png");
    expect(upload?.className).not.toContain("hidden");
    expect(
      container.querySelector(`label[for="${upload?.id}"]`)
    ).not.toBeNull();
  });

  it("restores and persists local email drafts", async () => {
    window.localStorage.setItem(
      "email-draft:workspace-1",
      JSON.stringify({
        subject: "Saved subject",
        markdown: "Saved body",
      })
    );

    render(<ControlledDraftEditor />);

    const subject = (await screen.findByLabelText(
      "Subject"
    )) as HTMLInputElement;
    const body = screen.getByLabelText("Body markdown") as HTMLTextAreaElement;

    expect(subject.value).toBe("Saved subject");
    expect(body.value).toBe("Saved body");

    fireEvent.change(subject, { target: { value: "Updated subject" } });

    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("email-draft:workspace-1") || "{}"
        )
      ).toMatchObject({
        subject: "Updated subject",
        markdown: "Saved body",
      })
    );
  });
});
