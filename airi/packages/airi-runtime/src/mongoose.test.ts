import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import mongoose from "mongoose";

let moduleInstance = 0;

function setReadyState(state: mongoose.ConnectionStates): void {
  // Mongoose exposes a runtime setter even though its public type is read-only.
  assert.equal(Reflect.set(mongoose.connection, "readyState", state), true);
}

async function loadMongoose(
  t: TestContext,
  env: Record<string, string> = {},
): Promise<typeof import("./mongoose")> {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    MONGODB_URI: "mongodb://127.0.0.1:27277/mongoose_unit_tests",
    MONGODB_RECONNECT_WAIT_TIMEOUT_MS: "500",
    MONGODB_MAX_POOL_SIZE: "2",
    MONGODB_MIN_POOL_SIZE: "10",
    ...env,
  };
  setReadyState(0);
  t.after(() => {
    setReadyState(0);
  });
  try {
    // Connection options are captured at import; exercise each config independently.
    return await import(
      new URL(`./mongoose.ts?test=${moduleInstance++}`, import.meta.url).href
    );
  } finally {
    process.env = originalEnv;
  }
}

for (const state of [2, 3] as const) {
  test(`rejects a stalled driver transition in state ${state} without starting another connect`, async t => {
    const { connectDB } = await loadMongoose(t);
    const connect = t.mock.method(mongoose, "connect", async () => mongoose);
    setReadyState(state);

    await Promise.all([
      assert.rejects(connectDB(), /Timed out while waiting for MongoDB reconnect/),
      assert.rejects(connectDB(), /Timed out while waiting for MongoDB reconnect/),
    ]);

    assert.equal(connect.mock.callCount(), 0);
    assert.equal(mongoose.connection.readyState, state);

    setReadyState(0);
    connect.mock.mockImplementation(async () => {
      setReadyState(1);
      return mongoose;
    });
    assert.equal(await connectDB(), mongoose);
    assert.equal(connect.mock.callCount(), 1);
  });
}

test("returns the driver's completed reconnect without opening another connection", async t => {
  const { connectDB } = await loadMongoose(t);
  const connect = t.mock.method(mongoose, "connect", async () => mongoose);
  setReadyState(2);
  const pending = connectDB();

  setReadyState(1);

  assert.equal(await pending, mongoose);
  assert.equal(connect.mock.callCount(), 0);
});

test("shares one fresh connection when concurrent reconnect waiters become disconnected", async t => {
  const { connectDB } = await loadMongoose(t);
  let resolveConnection!: (value: typeof mongoose) => void;
  const connection = new Promise<typeof mongoose>(resolve => {
    resolveConnection = resolve;
  });
  const connect = t.mock.method(mongoose, "connect", () => {
    setReadyState(2);
    setImmediate(() => {
      setReadyState(1);
      resolveConnection(mongoose);
    });
    return connection;
  });
  setReadyState(3);
  const pending = [connectDB(), connectDB()];
  setReadyState(0);

  assert.deepEqual(await Promise.all(pending), [mongoose, mongoose]);
  assert.equal(connect.mock.callCount(), 1);
});

test("bounds the minimum pool by the configured maximum before passing options to the driver", async t => {
  const { connectDB } = await loadMongoose(t);
  const connect = t.mock.method(mongoose, "connect", async (_uri: string, options?: mongoose.ConnectOptions) => {
    assert.equal(options?.maxPoolSize, 2);
    assert.equal(options?.minPoolSize, 2);
    // Construction validates the actual driver options without opening a socket.
    new mongoose.mongo.MongoClient("mongodb://127.0.0.1:27277/unused", {
      maxPoolSize: options?.maxPoolSize,
      minPoolSize: options?.minPoolSize,
    });
    setReadyState(1);
    return mongoose;
  });

  assert.equal(await connectDB(), mongoose);
  assert.equal(connect.mock.callCount(), 1);
});

test("preserves lazy pool defaults when no pool overrides are configured", async t => {
  const { connectDB } = await loadMongoose(t, {
    MONGODB_MAX_POOL_SIZE: "",
    MONGODB_MIN_POOL_SIZE: "",
  });
  t.mock.method(mongoose, "connect", async (_uri: string, options?: mongoose.ConnectOptions) => {
    assert.equal(options?.maxPoolSize, 10);
    assert.equal(options?.minPoolSize, 0);
    setReadyState(1);
    return mongoose;
  });

  assert.equal(await connectDB(), mongoose);
});

test("keeps failed connection retryable and directs local SRV failures to a development database", async t => {
  const { connectDB } = await loadMongoose(t, {
    MONGODB_URI: "mongodb+srv://mongoose-unit.invalid/test",
  });
  const failure = new Error("querySrv ENOTFOUND _mongodb._tcp.mongoose-unit.invalid");
  let failed = false;
  const connect = t.mock.method(mongoose, "connect", async () => {
    if (!failed) {
      failed = true;
      throw failure;
    }
    setReadyState(1);
    return mongoose;
  });

  await assert.rejects(connectDB(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /local.*development|development.*local/i);
    assert.doesNotMatch(error.message, /production.*credentials/i);
    assert.equal((error as Error & { cause: unknown }).cause, failure);
    return true;
  });
  assert.equal(await connectDB(), mongoose);
  assert.equal(connect.mock.callCount(), 2);
});
