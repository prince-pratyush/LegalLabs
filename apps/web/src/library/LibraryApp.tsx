import {
  AppShell,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  type LibraryEntry,
  LibraryList,
  LibraryListSkeleton,
  type LibraryShare,
  LibraryShareForm,
  LibraryShareFormSkeleton,
  PromptFill,
  SidePanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@legallabs/ui";
import { BookOpen, FileText, Workflow } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useHash } from "../vaults/route.js";
import { formatBytes, formatDate, messageOf } from "../vaults/shared.js";
import { type Kind, libraryApi, type Prompt, type Share, type Template } from "./api.js";
import { sendToComposer } from "./prefill.js";
import { type LibraryTab, libraryHash, parseLibraryRoute } from "./route.js";

type Panel =
  | { kind: "use"; prompt: Prompt }
  | { kind: "edit"; prompt: Prompt | null }
  | { kind: "share"; item: Kind; id: string; name: string }
  | { kind: "upload" };

const toShare = (s: Share): LibraryShare => ({
  principalType: s.principal_type,
  principalId: s.principal_id,
  label: s.label,
  level: s.level,
});

/** Saved prompts and firm templates, with links out to playbooks and workflows. */
export function LibraryApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseLibraryRoute(useHash())?.tab ?? "prompts";
  const [abilities, setAbilities] = useState({ manage: false, draft: false });
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [width, setWidth] = useState(440);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ item: Kind; id: string; name: string } | null>(null);
  const versionPicker = useRef<HTMLInputElement>(null);
  const [versionFor, setVersionFor] = useState<string | null>(null);

  const refresh = useCallback(() => {
    libraryApi.prompts().then(setPrompts, (err) => setError(messageOf(err)));
    libraryApi.templates().then(setTemplates, (err) => setError(messageOf(err)));
  }, []);
  useEffect(() => {
    libraryApi.abilities().then(setAbilities, () => {});
    refresh();
  }, [refresh]);

  const fail = (err: unknown) => toast.error(messageOf(err));
  const setTab = (next: string) => {
    window.location.hash = libraryHash(next as LibraryTab);
  };

  const promptEntry = (p: Prompt): LibraryEntry => ({
    id: p.id,
    name: p.name,
    description: p.description,
    meta: `${p.owner.name} · updated ${formatDate(p.updated_at)}`,
    badges: [
      ...(p.variables.length ? [`${p.variables.length} blanks`] : []),
      ...(p.shared ? ["Shared"] : []),
      ...(p.access === "use" ? ["Shared with you"] : []),
    ],
    actions: [
      { label: "Use", primary: true, onClick: () => setPanel({ kind: "use", prompt: p }) },
      ...(p.access !== "use"
        ? [{ label: "Edit", onClick: () => setPanel({ kind: "edit", prompt: p }) }]
        : []),
      ...(p.access === "owner" || p.access === "manage"
        ? [
            {
              label: "Share",
              onClick: () => setPanel({ kind: "share", item: "prompt", id: p.id, name: p.name }),
            },
            {
              label: "Delete",
              onClick: () => setRemoving({ item: "prompt", id: p.id, name: p.name }),
            },
          ]
        : []),
    ],
  });

  const templateEntry = (t: Template): LibraryEntry => ({
    id: t.id,
    name: t.name,
    description: t.description,
    meta: `Version ${t.current.no} · ${t.current.file_name} · ${formatBytes(t.current.size)}`,
    badges: [
      ...(t.is_default ? ["Default"] : []),
      ...(t.current.placeholders.length ? [`${t.current.placeholders.length} placeholders`] : []),
    ],
    actions: [
      { label: "Preview PDF", onClick: () => window.open(libraryApi.sampleUrl(t.id, "pdf")) },
      { label: "Sample .docx", onClick: () => window.open(libraryApi.sampleUrl(t.id, "docx")) },
      ...(t.access !== "use"
        ? [
            {
              label: "New version",
              onClick: () => {
                setVersionFor(t.id);
                versionPicker.current?.click();
              },
            },
          ]
        : []),
      ...(abilities.manage
        ? [
            {
              label: t.is_default ? "Stop using as default" : "Use for every export",
              onClick: () =>
                libraryApi.setDefault(t.id, !t.is_default).then(() => {
                  toast.success(
                    t.is_default ? "No default template now." : `Exports now use ${t.name}.`,
                  );
                  refresh();
                }, fail),
            },
          ]
        : []),
      ...(t.access === "owner" || t.access === "manage"
        ? [
            {
              label: "Share",
              onClick: () => setPanel({ kind: "share", item: "template", id: t.id, name: t.name }),
            },
            {
              label: "Delete",
              onClick: () => setRemoving({ item: "template", id: t.id, name: t.name }),
            },
          ]
        : []),
    ],
  });

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Library"
      commands={[
        {
          id: "new-prompt",
          kind: "action",
          group: "Library",
          label: "New prompt",
          run: () => setPanel({ kind: "edit", prompt: null }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <p className="text-dense text-fg-muted">
            Reusable prompts and your firm's document templates, shared with the people who need
            them.
          </p>
        </div>
      }
      panel={
        panel && (
          <SidePanel
            title={panelTitle(panel)}
            width={width}
            onWidthChange={setWidth}
            onClose={() => setPanel(null)}
          >
            {panel.kind === "use" && (
              <PromptFill
                text={panel.prompt.text}
                onUse={(text) => sendToComposer(text)}
                onCancel={() => setPanel(null)}
              />
            )}
            {panel.kind === "edit" && (
              <PromptEditor
                prompt={panel.prompt}
                onSaved={() => {
                  setPanel(null);
                  refresh();
                }}
              />
            )}
            {panel.kind === "share" && (
              <SharePanel
                item={panel.item}
                id={panel.id}
                canShareWorkspace={abilities.manage}
                onChanged={refresh}
              />
            )}
            {panel.kind === "upload" && (
              <TemplateUpload
                onSaved={() => {
                  setPanel(null);
                  refresh();
                }}
              />
            )}
          </SidePanel>
        )
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-title font-semibold">Library</h1>
          <div className="ml-auto flex gap-2">
            {abilities.draft && (
              <Button onClick={() => setPanel({ kind: "edit", prompt: null })}>New prompt</Button>
            )}
            {abilities.manage && (
              <Button variant="quiet" onClick={() => setPanel({ kind: "upload" })}>
                Upload template
              </Button>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="mb-4 text-destructive">
            {error}
          </p>
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="playbooks">Playbooks</TabsTrigger>
            <TabsTrigger value="workflows">Workflows</TabsTrigger>
          </TabsList>
          <TabsContent value="prompts">
            {prompts === null ? (
              <LibraryListSkeleton />
            ) : (
              <LibraryList
                label="Saved prompts"
                entries={prompts.map(promptEntry)}
                empty={{
                  icon: FileText,
                  title: "No saved prompts yet",
                  description:
                    "Save a prompt you use often. Put {{blanks}} where the details change, and fill them in each time you use it.",
                  action: {
                    label: "New prompt",
                    onClick: () => setPanel({ kind: "edit", prompt: null }),
                  },
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="templates">
            {templates === null ? (
              <LibraryListSkeleton />
            ) : (
              <LibraryList
                label="Firm templates"
                entries={templates.map(templateEntry)}
                empty={{
                  icon: BookOpen,
                  title: "No firm templates yet",
                  description: abilities.manage
                    ? "Upload your firm's Word template. Exported drafts then keep its fonts, headings, numbering, header and footer."
                    : "A Library manager can upload the firm's Word template. Until then, exports use a plain layout.",
                  action: abilities.manage
                    ? { label: "Upload template", onClick: () => setPanel({ kind: "upload" }) }
                    : { label: "Back to prompts", onClick: () => setTab("prompts") },
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="playbooks">
            <EmptyState
              icon={BookOpen}
              title="Playbooks have their own page"
              description="Your negotiation playbooks, and reviews run against them, live in Playbooks."
              action={{
                label: "Open Playbooks",
                onClick: () => {
                  window.location.hash = "#/playbooks";
                },
              }}
            />
          </TabsContent>
          <TabsContent value="workflows">
            <EmptyState
              icon={Workflow}
              title="Workflows are coming"
              description="Multi-step workflows arrive in a later release. Until then, a saved prompt with blanks covers most repeat tasks."
              action={{ label: "Go to prompts", onClick: () => setTab("prompts") }}
            />
          </TabsContent>
        </Tabs>
        <input
          ref={versionPicker}
          type="file"
          accept=".docx,.dotx"
          hidden
          aria-label="Choose a new template version"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file || !versionFor) return;
            libraryApi.addVersion(versionFor, file).then((t) => {
              toast.success(`${t.name} is now version ${t.current.no}.`);
              refresh();
            }, fail);
          }}
        />
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Delete ${removing?.name ?? ""}?`}
          description="People it was shared with lose it too. Threads and exports already made keep their own copy."
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            if (!removing) return;
            const gone =
              removing.item === "prompt"
                ? libraryApi.deletePrompt(removing.id)
                : libraryApi.deleteTemplate(removing.id);
            gone.then(refresh, fail);
            setRemoving(null);
          }}
        />
      </main>
    </AppShell>
  );
}

const panelTitle = (panel: Panel) => {
  switch (panel.kind) {
    case "use":
      return panel.prompt.name;
    case "edit":
      return panel.prompt ? "Edit prompt" : "New prompt";
    case "share":
      return `Share ${panel.name}`;
    case "upload":
      return "Upload a firm template";
  }
};

function PromptEditor({ prompt, onSaved }: { prompt: Prompt | null; onSaved: () => void }) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [description, setDescription] = useState(prompt?.description ?? "");
  const [text, setText] = useState(prompt?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { name, text, description };
      if (prompt) await libraryApi.updatePrompt(prompt.id, input);
      else await libraryApi.createPrompt(input);
      toast.success(prompt ? "Prompt saved." : "Prompt added to the Library.");
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-4" onSubmit={save}>
      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
          />
        )}
      </Field>
      <Field label="Description (optional)">
        {(props) => (
          <Input
            {...props}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        )}
      </Field>
      <Field
        label="Prompt"
        hint="Put {{blanks}} around details that change, like {{counterparty}}."
      >
        {(props) => (
          <Textarea
            {...props}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={8000}
            rows={10}
            required
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !name.trim() || !text.trim()}>
        {busy ? "Saving…" : "Save prompt"}
      </Button>
    </form>
  );
}

function SharePanel({
  item,
  id,
  canShareWorkspace,
  onChanged,
}: {
  item: Kind;
  id: string;
  canShareWorkspace: boolean;
  onChanged: () => void;
}) {
  const [shares, setShares] = useState<LibraryShare[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    libraryApi.shares(item, id).then(
      (next) => setShares(next.map(toShare)),
      (err) => setError(messageOf(err)),
    );
    fetch("/auth/session", { credentials: "same-origin" })
      .then((res) => res.json() as Promise<{ workspace_id?: string }>)
      .then(
        (s) => setWorkspaceId(s.workspace_id ?? ""),
        () => {},
      );
  }, [item, id]);
  const search = useCallback(
    async (q: string) =>
      (await libraryApi.principals(q)).map((p) => ({
        principalType: p.principal_type,
        principalId: p.principal_id,
        label: p.label,
      })),
    [],
  );
  if (shares === null) return error ? <p role="alert">{error}</p> : <LibraryShareFormSkeleton />;
  return (
    <LibraryShareForm
      shares={shares}
      workspace={{ principalType: "workspace", principalId: workspaceId, label: "Everyone" }}
      canShareWorkspace={canShareWorkspace && workspaceId !== ""}
      search={search}
      error={error}
      onChange={(next) => {
        setError(null);
        libraryApi
          .setShares(
            item,
            id,
            next.map((s) => ({
              principal_type: s.principalType,
              principal_id: s.principalId,
              level: s.level,
            })),
          )
          .then(
            (saved) => {
              setShares(saved.map(toShare));
              onChanged();
            },
            (err) => setError(messageOf(err)),
          );
      }}
    />
  );
}

function TemplateUpload({ onSaved }: { onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const t = await libraryApi.uploadTemplate(file, name);
      toast.success(
        t.current.placeholders.length
          ? `${t.name} added. It has ${t.current.placeholders.length} placeholders to fill.`
          : `${t.name} added.`,
      );
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-4" onSubmit={save}>
      <p className="text-dense text-fg-muted">
        A .docx or .dotx up to 10 MB. Its fonts, heading and list styles, header, footer and page
        setup are used for every draft exported through it. Put {"{{content}}"} on its own line
        where the draft goes and {"{{title}}"} for the title; without them the body is replaced.
      </p>
      <Field label="Word file">
        {(props) => (
          <Input
            {...props}
            type="file"
            accept=".docx,.dotx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        )}
      </Field>
      <Field label="Name (optional)">
        {(props) => (
          <Input
            {...props}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !file}>
        {busy ? "Uploading…" : "Upload template"}
      </Button>
    </form>
  );
}
