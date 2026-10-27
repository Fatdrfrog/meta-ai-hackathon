/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import { downloadTextFile } from "@/lib/spreadsheet/download";
import type { BusinessLocationRecord } from "@/lib/business-locations/types";
import { BusinessLocationsManager } from "./business-locations-manager";
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
  address: undefined,
  phone: "+7 727 111 11 11",
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
  address: "Kabanbay Batyr 62",
  phone: undefined,
  tags: [],
  latitude: 51.089,
  longitude: 71.406,
  isActive: false,
  mapUrl: "https://maps.app.goo.gl/mega",
});

function listResponse(offices: BusinessLocationRecord[]) {
  return jsonResponse({ offices });
}

function renderManager() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BusinessLocationsManager workspaceId="workspace-1" />
    </SWRConfig>
  );
}

beforeAll(() => {
  installDomPolyfills();
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  jest.mocked(toast.success).mockReset();
  jest.mocked(toast.error).mockReset();
  jest.mocked(downloadTextFile).mockReset();
});

it("shows a loading status, then the offices", async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise(done => (resolve = done)));
  renderManager();

  expect(screen.getByRole("status", { name: "Loading offices" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Add office" })).toBeDisabled();
  resolve(listResponse([abay]));

  const table = await screen.findByRole("table", { name: "Offices" });
  expect(within(table).getByText("Abay Avenue")).toBeVisible();
  expect(within(table).getByText("kz_almaty_abay")).toHaveAttribute(
    "title",
    "kz_almaty_abay"
  );
  // The country sits on its own line under the city.
  expect(within(table).getByText("Kazakhstan", { exact: true })).toBeVisible();
  expect(
    within(table).getByRole("link", { name: "Open Abay Avenue in maps" })
  ).toHaveAttribute(
    "href",
    "https://www.google.com/maps?q=43.238949,76.889709"
  );
  expect(fetchMock).toHaveBeenCalledWith(
    OFFICES_URL,
    expect.objectContaining({ method: "GET", cache: "no-store" })
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows a load error with Retry, and recovers", async () => {
  const user = userEvent.setup();
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse({ error: "Failed", code: "load_failed" }, 503)
    )
    .mockResolvedValueOnce(listResponse([abay]));
  renderManager();

  expect(await screen.findByText("Could not load offices.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByRole("table", { name: "Offices" })).toBeVisible();
  expect(screen.queryByText("Could not load offices.")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("offers Add and Import to a manager when the catalog is empty", async () => {
  fetchMock.mockResolvedValueOnce(listResponse([]));
  renderManager();

  expect(await screen.findByText("No offices yet")).toBeVisible();
  expect(
    screen.getByText(
      "Add offices one at a time, or import a CSV or Excel file."
    )
  ).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Add office" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Import" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
});

it("exports the listed offices, inactive ones included, as CSV", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(listResponse([abay, astana]));
  renderManager();

  const table = await screen.findByRole("table", { name: "Offices" });
  expect(within(table).getByText("Mega Silk Way")).toBeVisible();
  expect(within(table).getAllByText("Inactive")).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "Export CSV" }));

  expect(downloadTextFile).toHaveBeenCalledTimes(1);
  const [{ filename, text, mimeType }] =
    jest.mocked(downloadTextFile).mock.calls[0];
  expect(filename).toMatch(/^offices-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(mimeType).toBe("text/csv;charset=utf-8");
  expect(text.startsWith("\uFEFFkey,name,country,city,")).toBe(true);
  expect(text).toContain("kz_astana_mega,Mega Silk Way,KZ,Astana");
});

it("summarizes active offices, cities and countries, and counts inactive ones", async () => {
  fetchMock.mockResolvedValueOnce(listResponse([abay, dostyk, astana]));
  renderManager();

  expect(
    await screen.findByText(
      "2 active offices · 1 city · 1 country · 1 inactive"
    )
  ).toBeVisible();
});

it("filters by name, key, city, address and phone", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(listResponse([abay, dostyk, astana]));
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });
  const search = screen.getByRole("searchbox", { name: "Search offices" });
  const names = () =>
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map(row => row.querySelector("td p")?.textContent);
  const searchFor = async (text: string) => {
    await user.clear(search);
    await user.paste(text);
  };

  await user.type(search, "DOSTYK");
  expect(names()).toEqual(["Dostyk Plaza"]);

  await searchFor("astana_mega");
  expect(names()).toEqual(["Mega Silk Way"]);

  await searchFor("abay ave");
  expect(names()).toEqual(["Abay Avenue"]);

  await searchFor("111 11");
  expect(names()).toEqual(["Dostyk Plaza"]);

  await searchFor("almaty");
  expect(names()).toEqual(["Abay Avenue", "Dostyk Plaza"]);

  await searchFor("Shymkent");
  expect(screen.getByText("No offices match your search.")).toBeVisible();
  expect(
    screen.queryByRole("table", { name: "Offices" })
  ).not.toBeInTheDocument();
});

