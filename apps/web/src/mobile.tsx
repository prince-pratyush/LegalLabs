import { EmptyState, useMobile } from "@legallabs/ui";
import type { ReactNode } from "react";

/** Builders and editors need room: on a phone they say so instead. Not an access check. */
export function DesktopOnly({ children }: { children: ReactNode }) {
  return useMobile() ? (
    <EmptyState
      title="Open this on a larger screen"
      description="Building and editing aren't available on phones."
      action={{
        label: "Start a thread",
        onClick: () => {
          window.location.hash = "/";
        },
      }}
    />
  ) : (
    children
  );
}
