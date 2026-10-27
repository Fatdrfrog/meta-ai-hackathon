/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { BusinessLocationRecord } from "@/lib/business-locations/types";
import { downloadTextFile } from "@/lib/spreadsheet/download";
import { BusinessLocationsImportDialog } from "./business-locations-import-dialog";
import {
  createOfficeRecord,
  installDomPolyfills,
  jsonResponse,
} from "./business-locations-test-utils";

jest.mock(
  "next-intl",
  () => jest.requireActual("./business-locations-test-utils").nextIntlTestMock
);
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("@/lib/spreadsheet/download", () => ({
  downloadTextFile: jest.fn(),
}));

const OFFICES_URL = "/api/workspaces/workspace-1/business-locations";
const fetchMock = jest.fn();

const abay = createOfficeRecord();
const dostyk = createOfficeRecord({
  key: "kz_almaty_dostyk",
  name: "Dostyk Plaza",
  address: "Samal-2, 111",
  phone: undefined,
  tags: [],
  latitude: 43.233,
  longitude: 76.956,
  sortOrder: 1,
});
const astana = createOfficeRecord({
  key: "kz_astana_mega",
  name: "Mega Silk Way",
  city: "Astana",
  cityKey: "astana",
  address: undefined,
  phone: undefined,
  tags: [],
  latitude: 51.089,
  longitude: 71.406,
  sortOrder: 2,
});

// Renames Abay, keeps Dostyk as it is, adds Esentai without a key and
// leaves Mega Silk Way out.
const UPDATE_CSV = [
  "key,name,country,city,latitude,longitude",
  "kz_almaty_abay,Abay Avenue 2,KZ,Almaty,43.238949,76.889709",
  "kz_almaty_dostyk,Dostyk Plaza,KZ,Almaty,43.233,76.956",
  ",Esentai,KZ,Almaty,43.218,76.928",
].join("\n");

function renderDialog(existing: BusinessLocationRecord[] = [abay]) {
  const onOpenChange = jest.fn();
  const onImported = jest.fn();
  const props = {
    onOpenChange,
    workspaceId: "workspace-1",
    existing,
    onImported,
  };
  const view = render(<BusinessLocationsImportDialog open {...props} />);
  return {
    onOpenChange,
    onImported,
    dialog: () => screen.getByRole("dialog", { name: "Import offices" }),
    setOpen: (open: boolean) =>
      view.rerender(<BusinessLocationsImportDialog open={open} {...props} />),
  };
}

