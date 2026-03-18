import { ApifyClient } from "apify-client";
import Anthropic from "@anthropic-ai/sdk";

// --- Configuration ---
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REDDIT_SCRAPER_ACTOR = "comchat/reddit-api-scraper";

export function checkEnvVars() {
  const missing: string[] = [];
  if (!APIFY_TOKEN) missing.push("APIFY_TOKEN");
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

// --- Scrape Reddit via Apify ---
export async function scrapeReddit(
  topic: string,
  subreddits: string[],
  maxItems = 50
): Promise<Record<string, unknown>[]> {
  const client = new ApifyClient({ token: APIFY_TOKEN });

  const input: Record<string, unknown> = {
    searchList: [topic],
    resultsLimit: Math.min(maxItems, 250),
    sortBy: "relevance",
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
    },
  };

  if (subreddits.length > 0) {
    input.subRedditList = subreddits;
  }

  const run = await client.actor(REDDIT_SCRAPER_ACTOR).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

// --- Prepare data for summarization ---
export function prepareForSummary(items: Record<string, unknown>[]): string {
  if (items.length === 0) {
    return "No results found.";
  }

  const posts = items
    .map((item, i) => {
      const title = item.title || "(no title)";
      const body = item.body || item.text || item.selftext || item.selfText || "";
      const score = item.score ?? item.upVotes ?? item.ups ?? "?";
      const subreddit = item.subreddit || item.communityName || item.subreddit_name_prefixed || "unknown";
      const numComments = item.numberOfComments ?? item.commentCount ?? item.num_comments ?? "?";
      const url = item.url || item.permalink || "";
      const comments = Array.isArray(item.comments)
        ? (item.comments as Array<Record<string, unknown>>)
            .slice(0, 5)
            .map((c) => `  - [${c.score ?? "?"}pts] ${c.body || c.text || ""}`)
            .join("\n")
        : "";

      const bodyTruncated = typeof body === "string" ? body.slice(0, 500) : "";

      return [
        `--- Post ${i + 1} ---`,
        `Title: ${title}`,
        `Subreddit: r/${subreddit}`,
        `Score: ${score} | Comments: ${numComments}`,
        `URL: ${url}`,
        bodyTruncated ? `Body: ${bodyTruncated}` : "",
        comments ? `Top Comments:\n${comments}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return posts;
}

// --- Summarize with Claude ---
export async function summarize(topic: string, redditData: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are an expert research analyst. Below is raw data scraped from Reddit about the topic: "${topic}".

Analyze the posts and comments and produce a structured synopsis with:

1. **Overview** - A 2-3 sentence summary of the general sentiment and discussion landscape.
2. **Key Themes** - The top 3-5 recurring themes or discussion points, each with a brief explanation and representative quotes/examples.
3. **Notable Perspectives** - Any contrarian, expert, or particularly insightful viewpoints that stand out.
4. **Consensus vs. Debate** - What people broadly agree on vs. where opinions diverge.
5. **Actionable Takeaways** - If applicable, any recommendations or conclusions that emerge from the discussion.

Be concise but thorough. Cite specific posts or comments where helpful.

--- REDDIT DATA ---
${redditData}`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  return textBlock ? textBlock.text : "No summary generated.";
}

// --- Progress callback type ---
export type ProgressEvent = "scraping" | "summarizing" | "complete" | "error";
export type OnProgress = (event: ProgressEvent, data?: unknown) => void;

// --- Run result type ---
export interface RunResult {
  id: string;
  topicId: string;
  topicLabel: string;
  searchQuery: string;
  subreddits: string[];
  startedAt: string;
  completedAt: string;
  status: "complete" | "error";
  trigger: "manual" | "scheduled";
  rawPostCount: number;
  summary: string;
  rawData: string;
  error?: string;
}

// --- Orchestrator ---
export async function runResearch(params: {
  topicId: string;
  topicLabel: string;
  searchQuery: string;
  subreddits: string[];
  maxItems?: number;
  trigger?: "manual" | "scheduled";
  onProgress?: OnProgress;
}): Promise<RunResult> {
  const {
    topicId,
    topicLabel,
    searchQuery,
    subreddits,
    maxItems = 50,
    trigger = "manual",
    onProgress,
  } = params;

  const startedAt = new Date().toISOString();
  const id = `${topicId}-${startedAt.replace(/[:.]/g, "-")}`;

  try {
    // Step 1: Scrape
    onProgress?.("scraping", { topicLabel, subreddits });
    const items = await scrapeReddit(searchQuery, subreddits, maxItems);

    // Step 2: Prepare + Summarize
    onProgress?.("summarizing", { postCount: items.length });
    const rawData = prepareForSummary(items);
    const summary = await summarize(searchQuery, rawData);

    const result: RunResult = {
      id,
      topicId,
      topicLabel,
      searchQuery,
      subreddits,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "complete",
      trigger,
      rawPostCount: items.length,
      summary,
      rawData,
    };

    onProgress?.("complete", { postCount: items.length });
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    onProgress?.("error", { error: errorMsg });
    return {
      id,
      topicId,
      topicLabel,
      searchQuery,
      subreddits,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "error",
      trigger,
      rawPostCount: 0,
      summary: "",
      rawData: "",
      error: errorMsg,
    };
  }
}
