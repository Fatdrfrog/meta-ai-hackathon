export interface MetaConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly models: {
    readonly spark: string;
    readonly sam: string;
  };
  readonly budgetUsd: number;
  readonly ledgerPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  const apiKey = env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error("MODEL_API_KEY is not set. Copy .env.example to .env and add your Meta Model API key.");
  }
  const budgetUsd = Number(env.META_BUDGET_USD ?? "20");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(`META_BUDGET_USD must be a positive number, got "${env.META_BUDGET_USD}".`);
  }
  return {
    apiKey,
    baseUrl: env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
    models: {
      spark: env.MUSE_SPARK_MODEL ?? "muse-spark-1.3",
      sam: env.SAM_MODEL ?? "sam-3.1",
    },
    budgetUsd,
    ledgerPath: env.SPEND_LEDGER_PATH ?? ".data/spend.json",
  };
}
