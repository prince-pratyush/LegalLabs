import { parentPort } from "node:worker_threads";

parentPort.postMessage(Object.keys(process.env));
