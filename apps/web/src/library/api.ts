import type { LibraryGrant } from "@legallabs/contracts";
import { ApiError } from "../api.js";

export type Access = "owner" | "manage" | "edit" | "use";

export interface Prompt {
  id: string;
  name: string;
  description: string | null;
  text: string;
  variables: string[];
  owner: { id: string; name: string };
  access: Access;
  shared: boolean;
  updated_at: string;
}

export interface TemplateVersion {
  no: number;
  file_name: string;
  size: number;
  placeholders: string[];
  note: string | null;
  reverted_from: number | null;
  created_at: string;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  is_default: boolean;
  owner: { id: string; name: string };
  access: Access;
  shared: boolean;
  current: TemplateVersion;
  updated_at: string;
}

export interface Share {
  principal_type: LibraryGrant["principal_type"];
  principal_id: string;
  label: string;
  level: LibraryGrant["level"];
}

export type Kind = "prompt" | "template";

const FALLBACK = "Something went wrong. Try again.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(`/api/v1/library${path}`, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body?.code ?? "UNKNOWN"),
      typeof body?.message === "string" ? body.message : FALLBACK,
    );
  }
  return body as T;
}

const send = <T>(method: string, path: string, body: unknown) =>
  call<T>(path, { method, body: JSON.stringify(body) });
const item = (kind: Kind, id: string) => `/${kind}s/${encodeURIComponent(id)}`;

export const libraryApi = {
  abilities: () => call<{ manage: boolean; draft: boolean }>("/abilities"),
  prompts: async () => (await call<{ prompts: Prompt[] }>("/prompts")).prompts,
  createPrompt: async (input: { name: string; text: string; description?: string }) =>
    (await send<{ prompt: Prompt }>("POST", "/prompts", input)).prompt,
  updatePrompt: async (id: string, patch: { name?: string; text?: string; description?: string }) =>
    (await send<{ prompt: Prompt }>("PATCH", item("prompt", id), patch)).prompt,
  deletePrompt: (id: string) => call<null>(item("prompt", id), { method: "DELETE" }),

  templates: async () => (await call<{ templates: Template[] }>("/templates")).templates,
  uploadTemplate: async (file: File, name: string) => {
    const form = new FormData();
    form.set("file", file);
    if (name.trim()) form.set("name", name.trim());
    return (await call<{ template: Template }>("/templates", { method: "POST", body: form }))
      .template;
  },
  addVersion: async (id: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return (
      await call<{ template: Template }>(`${item("template", id)}/versions`, {
        method: "POST",
        body: form,
      })
    ).template;
  },
  setDefault: async (id: string, on: boolean) =>
    (await send<{ template: Template }>("PUT", `${item("template", id)}/default`, { on })).template,
  deleteTemplate: (id: string) => call<null>(item("template", id), { method: "DELETE" }),
  /** A link the browser downloads; the session cookie goes with it. */
  sampleUrl: (id: string, format: "docx" | "pdf") =>
    `/api/v1/library${item("template", id)}/sample?format=${format}`,

  shares: async (kind: Kind, id: string) =>
    (await call<{ shares: Share[] }>(`${item(kind, id)}/shares`)).shares,
  setShares: async (kind: Kind, id: string, grants: LibraryGrant[]) =>
    (await send<{ shares: Share[] }>("PUT", `${item(kind, id)}/shares`, { grants })).shares,
  principals: async (q: string) =>
    (await call<{ principals: Omit<Share, "level">[] }>(`/principals?q=${encodeURIComponent(q)}`))
      .principals,
};
