import { roundProductPrice } from "@icecore/temporal";

import { WorkspaceProduct } from "./workspace-product";

describe("WorkspaceProduct", () => {
  const product = (price: number | null) =>
    new WorkspaceProduct({
      workspaceId: "workspace-1",
      name: "Кукла Лол",
      price,
    });

  it.each([5000, null, 4.99, 4999.6, 1.25, 1.255])(
    "takes %p: a price to at most 3 decimals, or no price yet",
    price => {
      expect(product(price).validateSync()).toBeUndefined();
    }
  );

  it("refuses more than 3 decimals and a negative price", () => {
    expect(product(4.9999).validateSync()?.errors.price?.message).toBe(
      "A price has at most 3 decimals"
    );
    expect(product(-1).validateSync()?.errors.price).toBeDefined();
  });

  it("takes every price the import rounds to its currency's decimals", () => {
    // The worker stores these amounts with this model: they must agree.
    for (const [amount, currency] of [
      [4.994, "USD"],
      [1500.4, "JPY"],
      [1.2504, "KWD"],
      [5000, "KZT"],
    ] as const) {
      const price = roundProductPrice(amount, currency);
      expect(product(price).validateSync()).toBeUndefined();
    }
  });

  it("starts as a draft", () => {
    expect(product(100).status).toBe("draft");
  });

  it("holds the items shown for it as options, the first featured by default", () => {
    const panel = new WorkspaceProduct({
      workspaceId: "workspace-1",
      name: "Шежіре",
      price: 15500,
      options: [
        { description: "round tree-of-life panel" },
        { description: "star-shaped plaque", photo: { method: "restored" } },
      ],
    });

    expect(panel.validateSync()).toBeUndefined();
    expect(panel.featuredOption).toBe(0);
    expect(panel.options[0]?.photo).toBeUndefined();
    expect(panel.options[1]?.notes).toEqual([]);
    expect(
      new WorkspaceProduct({
        workspaceId: "workspace-1",
        name: "Шежіре",
        options: [{ description: "" }],
      }).validateSync()?.errors["options.0.description"]
    ).toBeDefined();
  });
});
