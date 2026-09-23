import Anthropic from "@anthropic-ai/sdk";
import { ClaudeProvider } from "./ai/claude";
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const log = (msg: string) => console.log(`[physicslab] ${msg}`);

const ai = config.aiEnabled
  ? new ClaudeProvider({
      // Credentials come from the environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile).
      client: new Anthropic({ maxRetries: 2 }),
      model: config.model,
      interpretEffort: config.interpretEffort,
      explainEffort: config.explainEffort,
      log,
    })
  : null;

const app = createApp({ config, ai, log });
app.listen(config.port, () => {
  log(`listening on http://localhost:${config.port}`);
  log(ai ? `AI interpreter: ${config.model} (effort ${config.interpretEffort})` : "AI interpreter: off — set ANTHROPIC_API_KEY to enable; using the offline interpreter");
});
