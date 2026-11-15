import { ChevronRight } from "lucide-react";
import { cn } from "../cn.js";

export interface Crumb {
  id: string | null;
  label: string;
}

/** Where someone is in a tree; every step but the last takes them back up. */
export function Breadcrumbs({
  items,
  onSelect,
  className,
}: {
  items: readonly Crumb[];
  onSelect: (id: string | null) => void;
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-ui text-fg-muted">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.id ?? "root"} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-4 shrink-0" />}
              {last ? (
                <span aria-current="page" className="truncate font-medium text-fg">
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="truncate rounded-sm hover:text-fg hover:underline"
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
