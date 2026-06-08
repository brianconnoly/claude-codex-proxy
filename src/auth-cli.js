import { loadConfig } from "./config.js";
import { runInteractiveLogin } from "./codex-auth.js";

const config = loadConfig();

runInteractiveLogin(config.codex.authFile).catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
