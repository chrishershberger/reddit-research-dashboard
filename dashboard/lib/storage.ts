import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RunResult } from "./research.js";

// --- Paths ---
// Use RAILWAY_VOLUME_MOUNT_PATH or DATA_DIR env var for persistent storage,
// otherwise fall back to local ./dashboard/data
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.DATA_DIR
  || join(decodeURIComponent(dirname(new URL(import.meta.url).pathname)), "..", "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const RUNS_DIR = join(DATA_DIR, "runs");
const INDEX_PATH = join(RUNS_DIR, "index.json");

// --- Types ---
export interface Topic {
  id: string;
  label: string;
  searchQuery: string;
  subreddits: string[];
  maxItems: number;
  enabled: boolean;
}

export interface ScheduleConfig {
  enabled: boolean;
  cron: string;
  description: string;
}

export interface Config {
  topics: Topic[];
  schedule: ScheduleConfig;
  defaults: {
    subreddits: string[];
    maxItems: number;
  };
}

export interface RunIndexEntry {
  id: string;
  topicId: string;
  topicLabel: string;
  startedAt: string;
  completedAt: string;
  status: string;
  trigger: string;
  rawPostCount: number;
}

// --- Default config ---
const DEFAULT_CONFIG: Config = {
  topics: [
    {
      id: "delivery-apps",
      label: "Delivery Apps (DoorDash/UberEats)",
      searchQuery: "doordash ubereats restaurant owner",
      subreddits: ["restaurantowners", "KitchenConfidential", "Restaurant_Managers", "smallbusiness"],
      maxItems: 50,
      enabled: true,
    },
    {
      id: "chain-competition",
      label: "Chain Competition",
      searchQuery: "restaurant competition from chains",
      subreddits: ["restaurantowners", "KitchenConfidential", "Restaurant_Managers", "smallbusiness"],
      maxItems: 50,
      enabled: true,
    },
    {
      id: "customer-acquisition",
      label: "Customer Acquisition",
      searchQuery: "restaurant marketing getting customers",
      subreddits: ["restaurantowners", "KitchenConfidential", "Restaurant_Managers", "smallbusiness"],
      maxItems: 50,
      enabled: true,
    },
    {
      id: "burnout",
      label: "Owner Burnout & Work-Life Balance",
      searchQuery: "restaurant owner burnout work life balance",
      subreddits: ["restaurantowners", "KitchenConfidential", "Restaurant_Managers", "smallbusiness"],
      maxItems: 50,
      enabled: true,
    },
  ],
  schedule: {
    enabled: false,
    cron: "0 6 * * 1",
    description: "Weekly on Monday at 6am",
  },
  defaults: {
    subreddits: ["restaurantowners", "KitchenConfidential", "Restaurant_Managers", "smallbusiness"],
    maxItems: 50,
  },
};

// --- Helpers ---
async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON(path: string, data: unknown) {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Config ---
export async function loadConfig(): Promise<Config> {
  return readJSON(CONFIG_PATH, DEFAULT_CONFIG);
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJSON(CONFIG_PATH, config);
}

// --- Runs ---
export async function loadRunIndex(): Promise<RunIndexEntry[]> {
  return readJSON(INDEX_PATH, []);
}

export async function saveRun(run: RunResult): Promise<void> {
  const slug = slugify(run.topicId);
  const ts = run.startedAt.replace(/[:.]/g, "-");
  const runPath = join(RUNS_DIR, slug, `${ts}.json`);

  // Save the full run
  await writeJSON(runPath, run);

  // Update the index
  const index = await loadRunIndex();
  const entry: RunIndexEntry = {
    id: run.id,
    topicId: run.topicId,
    topicLabel: run.topicLabel,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status: run.status,
    trigger: run.trigger,
    rawPostCount: run.rawPostCount,
  };
  index.unshift(entry); // newest first
  await writeJSON(INDEX_PATH, index);
}

export async function loadRun(topicSlug: string, timestamp: string): Promise<RunResult | null> {
  const runPath = join(RUNS_DIR, topicSlug, `${timestamp}.json`);
  return readJSON<RunResult | null>(runPath, null);
}

export async function listRunsForTopic(topicId: string): Promise<RunIndexEntry[]> {
  const index = await loadRunIndex();
  return index.filter((entry) => entry.topicId === topicId);
}

// --- Init: create default config if none exists ---
export async function initStorage(): Promise<void> {
  await ensureDir(RUNS_DIR);
  try {
    await readFile(CONFIG_PATH, "utf-8");
  } catch {
    // Config doesn't exist, write defaults
    await writeJSON(CONFIG_PATH, DEFAULT_CONFIG);
  }
}
