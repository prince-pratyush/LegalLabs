import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Without this, text-body and text-fg look like two colours and one is dropped.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["caption", "dense", "body", "prose", "section", "title", "display", "ui"] },
      ],
    },
  },
});

export const cn = (...classes: ClassValue[]) => merge(clsx(classes));
