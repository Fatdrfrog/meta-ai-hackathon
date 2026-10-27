import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("WhatsApp cron configuration", () => {
  it("keeps only Meta-side WhatsApp maintenance on Vercel cron", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "vercel.json"), "utf8")
    ) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cronPaths = new Set(config.crons?.map(cron => cron.path));

    expect(cronPaths).toContain("/api/cron/check-whatsapp-webhooks");
    // Reads receipts only, so it can run hourly without Meta API calls.
    expect(
      config.crons?.find(
        cron => cron.path === "/api/cron/whatsapp-inbound-liveness"
      )
    ).toEqual({
      path: "/api/cron/whatsapp-inbound-liveness",
      schedule: "25 * * * *",
    });
    expect(cronPaths).not.toContain("/api/cron/drain-whatsapp-webhook-events");
    expect(cronPaths).not.toContain("/api/cron/follow-up-audience-projection");
    expect(cronPaths).not.toContain("/api/cron/retryWebhooks");
  });

  it("keeps WhatsApp webhook draining out of the web runtime", () => {
    expect(
      existsSync(
        join(
          process.cwd(),
          "src/app/api/cron/drain-whatsapp-webhook-events/route.ts"
        )
      )
    ).toBe(false);
    expect(
      existsSync(
        join(process.cwd(), "src/lib/whatsapp/webhook-event-drainer.ts")
      )
    ).toBe(false);
  });
});

describe("Cron route configuration", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "vercel.json"), "utf8")
  ) as {
    crons?: Array<{ path?: string; schedule?: string }>;
  };

  it("schedules only crons that have a route handler", () => {
    const missing = (config.crons ?? [])
      .map(cron => String(cron.path).split("?")[0])
      .filter(
        path => !existsSync(join(process.cwd(), "src/app", path, "route.ts"))
      );

    expect(missing).toEqual([]);
  });

  // Regression: the landing stats snapshot kept rebuilding every 30 minutes
  // long after the homepage stopped showing it.
  it("no longer schedules the retired landing stats cron", () => {
    expect(
      config.crons?.some(cron => cron.path === "/api/cron/landing-stats")
    ).toBe(false);
  });
});

describe("Airi ingress cron configuration", () => {
  it("retries the durable queue on the deployment's established five-minute cadence", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "vercel.json"), "utf8")
    ) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    expect(
      config.crons?.find(cron => cron.path === "/api/cron/retry-airi-ingress")
    ).toEqual({
      path: "/api/cron/retry-airi-ingress",
      schedule: "*/5 * * * *",
    });
  });
});
