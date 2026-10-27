import { Skeleton } from "@/components/ui/skeleton";
import { Languages } from "lucide-react";

export default function Loading() {
  return (
    <div className="space-y-6 animate-in fade-in-50 duration-500">
      <div className="space-y-1">
        <h3 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Languages className="h-6 w-6 text-muted-foreground" />
          Airi Language
        </h3>
        <p className="text-sm text-muted-foreground">
          Choose the language Airi uses for all AI operations.
        </p>
      </div>

      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
