import { parentPort, workerData } from "node:worker_threads";
import { processFile } from "./process.js";

const { bytes, name } = workerData as { bytes: Uint8Array; name: string };
parentPort?.postMessage(await processFile(bytes, name));
