import fs from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { v4 as uuidv4 } from "uuid";

import { config } from "./config.js";
import { ensureStorageDirs, getPaths, saveUploadedFile } from "./storage.js";
import { getJob, setJob, updateJob } from "./job-store.js";
import { processPdf } from "./processor.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.corsOrigin });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
await ensureStorageDirs(config.storageRoot);

app.get("/health", async () => ({ ok: true }));

app.post("/v1/jobs", async (request, reply) => {
  const format = String(request.query?.format || "style_a");
  const allowedFormats = new Set(["style_a", "style_b", "style_c"]);
  if (!allowedFormats.has(format)) {
    return reply.code(400).send({ error: "Invalid format. Use style_a, style_b, or style_c." });
  }

  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: "Missing file" });
  }

  const contentType = file.mimetype || "";
  if (!contentType.includes("pdf")) {
    return reply.code(400).send({ error: "Only PDF uploads are allowed" });
  }

  const jobId = uuidv4();
  const paths = getPaths(config.storageRoot, jobId);

  await saveUploadedFile(file, paths.inputPath);

  const now = new Date().toISOString();
  setJob(jobId, {
    jobId,
    status: "processing",
    progress: "10",
    pagesProcessed: "0",
    pagesTotal: "0",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    error: ""
  });

  // Process synchronously (no Redis queue needed)
  try {
    const result = await processPdf({
      jobId,
      inputPath: paths.inputPath,
      outputPath: paths.outputPath,
      auditPath: paths.auditPath,
      settings: {
        autoThreshold: Number(process.env.MATCH_AUTO_THRESHOLD || config.autoThreshold),
        reviewThreshold: Number(process.env.MATCH_REVIEW_THRESHOLD || config.reviewThreshold),
        formatKey: format,
        mode: "overlay",
        roi: "top_right",
        aggressiveHeaderStrip: false
      }
    });

    const shouldReview = result.hasReview || Number(result.removedCount || 0) === 0;

    updateJob(jobId, {
      status: shouldReview ? "needs_review" : "completed",
      progress: String(result.progress),
      pagesProcessed: String(result.pagesProcessed),
      pagesTotal: String(result.pagesTotal),
      finishedAt: new Date().toISOString()
    });

    return reply.code(200).send({
      jobId,
      status: shouldReview ? "needs_review" : "completed"
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      progress: "100",
      error: error instanceof Error ? error.message : "Unknown error",
      finishedAt: new Date().toISOString()
    });

    app.log.error(error);
    return reply.code(500).send({
      jobId,
      status: "failed",
      error: error instanceof Error ? error.message : "Processing failed"
    });
  }
});

app.get("/v1/jobs/:jobId", async (request, reply) => {
  const { jobId } = request.params;
  const job = getJob(jobId);

  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }

  return reply.send(job);
});

app.get("/v1/jobs/:jobId/download", async (request, reply) => {
  const { jobId } = request.params;
  const job = getJob(jobId);

  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }

  if (!["completed", "needs_review"].includes(job.status)) {
    return reply.code(409).send({ error: `Job status is ${job.status}` });
  }

  const { outputPath } = getPaths(config.storageRoot, jobId);
  try {
    await fs.access(outputPath);
  } catch {
    return reply.code(404).send({ error: "Output file not found" });
  }

  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `attachment; filename=cleaned-${jobId}.pdf`);
  return reply.send(await fs.readFile(outputPath));
});

app.get("/v1/jobs/:jobId/audit", async (request, reply) => {
  const { jobId } = request.params;
  const { auditPath } = getPaths(config.storageRoot, jobId);

  try {
    const audit = await fs.readFile(auditPath, "utf-8");
    reply.header("Content-Type", "application/json");
    return reply.send(JSON.parse(audit));
  } catch {
    return reply.code(404).send({ error: "Audit not found" });
  }
});

app.listen({ port: config.apiPort, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
