"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ConnectInstagramButton({
  label = "Connect Instagram",
  disabled = false,
  workspaceId,
}: {
  label?: string;
  disabled?: boolean;
  workspaceId?: string;
}) {
  const [loading, setLoading] = useState(false);
  const onClick = () => {
    setLoading(true);
    // Navigate to server route which initiates OAuth; do not expose raw link
    window.location.href = `/api/sources/instagram/connect?workspaceId=${encodeURIComponent(workspaceId!)}`;
  };
  return (
    <Button onClick={onClick} disabled={loading || disabled || !workspaceId}>
      {loading ? "Redirecting…" : label}
    </Button>
  );
}

export function ConnectInstagramViaFacebookButton({
  label = "Connect Instagram via Facebook",
  disabled = false,
  workspaceId,
}: {
  label?: string;
  disabled?: boolean;
  workspaceId?: string;
}) {
  const [loading, setLoading] = useState(false);
  const onClick = () => {
    setLoading(true);
    window.location.href = `/api/sources/instagram/connect-facebook?workspaceId=${encodeURIComponent(workspaceId!)}`;
  };
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      disabled={loading || disabled || !workspaceId}
    >
      {loading ? "Opening Facebook…" : label}
    </Button>
  );
}
