#!/usr/bin/env node
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/worker.mjs [options]

Options:
  -h, --help  Show this help message and exit

Runs the Trustbridge queue worker. TypeScript modules are loaded via jiti.`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is required to run worker.mjs");
  process.exit(1);
}

const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: {
    "@": fileURLToPath(new URL("../src", import.meta.url)),
  },
});

const { runWorker } = await jiti.import("../src/lib/queue-worker.ts");
const { processSorobanOutbox } = await jiti.import(
  "../src/lib/soroban-outbox-worker.ts",
);

const OUTBOX_INTERVAL_MS = Number(
  process.env.SOROBAN_OUTBOX_INTERVAL_MS ?? 15_000,
);

let outboxTimer = null;
let outboxRunning = false;

async function runOutboxTick() {
  if (outboxRunning) return;
  outboxRunning = true;
  try {
    await processSorobanOutbox();
  } catch (err) {
    console.error("Soroban outbox tick failed:", err);
  } finally {
    outboxRunning = false;
  }
}

function startOutboxLoop() {
  if (outboxTimer) return;
  outboxTimer = setInterval(runOutboxTick, OUTBOX_INTERVAL_MS);
  if (typeof outboxTimer.unref === "function") outboxTimer.unref();
  void runOutboxTick();
}

function stopOutboxLoop() {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}

function shutdown(signal) {
  console.log(`Received ${signal}, stopping worker...`);
  stopOutboxLoop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startOutboxLoop();

runWorker().catch((err) => {
  console.error("Fatal worker error:", err);
  stopOutboxLoop();
  process.exit(1);
});
