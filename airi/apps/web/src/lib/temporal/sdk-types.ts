/**
 * The part of the @temporalio/client API that web code uses.
 *
 * ./sdk loads the SDK at runtime with createRequire. The SDK's declarations
 * import @temporalio/common and the generated @temporalio/proto namespaces
 * (8.7 MB), which would otherwise be parsed and bound by every TypeScript
 * program that compiles web code, so web modules type against this surface.
 * apps/temporal-worker/src/web-temporal-sdk-types.type-test.ts compiles it
 * against the real SDK. Keep this file types-only and free of "server-only":
 * campaign-schedule-config.ts is also bundled into client components.
 */

export type TemporalWorkflowExecutionStatusName =
  | "UNSPECIFIED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "CONTINUED_AS_NEW"
  | "TIMED_OUT"
  | "PAUSED"
  | "UNKNOWN";

export type TemporalWorkflowIdReusePolicy =
  | "ALLOW_DUPLICATE"
  | "ALLOW_DUPLICATE_FAILED_ONLY"
  | "REJECT_DUPLICATE"
  | "TERMINATE_IF_RUNNING";

export type TemporalWorkflowIdConflictPolicy =
  | "FAIL"
  | "USE_EXISTING"
  | "TERMINATE_EXISTING";

export type TemporalWorkflowStartOptions = {
  workflowId: string;
  taskQueue: string;
  args: unknown[];
  workflowIdReusePolicy?: TemporalWorkflowIdReusePolicy;
  workflowIdConflictPolicy?: TemporalWorkflowIdConflictPolicy;
};

export type TemporalWorkflowSignalWithStartOptions =
  TemporalWorkflowStartOptions & {
    signal: string;
    signalArgs: unknown[];
  };

export interface TemporalWorkflowHandle {
  readonly workflowId: string;
  signal(signalName: string, ...args: unknown[]): Promise<void>;
  query<Result>(queryName: string, ...args: unknown[]): Promise<Result>;
  cancel(): Promise<unknown>;
  describe(): Promise<{
    status: { name: TemporalWorkflowExecutionStatusName };
  }>;
}

export interface TemporalWorkflowHandleWithSignaledRunId
  extends TemporalWorkflowHandle {
  readonly signaledRunId: string;
}

export interface TemporalWorkflowClient {
  start(
    workflowType: string,
    options: TemporalWorkflowStartOptions
  ): Promise<TemporalWorkflowHandle>;
  signalWithStart(
    workflowType: string,
    options: TemporalWorkflowSignalWithStartOptions
  ): Promise<TemporalWorkflowHandleWithSignaledRunId>;
  getHandle(workflowId: string): TemporalWorkflowHandle;
}

export type TemporalDayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type TemporalMonth =
  | "JANUARY"
  | "FEBRUARY"
  | "MARCH"
  | "APRIL"
  | "MAY"
  | "JUNE"
  | "JULY"
  | "AUGUST"
  | "SEPTEMBER"
  | "OCTOBER"
  | "NOVEMBER"
  | "DECEMBER";

type TemporalCalendarRange<Unit> = Unit | { start: Unit; end?: Unit };

type TemporalCalendarField<Unit> =
  | TemporalCalendarRange<Unit>
  | TemporalCalendarRange<Unit>[];

export type TemporalCalendarSpec = {
  second?: TemporalCalendarField<number>;
  minute?: TemporalCalendarField<number>;
  hour?: TemporalCalendarField<number>;
  dayOfMonth?: TemporalCalendarField<number>;
  month?: TemporalCalendarField<TemporalMonth>;
  year?: TemporalCalendarField<number>;
  dayOfWeek?: TemporalCalendarField<TemporalDayOfWeek>;
};

/** Durations are milliseconds. */
export type TemporalScheduleSpec = {
  calendars?: TemporalCalendarSpec[];
  intervals?: { every: number }[];
  timezone?: string;
  startAt?: Date;
  endAt?: Date;
};

export type TemporalScheduleStartWorkflowAction = {
  type: "startWorkflow";
  workflowType: string;
  workflowId: string;
  taskQueue: string;
  args: unknown[];
  workflowRunTimeout?: number;
  workflowExecutionTimeout?: number;
};

export type TemporalScheduleOverlapPolicy =
  | "SKIP"
  | "BUFFER_ONE"
  | "BUFFER_ALL"
  | "CANCEL_OTHER"
  | "TERMINATE_OTHER"
  | "ALLOW_ALL";

export type TemporalScheduleUpdateOptions = {
  spec: TemporalScheduleSpec;
  action: TemporalScheduleStartWorkflowAction;
  policies?: {
    overlap?: TemporalScheduleOverlapPolicy;
    catchupWindow?: number;
    pauseOnFailure?: boolean;
  };
  state: { paused?: boolean; note?: string };
};

export type TemporalScheduleOptions = TemporalScheduleUpdateOptions & {
  scheduleId: string;
};

export type TemporalScheduleDescription = {
  state: { paused: boolean };
  info: {
    recentActions: {
      scheduledAt: Date;
      takenAt: Date;
      action: {
        type: "startWorkflow";
        workflow: { workflowId: string; firstExecutionRunId: string };
      };
    }[];
  };
};

export interface TemporalScheduleHandle {
  describe(): Promise<TemporalScheduleDescription>;
  update(
    updateFn: (
      previous: TemporalScheduleDescription
    ) => TemporalScheduleUpdateOptions
  ): Promise<void>;
  delete(): Promise<void>;
}

export interface TemporalScheduleClient {
  create(options: TemporalScheduleOptions): Promise<unknown>;
  getHandle(scheduleId: string): TemporalScheduleHandle;
}

export interface TemporalConnection {
  withDeadline<Result>(
    deadline: number | Date,
    fn: () => Promise<Result>
  ): Promise<Result>;
}

export interface TemporalWebClient {
  readonly connection: TemporalConnection;
  readonly workflow: TemporalWorkflowClient;
  readonly schedule: TemporalScheduleClient;
}

export type TemporalConnectionOptions = {
  address: string;
  apiKey?: string;
  tls?: Record<string, never>;
};
