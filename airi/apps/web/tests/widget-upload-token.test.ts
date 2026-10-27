import assert from "node:assert/strict";
import test from "node:test";
import {
  generateVisitorToken,
  generateWidgetUploadToken,
  verifyVisitorToken,
  verifyWidgetUploadToken,
} from "../src/lib/widget/visitor-auth";

test("upload capabilities cannot authorize widget chat and chat tokens cannot authorize upload bytes", async () => {
  const prior = process.env.WIDGET_JWT_SECRET;
  process.env.WIDGET_JWT_SECRET =
    "isolated-local-test-secret-for-widget-uploads";
  try {
    const upload = await generateWidgetUploadToken({
      visitorId: "visitor",
      companyId: "company",
      workspaceId: "workspace",
      sourceId: "source",
      reservationId: "reservation",
      path: "web_widget/workspace/object",
      bytes: 4,
      mimeType: "image/png",
      fileName: "image.png",
    });
    const chat = await generateVisitorToken({
      scope: "widget",
      visitorId: "visitor",
      workspaceId: "workspace",
      sourceId: "source",
    });
    assert.equal(await verifyVisitorToken(upload), null);
    assert.equal(await verifyWidgetUploadToken(chat), null);
    assert.equal((await verifyWidgetUploadToken(upload))?.bytes, 4);
    assert.equal((await verifyVisitorToken(chat))?.visitorId, "visitor");
    assert.equal(
      await verifyWidgetUploadToken(upload.slice(0, -5) + "other"),
      null
    );
  } finally {
    if (prior === undefined) delete process.env.WIDGET_JWT_SECRET;
    else process.env.WIDGET_JWT_SECRET = prior;
  }
});
