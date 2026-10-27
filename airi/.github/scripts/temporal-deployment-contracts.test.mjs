import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

test("worker image caches dependencies before copying runtime source", async () => {
  const dockerfile = await readRepoFile("apps/temporal-worker/Dockerfile");
  const sourceCopy = dockerfile.indexOf("COPY . .");
  assert.ok(sourceCopy >= 0, "the worker must retain its web runtime imports");
  const dependencyLayers = dockerfile.slice(0, sourceCopy);
  assert.match(
    dependencyLayers,
    /COPY apps\/temporal-worker\/media-runners\/requirements\.txt apps\/temporal-worker\/media-runners\/requirements\.txt/,
  );
  assert.match(dependencyLayers, /pip install --no-cache-dir -r/);
  assert.match(
    dependencyLayers,
    /COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.npmrc \.\//,
  );
  assert.match(dependencyLayers, /RUN pnpm fetch\s*\n/);
  assert.match(
    dockerfile.slice(sourceCopy),
    /RUN pnpm install --offline --frozen-lockfile/,
  );
  assert.match(
    dockerfile.slice(sourceCopy),
    /RUN pnpm --filter @icecore\/temporal-worker build:workflow-bundle/,
  );
  assert.doesNotMatch(
    dependencyLayers,
    /COPY (?:apps|packages)\/[^\s]+\/package\.json/,
    "workspace membership must remain owned by the workspace and lockfile",
  );
});

