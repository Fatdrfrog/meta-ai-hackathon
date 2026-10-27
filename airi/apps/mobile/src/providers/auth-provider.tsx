import type {
  MobileWorkspace,
  MobileWorkspacesResponse,
} from "@icecore/shared/types/mobile-api";
import type { Session } from "@supabase/supabase-js";
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppState } from "react-native";
import { authenticatedJson } from "@/lib/api";
import {
  clearStoredWorkspaceId,
  getStoredWorkspaceId,
  setStoredWorkspaceId,
} from "@/lib/secure-storage";
import { supabase } from "@/lib/supabase";

type AuthContextValue = {
  session: Session | null;
  isBootstrapping: boolean;
  workspaces: MobileWorkspace[];
  selectedWorkspaceId: string | null;
  selectedWorkspace: MobileWorkspace | null;
  isLoadingWorkspaces: boolean;
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeWorkspaces(
  payload: MobileWorkspacesResponse,
): MobileWorkspace[] {
  return (payload.workspaces || [])
    .map((workspace) => ({
      id: String(workspace.id || "").trim(),
      name: String(workspace.name || "Workspace").trim() || "Workspace",
      companyId:
        workspace.companyId ||
        (workspace as unknown as { company_id?: string | null }).company_id ||
        null,
    }))
    .filter((workspace) => workspace.id);
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [workspaces, setWorkspaces] = useState<MobileWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([supabase.auth.getSession(), getStoredWorkspaceId()])
      .then(([sessionResult, storedWorkspaceId]) => {
        if (!mounted) return;
        setSession(sessionResult.data.session);
        setSelectedWorkspaceId(storedWorkspaceId);
      })
      .finally(() => {
        if (mounted) setIsBootstrapping(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setWorkspaces([]);
        setSelectedWorkspaceId(null);
        void clearStoredWorkspaceId();
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const accessToken = session?.access_token || null;

  const apiFetch = useCallback(
    <T,>(path: string, init?: RequestInit) => {
      return authenticatedJson<T>(accessToken, path, init);
    },
    [accessToken],
  );

  const refreshWorkspaces = useCallback(async () => {
    if (!accessToken) return;
    setIsLoadingWorkspaces(true);
    try {
      const payload = await authenticatedJson<MobileWorkspacesResponse>(
        accessToken,
        "/api/workspaces",
      );
      const nextWorkspaces = normalizeWorkspaces(payload);
      setWorkspaces(nextWorkspaces);

      setSelectedWorkspaceId((current) => {
        if (
          current &&
          nextWorkspaces.some((workspace) => workspace.id === current)
        ) {
          return current;
        }
        const fallback = nextWorkspaces[0]?.id || null;
        if (fallback) {
          void setStoredWorkspaceId(fallback);
        }
        return fallback;
      });
    } finally {
      setIsLoadingWorkspaces(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    void refreshWorkspaces();
  }, [accessToken, refreshWorkspaces]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && accessToken) {
        void refreshWorkspaces();
      }
    });
    return () => subscription.remove();
  }, [accessToken, refreshWorkspaces]);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
    },
    [],
  );

  const signOut = useCallback(async () => {
    await clearStoredWorkspaceId();
    setSelectedWorkspaceId(null);
    await supabase.auth.signOut();
  }, []);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    await setStoredWorkspaceId(workspaceId);
  }, []);

  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ||
      null,
    [selectedWorkspaceId, workspaces],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isBootstrapping,
      workspaces,
      selectedWorkspaceId,
      selectedWorkspace,
      isLoadingWorkspaces,
      apiFetch,
      signInWithPassword,
      signOut,
      refreshWorkspaces,
      selectWorkspace,
    }),
    [
      apiFetch,
      isBootstrapping,
      isLoadingWorkspaces,
      refreshWorkspaces,
      selectedWorkspace,
      selectedWorkspaceId,
      session,
      signInWithPassword,
      signOut,
      selectWorkspace,
      workspaces,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
