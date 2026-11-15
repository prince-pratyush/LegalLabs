import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Shared CI machines are slow; a second is too short to wait for a re-render there.
configure({ asyncUtilTimeout: 5_000 });
afterEach(cleanup);
