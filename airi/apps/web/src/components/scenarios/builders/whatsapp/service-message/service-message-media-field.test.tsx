/** @jest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { ScenarioRequestError } from "@/lib/scenarios/client";
import { ServiceMessageMediaField } from "./service-message-media-field";

let mockLocale = "en";

jest.mock("next-intl", () => {
  const enMessages = jest.requireActual<{
    Scenarios: Record<string, string>;
  }>("../../../../../../messages/scenarios/en/page.json").Scenarios;
  const ruMessages = jest.requireActual<{
    Scenarios: Record<string, string>;
  }>("../../../../../../messages/scenarios/ru/page.json").Scenarios;
  return {
    useFormatter: () => ({
      number: (value: number, options: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat(mockLocale, options).format(value),
    }),
    useTranslations:
      () => (key: string, values?: Record<string, string | number>) => {
        if (
          key !== "whatsappServiceMediaFileTooLarge" &&
          key !== "whatsappServiceCarouselMediaUnsupported"
        ) {
          return key;
        }
        const messages = mockLocale === "ru" ? ruMessages : enMessages;
        return (messages[key] || key).replace(/\{(\w+)\}/g, (_match, name) =>
          String(values?.[name] ?? "")
        );
      },
  };
});

beforeEach(() => {
  mockLocale = "en";
});

const image: ScenarioActionAttachment = {
  mediaType: "image",
  url: "https://cdn.example/photo.png",
};
const labels = { uploadLabel: "Add media", removeLabel: "Remove media" };
const file = new File(["image"], "photo.png", { type: "image/png" });

it("does not restore media removed during an upload", async () => {
  let finish!: (value: ScenarioActionAttachment) => void;
  const upload = jest.fn(
    () =>
      new Promise<ScenarioActionAttachment>(resolve => {
        finish = resolve;
      })
  );
  const onChange = jest.fn();
  render(
    <ServiceMessageMediaField
      {...labels}
      attachment={image}
      upload={upload}
      onChange={onChange}
    />
  );
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove media" }));
  await act(async () => {
    finish({ ...image, url: "https://cdn.example/new.png" });
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(undefined);
});

it("keeps an upload that finishes after the attached media's signed URL arrives", async () => {
  let finish!: (value: ScenarioActionAttachment) => void;
  const upload = jest.fn(
    () =>
      new Promise<ScenarioActionAttachment>(resolve => {
        finish = resolve;
      })
  );
  const onChange = jest.fn();
  const stored = { bucket: "media", path: "workspace/photo.png" };
  const field = (url: string) => (
    <ServiceMessageMediaField
      {...labels}
      attachment={{ ...image, ...stored, url }}
      upload={upload}
      onChange={onChange}
    />
  );
  const { rerender } = render(field("gcs://media/workspace/photo.png"));
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  // The scenario opened before its media was signed; the display URL lands
  // while the replacement uploads.
  rerender(
    field(
      "https://storage.googleapis.com/media/workspace/photo.png?X-Goog-Signature=1"
    )
  );
  // Still uploading: the replace action stays busy.
  expect(
    screen.getByRole("button", { name: "whatsappServiceReplaceMedia" })
  ).toBeDisabled();
  const replacement = { ...image, url: "https://cdn.example/new.png" };
  await act(async () => {
    finish(replacement);
  });
  expect(onChange).toHaveBeenCalledWith(replacement, undefined);
});

it("discards an upload after leaving its document and returning", async () => {
  let finish!: (value: ScenarioActionAttachment) => void;
  const upload = jest.fn(
    () =>
      new Promise<ScenarioActionAttachment>(resolve => {
        finish = resolve;
      })
  );
  const onChange = jest.fn();
  const field = (key: string) => (
    <ServiceMessageMediaField
      key={key}
      {...labels}
      upload={upload}
      onChange={onChange}
    />
  );
  const { rerender } = render(field("document-a"));
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  rerender(field("document-b"));
  rerender(field("document-a"));
  await act(async () => {
    finish(image);
  });
  expect(onChange).not.toHaveBeenCalled();
});

it("shows an upload error and lets the author retry", async () => {
  const upload = jest
    .fn()
    .mockRejectedValue(new Error("Private storage credentials unavailable"));
  render(
    <ServiceMessageMediaField
      {...labels}
      upload={upload}
      onChange={jest.fn()}
    />
  );
  await act(async () => {
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "actionImageUploadFailed"
  );
  expect(
    screen.queryByText("Private storage credentials unavailable")
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Add media" })).toHaveAttribute(
    "aria-disabled",
    "false"
  );
});

it("prioritizes the actionable upload failure over a missing-media validation error", async () => {
  const upload = jest.fn().mockRejectedValue(
    new ScenarioRequestError({
      message: "Provider private bucket rejected this video",
      status: 413,
      code: "scenario_asset_upload_too_large",
    })
  );
  render(
    <ServiceMessageMediaField
      {...labels}
      carousel
      error="Media required"
      upload={upload}
      onChange={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "scenario_asset_upload_too_large"
  );
  expect(screen.queryByText("Media required")).toBeNull();
  expect(
    screen.queryByText("Provider private bucket rejected this video")
  ).toBeNull();
});

it("clears an upload failure when the author retries successfully", async () => {
  const upload = jest
    .fn()
    .mockRejectedValueOnce(
      new ScenarioRequestError({
        message: "Network unavailable",
        status: 0,
        code: "scenario_asset_upload_network_failed",
      })
    )
    .mockResolvedValueOnce(image);
  const onChange = jest.fn();
  render(
    <ServiceMessageMediaField {...labels} upload={upload} onChange={onChange} />
  );
  const input = document.querySelector('input[type="file"]')!;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "scenario_asset_upload_network_failed"
  );

  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(image, undefined);
});

it.each([
  ["clip.mp4", "video/mp4", 17, "16 MB"],
  ["photo.png", "image/png", 6, "5 MB"],
])(
  "explains the allowed size for an oversized %s",
  async (name, type, size, limit) => {
    const selectedFile = new File(
      [new Uint8Array(Number(size) * 1024 * 1024)],
      String(name),
      { type: String(type) }
    );
    const upload = jest.fn().mockRejectedValue(
      new ScenarioRequestError({
        message: "File size rejected",
        status: 413,
        code: "scenario_asset_upload_too_large",
      })
    );
    render(
      <ServiceMessageMediaField
        {...labels}
        carousel
        upload={upload}
        onChange={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [selectedFile] },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(String(limit));
  }
);

it("localizes the video size limit in Russian", async () => {
  mockLocale = "ru";
  const selectedFile = new File(
    [new Uint8Array(17 * 1024 * 1024)],
    "clip.mp4",
    { type: "video/mp4" }
  );
  const upload = jest.fn().mockRejectedValue(
    new ScenarioRequestError({
      message: "File size rejected",
      status: 413,
      code: "scenario_asset_upload_too_large",
    })
  );
  render(
    <ServiceMessageMediaField
      {...labels}
      carousel
      upload={upload}
      onChange={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [selectedFile] },
    });
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Файл превышает допустимый размер 16 МБ."
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("MB");
});

it("explains the supported carousel formats and their size limits", async () => {
  const upload = jest.fn().mockRejectedValue(
    new ScenarioRequestError({
      message: "GIF not supported",
      status: 400,
      code: "scenario_asset_upload_unsupported_file",
    })
  );
  render(
    <ServiceMessageMediaField
      {...labels}
      carousel
      upload={upload}
      onChange={jest.fn()}
    />
  );

  await act(async () => {
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["gif"], "photo.gif", { type: "image/gif" })],
      },
    });
  });

  const alert = screen.getByRole("alert");
  for (const detail of ["JPEG", "PNG", "5 MB", "MP4", "3GP", "16 MB"]) {
    expect(alert).toHaveTextContent(detail);
  }
});

it("shows distinct, keyboard-visible replace and remove actions", () => {
  const onChange = jest.fn();
  render(
    <ServiceMessageMediaField
      {...labels}
      attachment={image}
      upload={jest.fn()}
      onChange={onChange}
    />
  );
  const input = document.querySelector('input[type="file"]')!;
  const choose = jest.spyOn(input as HTMLInputElement, "click");
  const replace = screen.getByRole("button", {
    name: "whatsappServiceReplaceMedia",
  });
  const remove = screen.getByRole("button", { name: "Remove media" });
  expect(replace.parentElement).not.toHaveClass("absolute", "opacity-0");
  expect(remove).not.toHaveClass("opacity-0");
  remove.focus();
  expect(remove).toHaveFocus();
  fireEvent.click(replace);
  expect(choose).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(remove);
  expect(onChange).toHaveBeenCalledWith(undefined);
});

it("exposes voice generation without requiring an existing attachment", async () => {
  const voice = {
    mediaType: "audio" as const,
    url: "https://cdn.example/voice.ogg",
  };
  const generateVoice = jest.fn().mockResolvedValue(voice);
  const onChange = jest.fn();
  render(
    <ServiceMessageMediaField
      {...labels}
      generateVoice={generateVoice}
      voiceScriptDefault="Hello"
      onDeliverAsVoiceChange={jest.fn()}
      onChange={onChange}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappServiceMediaVoiceNoteBadge" })
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceMediaGenerateVoice" })
    );
  });
  expect(generateVoice).toHaveBeenCalledWith({ text: "Hello" });
  expect(onChange).toHaveBeenCalledWith(voice, { deliverAsVoice: true });
});

it("asks how to send audio only once an audio file is attached", () => {
  const onDeliverAsVoiceChange = jest.fn();
  const { rerender } = render(
    <ServiceMessageMediaField
      {...labels}
      onDeliverAsVoiceChange={onDeliverAsVoiceChange}
      onChange={jest.fn()}
    />
  );
  expect(
    screen.queryByText("whatsappServiceMediaAudioDeliveryLabel")
  ).toBeNull();

  rerender(
    <ServiceMessageMediaField
      {...labels}
      attachment={{
        mediaType: "audio",
        url: "https://cdn.example/song.mp3",
        fileName: "song.mp3",
        mimeType: "audio/mpeg",
      }}
      onDeliverAsVoiceChange={onDeliverAsVoiceChange}
      onChange={jest.fn()}
    />
  );
  const group = screen.getByRole("group", {
    name: "whatsappServiceMediaAudioDeliveryLabel",
  });
  expect(
    within(group).getByRole("radio", {
      name: "whatsappServiceMediaBasicAudioBadge",
    })
  ).toHaveAttribute("aria-checked", "true");
  // Only .ogg files can go out as a voice note, and the line says why.
  const voice = within(group).getByRole("radio", {
    name: "whatsappServiceMediaVoiceNoteBadge",
  });
  expect(voice).toBeDisabled();
  expect(voice).toHaveAccessibleDescription(
    "whatsappServiceMediaVoiceNeedsOgg"
  );
  // The uppercase badge above the player is gone.
  expect(screen.queryByTestId("whatsapp-service-audio-mode-badge")).toBeNull();
  expect(screen.getByLabelText("whatsappServiceMediaAudio")).toBeTruthy();
});

it("switches an .ogg attachment to a voice note", () => {
  const onDeliverAsVoiceChange = jest.fn();
  render(
    <ServiceMessageMediaField
      {...labels}
      attachment={{
        mediaType: "audio",
        url: "https://cdn.example/voice.ogg",
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
      }}
      onDeliverAsVoiceChange={onDeliverAsVoiceChange}
      onChange={jest.fn()}
    />
  );
  fireEvent.click(
    screen.getByRole("radio", { name: "whatsappServiceMediaVoiceNoteBadge" })
  );
  expect(onDeliverAsVoiceChange).toHaveBeenCalledWith(true);
});

it("names previews by their media type, not the file name", () => {
  render(
    <ServiceMessageMediaField
      {...labels}
      attachment={{ ...image, fileName: "IMG_2044.png" }}
      onChange={jest.fn()}
    />
  );
  expect(screen.getByRole("img")).toHaveAttribute(
    "alt",
    "whatsappServiceMediaImage"
  );
});

it("keeps the voice ID under More and names ElevenLabs only in the info hint", () => {
  render(
    <ServiceMessageMediaField
      {...labels}
      generateVoice={jest.fn()}
      onDeliverAsVoiceChange={jest.fn()}
      onChange={jest.fn()}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "whatsappServiceMediaVoiceNoteBadge" })
  );
  expect(
    screen.getByRole("textbox", {
      name: "whatsappServiceMediaVoiceScriptLabel",
    })
  ).toHaveAttribute(
    "placeholder",
    "whatsappServiceMediaVoiceScriptPlaceholder"
  );
  expect(
    screen.queryByRole("textbox", {
      name: "whatsappServiceMediaVoiceIdPlaceholder",
    })
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "whatsappServiceMore" }));
  expect(
    screen.getByRole("textbox", {
      name: "whatsappServiceMediaVoiceIdPlaceholder",
    })
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "whatsappServiceMediaGenerateVoice" })
  ).toBeDisabled();
});
