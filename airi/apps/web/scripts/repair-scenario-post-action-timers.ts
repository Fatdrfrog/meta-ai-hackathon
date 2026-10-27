import mongoose from "mongoose";
import { loadWebOperatorEnv } from "./load-web-operator-env";

type Args = {
  apply: boolean;
  workspaceId: string;
  conversationIds: string[];
};

function parseArgs(argv: string[]): Args {
  const workspaceId =
    argv
      .find(arg => arg.startsWith("--workspace-id="))
      ?.slice("--workspace-id=".length)
      .trim() || "";
  const conversationIds = Array.from(
    new Set(
      argv
        .filter(arg => arg.startsWith("--conversation-id="))
        .map(arg => arg.slice("--conversation-id=".length).trim())
        .filter(Boolean)
    )
  );

  if (!workspaceId || conversationIds.length === 0) {
    throw new Error(
      "Usage: repair:scenario-post-action-timers -- --workspace-id=<id> --conversation-id=<id> [--conversation-id=<id>] [--apply]"
    );
  }

  return {
    apply: argv.includes("--apply"),
    workspaceId,
    conversationIds,
  };
}

async function main() {
  loadWebOperatorEnv();
  const args = parseArgs(process.argv.slice(2));
  const { recoverPostActionTimer } = await import(
    "../src/lib/airi/scenario/timer-recovery/recover"
  );

  console.log(
    JSON.stringify({
      mode: args.apply ? "apply" : "dry_run",
      workspaceId: args.workspaceId,
      conversationCount: args.conversationIds.length,
    })
  );

  for (const conversationId of args.conversationIds) {
    const result = await recoverPostActionTimer({
      workspaceId: args.workspaceId,
      conversationId,
      apply: args.apply,
    });
    console.log(JSON.stringify(result));
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
