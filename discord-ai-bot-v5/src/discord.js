"use strict";

const { sleep, backoff, fetchWithTimeout } = require("./http");

const MAX_RETRIES = 4;
const MAX_INLINE_WAIT_MS = 60_000;

class DiscordError extends Error {
  constructor(status, body, path, retryAfterMs = 0) {
    super(`Discord ${status} ${path}: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.body = String(body);
    this.retryAfterMs = retryAfterMs;
    this.fatal = status === 401; // توكن غلط/منتهي: لا تعيد المحاولة
  }
}

class DiscordClient {
  constructor(cfg, log, stats) {
    this.cfg = cfg;
    this.log = log;
    this.stats = stats;
    this.blockedUntil = new Map(); // routeKey -> timestamp
  }

  authHeader() {
    return this.cfg.tokenType === "bot" ? `Bot ${this.cfg.token}` : this.cfg.token;
  }

  async request(method, path, body) {
    const routeKey = `${method} ${path.split("?")[0]}`;
    for (let attempt = 0; ; attempt++) {
      const wait = (this.blockedUntil.get(routeKey) || 0) - Date.now();
      if (wait > 0) await sleep(wait);

      let res;
      try {
        res = await fetchWithTimeout(
          `${this.cfg.discordApiBase}${path}`,
          {
            method,
            headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          15000
        );
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw new DiscordError(0, e.message, path);
        await sleep(backoff(attempt));
        continue;
      }

      // احترام حدود الريت-لمت قبل ما نوصل للـ 429
      const remaining = res.headers.get("x-ratelimit-remaining");
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
      if (remaining === "0" && resetAfter > 0) this.blockedUntil.set(routeKey, Date.now() + resetAfter * 1000 + 50);

      if (res.status === 429) {
        this.stats.rateLimited++;
        const data = await res.json().catch(() => ({}));
        const secs = Number(data.retry_after ?? res.headers.get("retry-after") ?? 1);
        const waitMs = Math.ceil((Number.isFinite(secs) ? secs : 1) * 1000) + 100;
        if (waitMs > MAX_INLINE_WAIT_MS || attempt >= MAX_RETRIES) throw new DiscordError(429, JSON.stringify(data), path, waitMs);
        this.log.warn(`ريت-لمت من ديسكورد، أنتظر ${(waitMs / 1000).toFixed(1)} ثانية وأعيد`);
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) throw new DiscordError(res.status, await res.text().catch(() => ""), path);
      if (res.status === 204) return null;
      return res.json();
    }
  }

  me() {
    return this.request("GET", "/users/@me");
  }

  async messages({ after, limit = 20 } = {}) {
    const q = after ? `?after=${after}&limit=${limit}` : `?limit=1`;
    const list = await this.request("GET", `/channels/${this.cfg.channelId}/messages${q}`);
    return list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // الأقدم أول
  }

  async send(content, { replyTo } = {}) {
    if (this.cfg.dryRun) {
      this.log.sent(`[تجربة - ما انرسلت] ${content}`);
      return { id: "dry-run", content };
    }
    const body = { content, allowed_mentions: { parse: [], replied_user: false } };
    if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
    const msg = await this.request("POST", `/channels/${this.cfg.channelId}/messages`, body);
    this.log.sent(`أرسلت: ${content}`);
    return msg;
  }

  async react(messageId, emoji) {
    if (this.cfg.dryRun) return;
    await this.request(
      "PUT",
      `/channels/${this.cfg.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    );
  }
}

module.exports = { DiscordClient, DiscordError };
