export interface MassDeleteEvent {
  type: "scim.mass_delete_paused";
  workspaceId: string;
  /** Deprovisionings in the window, counting the one that was refused. */
  count: number;
  population: number;
}

/** Tells the workspace's admins out of band. Injected so tests never reach the network. */
export interface ScimWebhook {
  notify(event: MassDeleteEvent): Promise<void>;
}

// No outbound delivery is wired yet: the pause is still audited and visible to admins.
export const noWebhook: ScimWebhook = { notify: async () => {} };
