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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderAuthCallbackPage({
  status = "success",
  title = "Authorization complete",
  heading = "Authorization complete",
  message = "You can close this tab and return to the terminal.",
  detail = "Claude Codex Proxy is ready to save your ChatGPT OAuth session locally.",
} = {}) {
  const success = status === "success";
  const safeTitle = escapeHtml(title);
  const safeHeading = escapeHtml(heading);
  const safeMessage = escapeHtml(message);
  const safeDetail = escapeHtml(detail);
  const accent = success ? "#0f766e" : "#b42318";
  const accentSoft = success ? "#ccfbf1" : "#fee4e2";
  const accentDark = success ? "#134e4a" : "#7a271a";
  const icon = success ? "OK" : "!";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #647084;
      --line: #d9e0ea;
      --accent: ${accent};
      --accent-soft: ${accentSoft};
      --accent-dark: ${accentDark};
      --shadow: 0 24px 80px rgba(28, 39, 54, 0.14);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        linear-gradient(180deg, #eef3f8 0%, #f6f8fb 46%, #ffffff 100%);
      color: var(--text);
      font-family:
        Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
    }
    main {
      width: min(520px, 100%);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .bar {
      height: 6px;
      background: var(--accent);
    }
    .content {
      padding: 32px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--accent-dark);
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .mark {
      width: 34px;
      height: 34px;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-dark);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
    }
    h1 {
      margin: 22px 0 10px;
      font-size: clamp(28px, 5vw, 40px);
      line-height: 1.05;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }
    .detail {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 26px;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 8px;
      padding: 11px 16px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { filter: brightness(0.96); }
    .secondary {
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--text);
    }
    footer {
      padding: 14px 32px;
      border-top: 1px solid var(--line);
      background: #f9fbfd;
      color: var(--muted);
      font-size: 12px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    @media (max-width: 480px) {
      body { padding: 14px; }
      .content { padding: 26px 22px; }
      footer { padding: 14px 22px; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <div class="bar"></div>
    <section class="content">
      <div class="status"><span class="mark">${icon}</span>${success ? "Authorized" : "Action needed"}</div>
      <h1>${safeHeading}</h1>
      <p>${safeMessage}</p>
      <p class="detail">${safeDetail}</p>
      <div class="actions">
        <button type="button" onclick="window.close()">Close tab</button>
        <button type="button" class="secondary" onclick="location.href='about:blank'">Clear page</button>
      </div>
    </section>
    <footer>Local callback: <code>${escapeHtml(REDIRECT_URI)}</code></footer>
  </main>
</body>
</html>`;
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
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(renderAuthCallbackPage({
          status: "error",
          title: "State mismatch",
          heading: "Authorization was not accepted",
          message: "The OAuth state did not match the login session.",
          detail: "Close this tab and run npm run auth again from the terminal.",
        }));
        resolveCode(null);
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(renderAuthCallbackPage({
          status: "error",
          title: "Missing authorization code",
          heading: "No authorization code received",
          message: "OpenAI redirected back without the code required to finish login.",
          detail: "Close this tab and run npm run auth again from the terminal.",
        }));
        resolveCode(null);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderAuthCallbackPage());
      resolveCode(code);
    } catch {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(renderAuthCallbackPage({
        status: "error",
        title: "Callback error",
        heading: "Callback failed",
        message: "The local callback server hit an internal error.",
        detail: "Return to the terminal. The CLI will fall back to manual paste if needed.",
      }));
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
