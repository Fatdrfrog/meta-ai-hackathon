"use client";

import { Badge } from "@/components/ui/badge";
import type { ExtractedEntity } from "@icecore/shared/types/models";

export function ExtractedEntitiesSection({
  entities,
}: {
  entities: ExtractedEntity[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {entities.map((entity, i) => (
        <Badge key={`${entity.type}-${i}`} variant="outline">
          <span className="font-semibold mr-1">{entity.type}:</span>{" "}
          {entity.value}
        </Badge>
      ))}
    </div>
  );
}
