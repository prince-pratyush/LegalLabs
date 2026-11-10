import { parentPort } from "node:worker_threads";

const hoard = [];
for (let i = 0; i < 20; i++) {
  hoard.push(new Uint8Array(32 * 1024 * 1024).fill(1));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
parentPort.postMessage(hoard.length);
