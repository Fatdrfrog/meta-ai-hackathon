type ConversationDetailModule = typeof import("./conversation-detail-view");

let detailModulePromise: Promise<ConversationDetailModule> | null = null;
let detailPreloadPromise: Promise<void> | null = null;
let loadedDetailModule: ConversationDetailModule | null = null;

export function getLoadedConversationDetailModule(): ConversationDetailModule | null {
  return loadedDetailModule;
}

export function loadConversationDetailModule(): Promise<ConversationDetailModule> {
  if (detailModulePromise) {
    return detailModulePromise;
  }

  const pending = import("./conversation-detail-view").then(module => {
    loadedDetailModule = module;
    return module;
  });
  detailModulePromise = pending;
  void pending.catch(() => {
    if (detailModulePromise === pending) {
      detailModulePromise = null;
      detailPreloadPromise = null;
    }
  });
  return pending;
}

export function preloadConversationDetailView(): Promise<void> {
  // The module loader owns failure cleanup for both promises.
  return (detailPreloadPromise ??= loadConversationDetailModule().then(
    () => undefined
  ));
}
