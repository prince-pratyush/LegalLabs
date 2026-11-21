import type { TaskRunPort } from "@legallabs/contracts";
import type pg from "pg";
import { createSpaces, type Spaces, type SpacesOptions } from "./spaces.js";
import { createTasks, type Tasks } from "./tasks.js";
import { createTemplates, type Templates } from "./templates.js";

export interface SpaceModule {
  spaces: Spaces;
  tasks: Tasks;
  templates: Templates;
}

export interface SpaceModuleOptions extends SpacesOptions {
  /** Starts, reads and cancels the runs behind tasks given to the assistant or an agent. */
  runs: TaskRunPort;
  now?: () => number;
}

/** Spaces, their tasks and their templates, sharing one set of audit and notification plumbing. */
export function createSpaceModule(pool: pg.Pool, options: SpaceModuleOptions): SpaceModule {
  const spaces = createSpaces(pool, options);
  return {
    spaces,
    tasks: createTasks(spaces.kit, spaces.catalog, {
      runs: options.runs,
      ...(options.now ? { now: options.now } : {}),
    }),
    templates: createTemplates(spaces.kit, spaces.catalog),
  };
}
