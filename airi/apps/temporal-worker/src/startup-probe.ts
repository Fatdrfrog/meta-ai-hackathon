import { createServer, type AddressInfo, type Socket } from "node:net";

export const WORKER_STARTUP_PROBE_PORT_ENV = "AIRI_WORKER_STARTUP_PROBE_PORT";

/** Port for the Cloud Run TCP startup probe, or null when none is wired. */
export function readWorkerStartupProbePort(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = String(env[WORKER_STARTUP_PROBE_PORT_ENV] ?? "").trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${WORKER_STARTUP_PROBE_PORT_ENV} must be a TCP port; got '${raw}'`,
    );
  }
  return port;
}

/**
 * Accepts TCP connections so Cloud Run's startup probe passes. The worker
 * opens it only once fully started: a rollout stops the previous instances
 * after the new ones pass their startup check, so they keep consuming until
 * this one does.
 */
export async function startWorkerStartupProbeListener(params: {
  port: number;
  host?: string;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, params.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => undefined);

  let stopping: Promise<void> | null = null;
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      stopping ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return stopping;
    },
  };
}