for (const scenario of [
  { name: "warm cache", pull: 0, build: 0, releasePush: 0, cachePush: 0 },
  { name: "cold cache", pull: 1, build: 0, releasePush: 0, cachePush: 0 },
  { name: "failed build", pull: 0, build: 1, releasePush: 0, cachePush: 0 },
  {
    name: "failed release push",
    pull: 0,
    build: 0,
    releasePush: 1,
    cachePush: 0,
  },
  {
    name: "failed cache push",
    pull: 0,
    build: 0,
    releasePush: 0,
    cachePush: 1,
  },
]) {
  test(`worker registry cache preserves release behavior with ${scenario.name}`, async () => {
    const config = await readRepoFile("cloudbuild.temporal-worker.yaml");
    assert.match(config, /entrypoint: bash/);
    assert.match(config, /- DOCKER_BUILDKIT=1/);
    assert.match(config, /args:\s*\n      - -c\s*\n      - \|/);
    const lines = config.split("\n");
    const scriptStart = lines.findIndex((line) => /^      - \|\s*$/.test(line));
    assert.ok(
      scriptStart >= 0,
      "Cloud Build must expose its Docker shell commands",
    );
    const scriptLines = [];
    for (const line of lines.slice(scriptStart + 1)) {
      if (line && !line.startsWith("        ")) break;
      scriptLines.push(line.replace(/^ {8}/, ""));
    }
    const releaseImage =
      "region-docker.pkg.dev/project/runtime/worker:immutable-sha";
    const cacheImage =
      "region-docker.pkg.dev/project/runtime/worker:build-cache";
    const substitutions = {
      _IMAGE_URI: releaseImage,
      _IMAGE_SOURCE_COMMIT: "source-sha",
      _BUILD_CONTEXT_SHA256: "context-sha",
      _REQUESTS_WRITER_PROTOCOL: "sequence_v2",
      _MINIMUM_COMPATIBLE_BUILD: "requests-sequence-v2-a",
    };
    const executable = scriptLines
      .join("\n")
      .replace(
        /\$\$|\$\{(_[A-Z0-9_]+)\}|\$(_[A-Z0-9_]+)/g,
        (match, bracedKey, key) => {
          if (match === "$$") return "$";
          const name = bracedKey || key;
          assert.ok(
            Object.hasOwn(substitutions, name),
            `unexpected substitution: ${name}`,
          );
          return substitutions[name];
        },
      );
    const bashExecutable =
      process.platform === "win32"
        ? join(
            process.env.ProgramFiles || "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          )
        : "bash";
    const result = spawnSync(
      bashExecutable,
      [
        "-c",
        `docker() {
          printf 'DOCKER_CALL\\0'; printf '%s\\0' "$@"; printf '\\n'
          case "$1" in
            pull) return "$TEST_PULL_STATUS" ;;
            build) return "$TEST_BUILD_STATUS" ;;
            push)
              if [[ "$2" == "$TEST_RELEASE_IMAGE" ]]; then
                return "$TEST_RELEASE_PUSH_STATUS"
              fi
              return "$TEST_CACHE_PUSH_STATUS"
              ;;
            *) return 99 ;;
          esac
        }
        ${executable}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_PULL_STATUS: String(scenario.pull),
          TEST_BUILD_STATUS: String(scenario.build),
          TEST_RELEASE_PUSH_STATUS: String(scenario.releasePush),
          TEST_CACHE_PUSH_STATUS: String(scenario.cachePush),
          TEST_RELEASE_IMAGE: releaseImage,
        },
      },
    );
    const expectedStatus = scenario.build || scenario.releasePush;
    assert.equal(
      result.status,
      expectedStatus,
      result.error?.message || result.stderr,
    );
    if (scenario.pull)
      assert.match(result.stdout, /continuing with a cold build/);
    if (scenario.cachePush && !expectedStatus) {
      assert.match(result.stdout, /release image remains available/);
    }
    const calls = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("DOCKER_CALL\0"))
      .map((line) => line.split("\0").slice(1).filter(Boolean));
    assert.deepEqual(calls[0], ["pull", cacheImage]);
    const build = calls[1];
    assert.equal(build[0], "build");
    const flagValue = (flag) => build[build.indexOf(flag) + 1];
    assert.equal(flagValue("--cache-from"), cacheImage);
    assert.equal(flagValue("--build-arg"), "BUILDKIT_INLINE_CACHE=1");
    assert.equal(flagValue("-f"), "apps/temporal-worker/Dockerfile");
    assert.deepEqual(
      build.flatMap((arg, i) => (arg === "-t" ? [build[i + 1]] : [])),
      [releaseImage, cacheImage],
    );
    assert.ok(build.includes("org.opencontainers.image.revision=source-sha"));
    assert.ok(build.includes("airi.requests.writer-protocol=sequence_v2"));
    assert.ok(build.includes("airi.build-context.sha256=context-sha"));
    assert.ok(
      build.includes("airi.minimum-compatible-build=requests-sequence-v2-a"),
    );
    assert.equal(build.at(-1), ".");
    const pushes = calls.filter(([command]) => command === "push");
    assert.deepEqual(
      pushes,
      scenario.build
        ? []
        : scenario.releasePush
          ? [["push", releaseImage]]
          : [
              ["push", releaseImage],
              ["push", cacheImage],
            ],
    );
    assert.match(config, /images:\s*\n  - \$_IMAGE_URI/);
    assert.doesNotMatch(
      config.slice(config.indexOf("images:")),
      /- \$_CACHE_IMAGE_URI/,
    );
  });
}

test("main worker deployment clears a prior manual revision suffix", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Deploy Cloud Run worker pool",
  );
  const expressions = {
    "steps.deploy-meta.outputs.worker_pool_name": "main-worker",
    "steps.deploy-meta.outputs.project_id": "project",
    "steps.deploy-meta.outputs.region": "region",
    "steps.deploy-meta.outputs.image_uri": "example/image:build",
    "steps.valkey.outputs.network": "network",
    "steps.runtime-config.outputs.worker_env_file": "worker.env",
    "steps.runtime-config.outputs.worker_secrets_arg": "",
  };
  const executable = runBlock.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(expressions, key), `unexpected expression: ${key}`);
    return expressions[key];
  });
  const bashExecutable =
    process.platform === "win32"
      ? join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        )
      : "bash";
  const result = spawnSync(
    bashExecutable,
    ["-c", `gcloud() { printf '%s\\0' "$@"; printf '\\n'; }\n${executable}`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GCP_WORKER_INSTANCES: "2",
        GCP_WORKER_CPU: "1",
        GCP_WORKER_MEMORY: "2Gi",
        GCP_WORKER_VPC_NETWORK: "network",
        GCP_WORKER_VPC_SUBNET: "",
        GCP_REALTIME_VPC_SUBNET: "",
        GCP_WORKER_SERVICE_ACCOUNT: "",
      },
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const calls = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\0").filter(Boolean));
  assert.deepEqual(calls[0].slice(0, 5), [
    "beta",
    "run",
    "worker-pools",
    "deploy",
    "main-worker",
  ]);
  assert.deepEqual(
    calls[0].filter((arg) => arg.startsWith("--revision-suffix")),
    ["--revision-suffix="],
    "gcloud must receive an explicitly empty suffix to clear an inherited revision name",
  );
  assert.ok(calls[0].includes("--image=example/image:build"));
  assert.ok(calls[0].includes("--instances=2"));
  assert.ok(calls[0].includes("--cpu=1"));
  assert.ok(calls[0].includes("--memory=2Gi"));
  assert.deepEqual(calls[1].slice(0, 5), [
    "beta",
    "run",
    "worker-pools",
    "update-instance-split",
    "main-worker",
  ]);
  assert.ok(calls[1].includes("--to-latest"));
});

test("OTP delivery is consolidated before its standalone pool is retired", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );
  const workerVars = manifest.worker.vars.map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  );
  for (const name of [
    "WHATSAPP_OTP_PUBSUB_ENABLED",
    "WHATSAPP_OTP_PUBSUB_PROJECT_ID",
    "WHATSAPP_OTP_PUBSUB_TOPIC",
    "WHATSAPP_OTP_PUBSUB_SUBSCRIPTION",
    "WHATSAPP_OTP_PUBSUB_MAX_MESSAGES",
  ]) {
    assert.ok(workerVars.includes(name), `main worker must receive ${name}`);
  }
  assert.ok(
    manifest.worker.secrets.some(
      (entry) =>
        (typeof entry === "string" ? entry : entry.name) === "OTP_HASH_SECRET",
    ),
  );
  assert.doesNotMatch(workflow, /- name: Deploy Cloud Run OTP worker pool/);
  const retirement = getWorkflowStepShellBlock(
    workflow,
    "Retire standalone OTP worker pool",
  );
  assert.ok(
    workflow.indexOf(retirement.stepBlock) >
      workflow.indexOf(
        "- name: Verify live Temporal history health after rollout",
      ),
    "standalone consumer must survive exact-build startup and live history verification",
  );
  assert.match(
    workflow,
    /OTP_WORKER_SUBSCRIBER_SERVICE_ACCOUNT="\$\{GCP_WORKER_SERVICE_ACCOUNT:-\}"/,
  );
  assert.match(retirement.runBlock, /--instances=0/);
  assert.match(
    retirement.runBlock,
    /OTP_WORKER_POOL_NAME.*==.*WORKER_POOL_NAME/,
  );
});

test("OTP retirement stops only the separate pool after consumer enablement", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Retire standalone OTP worker pool",
  );
  const bashExecutable =
    process.platform === "win32"
      ? join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        )
      : "bash";
  function run({
    enabled = "true",
    otpPool = "otp-worker",
    exists = "true",
    listFails = "false",
    bindingMatches = "true",
  } = {}) {
    const values = {
      project_id: "project",
      region: "region",
      worker_pool_name: "main-worker",
      otp_worker_pool_name: otpPool,
    };
    const executable = runBlock.replace(
      /\$\{\{ steps\.deploy-meta\.outputs\.(\w+) \}\}/g,
      (_, key) => values[key],
    );
    const mocks = `
      gcloud() {
        case "$*" in
          *"describe main-worker"*) printf 'main';;
          *"describe otp-worker"*) printf 'legacy';;
          *"worker-pools list"*)
            if [[ "$MOCK_LIST_FAILS" == true ]]; then return 9; fi
            if [[ "$MOCK_EXISTS" == true ]]; then printf '%s' "$MOCK_OTP_POOL"; fi;;
          *"worker-pools update"*) printf 'UPDATED:%s\\n' "$*";;
          *) echo 'Unexpected gcloud call' >&2; return 17;;
        esac
      }
      jq() {
        local input; input="$(cat)"
        if [[ "$*" == *"-c"* ]]; then
          if [[ "$input" == legacy && "$MOCK_BINDING_MATCHES" != true ]]; then printf 'other'; else printf 'binding'; fi
        else printf '%s' "$MOCK_ENABLED"; fi
      }
    `;
    return spawnSync(bashExecutable, ["-c", mocks + executable], {
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_ENABLED: enabled,
        MOCK_EXISTS: exists,
        MOCK_OTP_POOL: otpPool,
        MOCK_LIST_FAILS: listFails,
        MOCK_BINDING_MATCHES: bindingMatches,
      },
    });
  }
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(
    success.stdout,
    /UPDATED:beta run worker-pools update otp-worker .*--instances=0/,
  );
  for (const options of [
    { enabled: "false" },
    { otpPool: "main-worker" },
    { listFails: "true" },
    { bindingMatches: "false" },
  ]) {
    const rejected = run(options);
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stdout, /UPDATED:/);
  }
  const absent = run({ exists: "false" });
  assert.equal(absent.status, 0, absent.stderr);
  assert.doesNotMatch(absent.stdout, /UPDATED:/);
  for (const enabled of ["1", "yes", "on"]) {
    assert.equal(run({ enabled }).status, 0);
  }
});

test(
  "OTP retirement resolves the same project fallbacks as its consumer",
  {
    skip: process.platform === "win32" && !process.env.JQ_EXECUTABLE,
  },
  async () => {
    const workflow = await readRepoFile(
      ".github/workflows/deploy-temporal-worker.yml",
    );
    const { runBlock } = getWorkflowStepShellBlock(
      workflow,
      "Retire standalone OTP worker pool",
    );
    const bindingFilter = runBlock.match(
      /otp_consumer_binding\(\)\s*\{\s*jq -c --arg project "\$\{PROJECT_ID\}" '([\s\S]*?)'\s*\}/,
    )?.[1];
    assert.ok(bindingFilter, "retirement must resolve both effective bindings");

    for (const [envValues, expectedProject] of [
      [
        {
          WHATSAPP_OTP_PUBSUB_PROJECT_ID: " otp-project ",
          GOOGLE_CLOUD_PROJECT: "google-project",
          GCP_PROJECT_ID: "gcp-project",
        },
        "otp-project",
      ],
      [
        {
          WHATSAPP_OTP_PUBSUB_PROJECT_ID: " ",
          GOOGLE_CLOUD_PROJECT: " google-project ",
          GCP_PROJECT_ID: "gcp-project",
        },
        "google-project",
      ],
      [
        { GOOGLE_CLOUD_PROJECT: " ", GCP_PROJECT_ID: " gcp-project " },
        "gcp-project",
      ],
      [{ GCP_PROJECT_ID: " " }, "deployment-project"],
    ]) {
      const env = Object.entries(envValues).map(([name, value]) => ({
        name,
        value,
      }));
      const result = spawnSync(
        process.env.JQ_EXECUTABLE || "jq",
        ["-c", "--arg", "project", "deployment-project", bindingFilter],
        {
          encoding: "utf8",
          input: JSON.stringify({ template: { containers: [{ env }] } }),
        },
      );
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        expectedProject,
        "icecore-whatsapp-otp-delivery-worker",
      ]);
    }
  },
);

async function readRepoFile(path) {
  return (await readFile(new URL(path, repoRoot), "utf8")).replace(
    /\r\n?/g,
    "\n",
  );
}

function getWorkflowStepShellBlock(workflow, stepName) {
  const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stepBlock = workflow.match(
    new RegExp(`- name: ${escapedStepName}[\\s\\S]*?(?=\\n\\s{6}- name:)`),
  )?.[0];

  assert.ok(stepBlock, `${stepName} step must exist`);
  const lines = stepBlock.split(/\r?\n/);
  const runStart = lines.findIndex((line) => /^\s{8}run:\s+\|\s*$/.test(line));
  assert.ok(runStart >= 0, `${stepName} must have a shell run block`);

  return {
    stepBlock,
    runBlock: lines
      .slice(runStart + 1)
      .map((line) => line.replace(/^\s{10}/, ""))
      .join("\n"),
  };
}

function runAnalyticsValidationBlock(runBlock) {
  const projectExpression = "${{ steps.deploy-meta.outputs.project_id }}";
  assert.equal(
    runBlock.split(projectExpression).length - 1,
    1,
    "the behavior fixture must replace the sole GitHub project expression",
  );
  const executableBlock = runBlock.replace(projectExpression, "icecore-ai");
  const publisher = "airi-temporal-worker@icecore-ai.iam.gserviceaccount.com";
  const env = {
    ...process.env,
    GCP_AI_GATEWAY_SERVICE_ACCOUNT: publisher,
    GCP_WORKER_SERVICE_ACCOUNT: publisher,
  };
  const bashExecutable =
    process.platform === "win32"
      ? join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        )
      : "bash";
  const result = spawnSync(
    bashExecutable,
    ["-c", ["node() { printf '%s\\n' \"$@\"; }", executableBlock].join("\n")],
    {
      cwd: fileURLToPath(repoRoot),
      encoding: "utf8",
      env,
    },
  );

  assert.equal(result.error, undefined);
  return result;
}

function stripInlineShellComment(line) {
  let quote;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (
      character === "#" &&
      (index === 0 || /[\s;&|()]/.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }

  return line;
}

function normalizeShellContent(content) {
  return content
    .split(/\r?\n/)
    .map(stripInlineShellComment)
    .join("\n")
    .replace(/\\\s*\r?\n\s*/g, " ");
}

function getWorkflowRunContent(workflow) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  if (jobsStart < 0) return "";

  const jobContent = workflow.slice(jobsStart + "\njobs:\n".length);
  const runContents = [];
  for (const match of jobContent.matchAll(/^\s{8}run:\s*(.*)$/gm)) {
    const value = match[1].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const blockStart = match.index + match[0].length;
      const remainingContent = jobContent.slice(blockStart);
      const nextStepStart = remainingContent.search(/^\s{6}- name:/m);
      runContents.push(
        remainingContent.slice(
          0,
          nextStepStart < 0 ? remainingContent.length : nextStepStart,
        ),
      );
    } else {
      runContents.push(value);
    }
  }

  return normalizeShellContent(runContents.join("\n"));
}

function getInvokedProductionScripts(workflow) {
  // Only the push-driven worker job belongs in its push path filters. Manual
  // web recovery has its own dispatch condition and must not trigger a worker.
  const deployJob = workflow.match(/\n  deploy:\n[\s\S]*?(?=\n  [\w-]+:\n|$)/)?.[0];
  assert.ok(deployJob, "worker deployment job must exist");
  return getWorkflowRunContent(`\njobs:\n${deployJob}`)
    .split(/;|&&|\|\||\r?\n/)
    .flatMap((segment) => {
      const nodeCommand = segment.match(/^\s*node(?:\s|$)([\s\S]*)/);
      const script = nodeCommand?.[1].match(
        /(?:^|\s)(\.github\/scripts\/[^\s"']+\.mjs)\b/,
      )?.[1];
      return script ? [script] : [];
    })
    .filter((script) => !script.endsWith(".test.mjs"));
}

function assertReadOnlyLlmProductAnalyticsDeployment(workflow) {
  const analyticsScriptPath =
    ".github/scripts/sync-gcp-llm-product-analytics.mjs";
  const escapedAnalyticsScriptPath = analyticsScriptPath.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const workflowShellLines = workflow
    .split(/\r?\n/)
    .map(stripInlineShellComment);
  const { stepBlock: validationBlock, runBlock: validationRunBlock } =
    getWorkflowStepShellBlock(workflow, "Validate LLM product analytics");

  assert.equal(
    normalizeShellContent(workflow).match(
      new RegExp(
        `\\bnode(?:\\s+--no-warnings)?\\s+${escapedAnalyticsScriptPath}\\b`,
        "g",
      ),
    )?.length ?? 0,
    1,
    "the worker workflow must invoke the analytics lifecycle script exactly once",
  );
  const normalizedRunContent = normalizeShellContent(validationRunBlock);
  const nodeCommandSegments = normalizedRunContent
    .split(/;|&&|\|\||\r?\n/)
    .filter((segment) => /^\s*node(?:\s|$)/.test(segment));
  assert.equal(
    nodeCommandSegments.length,
    1,
    "the analytics run block must have exactly one executable node command",
  );
  assert.equal(
    normalizedRunContent.split(analyticsScriptPath).length - 1,
    1,
    "the analytics run block must reference the lifecycle script exactly once",
  );
  assert.match(
    nodeCommandSegments[0],
    /^\s*node(?:\s+--no-warnings)?\s+\.github\/scripts\/sync-gcp-llm-product-analytics\.mjs(?:\s|$)/,
    "the sole node command must use the approved lifecycle executable form",
  );
  assert.doesNotMatch(
    validationBlock,
    /^\s{8}if:\s/m,
    "analytics validation must run on every worker deployment",
  );
  assert.deepEqual(
    nodeCommandSegments.flatMap((segment) =>
      [
        ...segment.matchAll(/--phase\s+(?:"([^"]*)"|'([^']*)'|([^\s#\\;]+))/g),
      ].map((match) => match[1] ?? match[2] ?? match[3]),
    ),
    ["validate-finalized"],
    "analytics validation must use the read-only finalized phase",
  );
  assert.doesNotMatch(validationBlock, /BOOTSTRAP_INFRA|FINALIZE_CUTOVER/);
  assert.doesNotMatch(
    workflow,
    /--phase\s+["']?(?:prepare|preflight|finalize)["']?(?:\s|\\|$)/,
  );
  assert.doesNotMatch(workflow, /finalize_llm_analytics_cutover/);
  assert.ok(
    workflow.indexOf("- name: Validate LLM product analytics") <
      workflow.indexOf("- name: Build and push worker image"),
    "analytics state must be proven before a publisher image rolls out",
  );
}

test("workflow path filters are the only deploy and replay routers", async () => {
  const deploy = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const replay = await readRepoFile(
    ".github/workflows/replay-temporal-workflows.yml",
  );
  const deployPush = deploy.match(
    /push:\s*[\s\S]*?(?=\n\s{2}workflow_dispatch:)/,
  )?.[0];

  assert.ok(deployPush, "worker push trigger must exist");
  assert.doesNotMatch(deployPush, /\.github\/scripts\/\*\*/);
  assert.doesNotMatch(deployPush, /verify-dependency-direction/);
  assert.match(deployPush, /\.github\/cloud-run\/runtime-manifest\.json/);
  const invokedProductionScripts = getInvokedProductionScripts(deploy);
  const triggeredScripts = [
    ...deployPush.matchAll(/- "(\.github\/scripts\/[^"]+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(triggeredScripts)].sort(),
    [...new Set(invokedProductionScripts)].sort(),
  );

  assert.doesNotMatch(deploy, /detect-changed-projects(?:\.test)?\.mjs/);
  assert.doesNotMatch(deploy, /\n\s{2}detect-changes:/);
  assert.doesNotMatch(deploy, /\n\s{2}deploy-skipped:/);
  assert.doesNotMatch(replay, /detect-changed-projects\.mjs/);
  assert.doesNotMatch(replay, /pull-requests:\s*write/);
  assert.match(replay, /if: \$\{\{ !github\.event\.pull_request\.draft \}\}/);
  assert.match(replay, /Check replay fixture presence/);
});

test("workflow trigger coverage derives normalized executable deploy commands", async () => {
  const deploy = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const deployPush = deploy.match(
    /push:\s*[\s\S]*?(?=\n\s{2}workflow_dispatch:)/,
  )?.[0];
  const deployWithNormalizedCommand = deploy.replace(
    "        run: node .github/scripts/verify-gcloud-auth.mjs",
    [
      "        run: |",
      "          node    --no-warnings \\",
      "            --enable-source-maps \\",
      "            .github/scripts/verify-gcloud-auth.mjs",
      "          # node .github/scripts/commented-out-deploy-script.mjs",
      '          echo "gcloud auth verified" # node .github/scripts/also-commented-out-deploy-script.mjs',
    ].join("\n"),
  );

  assert.ok(deployPush, "worker push trigger must exist");
  assert.notEqual(
    deployWithNormalizedCommand,
    deploy,
    "the mutation must rewrite a real deploy invocation",
  );
  const invokedProductionScripts = getInvokedProductionScripts(
    deployWithNormalizedCommand,
  );
  const triggeredScripts = [
    ...deployPush.matchAll(/- "(\.github\/scripts\/[^"]+)"/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(invokedProductionScripts)].sort(),
    [...new Set(triggeredScripts)].sort(),
  );
});

test("workflow trigger coverage follows scripts after node option arguments", async () => {
  const deploy = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const deployPush = deploy.match(
    /push:\s*[\s\S]*?(?=\n\s{2}workflow_dispatch:)/,
  )?.[0];
  const deployWithOptionArgument = deploy.replace(
    "        run: node .github/scripts/verify-gcloud-auth.mjs",
    [
      "        run: |",
      "          node --import dotenv/config \\",
      "            .github/scripts/verify-gcloud-auth.mjs",
    ].join("\n"),
  );

  assert.ok(deployPush, "worker push trigger must exist");
  assert.notEqual(
    deployWithOptionArgument,
    deploy,
    "the mutation must rewrite a real deploy invocation",
  );
  const invokedProductionScripts = getInvokedProductionScripts(
    deployWithOptionArgument,
  );
  const triggeredScripts = [
    ...deployPush.matchAll(/- "(\.github\/scripts\/[^"]+)"/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(invokedProductionScripts)].sort(),
    [...new Set(triggeredScripts)].sort(),
  );
});

test("gcloud setup avoids eager project token exchange and build uses an explicit project", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const setupBlock = workflow.match(
    /- name: Set up gcloud[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  const buildBlock = workflow.match(
    /- name: Build and push worker image[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];

  assert.ok(setupBlock, "Set up gcloud step must exist");
  assert.doesNotMatch(setupBlock, /project_id:/);
  assert.match(
    workflow,
    /CLOUDSDK_CORE_PROJECT: \$\{\{ vars\.GCP_PROJECT_ID \}\}/,
  );
  assert.ok(buildBlock, "Build and push worker image step must exist");
  assert.match(
    buildBlock,
    /--project=\$\{\{ steps\.deploy-meta\.outputs\.project_id \}\}/,
  );
});

test("deploy metadata uses a canonical deployment name and immutable build identity", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const metadataBlock = workflow.match(
    /- name: Resolve deploy metadata[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];

  assert.ok(metadataBlock, "deploy metadata step must exist");
  assert.match(
    metadataBlock,
    /TEMPORAL_DEPLOYMENT_NAME="\$\{TEMPORAL_DEPLOYMENT_NAME#.*\}"/,
  );
  assert.match(
    metadataBlock,
    /TEMPORAL_DEPLOYMENT_NAME="\$\{TEMPORAL_DEPLOYMENT_NAME%.*\}"/,
  );
  assert.match(
    metadataBlock,
    /if \[\[ -z "\$\{TEMPORAL_DEPLOYMENT_NAME\}" \]\]/,
  );
  assert.match(
    metadataBlock,
    /BUILD_ID="\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
  );
  assert.doesNotMatch(metadataBlock, /BUILD_ID="\$\{GITHUB_SHA::8\}"/);
});

test("Temporal SDK packages stay aligned on one patch-compatible production line", async () => {
  const packageFiles = [
    "apps/temporal-worker/package.json",
    "apps/web/package.json",
  ];
  const versions = [];

  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(await readRepoFile(packageFile));
    for (const [name, version] of Object.entries(
      packageJson.dependencies || {},
    )) {
      if (!name.startsWith("@temporalio/")) continue;
      assert.match(
        version,
        /^~\d+\.\d+\.\d+$/,
        `${packageFile} ${name} must use a patch-compatible production range`,
      );
      versions.push(version);
    }
  }

  assert.ok(versions.length > 1, "Expected multiple Temporal SDK dependencies");
  assert.deepEqual([...new Set(versions)], [versions[0]]);
});

test("worker test cache prefers the official ECR mirror, falls back to mirror.gcr.io and requires a healthy container", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { stepBlock, runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Start local Valkey for worker tests",
  );
  assert.doesNotMatch(stepBlock, /continue-on-error:\s*true/);
  assert.match(
    workflow,
    /- name: Stop local Valkey for worker tests\s+if: always\(\)\s+shell: bash\s+run: docker rm -f airi-ci-valkey/,
  );
  const bashExecutable =
    process.platform === "win32"
      ? join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        )
      : "bash";
  function run({
    startStatus = "0",
    ecrStatus = startStatus,
    healthy = "true",
  } = {}) {
    const mocks = `
      docker() {
        case "$1" in
          rm) return 0;;
          run)
            printf 'START:%s\\n' "$*"
            if [[ "$*" == *public.ecr.aws* ]]; then return "$MOCK_ECR_STATUS"; fi
            return "$MOCK_START_STATUS";;
          exec)
            [[ "$*" == "exec airi-ci-valkey redis-cli ping" ]] || return 17
            if [[ "$MOCK_HEALTHY" == true ]]; then printf 'PONG\\n'; else return 1; fi;;
          *) return 17;;
        esac
      }
      sleep() { :; }
    `;
    return spawnSync(bashExecutable, ["-c", mocks + runBlock], {
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_START_STATUS: startStatus,
        MOCK_ECR_STATUS: ecrStatus,
        MOCK_HEALTHY: healthy,
      },
    });
  }
  const ready = run();
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(
    ready.stdout,
    /START:run -d --name airi-ci-valkey -p 16379:6379 public\.ecr\.aws\/docker\/library\/redis:7-alpine/,
  );
  assert.doesNotMatch(ready.stdout, /mirror\.gcr\.io/);
  assert.match(ready.stdout, /Local Valkey is ready/);

  const ecrQuotaExceeded = run({ ecrStatus: "125" });
  assert.equal(ecrQuotaExceeded.status, 0, ecrQuotaExceeded.stderr);
  assert.match(
    ecrQuotaExceeded.stdout,
    /START:run -d --name airi-ci-valkey -p 16379:6379 public\.ecr\.aws\/docker\/library\/redis:7-alpine\nSTART:run -d --name airi-ci-valkey -p 16379:6379 mirror\.gcr\.io\/library\/redis:7-alpine/,
  );
  assert.match(
    ecrQuotaExceeded.stderr,
    /Could not start Valkey from public\.ecr\.aws/,
  );
  assert.match(ecrQuotaExceeded.stdout, /Local Valkey is ready/);

  const startFailure = run({ startStatus: "42" });
  assert.equal(startFailure.status, 42, startFailure.stderr);
  assert.doesNotMatch(startFailure.stdout, /Local Valkey is ready/);

  const unhealthy = run({ healthy: "false" });
  assert.equal(unhealthy.status, 1, unhealthy.stderr);
  assert.match(unhealthy.stderr, /Local Valkey did not become ready/);
  assert.doesNotMatch(unhealthy.stdout, /Local Valkey is ready/);
});

test("deploy validation runs the complete Temporal worker test suite", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );

  assert.match(
    workflow,
    /- name: Start local Valkey for worker tests[\s\S]*?- name: Test Temporal worker runtime\s+env:\s+REALTIME_VALKEY_URL: redis:\/\/127\.0\.0\.1:16379\s+run: pnpm --filter @icecore\/temporal-worker test/,
  );

  const workerPackage = JSON.parse(
    await readRepoFile("apps/temporal-worker/package.json"),
  );
  assert.match(workerPackage.scripts.test, /src\/\*\*\/\*\.test\.ts/);
  assert.match(
    workerPackage.scripts.test,
    /packages\/airi-runtime\/src\/\*\*\/\*\.test\.ts/,
  );
  assert.match(
    workerPackage.scripts.test,
    /packages\/temporal\/src\/\*\*\/\*\.test\.ts/,
  );
  assert.match(
    workerPackage.scripts.test,
    /packages\/otp-runtime\/src\/\*\*\/\*\.test\.ts/,
  );
});

test("deploy provisions Temporal CLI before worker tests and promotion", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { stepBlock, runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Install Temporal CLI",
  );

  assert.equal(
    [...workflow.matchAll(/- name: Install Temporal CLI\s*\n/g)].length,
    1,
    "worker tests and promotion must reuse the same CLI installation",
  );
  const installIndex = workflow.indexOf("- name: Install Temporal CLI");
  for (const step of [
    "Test Temporal worker runtime",
    "Mark build current in Temporal",
  ]) {
    const stepIndex = workflow.indexOf(`- name: ${step}`);
    assert.ok(stepIndex >= 0, `${step} must exist`);
    assert.ok(
      installIndex < stepIndex,
      `Temporal CLI must be installed before ${step}`,
    );
  }
  assert.doesNotMatch(stepBlock, /^\s{8}if:\s/m);
  assert.match(
    runBlock,
    /sh \/tmp\/install-temporal\.sh --dir "\$TEMPORAL_INSTALL_DIR"/,
  );
  assert.match(
    runBlock,
    /echo "\$TEMPORAL_INSTALL_DIR\/bin" >> "\$GITHUB_PATH"/,
  );
});

test("deploy promotes the new build in Temporal right after the pool rollout", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const steps = [...workflow.matchAll(/^ {6}- name: (.+?)\s*$/gm)].map(
    (match) => match[1],
  );
  const rollout = steps.indexOf("Wait for Cloud Run worker pool rollout");
  assert.ok(rollout >= 0);
  // The rollout stops the previous build's instances; AUTO_UPGRADE tasks
  // have no pollers until the new build is current (2026-10-19: ~1.5 min
  // on every deploy while gateway and env-sync steps ran first).
  assert.deepEqual(steps.slice(rollout, rollout + 3), [
    "Wait for Cloud Run worker pool rollout",
    "Mark build current in Temporal",
    "Ensure worker startup probe",
  ]);
  assert.ok(
    steps.indexOf("Verify live Temporal history health after rollout") >
      rollout + 2,
  );
});

test("deploy provides the production audio tools before worker tests", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { stepBlock, runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Ensure worker audio tools",
  );
  assert.ok(
    workflow.indexOf("- name: Ensure worker audio tools") <
      workflow.indexOf("- name: Test Temporal worker runtime"),
  );
  assert.doesNotMatch(stepBlock, /continue-on-error:\s*true|^\s{8}if:\s/m);
  assert.match(runBlock, /set -euo pipefail/);
  assert.match(runBlock, /command -v ffmpeg/);
  assert.match(runBlock, /command -v ffprobe/);
  assert.match(runBlock, /apt-get install -y --no-install-recommends ffmpeg/);
  assert.match(runBlock, /ffmpeg -version/);
  assert.match(runBlock, /ffprobe -version/);
  const dockerfile = await readRepoFile("apps/temporal-worker/Dockerfile");
  assert.match(dockerfile, /apt-get install[^\n]*\bffmpeg\b/);
});

test("AI gateway uses one durable LLM product-event topic", async () => {
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );
  const gatewayVars = manifest.gateway.vars.map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  );
  const workerVars = manifest.worker.vars.map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  );

  assert.equal(manifest.worker.fixedVars.GCP_LLM_ANALYTICS_ENABLED, "true");

  for (const legacyName of [
    "GCP_LLM_ANALYTICS_PROJECT_ID",
    "GCP_LLM_ANALYTICS_DATASET",
    "GCP_LLM_ANALYTICS_TOPIC_PRODUCT_EVENTS",
    "GCP_LLM_ANALYTICS_TOPIC_TRACES",
    "GCP_LLM_ANALYTICS_TOPIC_RAG_TURNS",
    "GCP_LLM_ANALYTICS_TOPIC_SCORES",
    "GCP_LLM_ANALYTICS_TOPIC_EVAL_RUNS",
    "GCP_LLM_ANALYTICS_TOPIC_CUSTOMER_FEEDBACK",
    "GCP_LLM_ANALYTICS_TOPIC_HUMAN_EVALUATIONS",
  ]) {
    assert.ok(
      !gatewayVars.includes(legacyName),
      `${legacyName} must not override the provisioned product-ledger topology`,
    );
  }
});

test("worker deployment keeps product analytics read-only", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  assertReadOnlyLlmProductAnalyticsDeployment(workflow);
});

test("worker analytics validation invokes the finalized read-only phase", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const { runBlock } = getWorkflowStepShellBlock(
    workflow,
    "Validate LLM product analytics",
  );
  const publisher = "airi-temporal-worker@icecore-ai.iam.gserviceaccount.com";

  const result = runAnalyticsValidationBlock(runBlock);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    ".github/scripts/sync-gcp-llm-product-analytics.mjs",
    "--phase",
    "validate-finalized",
    "--project",
    "icecore-ai",
    "--publisher-service-account",
    publisher,
    "--publisher-service-account",
    publisher,
  ]);
});

test("worker analytics contract rejects lifecycle authorization escapes", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const alternatePhaseArgument = workflow.replace(
    "--phase validate-finalized",
    '--phase "${ANALYTICS_PHASE}"',
  );
  const alternatePhaseInvocation = workflow.replace(
    "      - name: Ensure WhatsApp Pub/Sub resources",
    '      - name: Bypass product analytics lifecycle\n        shell: bash\n        run: |\n          node .github/scripts/sync-gcp-llm-product-analytics.mjs \\\n            --phase "${ANALYTICS_PHASE}"\n\n      - name: Ensure WhatsApp Pub/Sub resources',
  );
  const conditionallyRunValidation = workflow.replace(
    "      - name: Validate LLM product analytics\n        shell: bash",
    "      - name: Validate LLM product analytics\n        if: ${{ github.event_name == 'workflow_dispatch' }}\n        shell: bash",
  );

  assert.throws(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(alternatePhaseArgument),
  );
  assert.throws(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(alternatePhaseInvocation),
  );
  assert.throws(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(conditionallyRunValidation),
  );
});

test("worker analytics contract rejects whitespace-tolerant lifecycle escapes", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const extraWhitespaceInvocation = workflow.replace(
    "      - name: Ensure WhatsApp Pub/Sub resources",
    '      - name: Bypass product analytics lifecycle\n        shell: bash\n        run: |\n          node    .github/scripts/sync-gcp-llm-product-analytics.mjs \\\n            --phase "${ANALYTICS_PHASE}"\n\n      - name: Ensure WhatsApp Pub/Sub resources',
  );

  assert.throws(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(extraWhitespaceInvocation),
  );
});

test("worker analytics contract accepts safe shell scalar syntax", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const safeShellSyntax = workflow.replace(
    "--phase validate-finalized",
    "--phase 'validate-finalized'",
  );

  assert.doesNotThrow(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(safeShellSyntax),
  );
});

test("worker analytics contract accepts safe Node options", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const nodeOption = workflow.replace(
    "node .github/scripts/sync-gcp-llm-product-analytics.mjs",
    "node --no-warnings .github/scripts/sync-gcp-llm-product-analytics.mjs",
  );

  assert.doesNotThrow(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(nodeOption),
  );
});

test("worker analytics contract ignores inline shell comments", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const accountLine =
    '          PUBLISHER_SERVICE_ACCOUNT="$(printf \'%s\' "${PUBLISHER_SERVICE_ACCOUNT}" | xargs)"';
  assert.ok(workflow.includes(accountLine));
  const inlineComment = workflow.replace(
    accountLine,
    `${accountLine} # ; node .github/scripts/sync-gcp-llm-product-analytics.mjs && node || node`,
  );

  assert.doesNotThrow(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(inlineComment),
  );
});

