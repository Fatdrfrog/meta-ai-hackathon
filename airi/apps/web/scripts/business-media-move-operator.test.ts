import { Types } from "mongoose";
import {
  parseMoveMode,
  planLinkRewrites,
  planObjectCopies,
} from "./business-media-move-operator";

const ORIGIN = "https://project.supabase.co/storage/v1/object/public";
const LEGACY = `${ORIGIN}/conversation-images/whatsapp-template-headers/ws/a.png`;
const MOVED = `${ORIGIN}/business-media/whatsapp-template-headers/ws/a.png`;

describe("business media move operator", () => {
  it("is a dry run unless one explicit mode is given", () => {
    expect(parseMoveMode([])).toBe("dry-run");
    expect(parseMoveMode(["--copy"])).toBe("copy");
    expect(parseMoveMode(["--rewrite"])).toBe("rewrite");
    expect(parseMoveMode(["--apply"])).toBe("apply");
    expect(() => parseMoveMode(["--copy", "--apply"])).toThrow("Usage");
    expect(() => parseMoveMode(["--delete"])).toThrow("Unknown mode");
    expect(() => parseMoveMode(["copy"])).toThrow("Usage");
  });

  it("plans field-level rewrites with dotted paths and never touches _id", () => {
    const id = new Types.ObjectId();
    const doc = {
      _id: id,
      name: "Autumn promo",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      header: { link: LEGACY },
      steps: [
        { media: { url: "https://cdn.example.com/x.png" } },
        { media: { url: LEGACY, caption: `See ${LEGACY}` } },
      ],
      customer: `${ORIGIN}/conversation-images/whatsapp/ws/c/m.jpg`,
    };

    expect(planLinkRewrites(doc)).toEqual([
      { path: "header.link", from: LEGACY, to: MOVED },
      { path: "steps.1.media.url", from: LEGACY, to: MOVED },
      {
        path: "steps.1.media.caption",
        from: `See ${LEGACY}`,
        to: `See ${MOVED}`,
      },
    ]);
  });

  it("copies only business prefixes that are not in the target yet", () => {
    const plans = planObjectCopies(
      [
        {
          bucket: "conversation-images",
          path: "whatsapp-template-headers/ws/a.png",
        },
        { bucket: "conversation-images", path: "studio/instagram/ws/p.jpg" },
        { bucket: "conversation-attachments", path: "scenarios/ws/v.mp4" },
        { bucket: "conversation-images", path: "whatsapp/ws/c/m.jpg" },
      ],
      new Set(["studio/instagram/ws/p.jpg"])
    );

    expect(plans).toEqual([
      {
        source: {
          bucket: "conversation-images",
          path: "whatsapp-template-headers/ws/a.png",
        },
        alreadyCopied: false,
      },
      {
        source: {
          bucket: "conversation-images",
          path: "studio/instagram/ws/p.jpg",
        },
        alreadyCopied: true,
      },
      {
        source: {
          bucket: "conversation-attachments",
          path: "scenarios/ws/v.mp4",
        },
        alreadyCopied: false,
      },
    ]);
  });
});
