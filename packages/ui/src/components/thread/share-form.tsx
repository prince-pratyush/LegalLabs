import { Link2, ShieldAlert, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Input } from "../field.js";
import { Skeleton, StatusText } from "../status.js";

export type Member = { id: string; name: string; email: string };

export type ExistingShare = { id: string; label: string; kind: "user" | "link" };

export type RejectedShare = { name: string; reason: "WALL_DENIED" | "NOT_MEMBER" };

const REASONS: Record<RejectedShare["reason"], string> = {
  WALL_DENIED: "is walled off from this matter",
  NOT_MEMBER: "isn't a member of this workspace",
};

/** Share a thread read-only; walls are checked per person, and refusals are named. */
export function ShareForm({
  members,
  shares,
  rejected = [],
  onShare,
  onRevoke,
  busy = false,
  walled = false,
  className,
}: {
  members: readonly Member[];
  shares: readonly ExistingShare[];
  rejected?: readonly RejectedShare[];
  onShare: (input: { memberIds: string[]; link: boolean }) => void;
  onRevoke: (share: ExistingShare) => void;
  busy?: boolean;
  /** A thread behind a wall can't be shared by link. */
  walled?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Member[]>([]);
  const [link, setLink] = useState(false);
  const searchId = useId();
  const linkId = useId();

  const q = query.trim().toLowerCase();
  const matches = q
    ? members
        .filter((m) => !picked.some((p) => p.id === m.id))
        .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
        .slice(0, 6)
    : [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked.length === 0 && !link) return;
    onShare({ memberIds: picked.map((m) => m.id), link });
    setPicked([]);
    setLink(false);
  };

  return (
    <form onSubmit={submit} aria-busy={busy || undefined} className={cn("grid gap-4", className)}>
      <div className="grid gap-1">
        <label htmlFor={searchId} className="text-ui font-medium">
          Add people
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or email"
          autoComplete="off"
        />
        {matches.length > 0 && (
          <ul
            aria-label="Matching people"
            className="grid gap-0.5 rounded-md border border-border p-1"
          >
            {matches.map((member) => (
              <li key={member.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked((list) => [...list, member]);
                    setQuery("");
                  }}
                  className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-dense hover:tint-hover"
                >
                  <span className="font-medium">{member.name}</span>
                  <span className="text-fg-muted">{member.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked.length > 0 && (
          <ul aria-label="To share with" className="flex flex-wrap gap-1">
            {picked.map((member) => (
              <li
                key={member.id}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg-subtle pr-0.5 pl-2 text-dense"
              >
                {member.name}
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => setPicked((list) => list.filter((m) => m.id !== member.id))}
                  className="grid size-6 place-items-center rounded-sm text-fg-muted hover:tint-hover"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-start gap-1">
        <Checkbox
          id={linkId}
          checked={link}
          disabled={walled}
          onCheckedChange={(checked) => setLink(checked === true)}
        />
        <label htmlFor={linkId} className="grid pt-0.5 text-ui">
          Anyone in the workspace with the link
          {walled && (
            <span className="text-caption text-fg-muted">
              Not available: this thread sits behind an ethical wall.
            </span>
          )}
        </label>
      </div>
      <Button
        type="submit"
        disabled={busy || (picked.length === 0 && !link)}
        className="justify-self-start"
      >
        Share
      </Button>
      {rejected.length > 0 && (
        <div role="alert" className="grid gap-1 rounded-md border border-border p-2">
          <StatusText tone="flagged">Not shared with everyone</StatusText>
          <ul className="grid gap-0.5 text-dense">
            {rejected.map((r) => (
              <li key={r.name} className="flex items-center gap-1">
                <ShieldAlert aria-hidden className="size-3.5 text-fg-muted" />
                {r.name} {REASONS[r.reason]}.
              </li>
            ))}
          </ul>
        </div>
      )}
      <section aria-label="Shared with" className="grid gap-1">
        <h3 className="text-dense font-semibold">Shared with</h3>
        {shares.length === 0 ? (
          <p className="text-dense text-fg-muted">Only you can see this thread.</p>
        ) : (
          <ul className="grid gap-0.5">
            {shares.map((share) => (
              <li key={share.id} className="flex h-8 items-center gap-2 text-dense">
                {share.kind === "link" && <Link2 aria-hidden className="size-4 text-fg-muted" />}
                <span className="truncate">{share.label}</span>
                <Button
                  variant="quiet"
                  size="sm"
                  className="ml-auto"
                  onClick={() => onRevoke(share)}
                  aria-label={`Stop sharing with ${share.label}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </form>
  );
}

export function ShareFormSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-8 w-20" />
    </div>
  );
}
