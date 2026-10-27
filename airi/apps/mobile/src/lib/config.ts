import Constants from "expo-constants";

type MobileExtraConfig = {
  apiBaseUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readConfigValue(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return "";
}

const extra = Constants.expoConfig?.extra as
  | { mobile?: MobileExtraConfig }
  | undefined;
const mobileExtra = extra?.mobile || {};

const supabaseUrl = readConfigValue(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  mobileExtra.supabaseUrl,
);
const supabaseAnonKey = readConfigValue(
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  mobileExtra.supabaseAnonKey,
);
const apiBaseUrl = trimTrailingSlash(
  readConfigValue(
    process.env.EXPO_PUBLIC_AIRI_API_URL,
    mobileExtra.apiBaseUrl,
    "http://localhost:3000",
  ),
);

export const mobileConfig = {
  supabaseUrl,
  supabaseAnonKey,
  apiBaseUrl,
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey && apiBaseUrl),
};
