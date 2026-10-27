export type KBTreeRefreshCallback = () => void | Promise<void>;

export type SetKBTreeRefreshCallback = (
  update:
    | KBTreeRefreshCallback
    | null
    | ((previous: KBTreeRefreshCallback | null) => KBTreeRefreshCallback | null)
) => void;

export function registerKBTreeRefreshCallback(
  setRefreshCallback: SetKBTreeRefreshCallback,
  refreshCallback: KBTreeRefreshCallback
) {
  setRefreshCallback(() => refreshCallback);
}
