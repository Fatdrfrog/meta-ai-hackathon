/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import ProductsRoute from "./route";

const mockContext = jest.fn();
const mockMembership = jest.fn();
const mockFlag = jest.fn();
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockContext(),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) => mockFlag(...args),
}));
jest.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
jest.mock("@/components/products/products-page", () => ({
  ProductsPage: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="products">{workspaceId}</div>
  ),
}));

const params = (workspaceId = "workspace-1") => ({
  params: Promise.resolve({ workspaceId }),
});

beforeEach(() => {
  jest.clearAllMocks();
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: mockMembership,
  };
  mockContext.mockResolvedValue({
    user: { id: "user-1" },
    supabase: { from: () => query },
  });
  mockMembership.mockResolvedValue({ data: { role: "admin" }, error: null });
  mockFlag.mockResolvedValue(true);
});

test("renders Products for an admin with the flag on", async () => {
  render(await ProductsRoute(params()));
  expect(screen.getByTestId("products")).toHaveTextContent("workspace-1");
  expect(mockFlag).toHaveBeenCalledWith("workspace-1", "products");
});

test("with the flag off, an admin goes to Airi", async () => {
  mockFlag.mockResolvedValue(false);
  await expect(ProductsRoute(params())).rejects.toThrow(
    "redirect:/panel/w/workspace-1/airi"
  );
});

test("a failed flag read counts as off", async () => {
  mockFlag.mockRejectedValue(new Error("flags unavailable"));
  await expect(ProductsRoute(params())).rejects.toThrow(
    "redirect:/panel/w/workspace-1/airi"
  );
});

test("a manager goes to Airi even with the flag on", async () => {
  mockMembership.mockResolvedValue({ data: { role: "manager" }, error: null });
  await expect(ProductsRoute(params())).rejects.toThrow(
    "redirect:/panel/w/workspace-1/airi"
  );
});

test("a membership failure shows an alert, not the products", async () => {
  mockMembership.mockResolvedValue({
    data: null,
    error: { message: "database unavailable" },
  });
  render(await ProductsRoute(params()));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Products couldn't be loaded."
  );
  expect(screen.queryByTestId("products")).not.toBeInTheDocument();
});

test("non-members go to the panel whatever the flag says", async () => {
  mockMembership.mockResolvedValue({ data: null, error: null });
  mockFlag.mockResolvedValue(false);
  await expect(ProductsRoute(params())).rejects.toThrow(/^redirect:\/panel$/);
});

test("signed-out visitors go to the login page", async () => {
  mockContext.mockResolvedValue({ user: null, supabase: {} });
  await expect(ProductsRoute(params())).rejects.toThrow("redirect:/login");
  expect(mockFlag).not.toHaveBeenCalled();
});
