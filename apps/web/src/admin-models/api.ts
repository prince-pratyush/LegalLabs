import type {
  Connector,
  ConnectorInput,
  DiscoverResult,
  LocalEndpointInput,
  ModelConfig,
  ModelConfigPatch,
  ModelList,
  ModelPolicy,
  ToolPolicy,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

export type {
  Connector,
  ConnectorInput,
  ConnectorTool,
  DiscoverResult,
  LocalEndpointInput,
  ModelConfig,
  ModelConfigPatch,
  ModelList,
  ModelPolicy,
  ToolPolicy,
} from "@legallabs/contracts";

export interface Role {
  id: string;
  name: string;
}

const enc = encodeURIComponent;
const modelPath = (m: Pick<ModelConfig, "provider" | "model">) =>
  `/admin/models/${enc(m.provider)}/${enc(m.model)}`;

export const modelsApi = {
  list: () => request<ModelList>("/admin/models"),
  roles: async () => (await request<{ items: Role[] }>("/admin/roles")).items,
  patch: (m: Pick<ModelConfig, "provider" | "model">, patch: ModelConfigPatch) =>
    send<ModelConfig>("PATCH", modelPath(m), patch),
  saveKey: (m: Pick<ModelConfig, "provider" | "model">, key: string) =>
    send<ModelConfig>("PUT", `${modelPath(m)}/key`, { key }),
  removeKey: (m: Pick<ModelConfig, "provider" | "model">) =>
    send<ModelConfig>("DELETE", `${modelPath(m)}/key`),
  addLocal: (input: LocalEndpointInput) => send<ModelConfig>("POST", "/admin/models/local", input),
  test: (m: Pick<ModelConfig, "provider" | "model">) =>
    send<{ ok: boolean; message: string }>("POST", `${modelPath(m)}/test`),
  savePolicy: (policy: ModelPolicy) => send<ModelPolicy>("PUT", "/admin/model-policy", policy),
};

export const connectorsApi = {
  list: async () => (await request<{ items: Connector[] }>("/admin/connectors")).items,
  create: (input: ConnectorInput) => send<Connector>("POST", "/admin/connectors", input),
  discover: (id: string) => send<DiscoverResult>("POST", `/admin/connectors/${enc(id)}/discover`),
  setPolicy: (id: string, tool: string, policy: ToolPolicy) =>
    send<Connector>("PUT", `/admin/connectors/${enc(id)}/tools/${enc(tool)}/policy`, { policy }),
  approve: (id: string) => send<Connector>("POST", `/admin/connectors/${enc(id)}/approve`),
  disable: (id: string) => send<Connector>("POST", `/admin/connectors/${enc(id)}/disable`),
  setMyPolicy: (id: string, tool: string, policy: "ask_user" | "block") =>
    send<Connector>("PUT", `/connectors/${enc(id)}/tools/${enc(tool)}/my-policy`, { policy }),
};
