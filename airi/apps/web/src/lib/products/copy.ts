// Products is English-only for now, so its copy lives here rather than in the
// en/ru/kz catalogs, whose checks require every locale. Moving it into the
// catalogs later is mechanical: every string the section shows is in this file.

export const PRODUCTS_COPY = {
  navLabel: "Products",
  title: "Products",
  loading: "Loading products…",
  loadError: "Products couldn't be loaded.",
  retry: "Retry",
  noPrice: "No price yet",
  emptyTitle: "Your products will appear here",
  emptyDescription:
    "Film your shelf on your phone and say each product's name and price. Airi turns the video into products for you to check.",
} as const;
