import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";
export const ACCOUNT_CLAIM = "https://api.openai.com/auth";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState() {
  return crypto.randomBytes(16).toString("hex");
}

export function createAuthorizationUrl() {
  const pkce = createPkcePair();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return { url: url.toString(), state, verifier: pkce.verifier };
}

export function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  return payload?.[ACCOUNT_CLAIM]?.chatgpt_account_id ?? null;
}

export function parseAuthorizationInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return {};

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Continue with compact forms below.
  }

  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    return { code, state };
  }

  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(trimmed);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: trimmed };
}

async function exchangeToken(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OAuth token response is missing expected fields");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: getAccountId(json.access_token),
  };
}

export function exchangeAuthorizationCode(code, verifier) {
  return exchangeToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
}

export function refreshAccessToken(refreshToken) {
  return exchangeToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

export async function readTokenFile(authFile) {
  const raw = await fs.readFile(authFile, "utf8");
  const token = JSON.parse(raw);
  if (!token?.access || !token?.refresh || typeof token?.expires !== "number") {
    throw new Error(`Invalid auth file: ${authFile}`);
  }
  if (!token.accountId) token.accountId = getAccountId(token.access);
  return token;
}

export async function writeTokenFile(authFile, token) {
  await fs.mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(
    {
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      accountId: token.accountId ?? getAccountId(token.access),
    },
    null,
    2,
  );
  await fs.writeFile(authFile, body, { mode: 0o600 });
}

export async function loadFreshToken(authFile) {
  let token;
  try {
    token = await readTokenFile(authFile);
  } catch (error) {
    error.message = `${error.message}. Run: npm run auth`;
    throw error;
  }

  if (token.expires - Date.now() > 60_000) {
    return token;
  }

  const refreshed = await refreshAccessToken(token.refresh);
  await writeTokenFile(authFile, refreshed);
  return refreshed;
}

function openBrowser(url) {
  const platform = os.platform();
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function startCallbackServer(expectedState) {
  const server = http.createServer();

  let resolveCode;
  const codePromise = new Promise((resolve) => {
    resolveCode = resolve;
  });

  server.on("request", (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost:1455");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("State mismatch. You can close this tab.");
        resolveCode(null);
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Missing authorization code. You can close this tab.");
        resolveCode(null);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>Authorized</title><h1>Authorization complete</h1><p>You can close this tab and return to the terminal.</p>",
      );
      resolveCode(code);
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal error");
      resolveCode(null);
    }
  });

  return new Promise((resolve) => {
    server.once("error", () => {
      resolve({
        ready: false,
        waitForCode: async () => null,
        close: () => {},
      });
    });
    server.listen(1455, "127.0.0.1", () => {
      resolve({
        ready: true,
        waitForCode: () =>
          Promise.race([
            codePromise,
            new Promise((timeoutResolve) => setTimeout(() => timeoutResolve(null), 120_000)),
          ]),
        close: () => server.close(),
      });
    });
  });
}

export async function runInteractiveLogin(authFile) {
  const flow = createAuthorizationUrl();
  const server = await startCallbackServer(flow.state);

  console.log("Open this URL to authorize Codex OAuth:");
  console.log(flow.url);

  if (server.ready) {
    openBrowser(flow.url);
    console.log("Waiting for callback on http://localhost:1455/auth/callback ...");
    const code = await server.waitForCode();
    server.close();
    if (code) {
      const token = await exchangeAuthorizationCode(code, flow.verifier);
      await writeTokenFile(authFile, token);
      console.log(`Saved OAuth token to ${authFile}`);
      return;
    }
    console.log("No callback received. Falling back to manual paste.");
  }

  const rl = readline.createInterface({ input, output });
  try {
    const pasted = await rl.question("Paste the full redirect URL or code: ");
    const parsed = parseAuthorizationInput(pasted);
    if (!parsed.code) throw new Error("No authorization code found in pasted input");
    if (parsed.state && parsed.state !== flow.state) {
      throw new Error("OAuth state mismatch");
    }
    const token = await exchangeAuthorizationCode(parsed.code, flow.verifier);
    await writeTokenFile(authFile, token);
    console.log(`Saved OAuth token to ${authFile}`);
  } finally {
    rl.close();
  }
}
