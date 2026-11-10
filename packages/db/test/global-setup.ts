import type { TestProject } from "vitest/node";
import { startTestDatabase } from "../src/testing.js";

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
