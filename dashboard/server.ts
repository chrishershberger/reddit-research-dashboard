import express from "express";
import cors from "cors";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

import { checkEnvVars, runResearch } from "./lib/research.js";
import type { RunResult, OnProgress } from "./lib/research.js";
import {
  initStorage,
  loadConfig,
  saveConfig,
  loadRunIndex,
  loadRun,
  saveRun,
  listRunsForTopic,
  slugify,
} from "./lib/storage.js";
import type { Config, Topic } from "./lib/storage.js";
import { initScheduler, updateSchedule, getSchedulerStatus } from "./lib/scheduler.js";

// --- Env check (warn but don't exit — tokens only needed for scraping) ---
try {
  checkEnvVars();
} catch (err) {
  console.warn(`Warning: ${(err as Error).message}`);
  console.warn("The dashboard will start, but scraping will fail until tokens are set.\n");
}

// --- Job tracking ---
interface Job {
  id: string;
  topicId: string;
  topicLabel: string;
  status: "running" | "complete" | "error";
  events: Array<{ event: string; data: unknown; time: string }>;
  sseClients: Response[];
}

const activeJobs = new Map<string, Job>();

function broadcastSSE(job: Job, event: string, data: unknown) {
  const entry = { event, data, time: new Date().toISOString() };
  job.events.push(entry);
  for (const client of job.sseClients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// --- Run a topic (used by manual trigger and scheduler) ---
async function executeRun(topic: Topic, trigger: "manual" | "scheduled"): Promise<string> {
  const jobId = randomUUID();

  const job: Job = {
    id: jobId,
    topicId: topic.id,
    topicLabel: topic.label,
    status: "running",
    events: [],
    sseClients: [],
  };
  activeJobs.set(jobId, job);

  // Run async (don't await — let the caller get the jobId immediately)
  (async () => {
    const onProgress: OnProgress = (event, data) => {
      broadcastSSE(job, event, data);
    };

    const result: RunResult = await runResearch({
      topicId: topic.id,
      topicLabel: topic.label,
      searchQuery: topic.searchQuery,
      subreddits: topic.subreddits,
      maxItems: topic.maxItems,
      trigger,
      onProgress,
    });

    job.status = result.status === "complete" ? "complete" : "error";

    // Persist result
    if (result.status === "complete") {
      await saveRun(result);
    }

    // Close SSE connections
    for (const client of job.sseClients) {
      client.write(`event: done\ndata: ${JSON.stringify({ id: result.id, status: result.status })}\n\n`);
      client.end();
    }

    // Clean up after 2 minutes
    setTimeout(() => activeJobs.delete(jobId), 120_000);
  })();

  return jobId;
}

// --- Scheduler run callback ---
async function scheduledRunCallback(topic: Topic): Promise<void> {
  const jobId = await executeRun(topic, "scheduled");
  console.log(`[Scheduler] Started job ${jobId} for topic: ${topic.label}`);
}

// --- Express App ---
const app = express();
app.use(cors());
app.use(express.json());

const __dirname = decodeURIComponent(dirname(new URL(import.meta.url).pathname));
const publicDir = join(__dirname, "public");
app.use(express.static(publicDir));

// --- API: Config ---
app.get("/api/config", async (_req, res) => {
  const config = await loadConfig();
  res.json(config);
});

app.put("/api/config", async (req, res) => {
  const config = req.body as Config;
  await saveConfig(config);
  updateSchedule(config, scheduledRunCallback);
  res.json({ ok: true });
});

// --- API: Topics ---
app.post("/api/topics", async (req, res) => {
  const config = await loadConfig();
  const topic = req.body as Topic;
  topic.id = topic.id || slugify(topic.label);
  config.topics.push(topic);
  await saveConfig(config);
  res.json(topic);
});

app.put("/api/topics/:id", async (req, res) => {
  const config = await loadConfig();
  const idx = config.topics.findIndex((t) => t.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }
  config.topics[idx] = { ...config.topics[idx], ...req.body };
  await saveConfig(config);
  res.json(config.topics[idx]);
});

app.delete("/api/topics/:id", async (req, res) => {
  const config = await loadConfig();
  config.topics = config.topics.filter((t) => t.id !== req.params.id);
  await saveConfig(config);
  res.json({ ok: true });
});

// --- API: Runs ---
app.get("/api/runs", async (req, res) => {
  const topicId = req.query.topicId as string | undefined;
  if (topicId) {
    const runs = await listRunsForTopic(topicId);
    res.json(runs);
  } else {
    const runs = await loadRunIndex();
    res.json(runs);
  }
});

app.get("/api/runs/:slug/:timestamp", async (req, res) => {
  const run = await loadRun(req.params.slug, req.params.timestamp);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// --- API: Trigger runs ---
app.post("/api/runs/trigger", async (req, res) => {
  const { topicId } = req.body;
  const config = await loadConfig();

  if (topicId === "all") {
    const jobIds: string[] = [];
    // Start them sequentially to avoid rate limits
    const enabledTopics = config.topics.filter((t) => t.enabled);
    // Start first immediately, queue the rest
    for (const topic of enabledTopics) {
      const jobId = await executeRun(topic, "manual");
      jobIds.push(jobId);
    }
    res.json({ jobIds });
    return;
  }

  const topic = config.topics.find((t) => t.id === topicId);
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  const jobId = await executeRun(topic, "manual");
  res.json({ jobId });
});

// --- API: SSE stream for job progress ---
app.get("/api/jobs/:jobId/stream", (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send buffered events
  for (const entry of job.events) {
    res.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }

  // If already done, close
  if (job.status !== "running") {
    res.write(`event: done\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
    res.end();
    return;
  }

  // Register for future events
  job.sseClients.push(res);

  req.on("close", () => {
    job.sseClients = job.sseClients.filter((c) => c !== res);
  });
});

// --- API: Status ---
app.get("/api/status", (_req, res) => {
  const scheduler = getSchedulerStatus();
  const jobs = Array.from(activeJobs.values()).map((j) => ({
    id: j.id,
    topicId: j.topicId,
    topicLabel: j.topicLabel,
    status: j.status,
  }));
  res.json({
    scheduler,
    activeJobs: jobs,
    env: {
      APIFY_TOKEN: process.env.APIFY_TOKEN ? `set (${process.env.APIFY_TOKEN.slice(0, 12)}...)` : "MISSING",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.slice(0, 12)}...)` : "MISSING",
    },
  });
});

// --- Start ---
const PORT = parseInt(process.env.PORT || "3456", 10);

async function start() {
  await initStorage();
  const config = await loadConfig();
  initScheduler(config, scheduledRunCallback);

  app.listen(PORT, () => {
    console.log(`\n  Reddit Research Dashboard`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}

start();
