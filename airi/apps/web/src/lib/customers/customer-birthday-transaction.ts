import WorkspaceAiriSettings from "@/models/workspace-airi-settings";
import { logger } from "@/lib/logger";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { ClientSession } from "mongoose";

let workspaceOwnerIndexPromise: Promise<unknown> | null = null;

async function ensureBirthdayWorkspaceOwner(
  workspaceId: string
): Promise<void> {
  // The settings model already declares this unique key. Connections disable
  // autoIndex, so verify it before relying on one owner per workspace.
  workspaceOwnerIndexPromise ??= WorkspaceAiriSettings.collection
    .createIndex({ workspaceId: 1 }, { unique: true, name: "workspaceId_1" })
    .catch(error => {
      workspaceOwnerIndexPromise = null;
      throw error;
    });
  await workspaceOwnerIndexPromise;
  try {
    await WorkspaceAiriSettings.updateOne(
      { workspaceId },
      { $setOnInsert: { workspaceId } },
      { upsert: true, setDefaultsOnInsert: true, timestamps: false }
    );
  } catch (error) {
    // Simultaneous first use may lose the unique-key insert to the same owner.
    if (
      !isRecord(error) ||
      error.code !== 11000 ||
      !isRecord(error.keyPattern) ||
      error.keyPattern.workspaceId !== 1
    ) {
      throw error;
    }
  }
}

/**
 * Share Mongo's existing owner-write transaction pattern across birthday
 * imports and Scenario writes. A workspace write conflict retries the whole
 * callback against a fresh snapshot; no expiring lock can outlive its owner.
 */
export async function withBirthdayWorkspaceTransaction<T>(
  workspaceId: string,
  operation: (session: ClientSession) => Promise<T>
): Promise<T> {
  await ensureBirthdayWorkspaceOwner(workspaceId);
  const session = await WorkspaceAiriSettings.startSession();
  try {
    return await session.withTransaction(async () => {
      const owner = await WorkspaceAiriSettings.updateOne(
        { workspaceId },
        { $inc: { birthday_scenario_write_fence_version: 1 } },
        { session, timestamps: false }
      );
      if (owner.matchedCount !== 1) {
        throw new Error(
          "Could not acquire the birthday workspace write fence."
        );
      }
      return operation(session);
    });
  } finally {
    try {
      await session.endSession();
    } catch (error) {
      // Cleanup cannot undo a committed import or activation, and must not
      // hide the original transaction failure when the transaction aborted.
      logger.warn("birthday.workspace_transaction_session_cleanup_failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
