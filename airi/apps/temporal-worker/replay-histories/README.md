Place exported workflow histories here as `.json` fixtures for automated replay.

The three `synthetic-airi-*-before-turn-recovery.json` fixtures were captured
from the workflow before durable turn recovery was added, using an isolated
Temporal development server and synthetic activity responses. They cover a
completed turn, an ambiguous preparation failure, and exhausted timer-building
activity retries. They contain no production conversation data.

The `synthetic-airi-*-before-failed-turn-timer-replan.json` and
`synthetic-airi-*-before-refire-suppression.json` fixtures were captured the same
way from the workflow before the `…-replan-timer-after-unretried-turn-failure-v1`
and `…-suppress-timer-refire-v1` patches. They cover an inbound turn failing
without a timer re-plan, a timer turn re-arming the timer that just fired, and a
timer fire continuing as new without carrying the fired timer.
`synthetic-airi-timer-refire-upgraded-mid-flight.json` re-fires on the pre-fix
build until the worker deployment's current version moves to the fixed build,
whose next timer turn records the suppression marker instead of re-firing.

The `synthetic-airi-button-tap-*-before-in-order-button-taps.json` fixtures were
captured the same way from the workflow before the
`airi-conversation-in-order-button-taps-v1` patch. In one, three button taps and
two typed turns queued during a turn fold into the newest tap. In the other, a
typed turn supersedes a button tap's preparation retry.

The conversation integration suite also executes the current workflow on a local
Temporal server and replays every run, including Continue-As-New successors. With
the Temporal CLI installed, run from `apps/temporal-worker`:

```powershell
$env:TEMPORAL_WORKFLOW_TESTS = '1'
pnpm exec tsx --test src/airi-conversation-workflow.integration.test.ts
```

This suite supplies test activities; it does not contact MongoDB, model providers,
or messaging providers. The replay CI workflow enables it explicitly.

CI and production deploys run strict replay. If this directory has no JSON
fixtures, Temporal worker changes must fail before deployment because existing
workflow histories could replay against the new bundle.

Supported fixture formats:

```json
{
  "events": []
}
```

or:

```json
{
  "workflowId": "airi-conversation:69a96de08e6608e5ec1a5578",
  "runId": "4a04c6a1-74de-4ac1-a32f-74a2221d4022",
  "workflowType": "airiConversationWorkflow",
  "history": {
    "events": []
  }
}
```

Run replay locally:

```powershell
pnpm --filter @icecore/temporal-worker replay:histories
pnpm --filter @icecore/temporal-worker replay:histories:strict
```

Export from the deployed worker pool and Temporal Cloud:

```powershell
pnpm --filter @icecore/temporal-worker export:replay-histories -- --from-gcloud --limit 3
```

Export one exact execution:

```powershell
pnpm --filter @icecore/temporal-worker export:replay-histories -- --from-gcloud --execution "workflow-id,run-id"
```

Use `--dry-run` first when selecting histories:

```powershell
pnpm --filter @icecore/temporal-worker export:replay-histories -- --from-gcloud --dry-run --workflow-type airiConversationWorkflow --limit 10
```

Recommended fixture set:

- One normal inbound conversation turn
- One timer follow-up conversation
- One conversation where human outbound clears the timer
- One conversation that has already continued-as-new
- One bulk campaign dispatch history
- One campaign execution or node-run history when campaign orchestration changes

Do not commit raw production histories blindly. Temporal histories can contain
message payloads, activity inputs, and activity results. Prefer staging or
synthetic workflows; if production histories are needed, review them as sensitive
test fixtures before committing.
