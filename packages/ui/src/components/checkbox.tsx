import { Check, Minus } from "lucide-react";
import { Checkbox as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

// The box is 16 px but the button is 24 px, the smallest target WCAG allows.
export function Checkbox({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="checkbox"
      className={cn(
        "group inline-grid size-6 shrink-0 place-items-center rounded-md disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="grid size-4 place-items-center rounded-sm border border-control bg-bg-raised text-bg group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent group-data-[state=indeterminate]:border-accent group-data-[state=indeterminate]:bg-accent">
        <Primitive.Indicator>
          {props.checked === "indeterminate" ? (
            <Minus aria-hidden className="size-3" strokeWidth={3} />
          ) : (
            <Check aria-hidden className="size-3" strokeWidth={3} />
          )}
        </Primitive.Indicator>
      </span>
    </Primitive.Root>
  );
}
