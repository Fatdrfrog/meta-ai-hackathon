/**
 * @jest-environment jsdom
 */

import { downloadTextFile } from "./download";

describe("downloadTextFile", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let createObjectURL: jest.Mock<string, [Blob]>;
  let revokeObjectURL: jest.Mock<void, [string]>;

  beforeEach(() => {
    createObjectURL = jest.fn((_blob: Blob) => "blob:offices");
    revokeObjectURL = jest.fn((_url: string) => undefined);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("clicks a temporary download link for the text, then cleans up", async () => {
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({
          href: this.href,
          download: this.download,
          attached: document.body.contains(this),
        });
        expect(revokeObjectURL).not.toHaveBeenCalled();
      });

    downloadTextFile({
      filename: "offices.csv",
      text: "\uFEFFname\r\nАбай",
      mimeType: "text/csv;charset=utf-8",
    });

    expect(clicked).toEqual([
      { href: "blob:offices", download: "offices.csv", attached: true },
    ]);
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:offices");

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    // The BOM is written as the three UTF-8 bytes EF BB BF.
    const bytes = new Uint8Array(await readBlobBytes(blob));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    await expect(readBlobText(blob.slice(3))).resolves.toBe("name\r\nАбай");
  });

  it("removes the link and revokes the URL when the click throws", () => {
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() =>
      downloadTextFile({
        filename: "offices.csv",
        text: "name",
        mimeType: "text/csv;charset=utf-8",
      })
    ).toThrow("blocked");
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:offices");
  });
});

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
