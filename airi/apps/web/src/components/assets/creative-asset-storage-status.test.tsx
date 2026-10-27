/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { CreativeAssetStorageStatus } from "./creative-asset-storage-status";

const mockStatus = jest.fn();
jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockStatus(...args),
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: unknown) =>
    `${key}${values ? JSON.stringify(values) : ""}`,
}));

it.each([
  [{ isLoading: true }, "storageLoading"],
  [{ error: new Error("offline") }, "storageUnavailable"],
  [{ data: { storage: { ready: false } } }, "storagePreparing"],
  [
    {
      data: {
        storage: {
          ready: false,
          recording: true,
          limitBytes: 10 * 1024 ** 3,
          storedBytes: 1024 ** 3,
          reservedBytes: 0,
        },
      },
    },
    'storageRecording{"stored":"1.00","reserved":"0.00","limit":"10.00"}',
  ],
  [
    {
      data: {
        storage: {
          ready: false,
          recording: true,
          limitBytes: 10 * 1024 ** 3,
          remainingBytes: 0,
        },
      },
    },
    "storageFull",
  ],
  [
    {
      data: {
        storage: {
          ready: true,
          storedBytes: 2 * 1024 ** 3,
          reservedBytes: 1024 ** 3,
          limitBytes: 10 * 1024 ** 3,
          remainingBytes: 7 * 1024 ** 3,
        },
      },
    },
    'storageUsage{"stored":"2.00","reserved":"1.00","limit":"10.00"}',
  ],
  [
    {
      data: {
        storage: { ready: true, limitBytes: 10 * 1024 ** 3, remainingBytes: 0 },
      },
    },
    "storageFull",
  ],
])(
  "renders the storage state without hiding pending uploads",
  (state, expected) => {
    mockStatus.mockReturnValue(state);
    render(<CreativeAssetStorageStatus workspaceId="workspace" />);
    expect(screen.getByRole("status").textContent).toContain(expected);
  }
);
