import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import mongoose from "mongoose";

const uri = process.env.MONGO_COST_TEST_URI;
const integration = uri ? describe : describe.skip;
integration("history retention preview CLI with local Mongo", () => {
  it("uses tenant-scoped bounded reads and writes only an export manifest", async () => {
    if (
      !/^mongodb:\/\/127\.0\.0\.1:\d+\/airi_retention_preview_test\?/.test(uri!)
    )
      throw new Error(
        "Use the dedicated local retention preview fixture database"
      );
    const dbConnection = await mongoose.createConnection(uri!).asPromise();
    const db = dbConnection.db!;
    const directory = await mkdtemp(join(tmpdir(), "airi-retention-preview-"));
    const output = join(directory, "preview.json");
    const server = createServer((request, response) => {
      if (
        !request.url?.startsWith("/rest/v1/workspaces?") ||
        !request.url.includes("company_id=eq.company-1")
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "workspace-1" }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    try {
      await db
        .collection("conversations")
        .createIndex({ workspaceId: 1, _id: 1 });
      await db
        .collection("messages")
        .createIndex({ workspaceId: 1, conversation: 1, date: 1 });
      const ids = [
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ];
      const old = new Date("2020-01-01T00:00:00Z");
      await db
        .collection("conversations")
        .insertMany(
          ids.map(_id => ({
            _id,
            workspaceId: "workspace-1",
            status: "closed",
            service_closed_at: old,
            lastMessageAt: old,
            updatedAt: old,
            classification_state: { status: "ready" },
          }))
        );
      await db
        .collection("messages")
        .insertMany(
          ids.map((conversation, index) => ({
            workspaceId: "workspace-1",
            conversation,
            date: old,
            text: "PRIVATE_CONTENT_MUST_NOT_BE_EXPORTED",
            ...(index === 1
              ? {
                  rawSourcePayload: {
                    payload: { message: { type: "unsupported" } },
                  },
                }
              : {}),
          }))
        );
      const child = spawn(
        process.execPath,
        [
          join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs"),
          "scripts/history-retention-preview.ts",
          "--company-id=company-1",
          "--workspace-id=workspace-1",
          "--retention-days=180",
          "--limit=2",
          `--output=${output}`,
        ],
        {
          cwd: resolve(__dirname, ".."),
          windowsHide: true,
          env: {
            ...process.env,
            MONGODB_URI: uri,
            NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
            SUPABASE_SERVICE_ROLE_KEY: "local-test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let errors = "";
      child.stderr.on("data", data => {
        errors += data.toString();
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.on("error", reject);
        child.on("exit", done);
      });
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      const text = await readFile(output, "utf8");
      const report = JSON.parse(text);
      expect(report.candidates).toHaveLength(1);
      expect(report.excluded).toEqual([
        {
          conversationId: String(ids[1]),
          reason: "message_activity_or_recovery",
        },
      ]);
      expect(report.nextCursor).toBe(String(ids[1]));
      expect(report.deletionAuthorized).toBe(false);
      expect(text).not.toContain("PRIVATE_CONTENT_MUST_NOT_BE_EXPORTED");
      expect(await db.collection("messages").countDocuments()).toBe(3);
    } finally {
      server.close();
      await db.dropDatabase();
      await dbConnection.close();
      await unlink(output).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      await rmdir(directory);
    }
  }, 30_000);
});
