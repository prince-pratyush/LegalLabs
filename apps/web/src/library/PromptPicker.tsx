import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  PromptFill,
} from "@legallabs/ui";
import { BookMarked } from "lucide-react";
import { useState } from "react";
import { messageOf } from "../vaults/shared.js";
import { libraryApi, type Prompt } from "./api.js";
import { libraryHash } from "./route.js";

/** Puts a saved prompt into the composer, asking for its blanks first. */
export function PromptPicker({ onPick }: { onPick: (text: string) => void }) {
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState<Prompt | null>(null);

  const load = (open: boolean) => {
    if (!open) return;
    libraryApi.prompts().then(setPrompts, (err) => setError(messageOf(err)));
  };

  return (
    <>
      <Menu onOpenChange={load}>
        <MenuTrigger asChild>
          <Button type="button" variant="quiet">
            <BookMarked aria-hidden /> Saved prompts
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>
            {error ??
              (prompts === null ? "Loading…" : prompts.length ? "Your Library" : "None yet")}
          </MenuLabel>
          {prompts?.slice(0, 20).map((p) => (
            <MenuItem
              key={p.id}
              onSelect={() => (p.variables.length ? setFilling(p) : onPick(p.text))}
            >
              {p.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              window.location.hash = libraryHash("prompts");
            }}
          >
            Open the Library
          </MenuItem>
        </MenuContent>
      </Menu>
      {filling && (
        <section
          aria-label={`Fill in ${filling.name}`}
          className="w-full rounded-md border border-border p-4"
        >
          <PromptFill
            text={filling.text}
            onUse={(text) => {
              onPick(text);
              setFilling(null);
            }}
            onCancel={() => setFilling(null)}
          />
        </section>
      )}
    </>
  );
}
