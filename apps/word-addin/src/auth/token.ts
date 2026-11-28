import { createTokenStore } from "@legallabs/addin";

// Office keeps each add-in's storage apart, so the token is visible only to this pane.
export const tokenStore = createTokenStore("legallabs.addin.token");
