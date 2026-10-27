/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { toast } from "sonner";
import type { BusinessLocationRecord } from "@/lib/business-locations/types";
import { BusinessLocationDialog } from "./business-location-dialog";
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

const OFFICES_URL = "/api/workspaces/workspace-1/business-locations";
const fetchMock = jest.fn();
const abay = createOfficeRecord({ mapUrl: "https://maps.app.goo.gl/abay" });

function renderDialog(office: BusinessLocationRecord | null = null) {
  const onOpenChange = jest.fn();
  const onSaved = jest.fn();
  render(
    <BusinessLocationDialog
      open
      onOpenChange={onOpenChange}
      workspaceId="workspace-1"
      office={office}
      existing={[abay]}
      onSaved={onSaved}
    />
  );
  return { onOpenChange, onSaved, dialog: screen.getByRole("dialog") };
}

/** Replaces a field's text in one step; typing each key is slow in jsdom. */
async function fill(user: UserEvent, field: HTMLElement, value: string) {
  await user.clear(field);
  if (value) await user.paste(value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}

beforeAll(() => {
  installDomPolyfills();
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  jest.mocked(toast.success).mockReset();
});

it("derives the key of a new office until the key is edited", async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();
  const key = within(dialog).getByLabelText("Key");

  expect(
    within(dialog).getByRole("heading", { name: "Add office" })
  ).toBeVisible();
  expect(
    within(dialog).getByRole("combobox", { name: "Country" })
  ).toHaveTextContent("Kazakhstan (KZ)");
  expect(key).not.toHaveAttribute("readonly");
  expect(key).toHaveAccessibleDescription(
    "Scenarios use the key. It can't be changed later."
  );

  await fill(user, within(dialog).getByLabelText("City"), "Алматы");
  await fill(user, within(dialog).getByLabelText("Name"), "Достык Плаза");
  expect(key).toHaveValue("kz_almaty_dostyk_plaza");

  await user.type(key, "_2");
  await fill(user, within(dialog).getByLabelText("Name"), "Esentai");
  expect(key).toHaveValue("kz_almaty_dostyk_plaza_2");
});

it("shows the key of an office being edited read-only", () => {
  const { dialog } = renderDialog(abay);
  const key = within(dialog).getByLabelText("Key");

  expect(
    within(dialog).getByRole("heading", { name: "Edit office" })
  ).toBeVisible();
  expect(key).toHaveValue("kz_almaty_abay");
  expect(key).toHaveAttribute("readonly");
  expect(key).toHaveAccessibleDescription(
    "The key can't be changed. To use another key, add a new office and deactivate this one."
  );
  expect(within(dialog).getByLabelText("Coordinates")).toHaveValue(
    "43.238949, 76.889709"
  );
});

it("explains what it read from the coordinates field", async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();
  const coordinates = within(dialog).getByLabelText("Coordinates");

  expect(
    within(dialog).getByText(
      "Paste latitude and longitude, or a full Google Maps link."
    )
  ).toBeVisible();

  await fill(user, coordinates, "43,238949; 76,889709");
  expect(within(dialog).getByText("Pin: 43.238949, 76.889709")).toBeVisible();
  expect(
    within(dialog).getByRole("link", { name: "Open in maps" })
  ).toHaveAttribute(
    "href",
    "https://www.google.com/maps?q=43.238949,76.889709"
  );

  await fill(
    user,
    coordinates,
    "https://www.google.com/maps/place/Abay/@43.2,76.8,17z/data=!3d43.238949!4d76.889709"
  );
  expect(within(dialog).getByText("Pin: 43.238949, 76.889709")).toBeVisible();

  await fill(user, coordinates, "https://maps.app.goo.gl/abc123");
  expect(
    within(dialog).getByText(
      "Open the link in a browser and copy the coordinates."
    )
  ).toBeVisible();

  await fill(user, coordinates, "https://www.google.com/maps?q=Abay+Avenue");
  expect(
    within(dialog).getByText(
      "This link has no coordinates. Paste the coordinates instead."
    )
  ).toBeVisible();

  await fill(user, coordinates, "somewhere in Almaty");
  expect(
    within(dialog).getByText(
      "These coordinates can't be read. Use latitude, longitude, e.g. 43.238949, 76.889709."
    )
  ).toBeVisible();
});

