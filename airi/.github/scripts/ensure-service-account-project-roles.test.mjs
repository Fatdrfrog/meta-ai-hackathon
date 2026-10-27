import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectRoleIamCommands,
  buildProjectRoleIamFailureMessage,
  normalizeServiceAccountMember,
  parseProjectRoleIamCommand,
  projectRoleBindingExistsInPolicy,
} from "./ensure-service-account-project-roles.mjs";

test("normalizes service account emails as IAM members", () => {
  assert.equal(
    normalizeServiceAccountMember("web@project-1.iam.gserviceaccount.com"),
    "serviceAccount:web@project-1.iam.gserviceaccount.com",
  );
  assert.equal(
    normalizeServiceAccountMember(
      "serviceAccount:web@project-1.iam.gserviceaccount.com",
    ),
    "serviceAccount:web@project-1.iam.gserviceaccount.com",
  );
});

test("builds project role IAM binding commands", () => {
  const commands = buildProjectRoleIamCommands({
    projectId: "project-1",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
    roles: ["roles/cloudtranslate.user"],
  });

  assert.deepEqual(commands, [
    [
      "projects",
      "add-iam-policy-binding",
      "project-1",
      "--member=serviceAccount:web@project-1.iam.gserviceaccount.com",
      "--role=roles/cloudtranslate.user",
      "--condition=None",
    ],
  ]);
});

test("deduplicates comma-separated and repeated roles", () => {
  const commands = buildProjectRoleIamCommands({
    projectId: "project-1",
    serviceAccount: "serviceAccount:web@project-1.iam.gserviceaccount.com",
    roles: [
      "roles/cloudtranslate.user, roles/pubsub.publisher",
      "roles/pubsub.publisher",
    ],
  });

  assert.deepEqual(
    commands.map((command) => command[4]),
    ["--role=roles/cloudtranslate.user", "--role=roles/pubsub.publisher"],
  );
});

test("explains missing permissions when project IAM binding fails", () => {
  const commands = buildProjectRoleIamCommands({
    projectId: "project-1",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
    roles: ["roles/cloudtranslate.user"],
  });

  const message = buildProjectRoleIamFailureMessage(commands[0], commands);

  assert.match(message, /resourcemanager\.projects\.getIamPolicy/);
  assert.match(message, /resourcemanager\.projects\.setIamPolicy/);
  assert.match(
    message,
    /gcloud projects add-iam-policy-binding project-1 --member=serviceAccount:web@project-1\.iam\.gserviceaccount\.com --role=roles\/cloudtranslate\.user/,
  );
});

test("detects existing unconditioned project role bindings", () => {
  const [command] = buildProjectRoleIamCommands({
    projectId: "project-1",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
    roles: ["roles/cloudtranslate.user"],
  });

  assert.deepEqual(parseProjectRoleIamCommand(command), {
    projectId: "project-1",
    member: "serviceAccount:web@project-1.iam.gserviceaccount.com",
    role: "roles/cloudtranslate.user",
  });
  assert.equal(
    projectRoleBindingExistsInPolicy(
      {
        bindings: [
          {
            role: "roles/cloudtranslate.user",
            members: ["serviceAccount:web@project-1.iam.gserviceaccount.com"],
          },
        ],
      },
      command,
    ),
    true,
  );
});

test("does not treat conditional project role bindings as deploy-ready", () => {
  const [command] = buildProjectRoleIamCommands({
    projectId: "project-1",
    serviceAccount: "web@project-1.iam.gserviceaccount.com",
    roles: ["roles/cloudtranslate.user"],
  });

  assert.equal(
    projectRoleBindingExistsInPolicy(
      {
        bindings: [
          {
            role: "roles/cloudtranslate.user",
            members: ["serviceAccount:web@project-1.iam.gserviceaccount.com"],
            condition: {
              title: "temporary",
              expression: "request.time < timestamp('2026-01-01T00:00:00Z')",
            },
          },
        ],
      },
      command,
    ),
    false,
  );
});
