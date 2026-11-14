import { Command } from "cmdk";
import { Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { formatKeys, KEYMAP } from "../shortcuts.js";
import { Kbd } from "./tooltip.js";

export type PaletteCommand = {
  id: string;
  label: string;
  /** Objects are found by name; actions are listed after typing ">". */
  kind: "object" | "action";
  group: string;
  keywords?: readonly string[];
  shortcut?: string;
  run: () => void;
};

type Mode = "objects" | "actions" | "help";

const modeOf = (search: string): Mode =>
  search.startsWith(">") ? "actions" : search.startsWith("?") ? "help" : "objects";

const termOf = (search: string) => search.replace(/^[>?]\s*/, "").toLowerCase();

const found = (command: PaletteCommand, term: string) =>
  [command.label, ...(command.keywords ?? [])].some((text) => text.toLowerCase().includes(term));

/**
 * ⌘K reaches everything by name; ">" switches to actions and "?" lists shortcuts.
 * Focus is trapped here because the palette sits above everything else.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  initialSearch = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly PaletteCommand[];
  initialSearch?: string;
}) {
  const [search, setSearch] = useState(initialSearch);
  const mode = modeOf(search);
  const term = termOf(search);
  const shown = commands.filter(
    (command) =>
      (mode === "actions" ? command.kind === "action" : command.kind === "object") &&
      found(command, term),
  );
  const groups = [...new Set(shown.map((command) => command.group))];
  const help = KEYMAP.filter((entry) => entry.label.toLowerCase().includes(term));

  const close = (next: boolean) => {
    if (!next) setSearch(initialSearch);
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fg/30 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-bg-raised text-fg shadow-xl data-[state=open]:animate-pop-in"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter={false} loop label="Command palette">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 text-fg-muted" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search by name, > for actions, ? for shortcuts"
                className="h-12 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-muted focus-visible:-outline-offset-2"
              />
            </div>
            <Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto p-1">
              {mode === "help" ? (
                <Command.Group heading="Keyboard shortcuts" className={GROUP}>
                  {help.map((entry) => (
                    <Command.Item
                      key={entry.keys + entry.scope}
                      value={entry.keys + entry.scope}
                      className={ITEM}
                    >
                      <span>{entry.label}</span>
                      <span className="ml-auto text-caption text-fg-muted">{entry.scope}</span>
                      <Kbd>{formatKeys(entry.keys)}</Kbd>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : (
                <>
                  {shown.length === 0 && (
                    // A listbox needs an option, so the reason it's empty is one.
                    <Command.Item disabled value="nothing" className={ITEM}>
                      <span className="text-fg-muted">
                        Nothing matches “{term}”. Try fewer words, or type &gt; for actions.
                      </span>
                    </Command.Item>
                  )}
                  {groups.map((group) => (
                    <Command.Group key={group} heading={group} className={GROUP}>
                      {shown
                        .filter((command) => command.group === group)
                        .map((command) => (
                          <Command.Item
                            key={command.id}
                            value={command.id}
                            onSelect={() => {
                              close(false);
                              command.run();
                            }}
                            className={ITEM}
                          >
                            <span>{command.label}</span>
                            {command.shortcut && (
                              <Kbd className="ml-auto">{formatKeys(command.shortcut)}</Kbd>
                            )}
                          </Command.Item>
                        ))}
                    </Command.Group>
                  ))}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const GROUP =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted";
const ITEM =
  "flex h-9 cursor-default items-center gap-2 rounded-sm px-2 text-ui select-none data-[selected=true]:tint-selected";
