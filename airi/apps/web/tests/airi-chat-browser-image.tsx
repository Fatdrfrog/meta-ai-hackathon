import type { ImgHTMLAttributes } from "react";

// Next's Image needs its loader, which Vite does not host.
export default function BrowserImage({
  src,
  alt,
  fill: _fill,
  priority: _priority,
  unoptimized: _unoptimized,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | { src: string };
  fill?: boolean;
  priority?: boolean;
  unoptimized?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image
    <img src={typeof src === "string" ? src : src.src} alt={alt} {...props} />
  );
}
