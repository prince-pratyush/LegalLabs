import { Button, Skeleton } from "@legallabs/ui";
import { type DependencyList, type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, FALLBACK } from "../api.js";

export const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : FALLBACK);

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  reload: () => void;
}

/** Loads on mount and when `deps` change; a late answer to an old request is dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown }>({
    data: null,
    error: null,
  });
  const [turn, setTurn] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the load reads
  useEffect(() => {
    let current = true;
    load().then(
      (data) => current && setState({ data, error: null }),
      (error: unknown) => current && setState({ data: null, error }),
    );
    return () => {
      current = false;
    };
  }, [...deps, turn]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  return { ...state, reload };
}

/** The loading and failure states every admin panel shares. */
export function Panel<T>({
  state,
  children,
}: {
  state: Loaded<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.error) {
    return (
      <div className="grid justify-items-start gap-2">
        <p role="alert" className="text-destructive">
          {messageOf(state.error)}
        </p>
        <Button variant="secondary" size="sm" onClick={state.reload}>
          Try again
        </Button>
      </div>
    );
  }
  if (state.data === null) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
