import { writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";

const MODES = [
  "activate",
  "provision",
  "migrate-watermarks",
  "verify",
  "transition-sequence",
] as const;
const VERIFICATION_PROFILES = [
  "readiness-v1",
  "transition-prerequisites-v1",
  "handoff-export-v1",
] as const;
const UUID_PATTERN = /^[0-9a-f]{32}$/;
const APPROVED_CARDINALITY_CAP = 10_000_000 as const;

type OperatorMode = (typeof MODES)[number] | "finalize-handoff";
type WritableOutput = { write(value: string): unknown };
type ProvisioningOperatorApi = Pick<
  typeof import("@/lib/requests-projection/provisioning"),
  | "provisionRequestsProjectionInfrastructure"
  | "migrateRequestsProjectionWatermarks"
  | "verifyRequestsProjectionForOperator"
  | "requireRequestsProjectionCollectionUuid"
  | "transitionRequestsProjectionSequence"
>;
type RequestListProjectionOperatorDependencies = {
  loadProvisioning?: () => Promise<ProvisioningOperatorApi>;
  loadActivation?: () => Promise<
    Pick<
      typeof import("@/lib/requests-projection/activation"),
      "runProductionRequestsProjectionActivation"
    >
  >;
  writeReceipt?: (
    filePath: string,
    contents: string,
    options: { encoding: "utf8"; flag: "wx" }
  ) => Promise<unknown>;
  stdout?: WritableOutput;
  stderr?: WritableOutput;
  transitionSequence?: (
    input: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  finalizeHandoff?: (
    input: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};
type ParsedOperatorArgs =
  | { mode: "help" }
  | { mode: "transition-sequence" }
  | {
      mode: "transition-sequence";
      apply: true;
      expectedCollectionUuid: string;
      receiptOutput: string;
      verificationReceipt: string;
      deploymentReceipt: string;
      quiesceReceipt: string;
    }
  | {
      mode: "finalize-handoff";
      apply: true;
      expectedCollectionUuid: string;
      receiptOutput: string;
      transitionReceipt: string;
      handoffReceipt: string;
    }
  | {
      mode: "provision";
      apply: true;
      expectedCollectionUuid: string | "absent";
      approvedCardinalityCap: typeof APPROVED_CARDINALITY_CAP;
    }
  | {
      mode: "migrate-watermarks";
      apply: true;
      expectedCollectionUuid: string;
      approvedCardinalityCap: typeof APPROVED_CARDINALITY_CAP;
    }
  | {
      mode: "verify";
      expectedCollectionUuid: string;
      receiptOutput?: string;
      verificationProfile?: (typeof VERIFICATION_PROFILES)[number];
      requireGenerationMode?: string;
      requireAHandoff?: true;
    }
  | {
      mode: "activate";
      apply: true;
      expectedCollectionUuid: string;
    };

function write(stream: WritableOutput, value: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function invalidArguments(): never {
  throw new Error("invalid request-list-projection operator arguments");
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--") || flags.has(flag)) invalidArguments();
    if (flag === "--apply" || flag === "--require-a-handoff") {
      flags.set(flag, true);
      continue;
    }
    if (
      flag !== "--expected-collection-uuid" &&
      flag !== "--approved-cardinality-cap" &&
      flag !== "--receipt-output" &&
      flag !== "--verification-profile" &&
      flag !== "--require-generation-mode" &&
      flag !== "--require-a-handoff"
    ) {
      invalidArguments();
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) invalidArguments();
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function requireOnlyFlags(
  flags: Map<string, string | true>,
  allowed: readonly string[]
): void {
  for (const flag of flags.keys()) {
    if (!allowed.includes(flag)) invalidArguments();
  }
}

function requireUuid(value: string | true | undefined): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return invalidArguments();
  }
  return value;
}

function requireCap(
  value: string | true | undefined
): typeof APPROVED_CARDINALITY_CAP {
  if (value !== String(APPROVED_CARDINALITY_CAP)) invalidArguments();
  return APPROVED_CARDINALITY_CAP;
}

export function parseRequestListProjectionOperatorArgs(
  args: string[]
): ParsedOperatorArgs {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  const mode = args[0] as OperatorMode | undefined;
  if (
    !mode ||
    (!(MODES as readonly string[]).includes(mode) &&
      mode !== "finalize-handoff")
  )
    invalidArguments();
  if (mode === "transition-sequence" && args.length === 1) return { mode };
  if (mode === "transition-sequence" || mode === "finalize-handoff") {
    const flags = parseFlags(args.slice(1));
    const allowed =
      mode === "transition-sequence"
        ? [
            "--apply",
            "--expected-collection-uuid",
            "--receipt-output",
            "--verification-receipt",
            "--deployment-receipt",
            "--quiesce-receipt",
          ]
        : [
            "--apply",
            "--expected-collection-uuid",
            "--receipt-output",
            "--transition-receipt",
            "--handoff-receipt",
          ];
    requireOnlyFlags(flags, allowed);
    if (flags.get("--apply") !== true) invalidArguments();
    const expectedCollectionUuid = requireUuid(
      flags.get("--expected-collection-uuid")
    );
    const output = flags.get("--receipt-output");
    if (typeof output !== "string" || !path.isAbsolute(output))
      invalidArguments();
    const names =
      mode === "transition-sequence"
        ? [
            "--verification-receipt",
            "--deployment-receipt",
            "--quiesce-receipt",
          ]
        : ["--transition-receipt", "--handoff-receipt"];
    const values = names.map(name => flags.get(name));
    if (
      values.some(value => typeof value !== "string" || !path.isAbsolute(value))
    )
      invalidArguments();
    return mode === "transition-sequence"
      ? {
          mode,
          apply: true,
          expectedCollectionUuid,
          receiptOutput: output,
          verificationReceipt: values[0] as string,
          deploymentReceipt: values[1] as string,
          quiesceReceipt: values[2] as string,
        }
      : {
          mode,
          apply: true,
          expectedCollectionUuid,
          receiptOutput: output,
          transitionReceipt: values[0] as string,
          handoffReceipt: values[1] as string,
        };
  }
  const flags = parseFlags(args.slice(1));
  if (mode === "verify") {
    requireOnlyFlags(flags, [
      "--expected-collection-uuid",
      "--receipt-output",
      "--verification-profile",
      "--require-generation-mode",
      "--require-a-handoff",
    ]);
    const receiptOutput = flags.get("--receipt-output");
    if (
      receiptOutput !== undefined &&
      (typeof receiptOutput !== "string" || !path.isAbsolute(receiptOutput))
    ) {
      invalidArguments();
    }
    return {
      mode,
      expectedCollectionUuid: requireUuid(
        flags.get("--expected-collection-uuid")
      ),
      ...(typeof receiptOutput === "string" ? { receiptOutput } : {}),
      ...(typeof flags.get("--verification-profile") === "string"
        ? {
            verificationProfile:
              typeof flags.get("--verification-profile") === "string" &&
              VERIFICATION_PROFILES.includes(
                flags.get(
                  "--verification-profile"
                ) as (typeof VERIFICATION_PROFILES)[number]
              )
                ? (flags.get(
                    "--verification-profile"
                  ) as (typeof VERIFICATION_PROFILES)[number])
                : "readiness-v1",
          }
        : {}),
      ...(typeof flags.get("--require-generation-mode") === "string"
        ? {
            requireGenerationMode: flags.get(
              "--require-generation-mode"
            ) as string,
          }
        : {}),
      ...(flags.get("--require-a-handoff") === true
        ? { requireAHandoff: true as const }
        : {}),
    };
  }
  if (mode === "activate") {
    requireOnlyFlags(flags, ["--apply", "--expected-collection-uuid"]);
    if (flags.get("--apply") !== true) invalidArguments();
    return {
      mode,
      apply: true,
      expectedCollectionUuid: requireUuid(
        flags.get("--expected-collection-uuid")
      ),
    };
  }
  requireOnlyFlags(flags, [
    "--apply",
    "--expected-collection-uuid",
    "--approved-cardinality-cap",
  ]);
  if (flags.get("--apply") !== true) invalidArguments();
  const approvedCardinalityCap = requireCap(
    flags.get("--approved-cardinality-cap")
  );
  const expected = flags.get("--expected-collection-uuid");
  if (mode === "provision") {
    if (expected !== "absent" && !UUID_PATTERN.test(String(expected || ""))) {
      invalidArguments();
    }
    return {
      mode,
      apply: true,
      expectedCollectionUuid: expected as string | "absent",
      approvedCardinalityCap,
    };
  }
  return {
    mode,
    apply: true,
    expectedCollectionUuid: requireUuid(expected),
    approvedCardinalityCap,
  };
}

function closedReasonCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "reasonCode" in error &&
    typeof error.reasonCode === "string" &&
    /^[a-z0-9_]{1,96}$/.test(error.reasonCode)
  ) {
    return error.reasonCode;
  }
  return "requests_projection_operator_failed";
}

export async function runRequestListProjectionOperator(
  args: string[],
  dependencies: RequestListProjectionOperatorDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  let parsed: ParsedOperatorArgs;
  try {
    parsed = parseRequestListProjectionOperatorArgs(args);
  } catch {
    write(stderr, {
      contractVersion: 3,
      status: "error",
      reasonCode: "invalid_arguments",
    });
    return 1;
  }

  if (parsed.mode === "help") {
    write(stdout, {
      contractVersion: 3,
      mode: "help",
      status: "help",
      modes: MODES,
    });
    return 0;
  }
  if (
    parsed.mode === "transition-sequence" ||
    parsed.mode === "finalize-handoff"
  ) {
    if (parsed.mode === "transition-sequence" && !("apply" in parsed)) {
      write(stderr, {
        contractVersion: 3,
        mode: parsed.mode,
        status: "not_available",
        reasonCode: "not_available_until_task_18",
      });
      return 2;
    }
    const callback =
      parsed.mode === "transition-sequence"
        ? dependencies.transitionSequence ||
          (async value =>
            (
              await import("@/lib/requests-projection/provisioning")
            ).transitionRequestsProjectionSequence(value as never))
        : dependencies.finalizeHandoff ||
          (async value =>
            (
              await import("@/lib/requests-projection/provisioning")
            ).finalizeRequestsProjectionAHandoff(value as never));
    if (!callback) {
      write(stderr, {
        contractVersion: 3,
        mode: parsed.mode,
        status: "error",
        reasonCode: "requests_projection_transition_dependency_missing",
      });
      return 1;
    }
    try {
      const result = await callback(parsed);
      write(stdout, { ...result, contractVersion: 3, mode: parsed.mode });
      return result.status === "ready" || result.status === "committed" ? 0 : 2;
    } catch (error) {
      write(stderr, {
        contractVersion: 3,
        mode: parsed.mode,
        status: "error",
        reasonCode: closedReasonCode(error),
      });
      return 1;
    }
  }

  try {
    const provisioning = await (dependencies.loadProvisioning
      ? dependencies.loadProvisioning()
      : import("@/lib/requests-projection/provisioning"));
    let result: Record<string, unknown>;
    if (parsed.mode === "provision") {
      result = await provisioning.provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: parsed.expectedCollectionUuid,
        approvedCardinalityCap: parsed.approvedCardinalityCap,
      });
    } else if (parsed.mode === "migrate-watermarks") {
      result = await provisioning.migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: parsed.expectedCollectionUuid,
        approvedCardinalityCap: parsed.approvedCardinalityCap,
      });
    } else if (parsed.mode === "verify") {
      result = await provisioning.verifyRequestsProjectionForOperator({
        expectedCollectionUuid: parsed.expectedCollectionUuid,
      });
      if (parsed.receiptOutput) {
        await (dependencies.writeReceipt || writeFile)(
          parsed.receiptOutput,
          `${serializeCanonicalJson(result)}\n`,
          { encoding: "utf8", flag: "wx" }
        );
      }
    } else {
      await provisioning.requireRequestsProjectionCollectionUuid(
        parsed.expectedCollectionUuid
      );
      const { runProductionRequestsProjectionActivation } =
        await (dependencies.loadActivation
          ? dependencies.loadActivation()
          : import("@/lib/requests-projection/activation"));
      result = await runProductionRequestsProjectionActivation({
        ownerToken: `operator:${process.pid}`,
      });
    }
    write(stdout, {
      ...result,
      contractVersion: 3,
      mode: parsed.mode,
    });
    return result.status === "ready" ? 0 : 2;
  } catch (error) {
    write(stderr, {
      contractVersion: 3,
      mode: parsed.mode,
      status: "error",
      reasonCode: closedReasonCode(error),
    });
    return 1;
  }
}

if ((process.argv[1] || "").includes("request-list-projection-operator")) {
  void runRequestListProjectionOperator(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
