"use client";

import { cn } from "@/lib/utils";
import { type ComponentType } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { Route } from "next";
import { useTranslations } from "next-intl";
import { IntentPrefetchLink } from "./intent-prefetch-link";

export interface NavItem {
  title: string;
  url: string;
  icon: ComponentType<{ className?: string }>;
  prefetch?: boolean;
  disabled?: boolean;
}

export interface NavProps {
  items: NavItem[];
  pathname: string;
}

export function NavMain({ items, pathname }: NavProps) {
  const tNavMain = useTranslations("NavMain");

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{tNavMain("overview")}</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map(item => {
            const Icon = item.icon;
            const isActive = pathname === item.url;
            const isDisabled = item.disabled;
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild={!isDisabled}
                  className={cn(
                    "text-muted-foreground font-semibold",
                    isActive && "bg-accent text-accent-foreground",
                    isDisabled &&
                      "pointer-events-none cursor-not-allowed opacity-50"
                  )}
                  tooltip={item.title as never}
                >
                  {isDisabled ? (
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 shrink-0" />
                      {item.title}
                    </span>
                  ) : (
                    <IntentPrefetchLink
                      href={item.url as Route}
                      prefetch={item.prefetch}
                      className="flex items-center gap-2"
                    >
                      <Icon className="size-4 shrink-0" />
                      {item.title}
                    </IntentPrefetchLink>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
