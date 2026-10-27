import type { AnchorHTMLAttributes } from "react";

// Next's Link needs the app router, which Vite does not host.
export default function BrowserLink({
  href,
  prefetch: _prefetch,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string };
  prefetch?: boolean;
}) {
  return (
    <a
      href={typeof href === "string" ? href : href.pathname || "#"}
      {...props}
    />
  );
}
