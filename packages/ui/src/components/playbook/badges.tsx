import { Skeleton, StatusText } from "../status.js";

/** Published or not, as icon plus words. */
export function PlaybookStatus({ status }: { status: "published" | "unpublished" }) {
  return status === "published" ? (
    <StatusText tone="verified">Published</StatusText>
  ) : (
    <StatusText tone="locked">Unpublished</StatusText>
  );
}

/**
 * Where a generated rule came from. A quote found in the contract reads as verified;
 * anything else asks the author to check it, since the model may have misread the clause.
 */
export function ProvenanceBadge({
  provenance,
}: {
  provenance: { quote: string; verified: boolean } | null | undefined;
}) {
  if (provenance === undefined) return null;
  if (provenance?.verified) {
    return (
      <span className="inline-grid gap-1">
        <StatusText tone="verified">Source found in the contract</StatusText>
        <q className="text-caption text-fg-muted">{provenance.quote}</q>
      </span>
    );
  }
  return <StatusText tone="flagged">Check source: the quote wasn't found</StatusText>;
}

export function BadgeSkeleton() {
  return <Skeleton className="h-5 w-28" />;
}
