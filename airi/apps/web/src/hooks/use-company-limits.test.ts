import useSWR from "swr";
import { useCompanyLimits } from "./use-company-limits";

jest.mock("swr", () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe("useCompanyLimits", () => {
  beforeEach(() => {
    (useSWR as jest.Mock).mockReset();
  });

  it("does not refetch the slow limits endpoint on every tab focus", () => {
    useCompanyLimits("workspace-1");

    expect(useSWR).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/limits",
      expect.any(Function),
      expect.objectContaining({
        revalidateOnFocus: false,
      })
    );
  });

  it("uses a low-frequency poll for the slow limits endpoint", () => {
    useCompanyLimits("workspace-1");

    expect(useSWR).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/limits",
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 5 * 60 * 1000,
      })
    );
  });
});
