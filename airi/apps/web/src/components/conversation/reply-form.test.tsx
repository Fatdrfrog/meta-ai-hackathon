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
import { useForm } from "react-hook-form";
import { ReplyForm } from "@/components/conversation/reply-form";
import { AttachmentUploadBatchError } from "@/lib/conversation/attachment-upload";
import type { PopulatedMessage } from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";

type ReplyFormValues = { reply: string };

function ReplyFormHarness({
  onAddAttachments = jest.fn(),
  channel = "whatsapp",
  isInstagramCommentThread = false,
  instagramReplyMode = "comment",
  onInstagramReplyModeChange,
  attachments = [],
  onRemoveAttachment = jest.fn(),
  replyingToMessage = null,
}: {
  onAddAttachments?: (
    files: File[],
    options?: { isRetry?: boolean }
  ) => void | Promise<void>;
  channel?: string;
  isInstagramCommentThread?: boolean;
  instagramReplyMode?: "comment" | "private";
  onInstagramReplyModeChange?: (mode: "comment" | "private") => void;
  attachments?: OutboundAttachment[];
  onRemoveAttachment?: (index: number) => void;
  replyingToMessage?: PopulatedMessage | null;
}) {
  const form = useForm<ReplyFormValues>({
    defaultValues: { reply: "" },
  });

  return (
    <ReplyForm
      onSubmitReply={jest.fn()}
      control={form.control}
      handleSubmit={form.handleSubmit}
      register={form.register}
      isSubmitting={false}
      channel={channel}
      attachments={attachments}
      onAddAttachments={onAddAttachments}
      onRemoveAttachment={onRemoveAttachment}
      isInstagramCommentThread={isInstagramCommentThread}
      instagramReplyMode={instagramReplyMode}
      onInstagramReplyModeChange={onInstagramReplyModeChange}
      replyingToMessage={replyingToMessage}
      onClearReplyTo={jest.fn()}
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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("ReplyForm", () => {
  it("renders the chat composer shell used by request conversations", () => {
    render(<ReplyFormHarness />);

    expect(screen.queryByTestId("reply-composer")).not.toBeNull();
    expect(screen.queryByLabelText("Attach files")).not.toBeNull();
    expect(screen.queryByLabelText("Record voice message")).not.toBeNull();
  });

  it("previews the reply target without internal template markers", () => {
    render(
      <ReplyFormHarness
        replyingToMessage={
          {
            _id: "msg_parent",
            text: "[Template: welcome] Hello again",
            author: { firstName: "Aru", lastName: "S" },
          } as unknown as PopulatedMessage
        }
      />
    );

    expect(screen.getByText("Replying to Aru S")).not.toBeNull();
    expect(screen.getByText("Hello again")).not.toBeNull();
  });

  it("previews a media reply target by its attachment type", () => {
    render(
      <ReplyFormHarness
        replyingToMessage={
          {
            _id: "msg_parent",
            text: "",
            mediaType: "image",
          } as unknown as PopulatedMessage
        }
      />
    );

    // The unnamed author comes from the catalog (the mock returns the key).
    expect(screen.getByText("Replying to unnamedCustomer")).not.toBeNull();
    expect(screen.getByText("[image attachment]")).not.toBeNull();
  });

  it("keeps an empty composer to one row even when its placeholder wraps", () => {
    render(<ReplyFormHarness />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 96,
    });

    fireEvent.change(textarea, { target: { value: "A multiline reply" } });
    expect(textarea.style.height).toBe("96px");

    fireEvent.change(textarea, { target: { value: "" } });
    expect(textarea.style.height).toBe("");
    expect(textarea.getAttribute("aria-label")).toBe("enterYourReply");
  });

  it("replaces the voice action with Send while there is reply content", () => {
    render(<ReplyFormHarness />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hello" } });

    expect(screen.getByRole("button", { name: "send" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Record voice message" })
    ).toBeNull();

    fireEvent.change(textarea, { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: "Record voice message" })
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "send" })).toBeNull();
  });

  it("adds pasted clipboard images as attachments when the reply input is focused", async () => {
    const onAddAttachments = jest.fn();
    const imageFile = new File(["image"], "clipboard.png", {
      type: "image/png",
    });

    render(<ReplyFormHarness onAddAttachments={onAddAttachments} />);

    const textarea = screen.getByPlaceholderText("enterYourReply");
    textarea.focus();
    const event = dispatchPaste(textarea, {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => imageFile,
        },
      ],
    });

    await waitFor(() => {
      expect(onAddAttachments).toHaveBeenCalledWith([imageFile]);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("shows pasted image attachments immediately while upload is pending", async () => {
    const upload = createDeferred();
    const onAddAttachments = jest.fn(() => upload.promise);
    const imageFile = new File(["image"], "slow-screenshot.png", {
      type: "image/png",
    });

    render(<ReplyFormHarness onAddAttachments={onAddAttachments} />);

    const textarea = screen.getByPlaceholderText("enterYourReply");
    textarea.focus();
    dispatchPaste(textarea, {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => imageFile,
        },
      ],
    });

    expect(await screen.findByText("slow-screenshot.png")).not.toBeNull();
    expect(screen.queryByText("Uploading...")).not.toBeNull();

    upload.resolve();

    await waitFor(() => {
      expect(screen.queryByText("Uploading...")).toBeNull();
    });
  });

  it("shows selected document attachments immediately while upload is pending", async () => {
    const upload = createDeferred();
    const onAddAttachments = jest.fn(() => upload.promise);
    const documentFile = new File(["document"], "contract.pdf", {
      type: "application/pdf",
    });

    const { container } = render(
      <ReplyFormHarness onAddAttachments={onAddAttachments} />
    );

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [documentFile] },
    });

    expect(await screen.findByText("contract.pdf")).not.toBeNull();
    expect(screen.queryByText("Uploading...")).not.toBeNull();
    expect(onAddAttachments).toHaveBeenCalledWith([documentFile]);

    upload.resolve();

    await waitFor(() => {
      expect(screen.queryByText("Uploading...")).toBeNull();
    });
  });

  it("resends the same file through a retry button after a failed upload", async () => {
    const documentFile = new File(["document"], "contract.pdf", {
      type: "application/pdf",
    });
    const onAddAttachments = jest
      .fn()
      .mockRejectedValueOnce(
        new AttachmentUploadBatchError(
          "contract.pdf: upload timed out. Try again.",
          [documentFile]
        )
      )
      .mockResolvedValueOnce(undefined);

    const { container } = render(
      <ReplyFormHarness onAddAttachments={onAddAttachments} />
    );

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [documentFile] },
    });

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.getByText("contract.pdf: upload timed out. Try again.")
    ).not.toBeNull();

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(onAddAttachments).toHaveBeenCalledTimes(2);
    });
    expect(onAddAttachments).toHaveBeenLastCalledWith([documentFile], {
      isRetry: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("does not offer retry when the failure is not a retryable batch error", async () => {
    const documentFile = new File(["document"], "contract.pdf", {
      type: "application/pdf",
    });
    const onAddAttachments = jest
      .fn()
      .mockRejectedValue(new Error("contract.pdf: rejected"));

    const { container } = render(
      <ReplyFormHarness onAddAttachments={onAddAttachments} />
    );

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [documentFile] },
    });

    expect(await screen.findByText("contract.pdf: rejected")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders visual previews for uploaded image, video, and PDF attachments", () => {
    render(
      <ReplyFormHarness
        attachments={[
          {
            mediaType: "image",
            mimeType: "image/png",
            fileName: "photo.png",
            url: "https://cdn.example.com/photo.png",
          },
          {
            mediaType: "video",
            mimeType: "video/mp4",
            fileName: "clip.mp4",
            url: "https://cdn.example.com/clip.mp4",
          },
          {
            mediaType: "document",
            mimeType: "application/pdf",
            fileName: "contract.pdf",
            url: "https://cdn.example.com/contract.pdf",
          },
        ]}
      />
    );

    expect(screen.getByAltText("photo.png").getAttribute("src")).toBe(
      "https://cdn.example.com/photo.png"
    );
    expect(
      screen.getByLabelText("Video preview: clip.mp4").getAttribute("src")
    ).toBe("https://cdn.example.com/clip.mp4");
    expect(
      screen.getByTitle("PDF preview: contract.pdf").getAttribute("src")
    ).toBe("https://cdn.example.com/contract.pdf");
  });

  it("previews the picked local file instead of the private stored URL", () => {
    render(
      <ReplyFormHarness
        attachments={[
          {
            mediaType: "image",
            mimeType: "image/png",
            fileName: "photo.png",
            url: "https://project.supabase.co/storage/v1/object/public/conversation-attachments/outbound/photo.png",
            previewUrl: "blob:local-photo",
          },
        ]}
      />
    );

    expect(screen.getByAltText("photo.png").getAttribute("src")).toBe(
      "blob:local-photo"
    );
  });

  it("exposes WhatsApp document types in the file picker", () => {
    const { container } = render(<ReplyFormHarness channel="whatsapp" />);

    const input = container.querySelector('input[type="file"]');

    expect(input).not.toBeNull();
    expect(input?.getAttribute("accept")).toContain("application/pdf");
  });

  it("rejects Instagram office documents before upload", async () => {
    const onAddAttachments = jest.fn();
    const documentFile = new File(["document"], "contract.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const { container } = render(
      <ReplyFormHarness
        channel="instagram"
        onAddAttachments={onAddAttachments}
      />
    );

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [documentFile] },
    });

    await screen.findByText(/Instagram accepts/i);
    expect(onAddAttachments).not.toHaveBeenCalled();
    expect(screen.queryByText("contract.docx")).toBeNull();
  });

  it("accepts Instagram PDF attachments", async () => {
    const onAddAttachments = jest.fn().mockResolvedValue(undefined);
    const documentFile = new File(["document"], "contract.pdf", {
      type: "application/pdf",
    });

    const { container } = render(
      <ReplyFormHarness
        channel="instagram"
        onAddAttachments={onAddAttachments}
      />
    );

    fireEvent.change(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [documentFile] } }
    );

    await waitFor(() =>
      expect(onAddAttachments).toHaveBeenCalledWith([documentFile])
    );
  });

  it("rejects Instagram images over Meta's 8 MB limit", async () => {
    const onAddAttachments = jest.fn();
    const largeImage = new File(["image"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(largeImage, "size", { value: 9 * 1024 * 1024 });

    const { container } = render(
      <ReplyFormHarness
        channel="instagram"
        onAddAttachments={onAddAttachments}
      />
    );

    fireEvent.change(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [largeImage] } }
    );

    await screen.findByText(/limited to 8 MB/i);
    expect(onAddAttachments).not.toHaveBeenCalled();
  });

  it("leaves normal text paste alone", () => {
    const onAddAttachments = jest.fn();
    render(<ReplyFormHarness onAddAttachments={onAddAttachments} />);

    const textarea = screen.getByPlaceholderText("enterYourReply");
    textarea.focus();
    const event = dispatchPaste(textarea, {
      items: [
        {
          kind: "string",
          type: "text/plain",
        },
      ],
    });

    expect(onAddAttachments).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("shows Instagram comment reply modes and hides attachments", () => {
    const onInstagramReplyModeChange = jest.fn();
    render(
      <ReplyFormHarness
        channel="instagram"
        isInstagramCommentThread
        onInstagramReplyModeChange={onInstagramReplyModeChange}
      />
    );

    fireEvent.click(screen.getByText("instagramPrivateReply"));

    expect(onInstagramReplyModeChange).toHaveBeenCalledWith("private");
    expect(screen.queryByLabelText("Attach files")).toBeNull();
    expect(screen.queryByLabelText("Record voice message")).toBeNull();
  });

  it("allows attachments in Instagram direct-message threads", () => {
    const originalMediaRecorder = global.MediaRecorder;
    global.MediaRecorder = {
      isTypeSupported: (type: string) => type.startsWith("audio/mp4"),
    } as unknown as typeof MediaRecorder;
    try {
      render(<ReplyFormHarness channel="instagram" />);

      expect(screen.queryByLabelText("Attach files")).not.toBeNull();
      expect(screen.queryByLabelText("Record voice message")).not.toBeNull();
    } finally {
      global.MediaRecorder = originalMediaRecorder;
    }
  });

  it("hides the Instagram voice button when the browser can only record Ogg or WebM", () => {
    const originalMediaRecorder = global.MediaRecorder;
    global.MediaRecorder = {
      isTypeSupported: (type: string) =>
        type.startsWith("audio/ogg") || type.startsWith("audio/webm"),
    } as unknown as typeof MediaRecorder;
    try {
      render(<ReplyFormHarness channel="instagram" />);

      expect(screen.queryByLabelText("Attach files")).not.toBeNull();
      expect(screen.queryByLabelText("Record voice message")).toBeNull();
    } finally {
      global.MediaRecorder = originalMediaRecorder;
    }
  });
});

