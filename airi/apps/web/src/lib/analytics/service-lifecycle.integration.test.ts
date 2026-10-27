jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/customers/service", () => ({
  syncCustomerForConversation: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: jest.fn(),
}));
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { Conversation } from "@/models/conversation";
import {
  AnalyticsServiceLifecycleCheckpoint,
  AnalyticsServiceLifecycleFact,
  AnalyticsCustomerStageCheckpoint,
} from "@/models/analytics-service-lifecycle";
import Customer from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import {
  materializeCustomerStageEvent,
  watchCustomerStageTransitions,
} from "./customer-stage-consumer";
import {
  decodeCustomerStageEnvelope,
  customerStageQueryOptions,
} from "./customer-stage-transition";
import type { ServiceLifecycleEnvelope } from "./service-lifecycle";
import { customerCsatResolutionFields } from "./service-lifecycle";
import { activateManualHandoff } from "@/lib/airi/reply/runtime/handoff-state";
import {
  advanceServiceLifecycleCheckpoint,
  persistServiceLifecycleFact,
  watchServiceLifecycle,
  ANALYTICS_GLOBAL_CHECKPOINT,
  readServiceLifecycleCoverage,
  rebuildServiceLifecycleSnapshots,
} from "./service-lifecycle-consumer";
import { getServiceLifecycleReport } from "./service-lifecycle-report";
import { startAnalyticsProjectionRuntime } from "./analytics-projection-runtime";