it("shows field errors and sends nothing while the office is incomplete", async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();

  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(
    "Enter the office name."
  );
  expect(within(dialog).getByLabelText("City")).toHaveAccessibleDescription(
    "Enter the city."
  );
  expect(within(dialog).getByText("Enter the coordinates.")).toBeVisible();
  // The key waits for the name and city, which already say what is missing.
  expect(within(dialog).getByLabelText("Key")).not.toHaveAttribute(
    "aria-invalid"
  );
  expect(within(dialog).getByLabelText("Name")).toHaveFocus();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("asks for a key when the name gives none", async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();

  await fill(user, within(dialog).getByLabelText("Name"), "★★★");
  await fill(user, within(dialog).getByLabelText("City"), "Almaty");
  await fill(user, within(dialog).getByLabelText("Coordinates"), "43.2, 76.9");
  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  const key = within(dialog).getByLabelText("Key");
  expect(key).toHaveValue("");
  expect(key).toHaveAccessibleDescription(
    "Scenarios use the key. It can't be changed later. Use 1 to 64 Latin letters, digits, _ or - for the key."
  );
  expect(key).toHaveFocus();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("refuses a key another office already has", async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();

  await fill(user, within(dialog).getByLabelText("Name"), "Abay");
  await fill(user, within(dialog).getByLabelText("City"), "Almaty");
  await fill(user, within(dialog).getByLabelText("Key"), "kz_almaty_abay");
  await fill(user, within(dialog).getByLabelText("Coordinates"), "43.2, 76.9");
  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  expect(within(dialog).getByLabelText("Key")).toHaveAccessibleDescription(
    expect.stringContaining(
      "An office with this key already exists. Choose another key."
    )
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("creates an office with POST and hands back the new list", async () => {
  const user = userEvent.setup();
  const created = createOfficeRecord({
    key: "kz_almaty_esentai",
    name: "Esentai",
    tags: ["mall", "late"],
  });
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ office: created, offices: [abay, created] }, 201)
  );
  const { dialog, onSaved, onOpenChange } = renderDialog();

  await fill(user, within(dialog).getByLabelText("Name"), " Esentai ");
  await fill(user, within(dialog).getByLabelText("City"), "Almaty");
  await fill(user, within(dialog).getByLabelText(/^Address/), "Al-Farabi 77/8");
  await fill(user, within(dialog).getByLabelText(/^Phone/), "+7 727 222 22 22");
  await fill(
    user,
    within(dialog).getByLabelText("Coordinates"),
    "43.218, 76.928"
  );
  await fill(
    user,
    within(dialog).getByLabelText(/^Map link/),
    "https://maps.app.goo.gl/esentai"
  );
  await user.type(
    within(dialog).getByLabelText(/^Tags/),
    // A tag holding a separator becomes separate tags, as an import reads it.
    "mall{Enter}late; vip|24h{Enter}"
  );
  await user.click(within(dialog).getByRole("switch", { name: "Active" }));
  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith([abay, created]));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(toast.success).toHaveBeenCalledWith("Esentai added.");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(OFFICES_URL);
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({
    office: {
      key: "kz_almaty_esentai",
      name: "Esentai",
      country: "KZ",
      city: "Almaty",
      address: "Al-Farabi 77/8",
      phone: "+7 727 222 22 22",
      mapUrl: "https://maps.app.goo.gl/esentai",
      tags: ["mall", "late", "vip", "24h"],
      latitude: 43.218,
      longitude: 76.928,
      isActive: false,
    },
  });
});

