import { startTestDatabase } from "@legallabs/db/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const { url, stop } = await startTestDatabase();
  project.provide("databaseUrl", url);
  return stop;
}
