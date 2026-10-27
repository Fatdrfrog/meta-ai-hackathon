import * as SecureStore from "expo-secure-store";

const SELECTED_WORKSPACE_KEY = "airi:selected-workspace-id";

export const supabaseSecureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export function getStoredWorkspaceId() {
  return SecureStore.getItemAsync(SELECTED_WORKSPACE_KEY);
}

export function setStoredWorkspaceId(workspaceId: string) {
  return SecureStore.setItemAsync(SELECTED_WORKSPACE_KEY, workspaceId);
}

export function clearStoredWorkspaceId() {
  return SecureStore.deleteItemAsync(SELECTED_WORKSPACE_KEY);
}
