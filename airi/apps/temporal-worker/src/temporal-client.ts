import { Client, Connection } from "@temporalio/client";

import type { TemporalWorkerConfig } from "./config.js";

let temporalClientPromise: Promise<Client> | null = null;

export function getTemporalClient(
  config: Pick<
    TemporalWorkerConfig,
    "address" | "tls" | "apiKey" | "namespace"
  >,
): Promise<Client> {
  if (!temporalClientPromise) {
    temporalClientPromise = Connection.connect({
      address: config.address,
      tls: config.tls ? {} : undefined,
      apiKey: config.apiKey || undefined,
    }).then(
      (connection) =>
        new Client({
          connection,
          namespace: config.namespace,
        }),
    );
  }
  return temporalClientPromise;
}
