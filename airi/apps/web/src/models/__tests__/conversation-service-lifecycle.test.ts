import { Conversation } from "../conversation";

type Hook = { fn: (...args: unknown[]) => unknown };
const hooks = (
  Conversation.schema as unknown as {
    s: { hooks: { _pres: Map<string, Hook[]>; _posts: Map<string, Hook[]> } };
  }
).s.hooks;
function hook(phase: "pre" | "post", method: string, name: string) {
  return (phase === "pre" ? hooks._pres : hooks._posts)
    .get(method)!
    .find(entry => entry.fn.name === name)!.fn;
}
const started = new Date("2026-10-01T10:00:00Z");
test("a manager save atomically prepares stable fields and fences the source revision", async () => {
  const doc = Conversation.hydrate({
    _id: "66b8db4b52ca2cbd68b79311",
    workspaceId: "w",
    status: "open",
    first_inbound_at: started,
    service_lifecycle_revision: 3,
  });
  doc.status = "closed";
  doc.$locals.serviceResolutionKind = "manager";
  await hook("pre", "save", "captureServiceLifecycleTransition").call(doc);
  expect(doc.service_lifecycle_event).toMatchObject({
    revision: 4,
    kinds: ["resolved"],
    workspaceId: "w",
    previousStatus: "open",
    status: "closed",
  });
  expect(doc.service_resolved_at).toBeInstanceOf(Date);
  expect(typeof doc.toObject({ getters: false }).service_lifecycle_event).toBe(
    "string"
  );
  expect(doc.service_lifecycle_event_key).toContain("w:");
  expect(doc.$where).toEqual({ service_lifecycle_revision: 3 });
});
test("an unrelated hydrated legacy closure cannot acquire fabricated history", async () => {
  const doc = Conversation.hydrate({ workspaceId: "w", status: "closed" });
  doc.subject = "changed";
  await hook("pre", "save", "captureServiceLifecycleTransition").call(doc);
  expect(doc.service_resolved_at).toBeNull();
  expect(doc.service_lifecycle_event).toBeNull();
});

test("a late CSAT score preserves the original closure kind and timeout evidence", async () => {
  const before = {
    _id: "66b8db4b52ca2cbd68b79311",
    workspaceId: "w",
    status: "closed",
    service_resolution_kind: "manager",
    service_lifecycle_revision: 4,
  };
  const read = { select: jest.fn(), lean: jest.fn().mockResolvedValue(before) };
  read.select.mockReturnValue(read);
  const spy = jest
    .spyOn(Conversation, "findOne")
    .mockReturnValue(read as never);
  try {
    const query = Conversation.updateOne(
      { _id: before._id },
      {
        $set: {
          status: "closed",
          service_resolution_kind: "customer_csat",
          csat_timeout_closed: false,
          csat_score: 5,
        },
      }
    );
    await hook(
      "pre",
      "updateOne",
      "captureQueryServiceLifecycleTransition"
    ).call(query);
    expect(query.getUpdate()).toEqual({
      $set: { status: "closed", csat_score: 5 },
    });
  } finally {
    spy.mockRestore();
  }
});
test("manual handoff query writes one envelope in its existing source update", async () => {
  const before = {
    _id: "66b8db4b52ca2cbd68b79311",
    workspaceId: "w",
    status: "open",
    service_lifecycle_revision: 2,
    airi_handoff_active: false,
  };
  const read = { select: jest.fn(), lean: jest.fn().mockResolvedValue(before) };
  read.select.mockReturnValue(read);
  const spy = jest
    .spyOn(Conversation, "findOne")
    .mockReturnValue(read as never);
  try {
    const query = Conversation.updateOne(
      { _id: before._id },
      { $set: { status: "in_progress", airi_handoff_active: true } }
    );
    await hook(
      "pre",
      "updateOne",
      "captureQueryServiceLifecycleTransition"
    ).call(query);
    expect(query.getUpdate()).toMatchObject({
      $set: {
        service_lifecycle_revision: 3,
        service_lifecycle_event: {
          kinds: ["status_changed", "handoff_started"],
          workspaceId: "w",
        },
      },
    });
    expect(query.getQuery()).toEqual({
      $and: [
        { _id: before._id },
        { _id: before._id },
        { service_lifecycle_revision: 2 },
      ],
    });
    expect(() =>
      hook("post", "updateOne", "rejectLostServiceLifecycleTransition").call(
        query,
        { matchedCount: 0 }
      )
    ).toThrow("changed concurrently");
  } finally {
    spy.mockRestore();
  }
});
