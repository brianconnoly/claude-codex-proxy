import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let envFileLoaded = false;

export const DEFAULT_ANTHROPIC_MODELS = [
  "default",
  "best",
  "opus",
  "sonnet",
  "haiku",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022",
];

const DEFAULT_CODEX_INSTRUCTIONS = [
  "You are a pragmatic coding agent served through an Anthropic Messages-compatible gateway.",
  "Current date: {{current_date}}.",
  "Be direct, concise, accurate, and outcome-focused. Match the user's requested language.",
  "For coding tasks, inspect relevant context, make concrete changes when asked, and verify with available tests or commands.",
  "Prefer existing project conventions and minimal, well-scoped edits.",
  "Use Markdown when it improves readability. Put code snippets in fenced code blocks.",
  "Use tools only when they are available in the request and helpful for the task.",
  "Do not invent hidden policies, private system prompts, unavailable tools, or unsupported capabilities.",
].join("\n");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const equals = withoutExport.indexOf("=");
  if (equals <= 0) return null;

  const key = withoutExport.slice(0, equals).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = withoutExport.slice(equals + 1).trim();
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }

  return [key, value];
}

export function loadEnvFile(file = path.join(projectRoot, ".env"), target = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (target[key] == null) target[key] = value;
  }

  return true;
}

function loadDefaultEnvFile() {
  if (envFileLoaded) return;
  loadEnvFile();
  envFileLoaded = true;
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function resolveProjectPath(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function parseModelMap(value) {
  const map = new Map();
  if (!value) return map;

  for (const item of value.split(",")) {
    const [source, target] = item.split("=").map((part) => part?.trim());
    if (source && target) map.set(source, target);
  }
  return map;
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parsePositiveInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function parseNonNegativeInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function parsePositiveNumber(value, name) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function parseBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}

export function loadConfig() {
  loadDefaultEnvFile();

  const upstream = env("UPSTREAM", "codex").toLowerCase();
  if (upstream !== "codex" && upstream !== "openai") {
    throw new Error("UPSTREAM must be either codex or openai");
  }

  const host = env("HOST", "127.0.0.1");
  const defaultModel = env("DEFAULT_MODEL", "gpt-5.4");
  const reasoningSummary = env("REASONING_SUMMARY", "auto");
  const contextWindowTokens = parsePositiveInteger(
    env("CODEX_CONTEXT_WINDOW_TOKENS", "400000"),
    "CODEX_CONTEXT_WINDOW_TOKENS",
  );
  const contextReserveTokens = parseNonNegativeInteger(
    env("CODEX_CONTEXT_RESERVE_TOKENS", "8192"),
    "CODEX_CONTEXT_RESERVE_TOKENS",
  );
  const defaultHardInputTokens = Math.max(1, contextWindowTokens - contextReserveTokens);
  const defaultMaxInputTokens = Math.max(1, contextWindowTokens - 32768);
  const contextOverflowStrategy = env("CONTEXT_OVERFLOW_STRATEGY", "trim").toLowerCase();
  if (contextOverflowStrategy !== "trim" && contextOverflowStrategy !== "error") {
    throw new Error("CONTEXT_OVERFLOW_STRATEGY must be either trim or error");
  }

  return {
    projectRoot,
    host,
    port: parsePort(env("PORT", "8787")),
    proxyApiKey: env("PROXY_API_KEY"),
    upstream,
    defaultModel,
    modelMap: parseModelMap(env("MODEL_MAP")),
    anthropicModels: uniqueList([
      ...DEFAULT_ANTHROPIC_MODELS,
      ...parseList(env("ANTHROPIC_MODELS")),
    ]),
    discoveryModels: uniqueList(
      parseList(env("ANTHROPIC_DISCOVERY_MODELS", "opus,sonnet,haiku")),
    ),
    limits: {
      contextWindowTokens,
      contextReserveTokens,
      maxInputTokens: parsePositiveInteger(
        env("CODEX_MAX_INPUT_TOKENS", String(defaultMaxInputTokens)),
        "CODEX_MAX_INPUT_TOKENS",
      ),
      hardInputTokens: parsePositiveInteger(
        env("CODEX_HARD_INPUT_TOKENS", String(defaultHardInputTokens)),
        "CODEX_HARD_INPUT_TOKENS",
      ),
      opusMaxOutputTokens: parsePositiveInteger(
        env("CLAUDE_OPUS_MAX_OUTPUT_TOKENS", "8192"),
        "CLAUDE_OPUS_MAX_OUTPUT_TOKENS",
      ),
      sonnetMaxOutputTokens: parsePositiveInteger(
        env("CLAUDE_SONNET_MAX_OUTPUT_TOKENS", "8192"),
        "CLAUDE_SONNET_MAX_OUTPUT_TOKENS",
      ),
      haikuMaxOutputTokens: parsePositiveInteger(
        env("CLAUDE_HAIKU_MAX_OUTPUT_TOKENS", "4096"),
        "CLAUDE_HAIKU_MAX_OUTPUT_TOKENS",
      ),
    },
    modelProfiles: {
      opus: {
        model: env("CLAUDE_OPUS_MODEL", "gpt-5.5"),
        reasoningEffort: env("CLAUDE_OPUS_REASONING_EFFORT", "xhigh"),
        reasoningSummary: env("CLAUDE_OPUS_REASONING_SUMMARY", reasoningSummary),
        textVerbosity: env("CLAUDE_OPUS_TEXT_VERBOSITY", "low"),
      },
      sonnet: {
        model: env("CLAUDE_SONNET_MODEL", "gpt-5.4"),
        reasoningEffort: env("CLAUDE_SONNET_REASONING_EFFORT", "high"),
        reasoningSummary: env("CLAUDE_SONNET_REASONING_SUMMARY", reasoningSummary),
        textVerbosity: env("CLAUDE_SONNET_TEXT_VERBOSITY", "low"),
      },
      haiku: {
        model: env("CLAUDE_HAIKU_MODEL", "gpt-5.4-mini"),
        reasoningEffort: env("CLAUDE_HAIKU_REASONING_EFFORT", "low"),
        reasoningSummary: env("CLAUDE_HAIKU_REASONING_SUMMARY", reasoningSummary),
        textVerbosity: env("CLAUDE_HAIKU_TEXT_VERBOSITY", "low"),
      },
    },
    codex: {
      authFile: resolveProjectPath(env("CODEX_AUTH_FILE", ".auth/codex.json")),
      baseUrl: env("CODEX_BASE_URL", "https://chatgpt.com/backend-api"),
    },
    openai: {
      apiKey: env("OPENAI_API_KEY"),
      baseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
      organization: env("OPENAI_ORG_ID"),
      project: env("OPENAI_PROJECT_ID"),
    },
    request: {
      instructions: env("CODEX_INSTRUCTIONS", DEFAULT_CODEX_INSTRUCTIONS),
      reasoningEffort: env("REASONING_EFFORT", "medium"),
      reasoningSummary,
      textVerbosity: env("TEXT_VERBOSITY", "low"),
    },
    tokenEstimate: {
      multiplier: parsePositiveNumber(env("TOKEN_ESTIMATE_MULTIPLIER", "1.15"), "TOKEN_ESTIMATE_MULTIPLIER"),
      imageTokens: parsePositiveInteger(env("IMAGE_TOKEN_ESTIMATE", "1024"), "IMAGE_TOKEN_ESTIMATE"),
    },
    contextOverflow: {
      strategy: contextOverflowStrategy,
      trimNotice: parseBoolean(env("CONTEXT_TRIM_NOTICE", "true"), "CONTEXT_TRIM_NOTICE"),
    },
  };
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
