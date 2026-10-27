import {
  createStableMediaLinks,
  signedMediaObjectKey,
  withStableMediaLinks,
} from "@/lib/media/stable-media-links";

const signed = (path: string, token: string) =>
  `https://project.supabase.co/storage/v1/object/sign/conversation-images/${path}?token=${token}`;

describe("stable media links", () => {
  it("keys a signed link by its stored object, not its token", () => {
    expect(signedMediaObjectKey(signed("ig/clip.mp4", "a"))).toBe(
      signedMediaObjectKey(signed("ig/clip.mp4", "b"))
    );
    expect(signedMediaObjectKey("https://cdn.example/clip.mp4")).toBeNull();
    expect(signedMediaObjectKey(null)).toBeNull();
  });

  it("keeps the first link of an object when a refetch re-signs it", () => {
    const link = createStableMediaLinks();

    expect(link(signed("ig/clip.mp4", "first"))).toBe(
      signed("ig/clip.mp4", "first")
    );
    expect(link(signed("ig/clip.mp4", "second"))).toBe(
      signed("ig/clip.mp4", "first")
    );
    expect(link(signed("ig/photo.jpg", "other"))).toBe(
      signed("ig/photo.jpg", "other")
    );
    expect(link("/api/conversations/c1/whatsapp-media/m1")).toBe(
      "/api/conversations/c1/whatsapp-media/m1"
    );
  });

  it("takes the newer link once the kept one is half way to expiring", () => {
    let now = 0;
    const link = createStableMediaLinks(() => now);
    link(signed("ig/clip.mp4", "first"));

    now = 6 * 60 * 60 * 1000;

    expect(link(signed("ig/clip.mp4", "second"))).toBe(
      signed("ig/clip.mp4", "second")
    );
  });

  it("swaps message and attachment links and keeps unchanged messages as they are", () => {
    const link = createStableMediaLinks();
    const first = {
      imageUrl: signed("ig/clip.mp4", "first"),
      attachments: [{ url: signed("ig/clip.mp4", "first") }],
    };
    withStableMediaLinks(first, link);

    const refetched = {
      imageUrl: signed("ig/clip.mp4", "second"),
      attachments: [{ url: signed("ig/clip.mp4", "second") }],
    };
    expect(withStableMediaLinks(refetched, link)).toEqual(first);
    const unchanged = { imageUrl: "https://cdn.example/a.jpg" };
    expect(withStableMediaLinks(unchanged, link)).toBe(unchanged);
  });
});
