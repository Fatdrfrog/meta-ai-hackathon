const mockCreateSignedUrls = jest.fn();
const mockFrom = jest.fn(() => ({
  createSignedUrls: (...args: unknown[]) => mockCreateSignedUrls(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: { from: (...args: unknown[]) => mockFrom(...(args as [])) },
  },
}));

import {
  CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS,
  parseCustomerMediaObject,
  resolveCustomerMediaReadUrl,
  resolveCustomerMediaReadUrls,
  withCustomerMediaReadUrls,
} from "./customer-media-read-url";

const ORIGIN = "https://project.supabase.co";
const publicUrl = (bucket: string, path: string) =>
  `${ORIGIN}/storage/v1/object/public/${bucket}/${path}`;
const signedUrl = (bucket: string, path: string) =>
  `${ORIGIN}/storage/v1/object/sign/${bucket}/${path}?token=t`;

const WHATSAPP_IMAGE = publicUrl(
  "conversation-images",
  "whatsapp/ws-1/conv-1/msg-1.jpg"
);
const STAFF_FILE = publicUrl(
  "conversation-attachments",
  "outbound/telegram/ws-1/conv-1/1-a-invoice.pdf"
);

const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

describe("customer media read URLs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN;
    mockCreateSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map(path => ({
        path,
        signedUrl: `signed:${path}`,
        error: null,
      })),
      error: null,
    }));
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
  });

  describe("parseCustomerMediaObject", () => {
    it("recognizes customer media in this project's chat buckets", () => {
      expect(parseCustomerMediaObject(WHATSAPP_IMAGE)).toEqual({
        bucket: "conversation-images",
        path: "whatsapp/ws-1/conv-1/msg-1.jpg",
      });
      expect(parseCustomerMediaObject(STAFF_FILE)).toEqual({
        bucket: "conversation-attachments",
        path: "outbound/telegram/ws-1/conv-1/1-a-invoice.pdf",
      });
      expect(
        parseCustomerMediaObject(
          publicUrl("conversation-images", "telegram/ws-1/c/m%20one.png")
        )
      ).toEqual({
        bucket: "conversation-images",
        path: "telegram/ws-1/c/m one.png",
      });
    });

    it.each([
      [
        "a template header providers fetch",
        publicUrl("conversation-images", "whatsapp-template-headers/ws/a.png"),
      ],
      [
        "scenario media",
        publicUrl("conversation-attachments", "scenarios/ws/v.mp4"),
      ],
      ["a studio upload", publicUrl("conversation-images", "studio/ws/a.png")],
      ["a public knowledge-base image", publicUrl("kb-attachments", "a.png")],
      ["an already signed URL", signedUrl("conversation-images", "whatsapp/a")],
      [
        "another host",
        "https://other.supabase.co/storage/v1/object/public/conversation-images/whatsapp/a.jpg",
      ],
      ["a WhatsApp proxy path", "/api/conversations/c/whatsapp-media/m"],
      ["a non-string", 42],
    ])("ignores %s", (_label, value) => {
      expect(parseCustomerMediaObject(value)).toBeNull();
    });

    it.each([
      [
        "the Singapore project's host",
        "https://wnycyavumykzejnjelfb.supabase.co",
      ],
      ["the custom domain", "https://api.airi.chat"],
    ])("treats %s as this project's storage", (_label, alias) => {
      expect(
        parseCustomerMediaObject(
          `${alias}/storage/v1/object/public/conversation-images/whatsapp/ws-1/conv-1/msg-1.jpg`
        )
      ).toEqual({
        bucket: "conversation-images",
        path: "whatsapp/ws-1/conv-1/msg-1.jpg",
      });
    });

    it("recognizes Telegram customer avatars in the private avatars bucket", () => {
      expect(
        parseCustomerMediaObject(publicUrl("avatars", "telegram/5001.jpg"))
      ).toEqual({ bucket: "avatars", path: "telegram/5001.jpg" });
      // Stored before the region move, with the old host and naming.
      expect(
        parseCustomerMediaObject(
          "https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/avatars/telegram/414650383_AQADyKcxGw8QtxgB.jpg"
        )
      ).toEqual({
        bucket: "avatars",
        path: "telegram/414650383_AQADyKcxGw8QtxgB.jpg",
      });
    });

    it("leaves staff profile photos in the avatars bucket alone", () => {
      expect(
        parseCustomerMediaObject(
          publicUrl("avatars", "6f1c0d2e-0000-4000-8000-000000000000/profile")
        )
      ).toBeNull();
    });

    it("still ignores aliased business assets and other buckets", () => {
      const alias = "https://wnycyavumykzejnjelfb.supabase.co";
      expect(
        parseCustomerMediaObject(
          `${alias}/storage/v1/object/public/conversation-images/whatsapp-template-headers/ws/a.png`
        )
      ).toBeNull();
      expect(
        parseCustomerMediaObject(
          `${alias}/storage/v1/object/public/kb-attachments/a.png`
        )
      ).toBeNull();
    });

    it("signs nothing when the Supabase URL is not configured", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      expect(parseCustomerMediaObject(WHATSAPP_IMAGE)).toBeNull();
      expect(
        parseCustomerMediaObject(
          "https://api.airi.chat/storage/v1/object/public/conversation-images/whatsapp/a.jpg"
        )
      ).toBeNull();
    });
  });

  it("signs aliased URLs in the configured project", async () => {
    const legacy =
      "https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/conversation-images/whatsapp/ws-1/conv-1/msg-1.jpg";
    const resolved = await resolveCustomerMediaReadUrls(
      [legacy, WHATSAPP_IMAGE],
      CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
    );

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith("conversation-images");
    expect(mockCreateSignedUrls).toHaveBeenCalledWith(
      ["whatsapp/ws-1/conv-1/msg-1.jpg"],
      CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
    );
    expect(resolved.get(legacy)).toBe("signed:whatsapp/ws-1/conv-1/msg-1.jpg");
    expect(resolved.get(WHATSAPP_IMAGE)).toBe(
      "signed:whatsapp/ws-1/conv-1/msg-1.jpg"
    );
  });

  it("signs once per bucket and maps duplicates and other URLs", async () => {
    const other = "https://cdn.example.com/a.png";
    const resolved = await resolveCustomerMediaReadUrls(
      [WHATSAPP_IMAGE, STAFF_FILE, WHATSAPP_IMAGE, other, null],
      CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
    );

    expect(mockCreateSignedUrls).toHaveBeenCalledTimes(2);
    expect(mockFrom).toHaveBeenCalledWith("conversation-images");
    expect(mockCreateSignedUrls).toHaveBeenCalledWith(
      ["whatsapp/ws-1/conv-1/msg-1.jpg"],
      CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
    );
    expect(resolved.get(WHATSAPP_IMAGE)).toBe(
      "signed:whatsapp/ws-1/conv-1/msg-1.jpg"
    );
    expect(resolved.get(STAFF_FILE)).toBe(
      "signed:outbound/telegram/ws-1/conv-1/1-a-invoice.pdf"
    );
    expect(resolved.get(other)).toBe(other);
  });

  it("keeps the stored URL when signing fails", async () => {
    mockCreateSignedUrls.mockResolvedValue({
      data: null,
      error: { message: "storage unavailable" },
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveCustomerMediaReadUrl(WHATSAPP_IMAGE, 60)).resolves.toBe(
      WHATSAPP_IMAGE
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not touch storage for non-customer URLs", async () => {
    const other = "https://cdn.example.com/a.png";
    await expect(resolveCustomerMediaReadUrl(other, 60)).resolves.toBe(other);
    await expect(
      withCustomerMediaReadUrls([{ imageUrl: other, text: "hi" }])
    ).resolves.toEqual([{ imageUrl: other, text: "hi" }]);
    expect(mockCreateSignedUrls).not.toHaveBeenCalled();
  });

  it("rewrites imageUrl, mediaUrl and attachment URLs in message copies", async () => {
    const original = {
      _id: "msg-1",
      text: "photo",
      imageUrl: WHATSAPP_IMAGE,
      mediaUrl: WHATSAPP_IMAGE,
      attachments: [{ url: STAFF_FILE, name: "invoice.pdf" }, null],
    };

    const [signed] = await withCustomerMediaReadUrls([original]);

    expect(signed).toEqual({
      _id: "msg-1",
      text: "photo",
      imageUrl: "signed:whatsapp/ws-1/conv-1/msg-1.jpg",
      mediaUrl: "signed:whatsapp/ws-1/conv-1/msg-1.jpg",
      attachments: [
        {
          url: "signed:outbound/telegram/ws-1/conv-1/1-a-invoice.pdf",
          name: "invoice.pdf",
        },
        null,
      ],
    });
    expect(original.imageUrl).toBe(WHATSAPP_IMAGE);
    expect(original.attachments[0]?.url).toBe(STAFF_FILE);
  });

  it("signs the author's and the customer's avatar in copies", async () => {
    const avatar = publicUrl("avatars", "telegram/5001.jpg");
    const instagramAvatar = "https://scontent.cdninstagram.com/v/a.jpg";
    const message = {
      _id: "msg-1",
      author: { _id: 5001, firstName: "Ada", avatar_url: avatar },
    };
    const row = {
      _id: "conv-1",
      user: { _id: 5001, avatar_url: avatar },
      messages: [message],
    };
    const instagramRow = {
      _id: "conv-2",
      user: { avatar_url: instagramAvatar },
    };

    const [signedMessage] = await withCustomerMediaReadUrls([message]);
    const [signedRow, untouchedRow] = await withCustomerMediaReadUrls([
      row,
      instagramRow,
    ]);

    expect(mockFrom).toHaveBeenCalledWith("avatars");
    expect(signedMessage).toEqual({
      _id: "msg-1",
      author: {
        _id: 5001,
        firstName: "Ada",
        avatar_url: "signed:telegram/5001.jpg",
      },
    });
    expect(signedRow.user).toEqual({
      _id: 5001,
      avatar_url: "signed:telegram/5001.jpg",
    });
    expect(untouchedRow.user).toEqual({ avatar_url: instagramAvatar });
    expect(message.author.avatar_url).toBe(avatar);
    expect(row.user.avatar_url).toBe(avatar);
  });
});
