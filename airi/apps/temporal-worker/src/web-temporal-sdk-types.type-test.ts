// The web app and the OTP starter load @temporalio/client at runtime and type
// it against narrow local surfaces, so that the SDK's declarations (and the
// generated @temporalio/proto namespaces behind them) stay out of the web
// TypeScript program. This program compiles both the SDK and those surfaces,
// so it checks here that the real SDK still satisfies them.
import type {
  Client,
  Connection,
  DayOfWeek,
  Month,
  QueryNotRegisteredError,
  ScheduleSpec,
  WorkflowExecutionAlreadyStartedError,
  WorkflowExecutionStatusName,
  WorkflowNotFoundError,
} from "@temporalio/client";
import type {
  buildWhatsAppOtpDeliveryWorkflowStartOptions,
  OtpTemporalClientSdk,
} from "@icecore/otp-runtime";

import type { TemporalClientSdk } from "@/lib/temporal/sdk";
import type {
  TemporalConnectionOptions,
  TemporalDayOfWeek,
  TemporalMonth,
  TemporalScheduleOptions,
  TemporalScheduleSpec,
  TemporalScheduleUpdateOptions,
  TemporalWebClient,
  TemporalWorkflowExecutionStatusName,
  TemporalWorkflowSignalWithStartOptions,
  TemporalWorkflowStartOptions,
} from "@/lib/temporal/sdk-types";

type Assert<T extends true> = T;
type Extends<Actual, Expected> = [Actual] extends [Expected] ? true : false;
type IsExactly<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected
    ? 1
    : 2
    ? true
    : false;

type SdkWorkflowClient = Client["workflow"];
type SdkScheduleClient = Client["schedule"];
type SdkScheduleHandle = ReturnType<SdkScheduleClient["getHandle"]>;
type SdkWorkflowStartOptions = Parameters<SdkWorkflowClient["start"]>[1];

export type WebTemporalSdkSurfaceChecks = [
  // What the SDK returns provides everything web code reads.
  Assert<Extends<Client, TemporalWebClient>>,
  // What web code and the OTP starter pass in is accepted by the SDK.
  Assert<Extends<TemporalWorkflowStartOptions, SdkWorkflowStartOptions>>,
  Assert<
    Extends<
      TemporalWorkflowSignalWithStartOptions,
      Parameters<SdkWorkflowClient["signalWithStart"]>[1]
    >
  >,
  Assert<
    Extends<
      ReturnType<typeof buildWhatsAppOtpDeliveryWorkflowStartOptions>,
      SdkWorkflowStartOptions
    >
  >,
  Assert<
    Extends<TemporalScheduleOptions, Parameters<SdkScheduleClient["create"]>[0]>
  >,
  Assert<
    Extends<
      TemporalScheduleUpdateOptions,
      ReturnType<Parameters<SdkScheduleHandle["update"]>[0]>
    >
  >,
  Assert<Extends<TemporalScheduleSpec, ScheduleSpec>>,
  // The runtime-loaded module matches the shape ./sdk casts it to.
  Assert<
    Extends<
      TemporalConnectionOptions,
      NonNullable<Parameters<typeof Connection.lazy>[0]>
    >
  >,
  Assert<
    Extends<
      { connection: Connection; namespace: string },
      NonNullable<ConstructorParameters<typeof Client>[0]>
    >
  >,
  Assert<
    Extends<
      { Client: typeof Client; Connection: typeof Connection },
      OtpTemporalClientSdk<Connection>
    >
  >,
  Assert<
    Extends<
      typeof QueryNotRegisteredError,
      TemporalClientSdk["QueryNotRegisteredError"]
    >
  >,
  Assert<
    Extends<
      typeof WorkflowExecutionAlreadyStartedError,
      TemporalClientSdk["WorkflowExecutionAlreadyStartedError"]
    >
  >,
  Assert<
    Extends<
      typeof WorkflowNotFoundError,
      TemporalClientSdk["WorkflowNotFoundError"]
    >
  >,
  // Names web code compares against are exactly the SDK's.
  Assert<IsExactly<TemporalDayOfWeek, DayOfWeek>>,
  Assert<IsExactly<TemporalMonth, Month>>,
  Assert<
    IsExactly<TemporalWorkflowExecutionStatusName, WorkflowExecutionStatusName>
  >,
];
