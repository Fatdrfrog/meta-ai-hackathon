import { WorkspaceProduct } from "./workspace-product";

describe("WorkspaceProduct", () => {
  const product = (price: number | null) =>
    new WorkspaceProduct({
      workspaceId: "workspace-1",
      name: "Кукла Лол",
      price,
    });

  it("takes whole tenge, or no price yet", () => {
    expect(product(5000).validateSync()).toBeUndefined();
    expect(product(null).validateSync()).toBeUndefined();
  });

  it("refuses a fraction of a tenge and a negative price", () => {
    expect(product(4999.6).validateSync()?.errors.price?.message).toBe(
      "Prices are whole tenge"
    );
    expect(product(-1).validateSync()?.errors.price).toBeDefined();
  });

  it("starts as a draft", () => {
    expect(product(100).status).toBe("draft");
  });
});
