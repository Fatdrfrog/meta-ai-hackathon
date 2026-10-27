import { cn } from "@/lib/utils";
import Image from "next/image";
import type {
  IntegrationIconType,
  IntegrationImageIcon,
  IntegrationMetadata,
} from "./integration-registry";

function isImageIntegrationIcon(
  icon: IntegrationIconType
): icon is IntegrationImageIcon {
  return typeof icon === "object" && icon !== null && "src" in icon;
}

interface IntegrationIconProps {
  integration: IntegrationMetadata;
  alt: string;
  theme?: string;
  className?: string;
}

export function IntegrationIcon({
  integration,
  alt,
  theme,
  className,
}: IntegrationIconProps) {
  const icon =
    theme === "dark" ? integration.icon.dark : integration.icon.light;

  if (isImageIntegrationIcon(icon)) {
    return (
      <Image
        src={icon.src}
        alt={alt}
        width={icon.width || 24}
        height={icon.height || 24}
        className={cn("object-contain", className)}
      />
    );
  }

  const IconComponent = icon;

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center [&_svg]:h-full [&_svg]:w-full",
        className
      )}
    >
      <IconComponent className="h-full w-full" />
    </span>
  );
}
