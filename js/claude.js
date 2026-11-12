import { CONFIG } from "./config.js";

const KEY_STORE = "nsgeo.anthropicKey";

export function getUserKey() {
  try {
    return sessionStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";
  }
}

export function setUserKey(k) {
  try {
    if (k) sessionStorage.setItem(KEY_STORE, k);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* storage blocked: key lasts until the page reloads */
  }
  memKey = k;
}
let memKey = "";

export function liveMode() {
  if (getUserKey() || memKey) return "own-key";
  if (CONFIG.proxyUrl) return "proxy";
  return "offline";
}

export class LimitReached extends Error {}

export async function callClaude({ system, messages, tools }) {
  const body = { model: CONFIG.model, max_tokens: CONFIG.maxTokens, system, messages, tools };
  const key = getUserKey() || memKey;
  let res;
  if (key) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } else if (CONFIG.proxyUrl) {
    res = await fetch(CONFIG.proxyUrl.replace(/\/$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } else {
    throw new LimitReached("No live connection to Claude is set up.");
  }

  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    throw new LimitReached(j.message || "The demo's daily limit has been reached.");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j.error && j.error.message) || `Claude request failed (${res.status})`);
  }
  return res.json();
}
