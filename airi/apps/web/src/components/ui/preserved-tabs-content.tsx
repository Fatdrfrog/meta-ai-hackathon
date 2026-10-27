"use client";

import { Activity, useState, type ComponentProps, type ReactNode } from "react";

import { TabsContent } from "@/components/ui/tabs";

type PreservedTabsContentProps = Omit<
  ComponentProps<typeof TabsContent>,
  "forceMount" | "value" | "hidden"
> & {
  value: string;
  activeValue: string;
  children: ReactNode;
};

/**
 * Mount a tab the first time it is selected, then keep it mounted.
 * React 19 Activity hides the panel and disconnects its effects until shown again,
 * so typed drafts and chart state survive a tab switch without background work.
 */
export function PreservedTabsContent({
  value,
  activeValue,
  children,
  ...props
}: PreservedTabsContentProps) {
  const [seen, setSeen] = useState(activeValue === value);
  if (activeValue === value && !seen) {
    setSeen(true);
  }
  if (!seen) {
    return null;
  }

  const selected = activeValue === value;

  return (
    <TabsContent forceMount hidden={!selected} value={value} {...props}>
      <Activity mode={selected ? "visible" : "hidden"}>{children}</Activity>
    </TabsContent>
  );
}
