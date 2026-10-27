import {
  buildServiceLifecycleTransition,
  type ServiceLifecycleSnapshot,
} from "./service-lifecycle";
const started = new Date("2026-10-01T10:00:00Z"),
  now = new Date("2026-10-01T10:10:00Z");
const base: ServiceLifecycleSnapshot = {
  _id: "chat",
  workspaceId: "w",
  status: "open",
  first_inbound_at: started,
  service_lifecycle_revision: 0,
  airi_handoff_active: false,
};
test("records manager resolution with a stable episode and one atomic envelope", () => {
  const result = buildServiceLifecycleTransition({
    before: base,
    after: { ...base, status: "closed" },
    now,
    eventId: "event-1",
    resolutionKind: "manager",
  });
  expect(result?.service_resolved_at).toEqual(now);
  expect(result?.service_episode_started_at).toEqual(started);
  expect(result?.service_lifecycle_event).toMatchObject({
    eventId: "event-1",
    revision: 1,
    kinds: ["resolved"],
    previousStatus: "open",
    status: "closed",
    resolutionKind: "manager",
  });
});
test("timeout closes remain closure evidence without measured resolution", () => {
  const result = buildServiceLifecycleTransition({
    before: base,
    after: { ...base, status: "closed", csat_timeout_closed: true },
    now,
    eventId: "timeout",
  });
  expect(result?.service_closed_at).toEqual(now);
  expect(result?.service_resolved_at).toBeNull();
  expect(result?.service_lifecycle_event.kinds).toEqual(["timeout_closed"]);
});
test("reopening starts a new episode and cannot inherit an old timeout or resolution", () => {
  const before = {
    ...base,
    status: "closed",
    service_resolved_at: started,
    service_resolution_kind: "manager",
    csat_timeout_closed: true,
    service_lifecycle_revision: 4,
  };
  const result = buildServiceLifecycleTransition({
    before,
    after: { ...before, status: "open" },
    now,
    eventId: "reopen",
  });
  expect(result).toMatchObject({
    service_episode_started_at: now,
    service_resolved_at: null,
    service_closed_at: null,
    service_resolution_kind: null,
    csat_timeout_closed: false,
    service_lifecycle_revision: 5,
  });
  expect(result?.service_lifecycle_event.kinds).toEqual(["reopened"]);
});
test("unrelated legacy closed edits cannot invent resolution or rewrite lifecycle", () => {
  const before = { ...base, status: "closed" };
  expect(
    buildServiceLifecycleTransition({
      before,
      after: { ...before, updatedAt: now },
      now,
      eventId: "ignored",
    })
  ).toBeNull();
});
test("handoff and close in the same write retain both transitions", () => {
  const result = buildServiceLifecycleTransition({
    before: base,
    after: { ...base, status: "closed", airi_handoff_active: true },
    now,
    eventId: "combined",
  });
  expect(result?.service_lifecycle_event.kinds).toEqual([
    "closed_unknown",
    "handoff_started",
  ]);
  expect(result?.service_resolved_at).toBeNull();
});
test("new chats record opened evidence without inventing an inbound time", () => {
  const result = buildServiceLifecycleTransition({
    before: null,
    after: { _id: "chat", workspaceId: "w", status: "open" },
    now,
    eventId: "open",
  });
  expect(result?.service_episode_started_at).toBeNull();
  expect(result?.service_lifecycle_event.kinds).toEqual(["opened"]);
});
