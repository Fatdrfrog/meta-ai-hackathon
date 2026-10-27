const COMMIT_SHA_LENGTH = 12;

type AppVersionSource =
  | "next-public-app-version"
  | "vercel-deployment-id"
  | "vercel-git-commit-sha"
  | "next-public-vercel-git-commit-sha"
  | "development"
  | "fallback";

type AppVersionDetails = {
  source: AppVersionSource;
  version: string;
};

function readVersionCandidate(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getAppVersion(
  env: NodeJS.ProcessEnv = process.env
): AppVersionDetails {
  const explicitVersion = readVersionCandidate(env.NEXT_PUBLIC_APP_VERSION);

  if (explicitVersion) {
    return {
      source: "next-public-app-version",
      version: explicitVersion,
    };
  }

  const deploymentId = readVersionCandidate(env.VERCEL_DEPLOYMENT_ID);

  if (deploymentId) {
    return {
      source: "vercel-deployment-id",
      version: deploymentId,
    };
  }

  const commitSha =
    readVersionCandidate(env.VERCEL_GIT_COMMIT_SHA) ??
    readVersionCandidate(env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA);

  if (commitSha) {
    return {
      source: env.VERCEL_GIT_COMMIT_SHA
        ? "vercel-git-commit-sha"
        : "next-public-vercel-git-commit-sha",
      version: commitSha.slice(0, COMMIT_SHA_LENGTH),
    };
  }

  if (env.NODE_ENV !== "production") {
    return {
      source: "development",
      version: "dev",
    };
  }

  return {
    source: "fallback",
    version: "unknown",
  };
}
