"use client";

interface PanelMainProps {
  children: React.ReactNode;
}

export function PanelMain({ children }: PanelMainProps) {
  return (
    <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
  );
}
