/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ServiceMessageCommerceFields } from "./service-message-commerce-fields";

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <select
      value={value}
      onChange={event => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({
    children,
    value,
  }: {
    children?: ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

jest.mock("./service-message-product-picker", () => ({
  ServiceMessageProductPicker: () => null,
}));

describe("ServiceMessageCommerceFields", () => {
  const catalogs = [{ id: "catalog-1" }, { id: "catalog-2" }];
  const products = [
    { catalog_id: "catalog-1", retailer_id: "old-product" },
    { catalog_id: "catalog-2", retailer_id: "new-product" },
  ];

  it("keeps the selected catalog when switching commerce mode", () => {
    const onChange = jest.fn();
    render(
      <ServiceMessageCommerceFields
        commerce={{ mode: "catalog", catalogId: "catalog-2" }}
        catalogs={catalogs}
        products={products}
        loading={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "single_product" },
    });

    expect(onChange).toHaveBeenCalledWith({
      mode: "single_product",
      catalogId: "catalog-2",
      productRetailerId: "",
    });
  });

  it("clears products from the old catalog when the catalog changes", () => {
    const onChange = jest.fn();
    render(
      <ServiceMessageCommerceFields
        commerce={{
          mode: "product_carousel",
          catalogId: "catalog-1",
          bodyText: "Products",
          productRetailerIds: ["old-product"],
        }}
        catalogs={catalogs}
        products={products}
        loading={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getAllByRole("combobox")[1], {
      target: { value: "catalog-2" },
    });

    expect(onChange).toHaveBeenCalledWith({
      mode: "product_carousel",
      catalogId: "catalog-2",
      bodyText: "Products",
      productRetailerIds: [],
    });
  });

  it("names the modes and lets WhatsApp pick the cover product", () => {
    const onChange = jest.fn();
    render(
      <ServiceMessageCommerceFields
        commerce={{
          mode: "catalog",
          catalogId: "catalog-1",
          thumbnailProductRetailerId: "old-product",
        }}
        catalogs={catalogs}
        products={products}
        loading={false}
        onChange={onChange}
      />
    );

    expect(
      screen.getByRole("option", { name: "whatsappServiceFormatCatalog" })
    ).toBeTruthy();
    const cover = screen.getByRole("option", {
      name: "whatsappServiceCatalogThumbnailAuto",
    }).parentElement as HTMLSelectElement;
    expect(cover.value).toBe("old-product");
    fireEvent.change(cover, { target: { value: "none" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ thumbnailProductRetailerId: "old-product" })
    );
    expect(screen.getByLabelText("previewFieldMessage")).toBeTruthy();
  });

  it("says calmly when no catalog is connected", () => {
    render(
      <ServiceMessageCommerceFields
        commerce={{ mode: "catalog", catalogId: "" }}
        catalogs={[]}
        products={[]}
        loading={false}
        onChange={jest.fn()}
      />
    );

    const notice = screen.getByText("whatsappServiceCatalogUnavailable");
    expect(notice.className).toContain("text-muted-foreground");
    expect(notice.className).not.toContain("text-destructive");
  });
});