test("worker analytics contract rejects Node execution modes", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const evalBypass = workflow.replace(
    "node .github/scripts/sync-gcp-llm-product-analytics.mjs",
    "node --eval 'process.exit(0)' .github/scripts/sync-gcp-llm-product-analytics.mjs",
  );

  assert.throws(() => assertReadOnlyLlmProductAnalyticsDeployment(evalBypass));
});

test("worker analytics contract rejects same-line lifecycle invocations", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const secondNodeInvocation = workflow.replace(
    "node .github/scripts/sync-gcp-llm-product-analytics.mjs",
    "node .github/scripts/sync-gcp-llm-product-analytics.mjs ; node --no-warnings .github/scripts/sync-gcp-llm-product-analytics.mjs",
  );

  assert.throws(() =>
    assertReadOnlyLlmProductAnalyticsDeployment(secondNodeInvocation),
  );
});

test("deployment validation runs the product analytics migration contract", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const validationBlock = workflow.match(
    /- name: Validate Temporal deployment contracts[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(validationBlock);
  assert.match(
    validationBlock,
    /\.github\/scripts\/sync-gcp-llm-product-analytics\.test\.mjs/,
  );
});

test("the public AI gateway smoke test fails when unauthenticated traffic succeeds", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const authBlock = workflow.match(
    /- name: Verify AI gateway public auth boundary[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(authBlock);
  const expectedUnauthorizedBranch = authBlock.match(
    /if \[\[ "\$\{http_status\}" == "401" \]\] &&[\s\S]*?\n\s+fi/,
  )?.[0];
  assert.ok(expectedUnauthorizedBranch);
  assert.match(expectedUnauthorizedBranch, /\n\s+exit 0\s*\n\s+fi$/);
  assert.equal(authBlock.match(/\bexit 0\b/g)?.length, 1);
  assert.match(authBlock, /\n\s+exit 1\s*$/);
});

test("deploy validation imports the production worker graph before rollout", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const startupImportBlock = workflow.match(
    /- name: Check worker startup imports[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];

  assert.ok(startupImportBlock, "worker startup import gate must exist");
  assert.match(startupImportBlock, /NODE_ENV: production/);
  assert.match(startupImportBlock, /MONGODB_URI:/);
  assert.match(startupImportBlock, /NEXT_PUBLIC_SUPABASE_URL:/);
  assert.match(startupImportBlock, /SUPABASE_SERVICE_ROLE_KEY:/);
  assert.match(
    startupImportBlock,
    /pnpm --filter @icecore\/temporal-worker check:startup-import/,
  );

  const workerPackage = JSON.parse(
    await readRepoFile("apps/temporal-worker/package.json"),
  );
  assert.equal(
    workerPackage.scripts["check:startup-import"],
    "tsx scripts/check-worker-startup-import.ts",
  );

  const importGatePosition = workflow.indexOf(
    "- name: Check worker startup imports",
  );
  const deployPosition = workflow.indexOf(
    "- name: Build and push worker image",
  );
  assert.ok(importGatePosition >= 0);
  assert.ok(deployPosition > importGatePosition);
});

test("worker rollout is gated on production Mongo indexes and the WhatsApp QR cutover", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const ensureIndexPosition = workflow.indexOf("- name: Ensure Mongo indexes");
  const qrMigrationPosition = workflow.indexOf(
    "- name: Apply WhatsApp QR index migration",
  );
  const buildWorkerPosition = workflow.indexOf(
    "- name: Build and push worker image",
  );
  const deployWorkerPosition = workflow.indexOf(
    "- name: Deploy Cloud Run worker pool",
  );

  assert.notEqual(ensureIndexPosition, -1, "Mongo index gate must exist");
  assert.notEqual(
    qrMigrationPosition,
    -1,
    "WhatsApp QR index migration gate must exist",
  );
  assert.ok(
    ensureIndexPosition < qrMigrationPosition,
    "Mongo indexes must be ensured before the WhatsApp QR cutover",
  );
  assert.ok(
    qrMigrationPosition < buildWorkerPosition,
    "WhatsApp QR indexes must be migrated before the worker image is built",
  );
  assert.ok(
    buildWorkerPosition < deployWorkerPosition,
    "the worker image must be built before rollout",
  );
  const ensureIndexBlock = workflow.slice(
    ensureIndexPosition,
    workflow.indexOf("\n      - name:", ensureIndexPosition + 1),
  );
  const qrMigrationBlock = workflow.slice(
    qrMigrationPosition,
    workflow.indexOf("\n      - name:", qrMigrationPosition + 1),
  );
  assert.match(
    ensureIndexBlock,
    /MONGODB_URI: \$\{\{ secrets\.MONGODB_URI \}\}/,
  );
  assert.match(
    ensureIndexBlock,
    /pnpm --filter @icecore\/web run ensure:mongo-indexes/,
  );
  assert.match(
    qrMigrationBlock,
    /MONGODB_URI: \$\{\{ secrets\.MONGODB_URI \}\}/,
  );
  assert.match(
    qrMigrationBlock,
    /^\s{8}run: pnpm --filter @icecore\/web run migrate:whatsapp-qr-entry-point-indexes --apply\r?$/m,
  );
  assert.doesNotMatch(
    qrMigrationBlock,
    /migrate:whatsapp-qr-entry-point-indexes -- --apply/,
    "pnpm run forwards the separator as a literal script argument",
  );
  assert.doesNotMatch(
    qrMigrationBlock,
    /^\s+(?:continue-on-error|if):/m,
    "the WhatsApp QR index migration must fail closed",
  );
  assert.match(
    workflow,
    /- "apps\/web\/scripts\/migrate-whatsapp-qr-entry-point-indexes\.ts"/,
    "migration owner changes must trigger the deployment workflow",
  );
});

test("Google video generation configuration reaches the production worker", async () => {
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );
  const names = (entries) =>
    entries.map((entry) => (typeof entry === "string" ? entry : entry.name));
  const workerVars = names(manifest.worker.vars);
  const workerSecrets = names(manifest.worker.secrets);

  assert.ok(workerSecrets.includes("GEMINI_API_KEY"));
  assert.ok(workerSecrets.includes("GOOGLE_API_KEY"));
  assert.ok(workerVars.includes("GOOGLE_VIDEO_GENERATION_MODEL"));
  assert.ok(workerVars.includes("GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST"));

  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(workflow, /GOOGLE_API_KEY: \$\{\{ secrets\.GOOGLE_API_KEY \}\}/);
  assert.match(
    workflow,
    /GOOGLE_VIDEO_GENERATION_MODEL: \$\{\{ vars\.GOOGLE_VIDEO_GENERATION_MODEL \}\}/,
  );
  assert.match(
    workflow,
    /GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST: \$\{\{ vars\.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST \}\}/,
  );

  const workerEnvExample = await readRepoFile(
    "apps/temporal-worker/.env.example",
  );
  assert.match(workerEnvExample, /^GEMINI_API_KEY=/m);
  assert.match(workerEnvExample, /^# GOOGLE_API_KEY=/m);
  assert.match(workerEnvExample, /^# GOOGLE_VIDEO_GENERATION_MODEL=/m);
  assert.match(workerEnvExample, /^# GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST=/m);
});

test("Claude text generation configuration reaches every runtime that holds Google AI keys", async () => {
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );
  const names = (entries = []) =>
    entries.map((entry) => (typeof entry === "string" ? entry : entry.name));
  const optionalVars = [
    "AI_CHAT_PROVIDER_ORDER",
    "ANTHROPIC_AI_ENABLED",
    "ANTHROPIC_LIGHT_MODEL",
    "ANTHROPIC_HEAVY_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_WORKSPACE_ID",
  ];

  const runtimesWithGoogleAiKeys = Object.entries(manifest).filter(
    ([, runtime]) =>
      names(runtime?.secrets).includes("GEMINI_API_KEY"),
  );
  assert.ok(runtimesWithGoogleAiKeys.length > 0);
  for (const [runtimeName, runtime] of runtimesWithGoogleAiKeys) {
    const secret = runtime.secrets.find(
      (entry) => entry?.name === "ANTHROPIC_API_KEY",
    );
    assert.deepEqual(
      secret,
      { name: "ANTHROPIC_API_KEY", optional: true },
      `${runtimeName} must reference ANTHROPIC_API_KEY as an optional secret`,
    );
    for (const name of optionalVars) {
      const entry = runtime.vars.find((value) => value?.name === name);
      assert.ok(entry?.optional, `${runtimeName}.${name} must be optional`);
      assert.equal(runtime.fixedVars?.[name], undefined);
    }
  }
  for (const [runtimeName, runtime] of Object.entries(manifest)) {
    assert.ok(
      !names(runtime?.vars).includes("ANTHROPIC_API_KEY") &&
        !Object.hasOwn(runtime?.fixedVars || {}, "ANTHROPIC_API_KEY"),
      `${runtimeName} must never expose ANTHROPIC_API_KEY as a plain env value`,
    );
  }

  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const prepareBlock = workflow.match(
    /- name: Prepare Cloud Run runtime config[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(prepareBlock, "Cloud Run runtime config step must exist");
  assert.match(
    prepareBlock,
    /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/,
  );
  assert.doesNotMatch(workflow, /vars\.ANTHROPIC_API_KEY/);

  const syncBlock = workflow.match(
    /- name: Sync Vercel runtime env[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(syncBlock, "Vercel runtime sync step must exist");
  assert.doesNotMatch(syncBlock, /ANTHROPIC_API_KEY/);
  for (const name of optionalVars) {
    const mapping = new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`);
    assert.match(prepareBlock, mapping);
    assert.match(syncBlock, mapping);
  }

  const workerEnvExample = await readRepoFile(
    "apps/temporal-worker/.env.example",
  );
  assert.match(workerEnvExample, /^ANTHROPIC_API_KEY=/m);
  for (const name of optionalVars) {
    assert.match(workerEnvExample, new RegExp(`^# ${name}=`, "m"));
  }
});

test("retired VERTEX_SUMMARY_MODEL is neither deployed nor documented", async () => {
  // Summaries run on the heavy text tier; their Gemini fallback uses
  // VERTEX_GEMINI_HEAVY_MODEL, so a summary-only override would be ignored.
  for (const path of [
    ".github/cloud-run/runtime-manifest.json",
    ".github/workflows/deploy-temporal-worker.yml",
    "apps/web/README.md",
    "apps/web/src/lib/ai/vertex-gemini-rest.ts",
  ]) {
    assert.doesNotMatch(await readRepoFile(path), /VERTEX_SUMMARY_MODEL/, path);
  }
});

test("worker image installs the Claude SDK through the web workspace like the Google SDK", async () => {
  const webPackage = JSON.parse(await readRepoFile("apps/web/package.json"));
  const workerPackage = JSON.parse(
    await readRepoFile("apps/temporal-worker/package.json"),
  );
  for (const dependency of ["@anthropic-ai/sdk", "@google/genai"]) {
    assert.ok(
      webPackage.dependencies?.[dependency],
      `${dependency} must be a web runtime dependency`,
    );
    assert.equal(
      workerPackage.dependencies?.[dependency],
      undefined,
      `${dependency} must resolve from apps/web, not a second worker copy`,
    );
  }

  const lockfile = await readRepoFile("pnpm-lock.yaml");
  const webImporter = lockfile.match(
    /\n {2}apps\/web:\n {4}dependencies:\n([\s\S]*?)\n {4}devDependencies:/,
  )?.[1];
  assert.ok(webImporter, "the lockfile must declare apps/web dependencies");
  assert.match(webImporter, /^ {6}'@anthropic-ai\/sdk':$/m);
  assert.match(webImporter, /^ {6}'@google\/genai':$/m);
});

test("deployment verifies the live bulk campaign schema before rollout", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );

  const verificationBlock = workflow.match(
    /- name: Verify Supabase campaign contract[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(verificationBlock, "Supabase campaign contract step must exist");
  assert.match(
    verificationBlock,
    /NEXT_PUBLIC_SUPABASE_URL: \$\{\{ vars\.NEXT_PUBLIC_SUPABASE_URL \}\}/,
  );
  assert.match(
    verificationBlock,
    /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/,
  );
  assert.match(
    verificationBlock,
    /node \.github\/scripts\/verify-supabase-campaign-contract\.mjs/,
  );

  const verificationIndex = workflow.indexOf(
    "- name: Verify Supabase campaign contract",
  );
  const buildIndex = workflow.indexOf("- name: Build and push worker image");
  assert.ok(verificationIndex >= 0);
  assert.ok(buildIndex > verificationIndex);
});

test("the production web build verifies the same Supabase campaign contract", async () => {
  const webPackage = JSON.parse(await readRepoFile("apps/web/package.json"));

  assert.match(
    webPackage.scripts.prebuild,
    /verify-supabase-campaign-contract\.mjs --production-only/,
  );
});

test("classification Pub/Sub is verified and deployed disabled on the existing worker", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const ensureStart = workflow.indexOf("classification_pubsub_args=(");
  const ensureEnd = workflow.indexOf(
    'node .github/scripts/ensure-pubsub-resources.mjs "${classification_pubsub_args[@]}"',
    ensureStart,
  );
  assert.notEqual(ensureStart, -1, "classification provision block must exist");
  assert.notEqual(
    ensureEnd,
    -1,
    "classification verifier invocation must exist",
  );
  const ensureBlock = workflow.slice(ensureStart, ensureEnd);

  for (const value of [
    "icecore-conversation-classification-events",
    "icecore-conversation-classification-events-worker",
    "icecore-conversation-classification-events-dlq",
    "icecore-conversation-classification-events-dlq-worker",
  ]) {
    assert.match(ensureBlock, new RegExp(value));
  }
  assert.match(
    ensureBlock,
    /--message-retention-duration "31d"/,
    "classification must preserve a paused backlog for the maximum subscription retention window",
  );
  assert.deepEqual(
    (workflow.match(/--message-retention-duration [^\r\n]+/g) || [])
      .map((override) => override.trim())
      .sort(),
    ['--message-retention-duration "31d"', "--message-retention-duration 10m"],
    "only classification keeps a long backlog; the fast lane's unordered copy keeps 10 minutes",
  );
  assert.match(
    ensureBlock,
    /--never-expire/,
    "classification subscription must survive idle periods while its consumer is off",
  );
  assert.equal(
    (workflow.match(/--never-expire/g) || []).length,
    1,
    "the expiration override must remain classification-specific",
  );
  assert.match(ensureBlock, /--skip-setup/);
  for (const identity of [
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKER_SERVICE_ACCOUNT",
  ]) {
    assert.ok(
      ensureBlock.includes(
        `${identity}="$(printf '%s' "\${${identity}:-}" | xargs)"`,
      ),
      `${identity} must be trimmed before use`,
    );
    assert.match(
      ensureBlock,
      new RegExp(
        `if \\[\\[ -z "\\$\\{${identity}\\}" \\]\\]; then[\\s\\S]*?exit 1[\\s\\S]*?fi`,
      ),
      `${identity} must fail closed when blank after trimming`,
    );
  }
  assert.match(
    ensureBlock,
    /--subscriber-service-account "\$\{GCP_WORKER_SERVICE_ACCOUNT\}"/,
  );
  assert.equal(
    (
      ensureBlock.match(
        /--publisher-service-account "\$\{GCP_(?:SERVICE_ACCOUNT_EMAIL|WORKER_SERVICE_ACCOUNT)\}"/g,
      ) || []
    ).length,
    2,
  );
  assert.ok(
    ensureStart < workflow.indexOf("- name: Deploy Cloud Run worker pool"),
  );

  for (const expression of [
    'CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED: "true"',
    "CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED: ${{ vars.CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED || 'false' }}",
    "CONVERSATION_CLASSIFICATION_WORKSPACE_ALLOWLIST: ${{ vars.CONVERSATION_CLASSIFICATION_WORKSPACE_ALLOWLIST }}",
    "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID: ${{ vars.CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID || vars.GCP_PROJECT_ID }}",
    "CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC: ${{ vars.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC || 'icecore-conversation-classification-events' }}",
    "CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION: ${{ vars.CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION || 'icecore-conversation-classification-events-worker' }}",
    "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES: ${{ vars.CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES }}",
  ]) {
    assert.match(
      workflow,
      new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  for (const forbidden of [
    "GCP_CONVERSATION_CLASSIFICATION_CONSUMER_POOL_NAME",
    "conversationClassificationConsumer",
    "Deploy Cloud Run classification consumer worker pool",
  ]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden));
  }
});

test("Vercel classification values are synchronized with reconciliation enabled", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const syncBlock = workflow.match(
    /- name: Sync Vercel runtime env[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(syncBlock, "Vercel runtime sync step must exist");
  assert.match(
    syncBlock,
    /CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID: \$\{\{ vars\.CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID \|\| vars\.GCP_PROJECT_ID \}\}/,
  );
  assert.match(
    syncBlock,
    /CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC: \$\{\{ vars\.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC \|\| 'icecore-conversation-classification-events' \}\}/,
  );
  assert.match(
    syncBlock,
    /CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED: "true"/,
  );
  assert.doesNotMatch(
    syncBlock,
    /vars\.CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED/,
  );
});

test("WhatsApp OTP cutover stays on Pub/Sub until GitHub vars flip Temporal", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );
  const workerVars = manifest.worker.vars.map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  );
  const syncBlock = workflow.match(
    /- name: Sync Vercel runtime env[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];
  assert.ok(syncBlock, "Vercel runtime sync step must exist");
  assert.match(
    syncBlock,
    /WHATSAPP_OTP_DELIVERY_MODE: \$\{\{ vars\.WHATSAPP_OTP_DELIVERY_MODE \|\| 'pubsub' \}\}/,
  );
  assert.match(
    workflow,
    /WHATSAPP_OTP_DELIVERY_MODE: \$\{\{ vars\.WHATSAPP_OTP_DELIVERY_MODE \|\| 'pubsub' \}\}/,
  );
  assert.match(
    syncBlock,
    /WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST: \$\{\{ vars\.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST \}\}/,
  );
  assert.ok(workerVars.includes("WHATSAPP_OTP_DELIVERY_MODE"));
  assert.ok(workerVars.includes("WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST"));
  assert.notEqual(
    manifest.worker.fixedVars.WHATSAPP_OTP_DELIVERY_MODE,
    "temporal",
  );
});

test("classification keeps the existing Vercel cron cadence", async () => {
  const vercelConfig = JSON.parse(await readRepoFile("apps/web/vercel.json"));
  const classificationCrons = vercelConfig.crons.filter(
    (cron) => cron.path === "/api/cron/classify",
  );

  assert.deepEqual(classificationCrons, [
    {
      path: "/api/cron/classify",
      schedule: "*/5 * * * *",
    },
  ]);
});

test("Temporal promotion waits for the exact worker build to finish startup", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const promotionBlock = workflow.match(
    /- name: Mark build current in Temporal[\s\S]*?(?=\n\s{6}- name:)/,
  )?.[0];

  assert.ok(promotionBlock, "Temporal promotion step must exist");
  const lifecycleFilter = promotionBlock.match(
    /LIFECYCLE_LOG_FILTER="[^\n]+"/,
  )?.[0];
  const startupLogFilter = promotionBlock.match(
    /STARTUP_LOG_FILTER="[^\n]+"/,
  )?.[0];
  const startupFailureLogFilter = promotionBlock.match(
    /STARTUP_FAILURE_LOG_FILTER="[^\n]+"/,
  )?.[0];

  assert.ok(lifecycleFilter, "exact-build lifecycle log filter must exist");
  assert.ok(startupLogFilter, "exact-build startup log filter must exist");
  assert.ok(
    startupFailureLogFilter,
    "exact-build startup failure log filter must exist",
  );
  assert.match(
    lifecycleFilter,
    /jsonPayload\.event=\\"airi\.worker\.lifecycle\\"/,
  );
  assert.match(lifecycleFilter, /jsonPayload\.buildId=\\"\$\{BUILD_ID\}\\"/);
  assert.match(startupLogFilter, /jsonPayload\.note=\\"started\\"/);
  assert.match(startupLogFilter, /\$\{LIFECYCLE_LOG_FILTER\}/);
  assert.match(
    startupFailureLogFilter,
    /jsonPayload\.note=\\"auxiliary_step_failed\\"/,
  );
  assert.match(startupFailureLogFilter, /jsonPayload\.note=\\"start_failed\\"/);
  assert.doesNotMatch(lifecycleFilter, /resource\.(?:type|labels)/);
  assert.doesNotMatch(startupLogFilter, /resource\.(?:type|labels)/);
  assert.doesNotMatch(startupFailureLogFilter, /resource\.(?:type|labels)/);
  assert.match(
    promotionBlock,
    /gcloud logging read \\\r?\n\s+"\$\{LIFECYCLE_LOG_FILTER\}"/,
  );

  assert.match(
    workflow,
    /TEMPORAL_WORKER_STARTUP_LOG_WAIT_ATTEMPTS: \$\{\{ vars\.TEMPORAL_WORKER_STARTUP_LOG_WAIT_ATTEMPTS \}\}/,
  );
  assert.match(
    workflow,
    /TEMPORAL_WORKER_STARTUP_LOG_WAIT_SECONDS: \$\{\{ vars\.TEMPORAL_WORKER_STARTUP_LOG_WAIT_SECONDS \}\}/,
  );

  const startupFilter = promotionBlock.indexOf("STARTUP_LOG_FILTER=");
  const startupGate = promotionBlock.indexOf(
    'started_build_id="$(gcloud logging read "${STARTUP_LOG_FILTER}"',
    startupFilter,
  );
  const promote = promotionBlock.indexOf(
    "temporal worker deployment set-current-version",
  );
  const startupFailureGate = promotionBlock.indexOf(
    'failed_startup_note="$(gcloud logging read "${STARTUP_FAILURE_LOG_FILTER}"',
    startupFilter,
  );
  assert.ok(startupFilter >= 0, "exact-build startup log filter must exist");
  assert.ok(startupGate >= 0, "exact-build startup log query must exist");
  assert.ok(
    startupFailureGate >= 0,
    "exact-build startup failure query must exist",
  );
  assert.ok(
    startupGate < promote,
    "exact-build startup must be proven before Temporal promotion",
  );
  assert.ok(
    startupFailureGate < promote,
    "exact-build startup failure must block Temporal promotion",
  );
  assert.ok(
    startupFailureGate < startupGate,
    "exact-build startup failure must be checked before startup success",
  );
  const startupQuery = promotionBlock.slice(
    startupGate,
    promotionBlock.indexOf("if [[", startupGate),
  );
  assert.doesNotMatch(startupQuery, /2>\/dev\/null|\|\| true/);
});

test("deployment delegates Requests cutover to the enabled worker checkpoint runtime", async () => {
  const workflow = await readRepoFile(
    ".github/workflows/deploy-temporal-worker.yml",
  );
  const manifest = JSON.parse(
    await readRepoFile(".github/cloud-run/runtime-manifest.json"),
  );

  assert.doesNotMatch(
    workflow,
    /request-list-projection-operator[^\n]*--apply/,
  );
  assert.doesNotMatch(workflow, /migrate-request-list-indexes[^\n]*--apply/);
  assert.equal(manifest.worker.requestsReadModelMetadata.state, "live");
  assert.equal(
    manifest.worker.fixedVars.REQUESTS_PROJECTION_WRITER_ENABLED,
    "true",
  );
  assert.equal(
    manifest.worker.fixedVars.REQUESTS_PROJECTION_REALTIME_ENABLED,
    "true",
  );
});
