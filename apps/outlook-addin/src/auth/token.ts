import { createTokenStore } from "@legallabs/addin";

// Its own key: the panes are served from one origin.
export const tokenStore = createTokenStore("legallabs.outlook.token");
