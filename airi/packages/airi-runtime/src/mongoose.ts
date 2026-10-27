import { readIntegerEnv } from "@icecore/shared/lib/env";
import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI environment variable is required");
}

type MongooseCache = {
  connection: typeof mongoose | null;
  connectionPromise: Promise<typeof mongoose> | null;
  reconnectWaitPromise: Promise<typeof mongoose> | null;
  listenersBound: boolean;
};

const globalForMongoose = globalThis as typeof globalThis & {
  __mongooseCache?: MongooseCache;
};

const mongooseCache: MongooseCache = globalForMongoose.__mongooseCache ?? {
  connection: null,
  connectionPromise: null,
  reconnectWaitPromise: null,
  listenersBound: false,
};

globalForMongoose.__mongooseCache = mongooseCache;

function isSrvMongoUri(uri: string | undefined): boolean {
  return Boolean(uri?.startsWith("mongodb+srv://"));
}

function isMongoSrvLookupError(error: unknown): boolean {
  if (!isSrvMongoUri(MONGODB_URI)) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /querySrv\s+(ECONNREFUSED|ETIMEOUT|ENOTFOUND|ESERVFAIL|ENODATA)/i.test(
      message,
    ) || /_mongodb\._tcp/i.test(message)
  );
}

function withMongoLocalHint(error: unknown): Error {
  if (!isMongoSrvLookupError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const hintedError = new Error(
    [
      message,
      "MongoDB Atlas SRV lookup failed locally. Check the configured database's DNS/network access, or set MONGODB_URI in apps/web/.env.local to a local development database. If SRV is unavailable, use the configured database's standard mongodb:// connection string.",
    ].join("\n"),
  );
  (hintedError as Error & { cause?: unknown }).cause = error;
  return hintedError;
}

const maxPoolSize = readIntegerEnv("MONGODB_MAX_POOL_SIZE", 10, {
  min: 1,
  max: 50,
});

const connectionOptions = {
  maxPoolSize,
  minPoolSize: Math.min(
    maxPoolSize,
    readIntegerEnv("MONGODB_MIN_POOL_SIZE", 0, { min: 0, max: 10 }),
  ),
  maxIdleTimeMS: readIntegerEnv("MONGODB_MAX_IDLE_TIME_MS", 10_000, {
    min: 1_000,
    max: 120_000,
  }),
  maxConnecting: readIntegerEnv("MONGODB_MAX_CONNECTING", 5, {
    min: 1,
    max: 10,
  }),
  serverSelectionTimeoutMS: readIntegerEnv(
    "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
    8_000,
    { min: 1_000, max: 30_000 },
  ),
  connectTimeoutMS: readIntegerEnv("MONGODB_CONNECT_TIMEOUT_MS", 10_000, {
    min: 1_000,
    max: 30_000,
  }),
  socketTimeoutMS: readIntegerEnv("MONGODB_SOCKET_TIMEOUT_MS", 45_000, {
    min: 5_000,
    max: 120_000,
  }),
  appName: process.env.MONGODB_APP_NAME || "icecore-web",
  autoIndex: false,
  retryWrites: true,
  retryReads: true,
};

const reconnectWaitTimeoutMS = readIntegerEnv(
  "MONGODB_RECONNECT_WAIT_TIMEOUT_MS",
  5_000,
  { min: 500, max: 30_000 },
);

async function connectWithUri(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, connectionOptions);
}

function bindListenersOnce() {
  if (mongooseCache.listenersBound) {
    return;
  }

  mongooseCache.listenersBound = true;

  mongoose.connection.on("connected", () => {
    mongooseCache.connection = mongoose;
  });

  mongoose.connection.on("error", () => {
    if (mongoose.connection.readyState === 0) {
      mongooseCache.connection = null;
    }
  });

  mongoose.connection.on("disconnected", () => {
    mongooseCache.connection = null;
  });
}

function waitForDriverReconnect(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    mongooseCache.connection = mongoose;
    return Promise.resolve(mongoose);
  }

  if (mongooseCache.reconnectWaitPromise) {
    return mongooseCache.reconnectWaitPromise;
  }

  mongooseCache.reconnectWaitPromise = new Promise<typeof mongoose>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while waiting for MongoDB reconnect"));
      }, reconnectWaitTimeoutMS);

      const onConnected = () => {
        cleanup();
        mongooseCache.connection = mongoose;
        resolve(mongoose);
      };

      const cleanup = () => {
        clearTimeout(timer);
        mongoose.connection.off("connected", onConnected);
      };

      mongoose.connection.on("connected", onConnected);
    },
  ).finally(() => {
    mongooseCache.reconnectWaitPromise = null;
  });

  return mongooseCache.reconnectWaitPromise!;
}

async function connectDB(): Promise<typeof mongoose> {
  mongoose.set("bufferCommands", false);
  bindListenersOnce();

  const readyState = mongoose.connection.readyState;
  if (readyState === 1) {
    mongooseCache.connection = mongoose;
    return mongoose;
  }

  if (mongooseCache.connectionPromise) {
    return mongooseCache.connectionPromise;
  }

  if (readyState === 2 || readyState === 3) {
    try {
      return await waitForDriverReconnect();
    } catch (error) {
      // A sibling waiter may already own the fresh attempt after disconnection.
      if (mongooseCache.connectionPromise) {
        return mongooseCache.connectionPromise;
      }
      if (mongoose.connection.readyState === 1) {
        return mongoose;
      }
      // Reopening the same URI while connecting can resolve before it is ready.
      if (mongoose.connection.readyState !== 0) {
        throw error;
      }
    }
  }

  mongooseCache.connectionPromise = connectWithUri(MONGODB_URI!)
    .then((instance) => {
      mongooseCache.connection = instance;
      return instance;
    })
    .catch((error) => {
      mongooseCache.connection = null;
      throw withMongoLocalHint(error);
    })
    .finally(() => {
      mongooseCache.connectionPromise = null;
    });

  return mongooseCache.connectionPromise;
}

export function getDBState(): string {
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  return (
    states[mongoose.connection.readyState as keyof typeof states] || "unknown"
  );
}

export async function getDBHealth(): Promise<{
  status: "healthy" | "unhealthy";
  latency?: number;
}> {
  try {
    if (!mongoose.connection.db) {
      return { status: "unhealthy" };
    }

    const start = Date.now();
    await mongoose.connection.db.admin().ping();
    const latency = Date.now() - start;

    return {
      status: "healthy",
      latency,
    };
  } catch {
    return { status: "unhealthy" };
  }
}

export { connectDB };
export default connectDB;
