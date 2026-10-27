import { cn } from "@/lib/utils";
import { LoaderIcon } from "lucide-react";

function SpinnerCustom({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderIcon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}
export function Spinner() {
  return (
    <div className="flex items-center gap-4">
      <SpinnerCustom />
    </div>
  );
}
