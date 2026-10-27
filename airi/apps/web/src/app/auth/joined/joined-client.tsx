"use client";

import {
  buildClearPendingTeamInviteCookie,
  buildPendingTeamInviteCookie,
} from "@/lib/auth/pending-invite-cookie";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import type { TeamInviteContext } from "@/lib/auth/team-invite-context";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type JoinStatus = "checking" | "ready" | "joining" | "error";

function getInviteName(inviteContext: TeamInviteContext | null): string {
  if (inviteContext?.status !== "valid") {
    return "workspace";
  }

  return (
    inviteContext.companyName?.trim() ||
    inviteContext.workspaceName?.trim() ||
    "workspace"
  );
}

export function JoinedClient({
  token,
  workspaceId,
  inviteContext,
}: {
  token: string;
  workspaceId?: string | null;
  inviteContext: TeamInviteContext | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState<JoinStatus>("checking");
  const [message, setMessage] = useState("");
  const inviteName = getInviteName(inviteContext);

  useEffect(() => {
    let active = true;

    const checkUser = async () => {
      if (!token) {
        if (workspaceId) {
          router.replace(panelWorkspaceAiriHref(workspaceId));
        } else {
          router.replace("/onboarding");
        }
        return;
      }

      document.cookie = buildPendingTeamInviteCookie(token);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!active) {
        return;
      }

      if (!user) {
        router.replace(`/login?invite_token=${encodeURIComponent(token)}`);
        return;
      }

      setStatus("ready");
    };

    checkUser().catch(() => {
      if (!active) {
        return;
      }

      setStatus("error");
      setMessage("Could not check your sign-in status.");
    });

    return () => {
      active = false;
    };
  }, [router, supabase, token, workspaceId]);

  const acceptInvite = async () => {
    if (!token || status === "joining") {
      return;
    }

    setStatus("joining");
    setMessage("");

    try {
      const response = await fetch("/api/team/invite-link/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "Failed to accept invite");
      }

      document.cookie = buildClearPendingTeamInviteCookie();

      const nextWorkspaceId = result.workspaceId || workspaceId;
      router.replace(
        nextWorkspaceId ? panelWorkspaceAiriHref(nextWorkspaceId) : "/panel"
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Invite link is invalid or expired"
      );
    }
  };

  if (status === "checking") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <div className="w-full rounded-2xl border bg-card p-5 text-center shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workspace invite
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Join {inviteName}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            You are signed in. Accept the invite to finish joining this
            workspace.
          </p>
        </div>
        {status === "error" ? (
          <div className="flex items-center gap-2 text-center text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{message || "Invite link is invalid or expired."}</span>
          </div>
        ) : null}
        <Button
          type="button"
          className="h-12 w-full"
          onClick={acceptInvite}
          disabled={status === "joining" || inviteContext?.status !== "valid"}
        >
          {status === "joining" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Accepting...
            </>
          ) : (
            "Accept invite"
          )}
        </Button>
      </div>
    </div>
  );
}
