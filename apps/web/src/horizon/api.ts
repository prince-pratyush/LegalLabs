import type {
  HorizonBulk,
  HorizonItem,
  HorizonItemState,
  HorizonScan,
  HorizonScanCreate,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

const e = encodeURIComponent;
const scanPath = (id: string) => `/horizon/scans/${e(id)}`;

export interface HorizonSettingsView {
  enabled: boolean;
  can_manage: boolean;
  can_create: boolean;
}

export interface ItemFilter {
  tab: "all" | "unread" | "starred" | "archived";
  relevance: string;
  type: string;
  source: string;
  jurisdiction: string;
  topic: string;
  industry: string;
  q: string;
}

export interface ItemPage {
  items: HorizonItem[];
  next_cursor: string | null;
}

export const horizonApi = {
  settings: () => request<HorizonSettingsView>("/horizon/settings"),
  setEnabled: (enabled: boolean) =>
    send<{ enabled: boolean }>("PUT", "/horizon/settings", { enabled }),
  scans: async () => (await request<{ scans: HorizonScan[] }>("/horizon/scans")).scans,
  scan: async (id: string) => (await request<{ scan: HorizonScan }>(scanPath(id))).scan,
  create: async (scan: HorizonScanCreate) =>
    (await send<{ scan: HorizonScan }>("POST", "/horizon/scans", scan)).scan,
  update: async (id: string, scan: HorizonScanCreate) =>
    (await send<{ scan: HorizonScan }>("PATCH", scanPath(id), scan)).scan,
  remove: (id: string) => send<void>("DELETE", scanPath(id)),
  items: (id: string, filter: ItemFilter, cursor?: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value) query.set(key, value);
    }
    if (cursor) query.set("cursor", cursor);
    return request<ItemPage>(`${scanPath(id)}/items?${query}`);
  },
  setState: (itemId: string, state: Partial<HorizonItemState>) =>
    send<void>("PATCH", `/horizon/items/${e(itemId)}/state`, state),
  saveToVault: (itemId: string, vaultId: string) =>
    send<{ document_id: string }>("POST", `/horizon/items/${e(itemId)}/save-to-vault`, {
      vault_id: vaultId,
    }),
  ask: (itemId: string) =>
    send<{ thread_id: string; document_id: string }>("POST", `/horizon/items/${e(itemId)}/ask`, {}),
  draftEmail: (itemId: string) =>
    send<{ thread_id: string; draft_id: string }>(
      "POST",
      `/horizon/items/${e(itemId)}/draft-email`,
      {},
    ),
  bulk: (ids: string[], action: HorizonBulk["action"]) =>
    send<{ changed: number }>("POST", "/horizon/items/bulk", { ids, action }),
};
