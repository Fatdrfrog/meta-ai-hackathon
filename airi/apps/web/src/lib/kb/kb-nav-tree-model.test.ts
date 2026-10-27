import { buildKBNavTreeModel } from "./kb-nav-tree-model";

describe("buildKBNavTreeModel", () => {
  const articles = [
    {
      id: "child-2",
      title: "Second child",
      workspace_id: "workspace-1",
      parent_id: "root",
      sort_order: 2,
    },
    {
      id: "root",
      title: "Root",
      workspace_id: "workspace-1",
      parent_id: null,
      sort_order: 1,
    },
    {
      id: "grandchild",
      title: "Grandchild",
      workspace_id: "workspace-1",
      parent_id: "child-1",
      sort_order: 1,
    },
    {
      id: "child-1",
      title: "First child",
      workspace_id: "workspace-1",
      parent_id: "root",
      sort_order: 1,
    },
  ];

  it("precomputes sorted children without filtering the article list during render", () => {
    const model = buildKBNavTreeModel(articles);

    expect(model.getChildren(null).map(article => article.id)).toEqual([
      "root",
    ]);
    expect(model.getChildren("root").map(article => article.id)).toEqual([
      "child-1",
      "child-2",
    ]);
  });

  it("precomputes descendant counts for parent badges", () => {
    const model = buildKBNavTreeModel(articles);

    expect(model.getDescendantCount("root")).toBe(3);
    expect(model.getDescendantCount("child-1")).toBe(1);
    expect(model.getDescendantCount("child-2")).toBe(0);
  });

  it("returns a finite descendant count when the parent chain has a cycle", () => {
    const model = buildKBNavTreeModel([
      {
        id: "parent",
        title: "Parent",
        workspace_id: "workspace-1",
        parent_id: "child",
        sort_order: 1,
      },
      {
        id: "child",
        title: "Child",
        workspace_id: "workspace-1",
        parent_id: "parent",
        sort_order: 1,
      },
    ]);

    expect(model.getDescendantCount("parent")).toBeGreaterThanOrEqual(0);
    expect(model.getDescendantCount("parent")).toBeLessThan(10);
    expect(model.getDescendantCount("child")).toBeGreaterThanOrEqual(0);
    expect(model.getDescendantCount("child")).toBeLessThan(10);
  });
});
