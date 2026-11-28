import type {
  Group,
  Invitation,
  InviteResult,
  InviteUsers,
  ManagedUser,
  Role,
  UserDirectory,
  UserPatch,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

const enc = encodeURIComponent;
const items = async <T>(path: string) => (await request<{ items: T[] }>(path)).items;

export const usersApi = {
  load: async () => {
    const [directory, roles, groups] = await Promise.all([
      request<UserDirectory>("/admin/users"),
      items<Role>("/admin/roles"),
      items<Group>("/admin/groups"),
    ]);
    return { directory, roles, groups };
  },
  invite: (input: InviteUsers) => send<InviteResult>("POST", "/admin/users/invite", input),
  resend: (id: string) => send<Invitation>("POST", `/admin/users/${enc(id)}/invite`),
  update: (id: string, patch: UserPatch) =>
    send<ManagedUser>("PATCH", `/admin/users/${enc(id)}`, patch),
  createGroup: (name: string) => send<Group>("POST", "/admin/groups", { name }),
};
