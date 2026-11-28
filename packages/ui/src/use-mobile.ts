import { useSyncExternalStore } from "react";

// Below the tablet breakpoint: one column, a drawer for navigation and full-screen sheets.
const PHONE = "(max-width: 767.98px)";

const media = () => (typeof matchMedia === "function" ? matchMedia(PHONE) : null);

const subscribe = (notify: () => void) => {
  const query = media();
  query?.addEventListener?.("change", notify);
  return () => query?.removeEventListener?.("change", notify);
};

export const useMobile = () => useSyncExternalStore(subscribe, () => media()?.matches ?? false);
