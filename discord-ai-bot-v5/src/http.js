"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// انتظار تصاعدي مع شوية عشوائية: 0.5s, 1s, 2s, 4s ... لين max
const backoff = (attempt, base = 500, max = 15000) =>
  Math.min(max, base * 2 ** attempt) + Math.random() * 250;

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const jitter = ([min, max]) => min + Math.random() * Math.max(0, max - min);

module.exports = { sleep, backoff, fetchWithTimeout, jitter };