/** A CSV file whose text jsdom can read; the text may arrive later. */
function csvFile(text: string | Promise<string>, name = "offices.csv"): File {
  const file = new File([], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("No file input");
  fireEvent.change(input, { target: { files: [file] } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}

const importButton = (name: RegExp | string = /^Import/) =>
  screen.getByRole("button", { name });

beforeAll(() => {
  installDomPolyfills();
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  jest.mocked(toast.success).mockReset();
  jest.mocked(downloadTextFile).mockReset();
});

it("previews what a CSV changes before anything is saved", async () => {
  renderDialog([abay, dostyk, astana]);
  expect(importButton("Import")).toBeDisabled();
  expect(
    screen.getByText("CSV, XLSX or XLS, up to 500 offices per file.")
  ).toBeVisible();

  chooseFile(
    csvFile(`${UPDATE_CSV}\nkz_almaty_airport,Airport Desk,KZ,Almaty,44.5,78.5`)
  );

  expect(
    await screen.findByText(
      "2 new · 1 updated · 1 unchanged · 1 not in the file"
    )
  ).toBeVisible();
  expect(screen.getByText("File: offices.csv")).toBeVisible();
  expect(
    screen.queryByText("CSV, XLSX or XLS, up to 500 offices per file.")
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Choose another file" })
  ).toBeVisible();
  expect(
    screen.getByRole("checkbox", {
      name: "Deactivate 1 office missing from the file",
    })
  ).not.toBeChecked();
  expect(
    screen.getByText(
      "1 row has no key, so its key was made from country, city and name. Renaming an office in a later file creates a new office."
    )
  ).toBeVisible();
  expect(
    screen.getByText(
      "Not in the file: address, phone, map_url, tags, active, sort_order. Offices already in the list keep their current values for these."
    )
  ).toBeVisible();
  expect(screen.getByText("Check these pins")).toBeVisible();
  expect(
    screen.getByText(
      /^Airport Desk is \d+ km from the other offices in Almaty\. Check its coordinates\.$/
    )
  ).toBeVisible();
  expect(importButton("Import 4 offices")).toBeEnabled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("saves the merged offices, locks while saving, then closes", async () => {
  const user = userEvent.setup();
  const reply = deferred<Response>();
  fetchMock.mockReturnValueOnce(reply.promise);
  const { onOpenChange, onImported, dialog } = renderDialog([
    abay,
    dostyk,
    astana,
  ]);
  chooseFile(csvFile(UPDATE_CSV));
  await user.click(
    await screen.findByRole("button", { name: "Import 3 offices" })
  );

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(OFFICES_URL);
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    offices: [
      {
        key: "kz_almaty_abay",
        name: "Abay Avenue 2",
        country: "KZ",
        city: "Almaty",
        address: "Abay Ave 10",
        phone: "+7 727 000 00 00",
        tags: ["mall"],
        latitude: 43.238949,
        longitude: 76.889709,
        isActive: true,
        sortOrder: 0,
      },
      {
        key: "kz_almaty_dostyk",
        name: "Dostyk Plaza",
        country: "KZ",
        city: "Almaty",
        address: "Samal-2, 111",
        latitude: 43.233,
        longitude: 76.956,
        isActive: true,
        sortOrder: 1,
      },
      {
        key: "kz_almaty_esentai",
        name: "Esentai",
        country: "KZ",
        city: "Almaty",
        latitude: 43.218,
        longitude: 76.928,
        isActive: true,
      },
    ],
    deactivateMissing: false,
  });

  expect(importButton("Importing…")).toBeDisabled();
  expect(
    within(dialog()).getByRole("button", { name: "Choose another file" })
  ).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(onOpenChange).not.toHaveBeenCalled();

  const response = {
    offices: [abay, dostyk, astana],
    summary: { created: 1, updated: 1, deactivated: 0 },
  };
  await act(async () => reply.resolve(jsonResponse(response)));

  expect(toast.success).toHaveBeenCalledWith(
    "Imported: 1 new, 1 updated, 0 deactivated"
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onImported).toHaveBeenCalledWith(response);
  expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(
    onImported.mock.invocationCallOrder[0]
  );
});

it("asks the server to deactivate missing offices only when the box is checked", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      offices: [abay, dostyk],
      summary: { created: 1, updated: 1, deactivated: 1 },
    })
  );
  renderDialog([abay, dostyk, astana]);
  chooseFile(csvFile(UPDATE_CSV));
  const box = await screen.findByRole("checkbox", {
    name: "Deactivate 1 office missing from the file",
  });
  expect(box).toHaveAccessibleDescription(
    "Scenarios stop routing to them right away. Leave this off to keep them active."
  );

  await user.click(box);
  await user.click(importButton("Import 3 offices"));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
    deactivateMissing: true,
  });
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Imported: 1 new, 1 updated, 1 deactivated"
    )
  );
});

it("lists the file's problems by row and blocks Import", async () => {
  const lines = [
    "name,country,city,coordinates",
    'Esentai,KZ,Almaty,"43.218, 76.928"',
    ',KZ,Almaty,"43.2, 76.9"',
    "Mega,KZ,Astana,https://maps.app.goo.gl/abc",
    ...Array.from(
      { length: 20 },
      (_, index) => `Office ${index},Narnia,Almaty,"43.2, 76.9"`
    ),
  ];
  renderDialog();
  chooseFile(csvFile(lines.join("\n")));

  const alert = (
    await screen.findByText("22 problems to fix before importing")
  ).closest<HTMLElement>("[role='alert']");
  if (!alert) throw new Error("No problems alert");
  const items = within(alert).getAllByRole("listitem");
  expect(items).toHaveLength(20);
  expect(items[0]).toHaveTextContent("Row 3: Enter the office name.");
  expect(items[1]).toHaveTextContent(
    "Row 4: Short map links can't be read. Open the link in a browser and copy the coordinates."
  );
  expect(items[2]).toHaveTextContent(
    "Row 5: The country isn't recognized. Use a two-letter code such as KZ, or the country name."
  );
  expect(items[19]).toHaveTextContent(/^Row 22: /);
  expect(within(alert).getByText("+2 more")).toBeVisible();
  // The one good row is still previewed, but nothing can be imported.
  expect(
    screen.getByText("1 new · 0 updated · 0 unchanged · 1 not in the file")
  ).toBeVisible();
  expect(importButton("Import 1 office")).toBeDisabled();
});

it("refuses a file without the required columns", async () => {
  renderDialog();
  chooseFile(csvFile("name,country\nAbay,KZ"));

  expect(
    await screen.findByText(
      "The file needs these columns: city, latitude, longitude."
    )
  ).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  // The hint about the columns stays next to the refusal.
  expect(
    screen.getByText(/^Required columns: name, country, city/)
  ).toBeVisible();
  expect(importButton("Import")).toBeDisabled();
});

