import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { typography } from "./tokens.js";

// Without this, text-body and text-fg look like two colours and one is dropped.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...Object.keys(typography), "ui"] }],
    },
  },
});

export const cn = (...classes: ClassValue[]) => merge(clsx(classes));
