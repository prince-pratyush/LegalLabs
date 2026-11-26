import { Button, Field, Input } from "@legallabs/ui";
import { useRef, useState } from "react";
import { messageOf } from "../api.js";
import { latestOnly } from "../latest.js";
import { libraryApi } from "../library/api.js";

export interface Picked {
  type: "user" | "group";
  id: string;
  name: string;
}

const WANTED = { user: "a person", group: "a group", both: "a person or group" };

/** Finds a person or group by part of an email address or group name. */
export function PrincipalPicker({
  kinds,
  onPick,
}: {
  kinds: "user" | "group" | "both";
  onPick: (picked: Picked) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Picked[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useRef(latestOnly(libraryApi.principals)).current;

  const look = async (next: string) => {
    setQuery(next);
    setError(null);
    // The server asks for two characters before it searches.
    if (next.trim().length < 2) return setFound(null);
    try {
      const result = await search(next.trim());
      if (!result.current) return;
      setFound(
        result.value.flatMap((p): Picked[] =>
          p.principal_type !== "workspace" && (kinds === "both" || p.principal_type === kinds)
            ? [{ type: p.principal_type, id: p.principal_id, name: p.label }]
            : [],
        ),
      );
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <div className="grid gap-1">
      <Field label={`Find ${WANTED[kinds]}`} {...(error ? { error } : {})}>
        {(props) => <Input {...props} value={query} onChange={(e) => look(e.target.value)} />}
      </Field>
      {found?.length === 0 && <p className="text-caption text-fg-muted">No one found.</p>}
      {found && found.length > 0 && (
        <ul className="grid justify-items-start">
          {found.map((p) => (
            <li key={p.id}>
              <Button variant="quiet" size="sm" onClick={() => onPick(p)}>
                {p.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
