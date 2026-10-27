"use client";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface SettingsNavProps extends React.HTMLAttributes<HTMLElement> {
  items: {
    href: string;
    title: string;
    group?: string;
    disabled?: boolean;
  }[];
}

export function SettingsNav({ className, items, ...props }: SettingsNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const activeItem = items.find(
    item => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );
  const groups = Array.from(new Set(items.map(item => item.group || "")));

  return (
    <nav className={cn("min-w-0", className)} {...props}>
      <div className="lg:hidden">
        <Select
          value={activeItem?.href}
          onValueChange={href => router.push(href as Route)}
        >
          <SelectTrigger className="w-full" aria-label={props["aria-label"]}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map(group => (
              <SelectGroup key={group}>
                {group && <SelectLabel>{group}</SelectLabel>}
                {items
                  .filter(item => (item.group || "") === group)
                  .map(item => (
                    <SelectItem
                      key={item.href}
                      value={item.href}
                      disabled={item.disabled}
                    >
                      {item.title}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="hidden space-y-5 lg:block">
        {groups.map(group => (
          <div key={group} className="space-y-1">
            {group && (
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                {group}
              </p>
            )}
            {items
              .filter(item => (item.group || "") === group)
              .map(item => {
                const isActive =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                const isDisabled = item.disabled;

                return isDisabled ? (
                  <span
                    key={item.href}
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm text-muted-foreground opacity-60"
                    )}
                  >
                    <span>{item.title}</span>
                  </span>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href as Route}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "bg-muted text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    <span>{item.title}</span>
                  </Link>
                );
              })}
          </div>
        ))}
      </div>
    </nav>
  );
}
