const fs = require("fs");
const path = require("path");
const {
  validateSupabasePublicKey,
} = require("../../packages/shared/src/supabase/public-key-validation.cjs");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

function loadFileEnv() {
  const repoRoot = path.resolve(__dirname, "../..");
  const envFiles = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, "apps/web/.env"),
    path.join(repoRoot, "apps/web/.env.local"),
    path.join(__dirname, ".env"),
    path.join(__dirname, ".env.local"),
  ];

  return envFiles.reduce(
    (env, filePath) => ({
      ...env,
      ...parseEnvFile(filePath),
    }),
    {},
  );
}

function firstEnv(fileEnv, names, fallback = "") {
  for (const name of names) {
    const value = process.env[name] ?? fileEnv[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

module.exports = ({ config }) => {
  const fileEnv = loadFileEnv();
  const supabaseAnonKey = firstEnv(fileEnv, [
    "EXPO_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]);
  if (supabaseAnonKey) validateSupabasePublicKey(supabaseAnonKey);
  const apiBaseUrl = trimTrailingSlash(
    firstEnv(
      fileEnv,
      [
        "EXPO_PUBLIC_AIRI_API_URL",
        "NEXT_PUBLIC_APP_URL",
        "NEXT_PUBLIC_SITE_URL",
        "APP_URL",
        "SITE_URL",
      ],
      "http://localhost:3000",
    ),
  );

  return {
    ...config,
    extra: {
      ...config.extra,
      router: {
        ...(config.extra?.router || {}),
        origin: false,
      },
      mobile: {
        apiBaseUrl,
        supabaseUrl: firstEnv(fileEnv, [
          "EXPO_PUBLIC_SUPABASE_URL",
          "NEXT_PUBLIC_SUPABASE_URL",
        ]),
        supabaseAnonKey,
      },
    },
  };
};
