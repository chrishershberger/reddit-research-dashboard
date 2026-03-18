import cron from "node-cron";
import type { Config, Topic } from "./storage.js";

let currentTask: cron.ScheduledTask | null = null;
let currentCron: string = "";

type RunCallback = (topic: Topic) => Promise<void>;

export function initScheduler(config: Config, runCallback: RunCallback): void {
  stopScheduler();

  if (!config.schedule.enabled) {
    console.log("[Scheduler] Disabled.");
    return;
  }

  if (!cron.validate(config.schedule.cron)) {
    console.error(`[Scheduler] Invalid cron expression: ${config.schedule.cron}`);
    return;
  }

  currentCron = config.schedule.cron;

  currentTask = cron.schedule(config.schedule.cron, async () => {
    console.log(`[Scheduler] Triggered at ${new Date().toISOString()}`);
    const enabledTopics = config.topics.filter((t) => t.enabled);

    // Run topics sequentially to avoid rate limits
    for (const topic of enabledTopics) {
      console.log(`[Scheduler] Running topic: ${topic.label}`);
      try {
        await runCallback(topic);
      } catch (err) {
        console.error(`[Scheduler] Error running topic ${topic.id}:`, err);
      }
    }

    console.log("[Scheduler] All scheduled runs complete.");
  });

  console.log(`[Scheduler] Active: "${config.schedule.description}" (${config.schedule.cron})`);
}

export function updateSchedule(config: Config, runCallback: RunCallback): void {
  initScheduler(config, runCallback);
}

export function stopScheduler(): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    currentCron = "";
  }
}

export function getSchedulerStatus(): { enabled: boolean; cron: string } {
  return {
    enabled: currentTask !== null,
    cron: currentCron,
  };
}
