/* eslint-disable no-console -- dev-only CLI harness; console IS the output here */
// Dev-only enrichment-queue harness (NOT shipped, NOT an HTTP route).
//
// Puts a single { submissionId } message on the local `dib-enrichment` queue so
// the `queue` handler in src/worker.ts can be exercised without S-01 (the form).
//
// Recipe:
//   1. Terminal A:  npx wrangler dev          # runs the Worker + local queue consumer
//   2. Terminal B:  node scripts/enqueue-test.mjs <submission-uuid>
//
// getPlatformProxy() backs the QUEUE producer binding with the same local
// Miniflare state (.wrangler/state) that `wrangler dev` consumes from, so the
// message is delivered to the running consumer. `astro dev` does NOT run queue
// consumers — use `wrangler dev`.

import { getPlatformProxy } from "wrangler";

const submissionId = process.argv[2];
if (!submissionId) {
  console.error("usage: node scripts/enqueue-test.mjs <submission-uuid>");
  process.exit(1);
}

const { env, dispose } = await getPlatformProxy();
await env.QUEUE.send({ submissionId });
console.log(`enqueued { submissionId: "${submissionId}" } on dib-enrichment`);
await dispose();