describe("ReplyForm recording lifecycle", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices"
  );
  const originalMediaRecorder = global.MediaRecorder;
  let getUserMedia: jest.Mock;
  let stopTrack: jest.Mock;
  let stream: MediaStream;
  let recorders: MockMediaRecorder[];

  class MockMediaRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void | Promise<void>) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
      this.ondataavailable?.({
        data: new Blob(["voice"], { type: "audio/webm" }),
      });
    }
    stop() {
      this.state = "inactive";
      // MediaRecorder emits stop asynchronously after cleanup returns.
      void Promise.resolve().then(() => this.onstop?.());
    }
  }

  beforeEach(() => {
    recorders = [];
    stopTrack = jest.fn();
    stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    getUserMedia = jest.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    global.MediaRecorder = MockMediaRecorder as unknown as typeof MediaRecorder;
  });

  afterEach(() => {
    global.MediaRecorder = originalMediaRecorder;
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("discards active voice recording on unmount instead of uploading after a chat switch", async () => {
    const onAddAttachments = jest.fn();
    const { unmount } = render(
      <ReplyFormHarness onAddAttachments={onAddAttachments} />
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Record voice message"));
    });
    expect(recorders).toHaveLength(1);
    expect(recorders[0].state).toBe("recording");

    await act(async () => {
      unmount();
    });

    expect(recorders[0].state).toBe("inactive");
    expect(stopTrack).toHaveBeenCalled();
    expect(onAddAttachments).not.toHaveBeenCalled();
  });

  it("releases microphone permission that resolves after unmount without starting a recorder", async () => {
    const permission = createDeferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const onAddAttachments = jest.fn();
    const { unmount } = render(
      <ReplyFormHarness onAddAttachments={onAddAttachments} />
    );
    fireEvent.click(screen.getByLabelText("Record voice message"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      permission.resolve(stream);
    });

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recorders).toHaveLength(0);
    expect(onAddAttachments).not.toHaveBeenCalled();
  });
});
