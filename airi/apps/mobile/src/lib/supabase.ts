import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";
import { mobileConfig } from "./config";
import { supabaseSecureStorage } from "./secure-storage";

export const supabase = createClient(
  mobileConfig.supabaseUrl || "https://example.supabase.co",
  mobileConfig.supabaseAnonKey || "missing-anon-key",
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storage: supabaseSecureStorage,
    },
  },
);
