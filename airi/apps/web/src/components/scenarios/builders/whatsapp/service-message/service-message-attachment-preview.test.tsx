/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { ServiceMessageAttachmentPreview } from "./service-message-attachment-preview";

const durable = (mediaType: ScenarioActionAttachment["mediaType"]) =>
  ({
    url: "gcs://bucket/workspace/card.png",
    bucket: "bucket",
    path: "workspace/card.png",
    mediaType,
  }) as ScenarioActionAttachment;

describe("ServiceMessageAttachmentPreview", () => {
  it.each(["image", "video"] as const)(
    "holds the place of a %s whose display URL has not arrived",
    mediaType => {
      const { container } = render(
        <ServiceMessageAttachmentPreview
          attachment={durable(mediaType)}
          carousel
          mediaTypeLabel="Card media"
          deliverAsVoice={false}
        />
      );

      expect(
        screen.getByTestId("whatsapp-service-media-pending")
      ).toHaveAccessibleName("Card media");
      expect(container.querySelector("img, video, audio")).toBeNull();
    }
  );

  it("shows an audio player without a source until its display URL arrives", () => {
    const { rerender } = render(
      <ServiceMessageAttachmentPreview
        attachment={durable("audio")}
        carousel={false}
        mediaTypeLabel="Voice note"
        deliverAsVoice
      />
    );
    const pending = screen.getByTestId("whatsapp-service-media-pending");
    expect(pending.tagName).toBe("AUDIO");
    expect(pending).not.toHaveAttribute("src");
    expect(pending).toHaveAccessibleName("Voice note");

    const url = "https://storage.googleapis.com/bucket/note.ogg?sig=1";
    rerender(
      <ServiceMessageAttachmentPreview
        attachment={{ ...durable("audio"), url }}
        carousel={false}
        mediaTypeLabel="Voice note"
        deliverAsVoice
      />
    );
    // The same player, now with its source.
    expect(screen.getByLabelText("Voice note")).toBe(pending);
    expect(pending).toHaveAttribute("src", url);
  });

  it.each([
    [true, "h-24"],
    [false, "h-44"],
  ])(
    "keeps the media frame's height while it waits (carousel: %s)",
    (carousel, heightClass) => {
      render(
        <ServiceMessageAttachmentPreview
          attachment={durable("image")}
          carousel={carousel}
          mediaTypeLabel="Card media"
          deliverAsVoice={false}
        />
      );

      expect(screen.getByTestId("whatsapp-service-media-pending")).toHaveClass(
        heightClass,
        "w-full"
      );
    }
  );

  it("shows signed media", () => {
    const url = "https://storage.googleapis.com/bucket/card.png?sig=1";
    render(
      <ServiceMessageAttachmentPreview
        attachment={{ ...durable("image"), url }}
        carousel={false}
        mediaTypeLabel="Card media"
        deliverAsVoice={false}
      />
    );

    expect(screen.getByRole("img", { name: "Card media" })).toHaveAttribute(
      "src",
      url
    );
    expect(screen.queryByTestId("whatsapp-service-media-pending")).toBeNull();
  });
});
