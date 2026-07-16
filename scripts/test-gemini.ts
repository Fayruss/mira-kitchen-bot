// test-gemini.ts
// Standalone script to test services/gemini.ts directly, without going
// through Telegram or the webhook. Run with: npm run test:gemini
//
// Usage:
//   npm run test:gemini -- "What time do you open?"
//   npm run test:gemini -- "Do you have fried rice?" "Fried rice - $8, Noodles - $7"

import { config } from "dotenv";
import { understandMessage } from "../services/gemini";

config({ path: ".env.local" });

async function main() {
  const [message, menuContext] = process.argv.slice(2);

  if (!message) {
    console.error('Usage: npm run test:gemini -- "your message here" ["optional menu context"]');
    process.exit(1);
  }

  const result = await understandMessage(message, menuContext);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("test-gemini script failed:", error);
  process.exit(1);
});
