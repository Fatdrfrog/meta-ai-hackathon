import Customer from "../customer";
import { customerStageQueryOptions } from "@/lib/analytics/customer-stage-transition";

type Hook = { fn: (...args: unknown[]) => unknown };
const hooks = (
  Customer.schema as unknown as {
    s: { hooks: { _pres: Map<string, Hook[]>; _posts: Map<string, Hook[]> } };
  }
).s.hooks;
const hook = (phase: "pre" | "post", method: string, name: string) =>
  (phase === "pre" ? hooks._pres : hooks._posts)
    .get(method)!
    .find(entry => entry.fn.name === name)!.fn;

test("a stage save captures a distinct scalar transition and source revision in the same write", async () => {
  const doc = Customer.hydrate({
    _id: "66b8db4b52ca2cbd68b79312",
    workspaceId: "w",
    currentFunnelStage: "proposal",
    crm_stage_revision: 2,
  });
  doc.currentFunnelStage = "qualified";
  doc.$locals.customerStageContext = {
    actor: { type: "manager", userId: "u" },
    source: "crm_board",
  };
  await hook("pre", "save", "captureCustomerStageTransition").call(doc);
  expect(doc.crm_stage_event).toMatchObject({
    workspaceId: "w",
    customerId: String(doc._id),
    previousStage: "proposal",
    stage: "qualified",
    revision: 3,
    actor: { type: "manager", userId: "u" },
  });
  expect(typeof doc.toObject({ getters: false }).crm_stage_event).toBe(
    "string"
  );
  expect(doc.$where).toEqual({ crm_stage_revision: 2 });
});

test("an unchanged legacy stage does not fabricate a historical transition", async () => {
  const doc = Customer.hydrate({
    workspaceId: "w",
    currentFunnelStage: "qualified",
  });
  doc.displayName = "Fixture";
  await hook("pre", "save", "captureCustomerStageTransition").call(doc);
  expect(doc.crm_stage_event).toBeNull();
});

test("query stage capture consumes actor context, fences revisions and rejects a stale writer", async () => {
  const before = {
    _id: "66b8db4b52ca2cbd68b79312",
    workspaceId: "w",
    currentFunnelStage: "qualified",
    crm_stage_revision: 4,
  };
  const read = { select: jest.fn(), lean: jest.fn().mockResolvedValue(before) };
  read.select.mockReturnValue(read);
  const spy = jest.spyOn(Customer, "findOne").mockReturnValue(read as never);
  try {
    const context = {
      actor: { type: "manager" as const, userId: "u" },
      source: "crm_board",
    };
    const query = Customer.updateOne(
      { _id: before._id },
      { $set: { currentFunnelStage: "proposal" } },
      customerStageQueryOptions(context)
    );
    await hook("pre", "updateOne", "captureQueryCustomerStageTransition").call(
      query
    );
    expect(query.getUpdate()).toMatchObject({
      $set: {
        crm_stage_revision: 5,
        crm_stage_event: {
          previousStage: "qualified",
          stage: "proposal",
          actor: context.actor,
        },
      },
    });
    expect(query.getOptions()).not.toHaveProperty("customerStageContext");
    expect(query.getQuery()).toMatchObject({
      $and: [
        { _id: before._id },
        { _id: before._id },
        { crm_stage_revision: 4 },
      ],
    });
    expect(() =>
      hook("post", "updateOne", "rejectLostCustomerStageTransition").call(
        query,
        { matchedCount: 0 }
      )
    ).toThrow("changed concurrently");
  } finally {
    spy.mockRestore();
  }
});
