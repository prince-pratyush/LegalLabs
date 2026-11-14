import type { KnowledgePort, VaultPort } from "@legallabs/contracts";

// Stand-ins until the vault and knowledge work lands: nothing to list, nothing found.
export const noVaults: VaultPort = {
  list: async () => [],
  documentIds: async () => [],
};

export const noKnowledge: KnowledgePort = {
  list: async () => [],
  search: async () => [],
};
