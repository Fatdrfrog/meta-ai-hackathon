import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { MoreVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { IntentPrefetchLink } from "./intent-prefetch-link";
import { useTheme } from "next-themes";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

interface NavUserProps {
  user: { name: string; email: string; avatar: string | null } | null;
  isLoading: boolean;
  workspaceId?: string;
}

export function NavUser({ user, isLoading, workspaceId }: NavUserProps) {
  const t = useTranslations("NavUser");
  const tSiteHeader = useTranslations("SiteHeader");
  const router = useRouter();
  const supabase = createClient();
  const { setTheme } = useTheme();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 p-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex w-full items-center justify-between p-3"
        >
          <div className="flex items-center gap-3 overflow-hidden">
            <Avatar className="size-10">
              <AvatarImage src={user.avatar || ""} alt={user.name} />
              <AvatarFallback>{user.name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {user.email}
              </div>
            </div>
          </div>
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-muted-foreground text-xs leading-none">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <IntentPrefetchLink
              href={`/panel/w/${workspaceId}/settings/profile` as Route}
            >
              {t("profile")}
            </IntentPrefetchLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <IntentPrefetchLink
              href={`/panel/w/${workspaceId}/settings/integrations` as Route}
            >
              {t("settings")}
            </IntentPrefetchLink>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t("theme")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => setTheme("light")}>
                {tSiteHeader("lightTheme")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                {tSiteHeader("darkTheme")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                {tSiteHeader("systemTheme")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem asChild>
            <IntentPrefetchLink href={`/panel/w/${workspaceId}/help` as Route}>
              {t("whatsNew")}
            </IntentPrefetchLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (!workspaceId) return;
              navigator.clipboard?.writeText(workspaceId);
            }}
          >
            {t("copyWorkspaceId")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout}>
          {t("logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
