import type { CSSProperties, ReactNode } from "react";

export interface ShelfItem {
  readonly id: string;
  readonly imageUrl: string;
  readonly alt: string;
  /** Formatted price for the tag, or null for "No price". */
  readonly price: string | null;
  /** Set on products that just arrived, with their order in the arrival. */
  readonly arriving?: number;
  readonly below: ReactNode;
}

// Products stand on one continuous shelf: the cells touch, so the wall and the shelf edge run
// across each row like a shop window, and everything editable sits below the shelf line.
export function Shelf({ items, label }: { items: readonly ShelfItem[]; label: string }) {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <li
          key={item.id}
          className={item.arriving === undefined ? "min-w-0" : "arrive min-w-0"}
          style={item.arriving === undefined ? undefined : ({ "--i": item.arriving } as CSSProperties)}
        >
          <div className="relative flex aspect-[4/5] items-end justify-center border-b-[6px] border-shelf bg-wall px-4 pb-3 pt-12">
            <img
              src={item.imageUrl}
              alt={item.alt}
              loading="lazy"
              className="max-h-full max-w-full object-contain drop-shadow-[0_12px_10px_rgba(27,36,64,0.22)]"
            />
            <span className="price-tag absolute left-3 top-3 -rotate-3 text-sm sm:text-base" data-empty={item.price === null ? "" : undefined}>
              {item.price ?? "No price"}
            </span>
          </div>
          <div className="px-3 pt-3">{item.below}</div>
        </li>
      ))}
    </ul>
  );
}