it("deactivates an office only after confirmation, sending the whole office", async () => {
  const user = userEvent.setup();
  fetchMock
    .mockResolvedValueOnce(listResponse([abay, dostyk]))
    .mockResolvedValueOnce(
      jsonResponse({
        offices: [{ ...abay, isActive: false }, dostyk],
        summary: { created: 0, updated: 1, deactivated: 0 },
      })
    );
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });

  await user.click(
    within(table).getByRole("button", { name: "Deactivate Abay Avenue" })
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "Deactivate Abay Avenue?",
  });
  expect(
    within(confirm).getByText(
      "Scenarios stop routing to Abay Avenue right away. You can turn it on again later."
    )
  ).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await user.click(within(confirm).getByRole("button", { name: "Deactivate" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe(OFFICES_URL);
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    offices: [
      {
        key: "kz_almaty_abay",
        name: "Abay Avenue",
        country: "KZ",
        city: "Almaty",
        address: "Abay Ave 10",
        phone: "+7 727 000 00 00",
        tags: ["mall"],
        latitude: 43.238949,
        longitude: 76.889709,
        isActive: false,
        sortOrder: 0,
      },
    ],
  });
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Abay Avenue deactivated.")
  );
  const abayRow = within(table).getByText("Abay Avenue").closest("tr")!;
  expect(within(abayRow).getByText("Inactive")).toBeVisible();
  const activate = within(abayRow).getByRole("button", {
    name: "Activate Abay Avenue",
  });
  expect(activate).toBeEnabled();
  // Keyboard users keep their place: the row's toggle gets focus back.
  await waitFor(() => expect(activate).toHaveFocus());
});

it("cancelling the confirmation sends nothing", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(listResponse([abay]));
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });

  await user.click(
    within(table).getByRole("button", { name: "Deactivate Abay Avenue" })
  );
  const confirm = await screen.findByRole("alertdialog");
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("activates without confirmation and names the limit when it is reached", async () => {
  const user = userEvent.setup();
  fetchMock
    .mockResolvedValueOnce(listResponse([abay, astana]))
    .mockResolvedValueOnce(
      jsonResponse(
        { error: "Too many offices", code: "office_limit", limit: 500 },
        409
      )
    )
    .mockResolvedValueOnce(listResponse([abay, astana]));
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });

  await user.click(
    within(table).getByRole("button", { name: "Activate Mega Silk Way" })
  );

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "A workspace can have at most 500 active offices. Deactivate some first."
    )
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).offices[0]).toEqual(
    expect.objectContaining({
      key: "kz_astana_mega",
      isActive: true,
      mapUrl: "https://maps.app.goo.gl/mega",
    })
  );
  // The list is read again, since a failed reply can follow a saved write.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[2][1].method).toBe("GET");
});

it("warns about an office far from the other offices of its city", async () => {
  const farAway = createOfficeRecord({
    key: "kz_almaty_airport",
    name: "Airport Desk",
    latitude: 43.6,
    longitude: 77.6,
  });
  fetchMock.mockResolvedValueOnce(listResponse([abay, dostyk, farAway]));
  renderManager();

  expect(await screen.findByText("Check these pins")).toBeVisible();
  expect(
    screen.getByText(
      /^Airport Desk is \d+ km from the other offices in Almaty\. Check its coordinates\.$/
    )
  ).toBeVisible();
  expect(screen.queryByText(/^Abay Avenue is/)).not.toBeInTheDocument();
});

it("opens the add dialog and shows the saved office", async () => {
  const user = userEvent.setup();
  const created = createOfficeRecord({
    key: "kz_almaty_esentai",
    name: "Esentai",
    address: undefined,
    phone: undefined,
    tags: [],
    latitude: 43.218,
    longitude: 76.928,
  });
  fetchMock
    .mockResolvedValueOnce(listResponse([abay]))
    .mockResolvedValueOnce(
      jsonResponse({ office: created, offices: [abay, created] }, 201)
    );
  renderManager();
  await screen.findByRole("table", { name: "Offices" });

  await user.click(screen.getByRole("button", { name: "Add office" }));
  const dialog = await screen.findByRole("dialog", { name: "Add office" });
  for (const [label, value] of [
    ["Name", "Esentai"],
    ["City", "Almaty"],
    ["Coordinates", "43.218, 76.928"],
  ]) {
    await user.click(within(dialog).getByLabelText(label));
    await user.paste(value);
  }
  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    office: {
      key: "kz_almaty_esentai",
      name: "Esentai",
      country: "KZ",
      city: "Almaty",
      latitude: 43.218,
      longitude: 76.928,
      isActive: true,
    },
  });
  expect(
    within(screen.getByRole("table", { name: "Offices" })).getByText("Esentai")
  ).toBeVisible();
  expect(toast.success).toHaveBeenCalledWith("Esentai added.");
});

// A refused reply can follow a saved write, such as an import whose list read
// failed after the offices were stored.
it("reloads the list when the import dialog closes", async () => {
  const user = userEvent.setup();
  fetchMock
    .mockResolvedValueOnce(listResponse([abay]))
    .mockResolvedValueOnce(listResponse([abay, dostyk]));
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });

  await user.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");

  expect(await within(table).findByText("Dostyk Plaza")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith(
    OFFICES_URL,
    expect.objectContaining({ method: "GET" })
  );
});

it("returns focus to the button that opened a dialog", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(listResponse([abay]));
  renderManager();
  const table = await screen.findByRole("table", { name: "Offices" });

  const add = screen.getByRole("button", { name: "Add office" });
  await user.click(add);
  await screen.findByRole("dialog", { name: "Add office" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  await waitFor(() => expect(add).toHaveFocus());

  const deactivate = within(table).getByRole("button", {
    name: "Deactivate Abay Avenue",
  });
  await user.click(deactivate);
  await screen.findByRole("alertdialog");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  );
  await waitFor(() => expect(deactivate).toHaveFocus());
});