const uri = process.env.AIRICHAT_ANALYTICS_QA_MONGODB_URI;
const workspaceId = `qa-service-lifecycle-${randomUUID()}`;
const globalTenants = [randomUUID(), randomUUID()];
(uri ? describe : describe.skip)(
  "service lifecycle isolated replica integration",
  () => {
    beforeAll(async () => {
      if (
        !uri?.startsWith(
          "mongodb://127.0.0.1:27278/airi_analytics_qa_lifecycle_20261002?"
        )
      )
        throw new Error(
          "Lifecycle integration requires the explicitly isolated local QA database"
        );
      await mongoose.connect(uri, { autoIndex: false });
      await Promise.all([
        Conversation.createCollection(),
        AnalyticsServiceLifecycleFact.createCollection(),
        AnalyticsServiceLifecycleCheckpoint.createCollection(),
        Customer.createCollection(),
        CustomerEvent.createCollection(),
        AnalyticsCustomerStageCheckpoint.createCollection(),
      ]);
      await Promise.all([
        Conversation.createIndexes(),
        AnalyticsServiceLifecycleFact.createIndexes(),
        AnalyticsServiceLifecycleCheckpoint.createIndexes(),
        Customer.createIndexes(),
        CustomerEvent.createIndexes(),
        AnalyticsCustomerStageCheckpoint.createIndexes(),
      ]);
    }, 30000);
    afterAll(async () => {
      const tenantScope = {
        workspaceId: { $in: [workspaceId, ...globalTenants] },
      };
      const checkpointScope = {
        workspaceId: {
          $in: [workspaceId, ...globalTenants, ANALYTICS_GLOBAL_CHECKPOINT],
        },
      };
      await Promise.all([
        Conversation.collection.deleteMany(tenantScope),
        AnalyticsServiceLifecycleFact.deleteMany(tenantScope),
        AnalyticsServiceLifecycleCheckpoint.deleteMany(checkpointScope),
        Customer.collection.deleteMany(tenantScope),
        CustomerEvent.deleteMany(tenantScope),
        AnalyticsCustomerStageCheckpoint.deleteMany(checkpointScope),
      ]);
      await mongoose.disconnect();
    });

    test("captures each rapid source transition, resumes, deduplicates replay and aggregates retained evidence", async () => {
      const doc = await Conversation.create({
        workspaceId,
        channel: "whatsapp",
        status: "open",
        sourceId: "qa-source",
        first_inbound_at: new Date(Date.now() - 120000),
      });
      const watching = watchServiceLifecycle({ workspaceId, maxEvents: 4 });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await AnalyticsServiceLifecycleCheckpoint.findOne({
          workspaceId,
        }).lean<{ streamState?: string } | null>();
        if (state?.streamState === "streaming") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      doc.status = "closed";
      doc.$locals.serviceResolutionKind = "manager";
      await doc.save();
      doc.status = "open";
      await doc.save();
      await activateManualHandoff({ conversationId: String(doc._id) });
      await Conversation.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: "open",
            airi_handoff_active: false,
            airi_handoff_started_at: null,
          },
        }
      );
      expect(await watching).toMatchObject({ status: "stopped", processed: 4 });
      const facts = await AnalyticsServiceLifecycleFact.find({ workspaceId })
        .sort({ revision: 1 })
        .lean<{ envelope: ServiceLifecycleEnvelope }[]>();
      expect(facts).toHaveLength(4);
      expect(facts.map(row => row.envelope.kinds)).toEqual([
        ["resolved"],
        ["reopened"],
        ["status_changed", "handoff_started"],
        ["status_changed", "handoff_ended"],
      ]);
      const raw = await Conversation.collection.findOne({ _id: doc._id });
      expect(typeof raw?.service_lifecycle_event).toBe("string");
      expect(JSON.parse(raw!.service_lifecycle_event).revision).toBe(5);
      await persistServiceLifecycleFact(facts[0].envelope, "change_stream");
      expect(
        await AnalyticsServiceLifecycleFact.countDocuments({ workspaceId })
      ).toBe(4);

      const closing = await Conversation.findById(doc._id);
      closing.status = "closed";
      closing.csat_timeout_closed = true;
      await closing.save();
      expect(
        await watchServiceLifecycle({ workspaceId, maxEvents: 1 })
      ).toMatchObject({ status: "stopped", processed: 1 });
      const report = await getServiceLifecycleReport(
        workspaceId,
        new Date(Date.now() - 86400000),
        new Date(Date.now() + 60000)
      );
      expect(report.observed).toMatchObject({
        events: 5,
        resolvedEvents: 1,
        measuredResolutions: 1,
        timeoutClosures: 1,
        reopened: 1,
        handoffStarted: 1,
        handoffEnded: 1,
        measuredHandoffs: 1,
      });
      expect(report.observed.averageResolutionSeconds).toBeGreaterThanOrEqual(
        120
      );
      expect(report.observed.averageHandoffSeconds).toBeGreaterThanOrEqual(0);
    }, 30000);

    test("stale document saves cannot overwrite resolution and stale consumers cannot advance a checkpoint", async () => {
      const created = await Conversation.create({
        workspaceId,
        status: "open",
        first_inbound_at: new Date(Date.now() - 1000),
      });
      const first = await Conversation.findById(created._id),
        stale = await Conversation.findById(created._id);
      first.status = "closed";
      first.$locals.serviceResolutionKind = "manager";
      await first.save();
      stale.status = "closed";
      stale.csat_timeout_closed = true;
      await expect(stale.save()).rejects.toThrow();
      expect(
        (await Conversation.findById(created._id)).service_resolution_kind
      ).toBe("manager");
      await Conversation.updateOne(
        { _id: created._id },
        {
          $set: {
            status: "closed",
            customer_satisfaction_score: 5,
            ...customerCsatResolutionFields(),
          },
        }
      );
      expect(
        (await Conversation.findById(created._id)).service_resolution_kind
      ).toBe("manager");
      await AnalyticsServiceLifecycleCheckpoint.updateOne(
        { workspaceId },
        {
          $set: {
            leaseOwner: "new-holder",
            fence: 100,
            leaseExpiresAt: new Date(Date.now() + 30000),
            resumeToken: { token: "new-token" },
          },
        }
      );
      await expect(
        advanceServiceLifecycleCheckpoint(
          { workspaceId, owner: "old-holder", fence: 99 },
          { $set: { resumeToken: { token: "stale-token" } } }
        )
      ).rejects.toThrow("lease");
      expect(
        (
          await AnalyticsServiceLifecycleCheckpoint.findOne({
            workspaceId,
          }).lean<{ resumeToken?: Record<string, unknown> } | null>()
        )?.resumeToken
      ).toEqual({ token: "new-token" });
      expect(
        await watchServiceLifecycle({ workspaceId, maxEvents: 1 })
      ).toMatchObject({ status: "busy", processed: 0 });
    });

    test("provider CSAT query closure writes a stable customer resolution through the shared canonical model", async () => {
      const created = await Conversation.create({
        workspaceId,
        status: "open",
        awaiting_csat: true,
        first_inbound_at: new Date(Date.now() - 10000),
      });
      await Conversation.updateOne(
        { _id: created._id },
        {
          $set: {
            status: "closed",
            customer_satisfaction_score: 5,
            awaiting_csat: false,
            ...customerCsatResolutionFields(),
          },
        }
      );
      const closed = await Conversation.findById(created._id);
      expect(closed.service_resolution_kind).toBe("customer_csat");
      expect(closed.service_resolved_at).toBeInstanceOf(Date);
      expect(closed.csat_timeout_closed).toBe(false);
      expect(closed.service_lifecycle_event.kinds).toEqual(["resolved"]);
    });

    test("canonical CRM stage writes retain rapid return visits with actor and idempotent CustomerEvent replay", async () => {
      const customer = await Customer.create({
        workspaceId,
        currentFunnelStage: "new",
      });
      const watching = watchCustomerStageTransitions({
        workspaceId,
        maxEvents: 3,
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await AnalyticsCustomerStageCheckpoint.findOne({
          workspaceId,
        }).lean<{ streamState?: string } | null>();
        if (state?.streamState === "streaming") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      customer.currentFunnelStage = "qualified";
      await customer.save();
      await Customer.updateOne(
        { _id: customer._id },
        { $set: { currentFunnelStage: "proposal" } },
        customerStageQueryOptions({
          actor: { type: "manager", userId: "qa-manager" },
          source: "crm_board",
        })
      );
      await Customer.updateOne(
        { _id: customer._id },
        { $set: { currentFunnelStage: "qualified" } },
        customerStageQueryOptions({
          actor: { type: "manager", userId: "qa-manager" },
          source: "crm_board",
        })
      );
      expect(await watching).toMatchObject({ status: "stopped", processed: 3 });
      const events = await CustomerEvent.find({
        workspaceId,
        customerId: customer._id,
      })
        .sort({ "payload.stageRevision": 1 })
        .lean<
          {
            payload: { stage: string; previousStage: string };
            actor: { type: string; userId: string };
          }[]
        >();
      expect(events).toHaveLength(3);
      expect(events.map(row => row.payload.stage)).toEqual([
        "qualified",
        "proposal",
        "qualified",
      ]);
      expect(events.map(row => row.payload.previousStage)).toEqual([
        "new",
        "qualified",
        "proposal",
      ]);
      expect(events[2].actor).toMatchObject({
        type: "manager",
        userId: "qa-manager",
      });
      const latest = await Customer.collection.findOne({ _id: customer._id });
      expect(typeof latest?.crm_stage_event).toBe("string");
      await materializeCustomerStageEvent(
        decodeCustomerStageEnvelope(latest?.crm_stage_event)!
      );
      expect(
        await CustomerEvent.countDocuments({
          workspaceId,
          customerId: customer._id,
        })
      ).toBe(3);
      const first = await Customer.findById(customer._id),
        stale = await Customer.findById(customer._id);
      first.currentFunnelStage = "won";
      await first.save();
      stale.currentFunnelStage = "lost";
      await expect(stale.save()).rejects.toThrow();
      expect((await Customer.findById(customer._id)).currentFunnelStage).toBe(
        "won"
      );
      expect(
        (
          await AnalyticsServiceLifecycleCheckpoint.findOne({
            workspaceId,
          }).lean<{ fence: number } | null>()
        )?.fence
      ).toBe(100);
    }, 30000);

    test("selected sources isolate retained counts, resolution and handoff durations using the canonical source-window index", async () => {
      const sourceA = randomUUID(),
        sourceB = randomUUID();
      const start = new Date("2026-08-01T00:00:00Z"),
        end = new Date("2026-08-02T00:00:00Z");
      const occurredAt = new Date("2026-08-01T12:00:00Z");
      const envelope = (
        sourceId: string,
        values: Partial<ServiceLifecycleEnvelope>
      ): ServiceLifecycleEnvelope => ({
        contractVersion: 1,
        eventId: randomUUID(),
        revision: 1,
        occurredAt,
        workspaceId,
        conversationId: randomUUID(),
        customerId: null,
        sourceId,
        channel: "whatsapp",
        kinds: ["resolved"],
        previousStatus: "open",
        status: "closed",
        previousHandoffActive: false,
        handoffActive: false,
        episodeStartedAt: null,
        closedAt: occurredAt,
        resolvedAt: occurredAt,
        resolutionKind: "manager",
        ...values,
      });
      await Promise.all([
        persistServiceLifecycleFact(
          envelope(sourceA, {
            episodeStartedAt: new Date(occurredAt.getTime() - 60000),
          }),
          "change_stream"
        ),
        persistServiceLifecycleFact(
          envelope(sourceB, {
            episodeStartedAt: new Date(occurredAt.getTime() - 600000),
          }),
          "change_stream"
        ),
        persistServiceLifecycleFact(
          envelope(sourceA, {
            kinds: ["handoff_ended"],
            status: "open",
            closedAt: null,
            resolvedAt: null,
            resolutionKind: null,
            previousHandoffActive: true,
            handoffStartedAt: new Date(occurredAt.getTime() - 120000),
          }),
          "change_stream"
        ),
        persistServiceLifecycleFact(
          envelope(sourceB, {
            kinds: ["timeout_closed"],
            resolutionKind: "timeout",
            resolvedAt: null,
          }),
          "change_stream"
        ),
        persistServiceLifecycleFact(
          envelope(sourceA, {
            occurredAt: end,
            closedAt: end,
            resolvedAt: end,
            episodeStartedAt: new Date(end.getTime() - 900000),
          }),
          "change_stream"
        ),
      ]);
      const [all, first, second, missing] = await Promise.all([
        getServiceLifecycleReport(workspaceId, start, end),
        getServiceLifecycleReport(workspaceId, start, end, sourceA),
        getServiceLifecycleReport(workspaceId, start, end, sourceB),
        getServiceLifecycleReport(workspaceId, start, end, randomUUID()),
      ]);
      expect(all.observed).toMatchObject({
        events: 4,
        resolvedEvents: 2,
        averageResolutionSeconds: 330,
      });
      expect(all.sourceGroupsTotal).toBe(2);
      expect(first.observed).toMatchObject({
        events: 2,
        resolvedEvents: 1,
        measuredResolutions: 1,
        averageResolutionSeconds: 60,
        handoffEnded: 1,
        measuredHandoffs: 1,
        averageHandoffSeconds: 120,
        timeoutClosures: 0,
      });
      expect(first.bySource).toHaveLength(1);
      expect(first.bySource[0].sourceId).toBe(sourceA);
      expect(first.sourceGroupsTotal).toBe(1);
      expect(second.observed).toMatchObject({
        events: 2,
        resolvedEvents: 1,
        averageResolutionSeconds: 600,
        handoffEnded: 0,
        measuredHandoffs: 0,
        averageHandoffSeconds: null,
        timeoutClosures: 1,
      });
      expect(second.bySource).toHaveLength(1);
      expect(second.bySource[0].sourceId).toBe(sourceB);
      expect(missing.observed).toMatchObject({
        events: 0,
        averageResolutionSeconds: null,
        averageHandoffSeconds: null,
      });
      expect(missing.bySource).toEqual([]);
      expect(missing.sourceGroupsTotal).toBe(0);
      expect(await AnalyticsServiceLifecycleFact.collection.indexes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: { workspaceId: 1, sourceId: 1, occurredAt: 1, _id: 1 },
          }),
        ])
      );
    });
    test("two shared fenced streams route two tenants, resume offline transitions and lazily recover a new global gap", async () => {
      await Promise.all([
        AnalyticsServiceLifecycleCheckpoint.deleteOne({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
        }),
        AnalyticsCustomerStageCheckpoint.deleteOne({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
        }),
      ]);
      const abort = new AbortController();
      const tasks: Promise<unknown>[] = [];
      const waitStreaming = async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [service, stage] = await Promise.all([
            AnalyticsServiceLifecycleCheckpoint.findOne({
              workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
            }).lean<{ streamState?: string } | null>(),
            AnalyticsCustomerStageCheckpoint.findOne({
              workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
            }).lean<{ streamState?: string } | null>(),
          ]);
          if (
            service?.streamState === "streaming" &&
            stage?.streamState === "streaming"
          )
            return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error("Shared source streams did not activate");
      };
      try {
        const service = watchServiceLifecycle({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          signal: abort.signal,
          maxEvents: 4,
        });
        const stage = watchCustomerStageTransitions({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          signal: abort.signal,
          maxEvents: 4,
        });
        tasks.push(service, stage);
        await waitStreaming();
        const originalHolder =
          await AnalyticsServiceLifecycleCheckpoint.findOne({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          }).lean<{ leaseOwner: string; fence: number } | null>();
        expect(originalHolder).not.toBeNull();
        const chats = [];
        const customers = [];
        for (const tenant of globalTenants) {
          chats.push(
            await Conversation.create({
              workspaceId: tenant,
              status: "open",
              first_inbound_at: new Date(Date.now() - 1000),
            })
          );
          customers.push(
            await Customer.create({
              workspaceId: tenant,
              currentFunnelStage: "new",
            })
          );
        }
        for (const chat of chats) {
          chat.status = "closed";
          chat.$locals.serviceResolutionKind = "manager";
          await chat.save();
        }
        for (const customer of customers) {
          customer.currentFunnelStage = "qualified";
          await customer.save();
        }
        expect(await service).toMatchObject({
          status: "stopped",
          processed: 4,
        });
        expect(await stage).toMatchObject({ status: "stopped", processed: 4 });
        for (const tenant of globalTenants) {
          expect(
            await AnalyticsServiceLifecycleFact.countDocuments({
              workspaceId: tenant,
            })
          ).toBe(2);
          expect(
            await CustomerEvent.countDocuments({ workspaceId: tenant })
          ).toBe(2);
          expect(await readServiceLifecycleCoverage(tenant)).toMatchObject({
            state: "degraded",
            history: "since_activation",
          });
        }
        expect(
          await AnalyticsServiceLifecycleFact.countDocuments({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          })
        ).toBe(0);
        expect(
          await CustomerEvent.countDocuments({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          })
        ).toBe(0);
        const beforeOffline = await AnalyticsServiceLifecycleCheckpoint.findOne(
          { workspaceId: ANALYTICS_GLOBAL_CHECKPOINT }
        ).lean<{ resumeToken: Record<string, unknown> } | null>();
        expect(beforeOffline?.resumeToken).toBeTruthy();
        for (const chat of chats)
          await Conversation.updateOne(
            { _id: chat._id },
            { $set: { status: "open" } }
          );
        for (const customer of customers)
          await Customer.updateOne(
            { _id: customer._id },
            { $set: { currentFunnelStage: "proposal" } }
          );
        const resumedService = watchServiceLifecycle({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          signal: abort.signal,
          maxEvents: 2,
        });
        const resumedStage = watchCustomerStageTransitions({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          signal: abort.signal,
          maxEvents: 2,
        });
        tasks.push(resumedService, resumedStage);
        expect(await resumedService).toMatchObject({ processed: 2 });
        expect(await resumedStage).toMatchObject({ processed: 2 });
        expect(
          await AnalyticsServiceLifecycleFact.countDocuments({
            workspaceId: { $in: globalTenants },
          })
        ).toBe(6);
        expect(
          await CustomerEvent.countDocuments({
            workspaceId: { $in: globalTenants },
          })
        ).toBe(6);
        await expect(
          advanceServiceLifecycleCheckpoint(
            {
              workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
              owner: originalHolder!.leaseOwner,
              fence: originalHolder!.fence,
            },
            { $set: { resumeToken: { stale: true } } }
          )
        ).rejects.toThrow("lease");
        await AnalyticsServiceLifecycleCheckpoint.updateOne(
          { workspaceId: ANALYTICS_GLOBAL_CHECKPOINT },
          { $set: { resumeToken: beforeOffline!.resumeToken } }
        );
        const replay = watchServiceLifecycle({
          workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          signal: abort.signal,
          maxEvents: 2,
        });
        tasks.push(replay);
        expect(await replay).toMatchObject({ processed: 2 });
        expect(
          await AnalyticsServiceLifecycleFact.countDocuments({
            workspaceId: { $in: globalTenants },
          })
        ).toBe(6);
        await rebuildServiceLifecycleSnapshots({
          workspaceId: globalTenants[0],
          batchSize: 1,
        });
        expect(
          (await readServiceLifecycleCoverage(globalTenants[0]))
            .snapshotRecovery
        ).toBe("complete");
        const latest = await Conversation.findById(chats[0]._id);
        latest.status = "closed";
        latest.$locals.serviceResolutionKind = "manager";
        await latest.save();
        expect(
          await AnalyticsServiceLifecycleFact.countDocuments({
            workspaceId: { $in: globalTenants },
          })
        ).toBe(6);
        const gapAt = new Date();
        await AnalyticsServiceLifecycleCheckpoint.updateOne(
          { workspaceId: ANALYTICS_GLOBAL_CHECKPOINT },
          { $set: { historyState: "history_gap", historyGapAt: gapAt } }
        );
        expect(
          await readServiceLifecycleCoverage(globalTenants[0])
        ).toMatchObject({
          history: "history_gap",
          snapshotRecovery: "pending",
          snapshotScanned: 0,
        });
        await rebuildServiceLifecycleSnapshots({
          workspaceId: globalTenants[0],
          batchSize: 1,
        });
        await rebuildServiceLifecycleSnapshots({
          workspaceId: globalTenants[0],
          batchSize: 1,
        });
        expect(
          await AnalyticsServiceLifecycleFact.countDocuments({
            workspaceId: { $in: globalTenants },
          })
        ).toBe(7);
        expect(
          await readServiceLifecycleCoverage(globalTenants[0])
        ).toMatchObject({
          history: "history_gap",
          snapshotRecovery: "complete",
          snapshotScanned: 1,
        });
        expect(
          (
            await AnalyticsServiceLifecycleCheckpoint.findOne({
              workspaceId: globalTenants[0],
            }).lean<{ snapshotGapAt: Date } | null>()
          )?.snapshotGapAt
        ).toEqual(gapAt);
      } finally {
        abort.abort();
        await Promise.allSettled(tasks);
      }
    }, 60000);
    test("a stage-less customer insert never reaches the shared stage consumer or opens a history gap", async () => {
      await AnalyticsCustomerStageCheckpoint.deleteOne({
        workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
      });
      const tenant = globalTenants[1];
      const before = await CustomerEvent.countDocuments({
        workspaceId: tenant,
      });
      const abort = new AbortController();
      const stage = watchCustomerStageTransitions({
        workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
        signal: abort.signal,
        maxEvents: 1,
      });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const state = await AnalyticsCustomerStageCheckpoint.findOne({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          }).lean<{ streamState?: string } | null>();
          if (state?.streamState === "streaming") break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        // The schema default (crm_stage_event_key: null) is not an event.
        const stageless = await Customer.create({ workspaceId: tenant });
        expect(
          (await Customer.collection.findOne({ _id: stageless._id }))
            ?.crm_stage_event_key
        ).toBeNull();
        await Customer.create({
          workspaceId: tenant,
          currentFunnelStage: "new",
        });
        // The single processed change is the real transition, not the default insert.
        expect(await stage).toMatchObject({ status: "stopped", processed: 1 });
        expect(
          await CustomerEvent.countDocuments({ workspaceId: tenant })
        ).toBe(before + 1);
        expect(
          await AnalyticsCustomerStageCheckpoint.findOne({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
          }).lean()
        ).toMatchObject({
          historyState: "since_activation",
          historyGapAt: null,
        });
      } finally {
        abort.abort();
        await stage.catch(() => undefined);
      }
    }, 30000);
    test("the worker-owned daemon starts exactly two shared streams and drains both fenced holders on shutdown", async () => {
      const parent = new AbortController();
      const stop = await startAnalyticsProjectionRuntime({
        signal: parent.signal,
        logger: { info: () => undefined, error: () => undefined },
        loadDependencies: async () => ({
          streams: [],
          discover: async () => ({ ids: [], lastId: null, hasMore: false }),
          acquireDiscovery: async () => null,
          acquireProvider: async () => null,
          project: async () => ({ status: "idle", processed: 0 }),
          snapshots: async () => undefined,
          syncProvider: async () => ({ hasMore: false, nextSourceId: null }),
          logger: { info: () => undefined, error: () => undefined },
          now: () => new Date(),
        }),
      });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const held = await Promise.all([
            AnalyticsServiceLifecycleCheckpoint.countDocuments({
              workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
              streamState: "streaming",
              leaseOwner: { $ne: null },
            }),
            AnalyticsCustomerStageCheckpoint.countDocuments({
              workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
              streamState: "streaming",
              leaseOwner: { $ne: null },
            }),
          ]);
          if (held.every(count => count === 1)) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(
          await AnalyticsServiceLifecycleCheckpoint.countDocuments({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
            leaseOwner: { $ne: null },
          })
        ).toBe(1);
        expect(
          await AnalyticsCustomerStageCheckpoint.countDocuments({
            workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
            leaseOwner: { $ne: null },
          })
        ).toBe(1);
      } finally {
        parent.abort();
        await stop();
      }
      for (const model of [
        AnalyticsServiceLifecycleCheckpoint,
        AnalyticsCustomerStageCheckpoint,
      ]) {
        const retained = await model
          .findOne({ workspaceId: ANALYTICS_GLOBAL_CHECKPOINT })
          .lean<{
            leaseOwner: string | null;
            leaseExpiresAt: Date | null;
            resumeToken: Record<string, unknown>;
            firstObservedAt: Date;
          } | null>();
        expect(retained).toMatchObject({
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        expect(retained?.resumeToken).toBeTruthy();
        expect(retained?.firstObservedAt).toBeInstanceOf(Date);
      }
    }, 30000);
  }
);
