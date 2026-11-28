import type { SsoInput, SsoSettings } from "@legallabs/contracts";
import { request, send } from "../http.js";

export const identityApi = {
  get: () => request<SsoSettings>("/admin/identity/sso"),
  save: (input: SsoInput) => send<SsoSettings>("PUT", "/admin/identity/sso", input),
};
