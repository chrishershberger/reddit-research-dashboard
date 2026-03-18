#!/usr/bin/env npx tsx

import { checkEnvVars, scrapeReddit, prepareForSummary, summarize } from "./dashboard/lib/research.js";

// --- Validate env ---
try {
  checkEnvVars();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// --- Parse CLI arguments ---
function parseArgs(): { topic: string; subreddits: string[]; maxItems: number } {
  const args = process.argv.slice(2);
  let topic = "";
  const subreddits: string[] = [];
  let maxItems = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--topic":
      case "-t":
        topic = args[++i];
        break;
      case "--subreddit":
      case "-s":
        // Accept comma-separated list or multiple --subreddit flags
        args[++i].split(",").forEach((s) => {
          // Strip URL format, r/ prefix, trailing slashes
          const clean = s
            .trim()
            .replace(/^https?:\/\/(www\.)?reddit\.com\/r\//, "")
            .replace(/^r\//, "")
            .replace(/\/+$/, "");
          if (clean) subreddits.push(clean);
        });
        break;
      case "--max-items":
      case "-n":
        maxItems = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        console.log(`
Usage: npx tsx reddit-synopsis.ts --topic <topic> [options]

Options:
  --topic, -t       Topic to search for (required)
  --subreddit, -s   Subreddit(s) to search in. Accepts:
                      - names: Restaurant_Managers,KitchenConfidential
                      - URLs: https://www.reddit.com/r/restaurantowners/
                      - multiple flags: -s sub1 -s sub2
  --max-items, -n   Max posts per search term (default: 50, max: 250)
  --help, -h        Show this help message

Examples:
  npx tsx reddit-synopsis.ts --topic "labor costs" -s Restaurant_Managers,KitchenConfidential,restaurantowners
  npx tsx reddit-synopsis.ts --topic "menu pricing" -s https://www.reddit.com/r/restaurantowners/
`);
        process.exit(0);
    }
  }

  if (!topic) {
    console.error('Error: --topic is required. Use --help for usage info.');
    process.exit(1);
  }

  return { topic, subreddits, maxItems };
}

// --- Main ---
async function main() {
  const { topic, subreddits, maxItems } = parseArgs();

  try {
    const subLabel = subreddits.length > 0
      ? ` in ${subreddits.map((s) => `r/${s}`).join(", ")}`
      : "";
    console.log(`Scraping Reddit for "${topic}"${subLabel}...`);
    console.log(`Max items per search: ${maxItems}\n`);

    const items = await scrapeReddit(topic, subreddits, maxItems);
    console.log(`Found ${items.length} items.\n`);

    if (items.length === 0) {
      console.log("No results found. Try a different topic or subreddit.");
      return;
    }

    const redditData = prepareForSummary(items);
    console.log("Sending data to Claude for summarization...\n");
    const synopsis = await summarize(topic, redditData);

    console.log("=".repeat(60));
    console.log(`  REDDIT SYNOPSIS: "${topic}"`);
    console.log("=".repeat(60));
    console.log();
    console.log(synopsis);
    console.log();
    console.log("=".repeat(60));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred:", error);
    }
    process.exit(1);
  }
}

main();
