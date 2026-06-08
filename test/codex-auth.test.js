import assert from "node:assert/strict";
import test from "node:test";
import { renderAuthCallbackPage } from "../src/codex-auth.js";

test("renders styled OAuth callback success page", () => {
  const html = renderAuthCallbackPage();

  assert.match(html, /<!doctype html>/);
  assert.match(html, /Authorization complete/);
  assert.match(html, /Close tab/);
  assert.match(html, /Local callback/);
  assert.match(html, /--accent: #0f766e/);
});

test("renders escaped OAuth callback error page", () => {
  const html = renderAuthCallbackPage({
    status: "error",
    title: "<bad>",
    heading: "State < mismatch",
    message: "Retry & return",
    detail: "\"quoted\"",
  });

  assert.match(html, /Action needed/);
  assert.match(html, /&lt;bad&gt;/);
  assert.match(html, /State &lt; mismatch/);
  assert.match(html, /Retry &amp; return/);
  assert.match(html, /&quot;quoted&quot;/);
  assert.match(html, /--accent: #b42318/);
});
