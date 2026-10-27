const mockImportDetail = jest.fn();

jest.mock("./conversation-detail-view", () => mockImportDetail());

describe("conversation detail module loading", () => {
  beforeEach(() => {
    jest.resetModules();
    mockImportDetail.mockReset().mockReturnValue({
      ConversationDetailView: () => null,
    });
  });

  function getLoader() {
    return jest.requireActual<typeof import("./conversation-detail-loader")>(
      "./conversation-detail-loader"
    );
  }

  it("shares the import across rendering and intent preloads", async () => {
    const loader = getLoader();
    expect(loader.getLoadedConversationDetailModule()).toBeNull();

    const preload = loader.preloadConversationDetailView();
    const load = loader.loadConversationDetailModule();
    expect(loader.preloadConversationDetailView()).toBe(preload);
    expect(loader.loadConversationDetailModule()).toBe(load);

    await expect(preload).resolves.toBeUndefined();
    expect(loader.getLoadedConversationDetailModule()).toBe(await load);
    expect(mockImportDetail).toHaveBeenCalledTimes(1);
  });

  it("clears a failed import and its preload so later intent can retry", async () => {
    const error = new Error("Chunk failed to load");
    mockImportDetail.mockImplementationOnce(() => {
      throw error;
    });
    const loader = getLoader();
    const failedPreload = loader.preloadConversationDetailView();
    const failedLoad = loader.loadConversationDetailModule();
    await Promise.all([
      expect(failedPreload).rejects.toBe(error),
      expect(failedLoad).rejects.toBe(error),
    ]);
    expect(loader.getLoadedConversationDetailModule()).toBeNull();

    const retry = loader.preloadConversationDetailView();
    expect(retry).not.toBe(failedPreload);
    expect(loader.loadConversationDetailModule()).not.toBe(failedLoad);
    await expect(retry).resolves.toBeUndefined();
    expect(loader.getLoadedConversationDetailModule()).not.toBeNull();
    expect(mockImportDetail).toHaveBeenCalledTimes(2);
  });
});
