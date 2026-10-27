"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { getFreePlanUpsellLink } from "@/components/limits/free-plan-upsell";
import {
  getJoinedUserProfile,
  isCompanyAdminRole,
  isWorkspaceRole,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "@/lib/supabase/company-users";
import type { Member, TeamMembers } from "@/types/supabase";
import {
  Check,
  Copy,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function TeamManagementClientPage({
  initialMembers,
  workspaceId,
  currentUserId,
  currentRole = "manager",
}: {
  initialMembers: TeamMembers;
  workspaceId: string;
  currentUserId?: string;
  currentRole?: string;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [manualInviteUrl, setManualInviteUrl] = useState<string | null>(null);
  const [members, setMembers] = useState(initialMembers);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
  const t = useTranslations("TeamManagementClientPage");
  const router = useRouter();
  const {
    data: limits,
    error: limitsError,
    mutate: refreshLimits,
  } = useCompanyLimits(workspaceId);
  const seatLocked = Boolean(
    limits?.seatExhausted ||
      limits?.lockedCapabilities?.includes("team_invites")
  );
  const busy = pendingAction !== null;
  const canManage = isCompanyAdminRole(currentRole);
  const billingHref = getFreePlanUpsellLink(workspaceId);

  useEffect(() => setMembers(initialMembers), [initialMembers]);

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const textArea = document.createElement("textarea");
      try {
        textArea.value = value;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        return copied;
      } catch {
        return false;
      } finally {
        textArea.remove();
      }
    }
  };

  const request = async (
    url: string,
    method: string,
    body?: Record<string, unknown>
  ) => {
    const response = await fetch(url, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof result.error === "string" ? result.error : t("actionError")
      );
    return result;
  };

  const shareInviteUrl = async (url: string) => {
    const copied = await copyToClipboard(url);
    setManualInviteUrl(copied ? null : url);
    setInviteLinkCopied(copied);
    return copied;
  };

  const sendInvite = async (email: string, resend = false) => {
    if (!canManage || busy || seatLocked) return;
    const normalizedEmail = email.trim();
    if (!normalizedEmail) return;
    setPendingAction(resend ? `resend:${normalizedEmail}` : "invite");
    setInviteLinkCopied(false);
    setManualInviteUrl(null);
    try {
      const result = await request("/api/team/invite", "POST", {
        email: normalizedEmail,
        workspaceId,
      });
      if (
        result.delivery === "manual_link" &&
        typeof result.manualInviteUrl === "string"
      ) {
        const copied = await shareInviteUrl(result.manualInviteUrl);
        toast.success(
          t(copied ? "manualInviteLinkCopied" : "manualInviteLinkPrompt")
        );
      } else {
        if (result.success !== true || result.delivery !== "email") {
          throw new Error(t("inviteError"));
        }
        toast.success(
          t(resend ? "resendSuccess" : "inviteSuccess", {
            email: normalizedEmail,
          })
        );
      }
      if (!resend) setInviteEmail("");
      router.refresh();
      void refreshLimits();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inviteError"));
    } finally {
      setPendingAction(null);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!canManage || busy || seatLocked) return;
    setPendingAction("link");
    setInviteLinkCopied(false);
    try {
      const result = await request("/api/team/invite-link", "POST", {
        workspaceId,
      });
      if (typeof result.inviteUrl !== "string" || !result.inviteUrl)
        throw new Error(t("inviteLinkError"));
      const copied = await shareInviteUrl(result.inviteUrl);
      toast.success(t(copied ? "inviteLinkCopied" : "manualInviteLinkPrompt"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("inviteLinkError")
      );
    } finally {
      setPendingAction(null);
    }
  };

  const removeMember = async (member: Member) => {
    if (busy) return;
    setPendingAction(`remove:${member.id}`);
    try {
      await request(`/api/team/revoke/${member.id}`, "DELETE");
      setMembers(previous => previous.filter(item => item.id !== member.id));
      toast.success(t(member.user_id ? "removeSuccess" : "revokeSuccess"));
      void refreshLimits();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actionError"));
    } finally {
      setPendingAction(null);
    }
  };

  const updateRole = async (member: Member, role: WorkspaceRole) => {
    if (busy || member.role === role) return;
    setPendingAction(`role:${member.id}`);
    try {
      await request("/api/team/update-role", "POST", {
        memberId: member.id.toString(),
        role,
      });
      setMembers(previous =>
        previous.map(item => (item.id === member.id ? { ...item, role } : item))
      );
      toast.success(t("roleUpdated"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actionError"));
    } finally {
      setPendingAction(null);
    }
  };

  const roleLabel = (role: string) =>
    isWorkspaceRole(role) ? t(`roles.${role}`) : role;

  return (
    <div className="max-w-3xl space-y-4">
      {canManage && (
        <Card className="gap-0 shadow-none">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <form
              onSubmit={event => {
                event.preventDefault();
                void sendInvite(inviteEmail);
              }}
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="team-invite-email">
                  {t("inviteNewMember")}
                </Label>
                <Input
                  id="team-invite-email"
                  type="email"
                  autoComplete="email"
                  placeholder={t("emailPlaceholder")}
                  value={inviteEmail}
                  onChange={event => setInviteEmail(event.target.value)}
                  disabled={busy || seatLocked}
                  required
                />
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || seatLocked || !inviteEmail.trim()}
                  className="flex-1 sm:flex-none"
                >
                  {pendingAction === "invite" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserPlus className="size-4" />
                  )}
                  {t("inviteButton")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopyInviteLink}
                  disabled={busy || seatLocked}
                  className="flex-1 sm:flex-none"
                >
                  {pendingAction === "link" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : inviteLinkCopied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {t("copyInviteLink")}
                </Button>
              </div>
            </form>
            {seatLocked && (
              <p className="text-xs text-muted-foreground">
                {t(limits?.trialExpired ? "trialExpired" : "seatLimitReached")}{" "}
                {billingHref && (
                  <a
                    href={billingHref}
                    className="underline underline-offset-2"
                  >
                    {t("viewLimits")}
                  </a>
                )}
              </p>
            )}
            {limitsError && (
              <p className="text-xs text-muted-foreground">
                {t("limitsUnavailable")}{" "}
                <button
                  type="button"
                  onClick={() => void refreshLimits()}
                  className="underline underline-offset-2"
                >
                  {t("retry")}
                </button>
              </p>
            )}
            {manualInviteUrl && (
              <div className="space-y-2">
                <Label htmlFor="manual-invite-url">
                  {t("manualInviteLinkPrompt")}
                </Label>
                <Input
                  id="manual-invite-url"
                  readOnly
                  value={manualInviteUrl}
                  onFocus={event => event.currentTarget.select()}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="gap-0 overflow-hidden shadow-none">
        <div className="flex items-center justify-between border-b px-4 py-3 sm:px-5">
          <h4 className="text-sm font-medium">{t("currentTeam")}</h4>
          <span className="text-xs text-muted-foreground">
            {t("memberCount", { count: members.length })}
          </span>
        </div>
        {members.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">{t("emptyTeam")}</p>
        ) : (
          <ul className="divide-y">
            {members.map(member => {
              const profile = getJoinedUserProfile(member.users);
              const isPending = !member.user_id;
              const isSelf = member.user_id === currentUserId;
              const displayName =
                profile?.full_name || member.email || t("unknownMember");
              const editable = canManage && !isSelf;
              return (
                <li
                  key={member.id}
                  className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:items-center sm:px-5"
                >
                  <Avatar className="size-9 border">
                    <AvatarImage
                      src={profile?.avatar_url ?? undefined}
                      alt={displayName}
                    />
                    <AvatarFallback>
                      {displayName.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 break-words text-sm font-medium">
                        {displayName}
                      </p>
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">
                          {t("you")}
                        </span>
                      )}
                      {isPending && (
                        <Badge variant="outline" className="text-xs">
                          {t("pending")}
                        </Badge>
                      )}
                    </div>
                    {profile?.full_name && member.email && (
                      <p className="break-all text-xs text-muted-foreground">
                        {member.email}
                      </p>
                    )}
                  </div>
                  <div className="ml-12 flex w-[calc(100%-3rem)] items-center justify-between gap-1 sm:ml-0 sm:w-auto sm:shrink-0 sm:justify-end">
                    {editable && isWorkspaceRole(member.role) ? (
                      <Select
                        value={member.role}
                        onValueChange={role => {
                          if (isWorkspaceRole(role))
                            void updateRole(member, role);
                        }}
                        disabled={busy}
                      >
                        <SelectTrigger
                          className="h-8 min-w-36 text-xs"
                          aria-label={t("changeRoleFor", { name: displayName })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORKSPACE_ROLES.map(role => (
                            <SelectItem key={role} value={role}>
                              {roleLabel(role)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground sm:px-2">
                        {roleLabel(member.role)}
                      </span>
                    )}
                    {(editable ||
                      (canManage && isPending && Boolean(member.email))) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            disabled={busy}
                            aria-label={t("actionsFor", { name: displayName })}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isPending && member.email && (
                            <DropdownMenuItem
                              disabled={seatLocked}
                              onSelect={() =>
                                void sendInvite(member.email, true)
                              }
                            >
                              <RefreshCw className="size-4" />
                              {t("resendInvite")}
                            </DropdownMenuItem>
                          )}
                          {editable && (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setMemberToRemove(member)}
                            >
                              {t(isPending ? "revokeInvite" : "removeMember")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <AlertDialog
        open={Boolean(memberToRemove)}
        onOpenChange={open => {
          if (!open) setMemberToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(memberToRemove?.user_id ? "confirmRemove" : "confirmRevoke")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                memberToRemove?.user_id
                  ? "removeDescription"
                  : "revokeDescription"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (memberToRemove) void removeMember(memberToRemove);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t(memberToRemove?.user_id ? "removeMember" : "revokeInvite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