it("edits with PUT, keeping the key and sort order and clearing emptied fields", async () => {
  const user = userEvent.setup();
  const office = createOfficeRecord({
    sortOrder: 3,
    mapUrl: "https://maps.app.goo.gl/abay",
  });
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      offices: [{ ...office, address: undefined }],
      summary: { created: 0, updated: 1, deactivated: 0 },
    })
  );
  const { dialog, onSaved } = renderDialog(office);

  await fill(user, within(dialog).getByLabelText(/^Address/), "");
  await fill(user, within(dialog).getByLabelText("Name"), "Abay 10");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0];
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    offices: [
      {
        key: "kz_almaty_abay",
        name: "Abay 10",
        country: "KZ",
        city: "Almaty",
        phone: "+7 727 000 00 00",
        mapUrl: "https://maps.app.goo.gl/abay",
        tags: ["mall"],
        latitude: 43.238949,
        longitude: 76.889709,
        isActive: true,
        sortOrder: 3,
      },
    ],
  });
  expect(toast.success).toHaveBeenCalledWith("Abay 10 saved.");
});

it("shows the server's refused fields next to them", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(
    jsonResponse(
      {
        error: "Invalid offices",
        code: "invalid_offices",
        rows: [
          {
            index: 0,
            key: "kz_almaty_abay",
            issues: ["map_url_invalid", "phone_too_long"],
          },
        ],
      },
      400
    )
  );
  const { dialog, onSaved, onOpenChange } = renderDialog(abay);

  await user.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(
    await within(dialog).findByText("Check the highlighted fields.")
  ).toBeVisible();
  expect(
    within(dialog).getByLabelText(/^Map link/)
  ).toHaveAccessibleDescription(
    expect.stringContaining("Use a full https:// link of up to 500 characters.")
  );
  expect(within(dialog).getByLabelText(/^Phone/)).toHaveAccessibleDescription(
    "Shorten the phone to 40 characters."
  );
  // The first refused field in the form takes focus.
  expect(within(dialog).getByLabelText(/^Phone/)).toHaveFocus();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();

  // Changing the form clears the server's verdict until the next save.
  await user.type(within(dialog).getByLabelText(/^Phone/), "1");
  expect(
    within(dialog).queryByText("Check the highlighted fields.")
  ).not.toBeInTheDocument();
  expect(within(dialog).getByLabelText(/^Phone/)).not.toHaveAttribute(
    "aria-invalid"
  );
});

it("puts a key the server reports as taken on the key field", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ error: "Office key taken", code: "office_key_taken" }, 409)
  );
  const { dialog } = renderDialog();

  await fill(user, within(dialog).getByLabelText("Name"), "Esentai");
  await fill(user, within(dialog).getByLabelText("City"), "Almaty");
  await fill(
    user,
    within(dialog).getByLabelText("Coordinates"),
    "43.218, 76.928"
  );
  await user.click(within(dialog).getByRole("button", { name: "Add office" }));

  await waitFor(() =>
    expect(within(dialog).getByLabelText("Key")).toHaveAccessibleDescription(
      expect.stringContaining(
        "An office with this key already exists. Choose another key."
      )
    )
  );
});

it("locks the form while saving and names a failed save", async () => {
  const user = userEvent.setup();
  const reply = deferred<Response>();
  fetchMock.mockReturnValueOnce(reply.promise);
  const { dialog, onOpenChange } = renderDialog(abay);

  await user.click(within(dialog).getByRole("button", { name: "Save" }));

  const saving = within(dialog).getByRole("button", { name: "Saving…" });
  expect(saving).toBeDisabled();
  expect(within(dialog).getByLabelText("Name")).toBeDisabled();
  expect(
    within(dialog).getByRole("combobox", { name: "Country" })
  ).toBeDisabled();
  expect(within(dialog).getByRole("switch", { name: "Active" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(onOpenChange).not.toHaveBeenCalled();

  reply.resolve(
    jsonResponse({ error: "Save failed", code: "save_failed" }, 503)
  );

  expect(
    await within(dialog).findByText("Could not save offices. Try again.")
  ).toBeVisible();
  expect(within(dialog).getByLabelText("Name")).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Abay Avenue");
  expect(onOpenChange).not.toHaveBeenCalled();
});
