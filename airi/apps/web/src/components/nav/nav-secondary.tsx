"use client";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { Route } from "next";
import { IntentPrefetchLink } from "./intent-prefetch-link";
import { NavProps } from "./nav-main";

interface NavSecondaryProps extends NavProps {
  className: string;
  groupLabel?: string;
}

export function NavSecondary({
  items,
  pathname,
  className,
  groupLabel = "Settings",
}: NavSecondaryProps) {
  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{groupLabel}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => {
            const Icon = item.icon;
            const isActive = pathname === item.url;
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  className={cn(
                    "text-muted-foreground font-semibold",
                    isActive && "bg-accent text-accent-foreground"
                  )}
                  tooltip={item.title as never}
                >
                  <IntentPrefetchLink
                    href={item.url as Route}
                    prefetch={item.prefetch}
                  >
                    <Icon className="size-5" />
                    {item.title}
                  </IntentPrefetchLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
