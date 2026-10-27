"use client";

import { createClient } from "@/lib/supabase/client";
import { setPostHogUser } from "@/lib/posthog/client";
import { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    let active = true;
    let authChanged = false;
    const applySession = (session: Session | null, reset = false) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      void setPostHogUser(session?.user ?? null, { reset });
    };
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active && !authChanged) applySession(session);
    });

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      authChanged = true;
      // No Supabase calls inside its auth callback: analytics uses only the
      // supplied session and the shared, independently loaded PostHog client.
      applySession(session, event === "SIGNED_OUT");
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}

export function useAuth() {
  const context = useOptionalAuth();
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