it("blocks Import over the active office limit until missing offices are deactivated", async () => {
  const user = userEvent.setup();
  const full = Array.from({ length: 500 }, (_, index) =>
    createOfficeRecord({
      key: `kz_city${index}_office`,
      name: `Office ${index}`,
      city: `City ${index}`,
      cityKey: `city${index}`,
      latitude: 40 + index / 100,
      longitude: 70,
    })
  );
  renderDialog(full);
  chooseFile(
    csvFile(
      "name,country,city,latitude,longitude\nEsentai,KZ,Almaty,43.218,76.928"
    )
  );

  expect(
    await screen.findByText(
      "After this import there would be 501 active offices, over the limit of 500. Deactivate the offices missing from the file or remove rows."
    )
  ).toBeVisible();
  expect(importButton("Import 1 office")).toBeDisabled();

  await user.click(
    screen.getByRole("checkbox", {
      name: "Deactivate 500 offices missing from the file",
    })
  );
  expect(
    screen.queryByText(/^After this import there would be/)
  ).not.toBeInTheDocument();
  expect(importButton("Import 1 office")).toBeEnabled();
});

it("names refused offices by their row in the file", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(
    jsonResponse(
      {
        error: "Invalid offices",
        code: "invalid_offices",
        rows: [
          { index: 1, key: "kz_almaty_mega", issues: ["map_url_invalid"] },
        ],
      },
      400
    )
  );
  const { onOpenChange } = renderDialog();
  // The blank line moves the offices to rows 3 and 4 of the file.
  chooseFile(
    csvFile(
      [
        "key,name,country,city,latitude,longitude,map_url",
        "",
        "kz_almaty_esentai,Esentai,KZ,Almaty,43.218,76.928,",
        "kz_almaty_mega,Mega,KZ,Almaty,43.2,76.9,https://example.com/mega",
      ].join("\n")
    )
  );
  await user.click(
    await screen.findByRole("button", { name: "Import 2 offices" })
  );

  const refusal = await screen.findByText(
    "Some rows were refused. Fix them in the file and choose it again."
  );
  const alert = refusal.closest<HTMLElement>("[role='alert']");
  if (!alert) throw new Error("No refusal alert");
  expect(within(alert).getByRole("listitem")).toHaveTextContent(
    "Row 4: Use a full https:// link of up to 500 characters."
  );
  await waitFor(() => expect(alert).toHaveFocus());
  expect(importButton("Import 2 offices")).toBeDisabled();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("explains other refusals and lets the import be tried again", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ error: "Too many", code: "office_limit", limit: 500 }, 409)
  );
  renderDialog();
  chooseFile(csvFile(UPDATE_CSV));
  await user.click(
    await screen.findByRole("button", { name: "Import 3 offices" })
  );

  expect(
    await screen.findByText(
      "A workspace can have at most 500 active offices. Deactivate some first."
    )
  ).toBeVisible();
  expect(importButton("Import 3 offices")).toBeEnabled();
  expect(toast.success).not.toHaveBeenCalled();
});

it("ignores a file that finishes reading after a newer one", async () => {
  const slow = deferred<string>();
  renderDialog();

  chooseFile(csvFile(slow.promise, "old.csv"));
  expect(await screen.findByText("Reading the file…")).toBeVisible();
  chooseFile(
    csvFile(
      "name,country,city,latitude,longitude\nEsentai,KZ,Almaty,43.218,76.928",
      "new.csv"
    )
  );
  expect(
    await screen.findByText(
      "1 new · 0 updated · 0 unchanged · 1 not in the file"
    )
  ).toBeVisible();

  await act(async () => slow.resolve(UPDATE_CSV));

  expect(screen.getByText("File: new.csv")).toBeVisible();
  expect(
    screen.getByText("1 new · 0 updated · 0 unchanged · 1 not in the file")
  ).toBeVisible();
  expect(screen.queryByText("Reading the file…")).not.toBeInTheDocument();
});

it("starts empty when opened again", async () => {
  const slow = deferred<string>();
  const { setOpen } = renderDialog();
  chooseFile(csvFile(UPDATE_CSV));
  await screen.findByText(
    "2 new · 1 updated · 0 unchanged · 0 not in the file"
  );
  chooseFile(csvFile(slow.promise, "late.csv"));

  setOpen(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => slow.resolve(UPDATE_CSV));
  setOpen(true);

  expect(screen.getByRole("button", { name: "Choose file" })).toBeVisible();
  expect(screen.queryByText(/^File: /)).not.toBeInTheDocument();
  expect(screen.queryByText(/not in the file$/)).not.toBeInTheDocument();
  expect(importButton("Import")).toBeDisabled();
});

it("downloads a template with the import's columns", async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.click(screen.getByRole("button", { name: "Download template" }));

  expect(downloadTextFile).toHaveBeenCalledWith({
    filename: "offices-template.csv",
    text: "\uFEFFkey,name,country,city,address,phone,latitude,longitude,map_url,tags,active,sort_order",
    mimeType: "text/csv;charset=utf-8",
  });
});
