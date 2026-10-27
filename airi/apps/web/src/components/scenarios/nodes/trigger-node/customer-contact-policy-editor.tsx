"use client";
import { useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  fetchCustomerBehavior,
  saveCustomerContactPolicy,
} from "@/lib/scenarios/client/customer-behavior";
import {
  isCustomerContactPolicy,
  type CustomerContactPolicy,
} from "@icecore/scenario-contracts";

export function CustomerContactPolicyEditor({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("CustomerBehavior");
  const { data, error, mutate } = useSWR(
    ["contact-policy", workspaceId],
    () => fetchCustomerBehavior(workspaceId),
    { errorRetryCount: 1 }
  );
  const [draft, setDraft] = useState<CustomerContactPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const policy = draft || data?.policy;
  if (!policy)
    return (
      <div role={error ? "alert" : "status"} className="text-xs">
        {error ? t("error") : t("loading")}
        {error && (
          <Button size="sm" variant="ghost" onClick={() => void mutate()}>
            {t("retry")}
          </Button>
        )}
      </div>
    );
  return (
    <details className="rounded-md border p-2 text-xs nodrag nopan">
      <summary className="cursor-pointer font-medium">
        {t("contactPolicy")}
      </summary>
      <p className="mt-2 text-muted-foreground">{t("policyHint")}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label>
          {t("intervalHours")}
          <Input
            aria-label={t("intervalHours")}
            type="number"
            min={1}
            max={720}
            disabled={busy}
            value={policy.minIntervalHours}
            onChange={e =>
              setDraft({ ...policy, minIntervalHours: Number(e.target.value) })
            }
          />
        </label>
        <label>
          {t("maxPerWeek")}
          <Input
            aria-label={t("maxPerWeek")}
            type="number"
            min={1}
            max={100}
            disabled={busy}
            value={policy.maxPerWeek}
            onChange={e =>
              setDraft({ ...policy, maxPerWeek: Number(e.target.value) })
            }
          />
        </label>
      </div>
      {failed && (
        <p role="alert" className="mt-1 text-destructive">
          {t("error")}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        className="mt-2"
        disabled={busy || !draft || !isCustomerContactPolicy(policy)}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            await saveCustomerContactPolicy(workspaceId, policy);
            await mutate();
            setDraft(null);
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("saving") : t("savePolicy")}
      </Button>
    </details>
  );
}
