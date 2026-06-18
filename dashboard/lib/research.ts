import Anthropic from "@anthropic-ai/sdk";

// --- Configuration ---
// Data source is PullPush.io — a public Reddit archive (Pushshift successor).
// No API key, signup, or proxy required. See docs at https://pullpush.io/.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PULLPUSH_BASE = "https://api.pullpush.io";
const PULLPUSH_UA = process.env.PULLPUSH_USER_AGENT || "reddit-research-dashboard/1.0";

// Enrich the most-discussed posts with their top comments (best signal for pain points).
const COMMENT_FETCH_POSTS = 8;
const COMMENTS_PER_POST = 6;

// PullPush is rate-limited, so space requests globally and retry on 429.
const MIN_REQUEST_GAP_MS = 700;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export function checkEnvVars() {
  // PullPush needs no credentials; only Claude summarization requires a key.
  if (!ANTHROPIC_API_KEY) {
    throw new Error("Missing environment variables: ANTHROPIC_API_KEY");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Global request throttle (serializes + spaces all PullPush calls) ---
// Keeps concurrent runs (e.g. "Run All") from tripping PullPush's rate limit.
let throttleChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttle(): Promise<void> {
  const run = throttleChain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  // Swallow errors on the chain so one failure doesn't poison later waiters.
  throttleChain = run.catch(() => {});
  return run;
}

// --- Low-level GET against the PullPush API; returns the `data` array ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pullpushGet(path: string, params: Record<string, string>, attempt = 0): Promise<any[]> {
  await throttle();
  const url = new URL(`${PULLPUSH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const backoff = Math.min(8000, 1000 * 2 ** attempt);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": PULLPUSH_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(backoff);
      return pullpushGet(path, params, attempt + 1);
    }
    throw new Error(`PullPush request failed: ${(err as Error).message}`);
  }

  if (res.status === 429) {
    if (attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
      await sleep(Math.max(retryAfter, backoff));
      return pullpushGet(path, params, attempt + 1);
    }
    throw new Error("PullPush rate limit (429) — retries exhausted. Try again shortly.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PullPush error (${res.status} ${res.statusText}) for ${path}. ${text.slice(0, 150)}`);
  }

  // PullPush occasionally returns an empty/non-JSON body on a 200 — don't crash on it.
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return [];
  }
  return Array.isArray(json?.data) ? json.data : [];
}

// --- Normalized item shape consumed by prepareForSummary ---
interface RedditItem extends Record<string, unknown> {
  id: string;
  title: string;
  selftext: string;
  score: number;
  subreddit: string;
  num_comments: number;
  url: string;
  comments?: Array<{ score: number; body: string }>;
}

function cleanSubName(sub: string): string {
  return sub
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "");
}

// --- Search submissions, highest-scoring first (one subreddit at a time) ---
async function searchSubmissions(
  query: string,
  subreddit: string | null,
  size: number,
): Promise<RedditItem[]> {
  const params: Record<string, string> = {
    size: String(Math.min(Math.max(size, 1), 100)), // PullPush caps a single request at 100
    sort: "desc",
    sort_type: "score",
  };
  if (query) params.q = query;
  if (subreddit) params.subreddit = subreddit;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await pullpushGet("/reddit/search/submission/", params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.map((p: any) => ({
    id: p.id ?? "",
    title: p.title ?? "(no title)",
    selftext: typeof p.selftext === "string" ? p.selftext : "",
    score: p.score ?? 0,
    subreddit: p.subreddit ?? subreddit ?? "unknown",
    num_comments: p.num_comments ?? 0,
    url: p.permalink ? `https://reddit.com${p.permalink}` : (p.url ?? ""),
  }));
}

// --- Fetch top comments for a single post (best-effort) ---
async function fetchTopComments(postId: string): Promise<Array<{ score: number; body: string }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await pullpushGet("/reddit/search/comment/", {
    link_id: postId,
    size: String(COMMENTS_PER_POST),
    sort: "desc",
    sort_type: "score",
  });
  const comments: Array<{ score: number; body: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of data as any[]) {
    const body = typeof c.body === "string" ? c.body : "";
    if (body.trim() && body !== "[deleted]" && body !== "[removed]") {
      comments.push({ score: c.score ?? 0, body });
    }
    if (comments.length >= COMMENTS_PER_POST) break;
  }
  return comments;
}

// --- Scrape Reddit via PullPush ---
// Same (topic, subreddits, maxItems) signature and item shape as before, so
// prepareForSummary / discover keep working unchanged.
export async function scrapeReddit(
  topic: string,
  subreddits: string[],
  maxItems = 50,
  fetchComments = true,
): Promise<Record<string, unknown>[]> {
  const cap = Math.min(maxItems, 250);
  let items: RedditItem[] = [];
  const seen = new Set<string>();

  const addUnique = (arr: RedditItem[]) => {
    for (const it of arr) {
      if (it.id && !seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    }
  };

  const cleanSubs = subreddits.map(cleanSubName).filter(Boolean);

  if (cleanSubs.length > 0) {
    // PullPush filters one subreddit per request — search each and merge.
    const perSub = Math.max(10, Math.ceil(cap / cleanSubs.length));
    for (const sub of cleanSubs) {
      try {
        addUnique(await searchSubmissions(topic, sub, perSub));
      } catch (err) {
        // One bad/private subreddit shouldn't kill the whole run.
        console.warn(`[PullPush] Search failed for r/${sub}: ${(err as Error).message}`);
      }
    }
  } else {
    addUnique(await searchSubmissions(topic, null, cap));
  }

  // Highest-scoring posts first, then cap.
  items.sort((a, b) => b.score - a.score);
  items = items.slice(0, cap);

  // Enrich the most-discussed posts with their top comments.
  if (fetchComments && items.length > 0) {
    const topForComments = [...items].sort((a, b) => b.num_comments - a.num_comments).slice(0, COMMENT_FETCH_POSTS);
    for (const item of topForComments) {
      try {
        item.comments = await fetchTopComments(item.id);
      } catch {
        // Comments are best-effort; ignore failures.
      }
    }
  }

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
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
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

    // No posts found is a real failure, not a silent empty summary.
    if (items.length === 0) {
      const where = subreddits.length ? ` in ${subreddits.map((s) => `r/${s}`).join(", ")}` : "";
      throw new Error(
        `PullPush returned 0 posts for "${searchQuery}"${where}. ` +
          `PullPush matches all keywords literally — try fewer / shorter keywords ` +
          `(one or two distinctive words work best) or different subreddits.`,
      );
    }

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
