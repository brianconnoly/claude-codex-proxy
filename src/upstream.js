import { loadFreshToken } from "./codex-auth.js";

export async function callUpstream(config, body) {
  if (config.upstream === "codex") {
    return callCodex(config, body);
  }
  return callOpenAI(config, body);
}

async function callCodex(config, body) {
  const token = await loadFreshToken(config.codex.authFile);
  if (!token.accountId) {
    throw new Error("Could not extract chatgpt_account_id from OAuth access token");
  }

  const headers = {
    authorization: `Bearer ${token.access}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "chatgpt-account-id": token.accountId,
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
  };

  return fetch(`${config.codex.baseUrl.replace(/\/$/, "")}/codex/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true, store: false }),
  });
}

async function callOpenAI(config, body) {
  if (!config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required when UPSTREAM=openai");
  }

  const headers = {
    authorization: `Bearer ${config.openai.apiKey}`,
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json",
  };
  if (config.openai.organization) headers["openai-organization"] = config.openai.organization;
  if (config.openai.project) headers["openai-project"] = config.openai.project;

  return fetch(`${config.openai.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
