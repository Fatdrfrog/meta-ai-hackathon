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
import { utils, write } from "xlsx";
import { CsvUpload } from "./csv-upload";

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (
      key: string,
      values?: { row?: number; count?: number; original?: number }
    ) =>
      values?.row
        ? `${key}:${values.row}`
        : values?.original !== undefined
          ? `${key}:${values.original}/${values.count}`
          : values?.count !== undefined
            ? `${key}:${values.count}`
            : key,
}));

function makeWorkbookFile(rows: string[][]): File {
  const workbook = utils.book_new();
  const worksheet = utils.aoa_to_sheet(rows);
  utils.book_append_sheet(workbook, worksheet, "Recipients");
  const buffer = write(workbook, { bookType: "xlsx", type: "array" }) as
    | ArrayBuffer
    | Uint8Array;
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

  const file = new File([arrayBuffer], "recipients.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: jest.fn(async () => arrayBuffer),
  });
  return file;
}

describe("CsvUpload", () => {
  it.each([true, false])("keeps a loaded file compact with replace and clear actions (compact=%s)", async compact => {
    const onRecipientsLoaded = jest.fn();
    const { container } = render(
      <CsvUpload onRecipientsLoaded={onRecipientsLoaded} compact={compact} dropzone variant="plain" />
    );
    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    const file = new File([], "audience.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => "phone,name\n+77001234567,Aibek" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("audience.csv");
    expect(screen.getByText("recipientCount:1")).toBeTruthy();
    expect(screen.queryByText("dropzoneTitle")).toBeNull();
    expect(screen.queryByText("csvFormat")).toBeNull();
    expect(screen.queryByText(/phone,name/)).toBeNull();
    const clickInput = jest.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "replaceFile" }));
    expect(clickInput).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "clearFile" }));
    expect(onRecipientsLoaded).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText("audience.csv")).toBeNull();
    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(screen.getByText(compact ? /phone,name/ : "csvFormat")).toBeTruthy();
  });

  it("keeps recipient-limit warnings visible with the compact loaded file", async () => {
    const onRecipientsLoaded = jest.fn();
    const { container } = render(
      <CsvUpload onRecipientsLoaded={onRecipientsLoaded} recipientLimit={1} compact dropzone />
    );
    const file = new File([], "large-audience.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: async () => "phone,name\n+77001234567,Aibek\n+77001234568,Samat",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText("large-audience.csv");
    expect(screen.queryByText("dropzoneTitle")).toBeNull();
    expect(screen.getByText("truncationNotice:2/1")).toBeTruthy();
    expect(onRecipientsLoaded).toHaveBeenLastCalledWith([expect.objectContaining({ phone: "+77001234567" })]);
  });

  it("emits recipients and client-safe file evidence together after parsing succeeds", async () => {
    const onRecipientsLoaded = jest.fn();
    const onUploadedAudienceChange = jest.fn();
    const { container } = render(
      <CsvUpload
        onRecipientsLoaded={onRecipientsLoaded}
        uploadedAudienceEvidence={null}
        uploadedRecipientCount={0}
        onUploadedAudienceChange={onUploadedAudienceChange}
      />
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(
      ["phone,name\n+77001234567,Aibek"],
      "campaign-audience.csv",
      { type: "text/csv" }
    );
    Object.defineProperty(file, "text", {
      value: jest.fn(async () => "phone,name\n+77001234567,Aibek"),
    });

    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() =>
      expect(onUploadedAudienceChange).toHaveBeenCalledWith({
        recipients: [
          expect.objectContaining({
            phone: "+77001234567",
            name: "Aibek",
          }),
        ],
        uploadEvidence: {
          originalFilename: "campaign-audience.csv",
          selectedAt: expect.any(String),
        },
      })
    );
    expect(onRecipientsLoaded).not.toHaveBeenCalled();
  });

  it("clears the controlled audience when a replacement fails", async () => {
    const onUploadedAudienceChange = jest.fn();
    const { container } = render(
      <CsvUpload
        onRecipientsLoaded={jest.fn()}
        uploadedAudienceEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
        uploadedRecipientCount={2}
        onUploadedAudienceChange={onUploadedAudienceChange}
      />
    );

    expect(screen.getByText("accepted.csv")).toBeTruthy();
    expect(screen.getByText("recipientCount:2")).toBeTruthy();

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const invalidFile = new File(["name\nNo phone"], "broken.csv", {
      type: "text/csv",
    });
    Object.defineProperty(invalidFile, "text", {
      value: jest.fn(async () => "name\nNo phone"),
    });
    fireEvent.change(input!, { target: { files: [invalidFile] } });

    expect(await screen.findByText("errors.whatsappMissingPhone")).toBeTruthy();
    expect(onUploadedAudienceChange).toHaveBeenCalledTimes(1);
    expect(onUploadedAudienceChange).toHaveBeenCalledWith(null);
  });

  it("clears prior recipients, file details and variable mappings on invalid replacement", async () => {
    const onRecipientsLoaded = jest.fn();
    const { container } = render(
      <CsvUpload
        onRecipientsLoaded={onRecipientsLoaded}
        templateVariables={["1"]}
      />
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const upload = (contents: string, name: string) => {
      const file = new File([contents], name, { type: "text/csv" });
      Object.defineProperty(file, "text", { value: async () => contents });
      fireEvent.change(input!, { target: { files: [file] } });
    };
    upload("phone,var1\n+77001234567,discount", "accepted.csv");
    await screen.findByText("accepted.csv");
    expect(screen.queryByText(/Auto-detected mappings:/)).toBeNull();
    expect(screen.getByText("recipientCount:1")).toBeTruthy();

    upload("phone,var1\nKZ.123456789012,discount", "invalid.csv");
    expect(
      await screen.findByText("errors.whatsappInvalidPhone:2")
    ).toBeTruthy();
    expect(screen.queryByText("accepted.csv")).toBeNull();
    expect(screen.queryByText("recipientCount:1")).toBeNull();
    expect(screen.queryByText(/Auto-detected mappings:/)).toBeNull();
    expect(screen.getByText("csvFormat")).toBeTruthy();
    expect(onRecipientsLoaded).toHaveBeenLastCalledWith([]);
  });

  describe("skipped rows", () => {
    function uploadText(container: HTMLElement, contents: string, name: string) {
      const input =
        container.querySelector<HTMLInputElement>('input[type="file"]');
      const file = new File([contents], name, { type: "text/csv" });
      Object.defineProperty(file, "text", { value: async () => contents });
      fireEvent.change(input!, { target: { files: [file] } });
    }

    it("lists rows without a usable phone and keeps the rest", async () => {
      const onRecipientsLoaded = jest.fn();
      const { container } = render(
        <CsvUpload onRecipientsLoaded={onRecipientsLoaded} />
      );
      uploadText(
        container,
        "phone,name\n+77001234567,Ok\ninvalid,Bad\n,Missing phone",
        "audience.csv"
      );

      const panel = await screen.findByTestId("csv-upload-skipped-rows");
      expect(panel.textContent).toContain("skipped.title:2");
      expect(panel.textContent).toContain("skipped.row:3");
      expect(panel.textContent).toContain("invalid");
      expect(panel.textContent).toContain("skipped.reasons.invalid_phone");
      expect(panel.textContent).toContain("skipped.row:4");
      expect(panel.textContent).toContain("skipped.reasons.missing_recipient");
      expect(onRecipientsLoaded).toHaveBeenLastCalledWith([
        expect.objectContaining({ phone: "+77001234567", name: "Ok" }),
      ]);
      expect(screen.getByText("recipientCount:1")).toBeTruthy();
    });

    it("shows the first 20 skipped rows and counts the rest", async () => {
      const { container } = render(<CsvUpload onRecipientsLoaded={jest.fn()} />);
      const badRows = Array.from({ length: 25 }, (_, index) => `bad${index},X`);
      uploadText(
        container,
        ["phone,name", "+77001234567,Ok", ...badRows].join("\n"),
        "audience.csv"
      );

      const panel = await screen.findByTestId("csv-upload-skipped-rows");
      expect(panel.querySelectorAll("li")).toHaveLength(20);
      expect(panel.textContent).toContain("skipped.more:5");
    });

    it("downloads every skipped row as a CSV named after the file", async () => {
      const createObjectURL = jest.fn((blob: Blob) => {
        void blob;
        return "blob:skipped";
      });
      const revokeObjectURL = jest.fn();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      const click = jest
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          expect(this.download).toBe("spring list-skipped.csv");
          expect(this.href).toBe("blob:skipped");
        });
      const { container } = render(<CsvUpload onRecipientsLoaded={jest.fn()} />);
      uploadText(
        container,
        'phone,name\n+77001234567,Ok\n"=HYPERLINK(1)",Bad',
        "spring list.csv"
      );

      fireEvent.click(await screen.findByRole("button", { name: /skipped.download/ }));

      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:skipped");
      // jsdom's Blob has no text(); FileReader reads it.
      const text = await new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(createObjectURL.mock.calls[0][0] as Blob);
      });
      expect(text).toContain("skipped.columns.row,skipped.columns.value");
      // A formula cell is neutralized before a spreadsheet opens it.
      expect(text).toContain("3,'=HYPERLINK(1),skipped.reasons.invalid_phone");
      click.mockRestore();
    });

    it("hides the skipped rows when the file is cleared", async () => {
      const { container } = render(<CsvUpload onRecipientsLoaded={jest.fn()} />);
      uploadText(container, "phone\n+77001234567\ninvalid", "audience.csv");
      await screen.findByTestId("csv-upload-skipped-rows");

      fireEvent.click(screen.getByRole("button", { name: "clearFile" }));

      expect(screen.queryByTestId("csv-upload-skipped-rows")).toBeNull();
    });

    it("shows nothing when every row is usable", async () => {
      const { container } = render(<CsvUpload onRecipientsLoaded={jest.fn()} />);
      uploadText(container, "phone\n+77001234567", "audience.csv");
      await screen.findByText("audience.csv");
      expect(screen.queryByTestId("csv-upload-skipped-rows")).toBeNull();
    });
  });

  it("says how many duplicate rows were merged next to the count", () => {
    const { rerender } = render(
      <CsvUpload
        onRecipientsLoaded={jest.fn()}
        uploadedAudienceEvidence={{
          originalFilename: "spring-campaign-recipients-final.xlsx",
          selectedAt: "2026-10-05T08:00:00.000Z",
        }}
        uploadedRecipientCount={249}
        mergedDuplicateCount={1}
        onUploadedAudienceChange={jest.fn()}
      />
    );

    expect(
      screen.getByText("recipientCount:249 · mergedDuplicates:1")
    ).toBeTruthy();
    // Long names wrap between words, so ".xlsx" is not split on a phone.
    const fileName = screen.getByText("spring-campaign-recipients-final.xlsx");
    expect(fileName.className).toContain("break-words");
    expect(fileName.className).not.toContain("break-all");

    rerender(
      <CsvUpload
        onRecipientsLoaded={jest.fn()}
        uploadedAudienceEvidence={{
          originalFilename: "spring-campaign-recipients-final.xlsx",
          selectedAt: "2026-10-05T08:00:00.000Z",
        }}
        uploadedRecipientCount={249}
        onUploadedAudienceChange={jest.fn()}
      />
    );
    expect(screen.getByText("recipientCount:249")).toBeTruthy();
    expect(screen.queryByText(/mergedDuplicates/)).toBeNull();
  });

  it("does not restore an older upload after a newer replacement failed", async () => {
    const onRecipientsLoaded = jest.fn();
    const { container } = render(
      <CsvUpload onRecipientsLoaded={onRecipientsLoaded} />
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    let finishOlder!: (text: string) => void;
    const older = new File([], "older.csv", { type: "text/csv" });
    Object.defineProperty(older, "text", {
      value: () =>
        new Promise<string>(resolve => {
          finishOlder = resolve;
        }),
    });
    fireEvent.change(input!, { target: { files: [older] } });
    const newer = new File([], "newer.csv", { type: "text/csv" });
    Object.defineProperty(newer, "text", {
      value: async () => "phone\ninvalid",
    });
    fireEvent.change(input!, { target: { files: [newer] } });
    await screen.findByText("errors.whatsappInvalidPhone:2");
    await act(async () => finishOlder("phone\n+77001234567"));
    expect(onRecipientsLoaded).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText("older.csv")).toBeNull();
    expect(screen.getByText("errors.whatsappInvalidPhone:2")).toBeTruthy();
  });

  it("emits one unified clear transition for a controlled upload", () => {
    const onUploadedAudienceChange = jest.fn();
    render(
      <CsvUpload
        onRecipientsLoaded={jest.fn()}
        uploadedAudienceEvidence={{
          originalFilename: "accepted.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        }}
        uploadedRecipientCount={2}
        onUploadedAudienceChange={onUploadedAudienceChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "clearFile" }));

    expect(onUploadedAudienceChange).toHaveBeenCalledTimes(1);
    expect(onUploadedAudienceChange).toHaveBeenCalledWith(null);
  });

  it.each(["phone\n+77001234567", "phone\ninvalid"])(
    "cancels callbacks from a pending upload on unmount",
    async contents => {
      const onUploadedAudienceChange = jest.fn();
      const onParsingChange = jest.fn();
      const { container, unmount } = render(
        <CsvUpload
          onUploadedAudienceChange={onUploadedAudienceChange}
          onParsingChange={onParsingChange}
        />
      );
      let finishRead!: (text: string) => void;
      const file = new File([], "pending.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", {
        value: () =>
          new Promise<string>(resolve => {
            finishRead = resolve;
          }),
      });
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [file] },
      });
      expect(onParsingChange).toHaveBeenLastCalledWith(true);
      unmount();
      expect(onParsingChange).toHaveBeenLastCalledWith(false);
      await act(async () => finishRead(contents));
      expect(onUploadedAudienceChange).not.toHaveBeenCalled();
      expect(onParsingChange.mock.calls.map(call => call[0])).toEqual([
        true,
        false,
      ]);
    }
  );

  it("uses translated dropzone copy without repeating file formats in the button", () => {
    const onRecipientsLoaded = jest.fn();

    render(
      <CsvUpload
        onRecipientsLoaded={onRecipientsLoaded}
        compact
        dropzone
        variant="plain"
      />
    );

    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(screen.getByText("dropzoneDescription")).toBeTruthy();
    expect(screen.getByRole("button", { name: /browseFile/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /xlsx/i })).toBeNull();
  });

  it("keeps the file input outside the browse button so one click opens one picker", () => {
    const onRecipientsLoaded = jest.fn();
    const { container } = render(
      <CsvUpload
        onRecipientsLoaded={onRecipientsLoaded}
        compact
        dropzone
        variant="plain"
      />
    );

    const browseButton = screen.getByRole("button", { name: /browseFile/i });
    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(fileInput).not.toBeNull();
    expect(fileInput?.className).toContain("hidden");
    expect(browseButton.querySelector('input[type="file"]')).toBeNull();
  });

  it("reports XLSX parsing progress before exposing parsed recipients", async () => {
    const onRecipientsLoaded = jest.fn();
    const onParsingChange = jest.fn();
    const { container } = render(
      <CsvUpload
        onRecipientsLoaded={onRecipientsLoaded}
        onParsingChange={onParsingChange}
      />
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    await act(async () => {
      fireEvent.change(input!, {
        target: {
          files: [
            makeWorkbookFile([
              ["phone", "name"],
              ["+77001234567", "Aibek"],
            ]),
          ],
        },
      });
    });

    await waitFor(() =>
      expect(onRecipientsLoaded).toHaveBeenCalledWith([
        expect.objectContaining({
          phone: "+77001234567",
          name: "Aibek",
        }),
      ])
    );
    expect(onParsingChange.mock.calls.map(call => call[0])).toEqual([
      true,
      false,
    ]);
  });
});
