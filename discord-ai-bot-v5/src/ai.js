"use strict";

const { fetchWithTimeout, sleep, backoff } = require("./http");

class AIError extends Error {
  constructor(status, body, model) {
    super(`AI ${status} (${model}): ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = String(body);
    this.model = model;
    this.fatal = status === 401;
    this.modelGone =
      status === 404 || /model_not_found|decommission|does not exist|no longer supported|model.*deprecated/i.test(this.body);
  }
}

// حسب توثيق Groq: qwen يقفل التفكير بـ none، و gpt-oss يستخدم low + include_reasoning
function reasoningParams(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: "low", include_reasoning: false };
  if (/qwen/i.test(model)) return { reasoning_effort: "none" };
  return {};
}

function parseRetryMs(res, text) {
  const h = Number(res.headers.get("retry-after"));
  if (Number.isFinite(h) && h > 0) return Math.ceil(h * 1000);
  const m = String(text).match(/try again in ([\d.]+)\s*(ms|s)/i);
  if (m) return Math.ceil(Number(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000));
  return 1000;
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host);
}

const FLAG_PROMPT =
  "ما اسم الدولة صاحبة هذا العلم؟ اكتب اسم الدولة بالعربي فقط، كلمة واحدة أو كلمتين، بدون أي شرح أو تشكيل أو نقطة. مثال: المجر أو السعودية أو الولايات المتحدة";
const FLAG_PROMPT_STRICT =
  "انظر للعلم في الصورة. أجب باسم الدولة بالحروف العربية فقط (مثل: المجر). لا تكتب إنجليزي ولا أي كلمة زيادة.";

class AI {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.chains = { vision: [...cfg.visionModels], chat: [...cfg.chatModels] };
  }

  headers() {
    return { Authorization: `Bearer ${this.cfg.aiKey}`, "Content-Type": "application/json" };
  }

  // يتأكد إن الموديلات المضبوطة لسا موجودة عند المزود (Groq يسحب موديلات كثير)
  async verify() {
    try {
      const res = await fetchWithTimeout(`${this.cfg.aiApiBase}/models`, { headers: this.headers() }, 10000);
      if (res.status === 401) throw new AIError(401, "invalid api key", "-");
      if (!res.ok) return this.log.warn(`ما قدرت أتحقق من الموديلات (HTTP ${res.status})`);
      const ids = new Set(((await res.json()).data || []).map((m) => m.id));
      for (const kind of ["vision", "chat"]) {
        const missing = this.chains[kind].filter((m) => !ids.has(m));
        if (missing.length) this.log.warn(`موديلات ${kind} مو موجودة عند المزود: ${missing.join(", ")}`);
        const alive = this.chains[kind].filter((m) => ids.has(m));
        if (alive.length) this.chains[kind] = alive;
        else this.log.error(`ما فيه ولا موديل ${kind} شغال! عدّل VISION_MODELS / CHAT_MODELS في .env`);
      }
    } catch (e) {
      if (e.fatal) throw e;
      this.log.warn(`ما قدرت أتحقق من الموديلات: ${e.message}`);
    }
  }

  async complete(kind, payload) {
    if (!this.chains[kind].length) this.chains[kind] = [...(kind === "vision" ? this.cfg.visionModels : this.cfg.chatModels)];
    let lastErr;
    for (const model of [...this.chains[kind]]) {
      try {
        return await this.post(model, payload);
      } catch (e) {
        lastErr = e;
        if (e.modelGone) {
          this.log.warn(`الموديل ${model} ما عاد متاح، أجرب اللي بعده`);
          this.chains[kind] = this.chains[kind].filter((m) => m !== model);
          continue;
        }
        throw e;
      }
    }
    throw lastErr ?? new AIError(0, "ما فيه موديلات مضبوطة", kind);
  }

  async post(model, payload) {
    const body = { model, ...payload, ...reasoningParams(model) };
    if (/gpt-oss/i.test(model) && body.max_completion_tokens) body.max_completion_tokens = Math.max(body.max_completion_tokens, 512);
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(`${this.cfg.aiApiBase}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, this.cfg.aiTimeoutMs);
      } catch (e) {
        if (attempt === 3) throw new AIError(0, e.message, model);
        await sleep(backoff(attempt, 300));
        continue;
      }
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      // لو المزود رفض باراميتر التفكير، نعيد بدونه
      if (res.status === 400 && /reasoning/i.test(text) && ("reasoning_effort" in body || "include_reasoning" in body)) {
        delete body.reasoning_effort;
        delete body.include_reasoning;
        delete body.reasoning_format;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const waitMs = res.status === 429 ? parseRetryMs(res, text) : backoff(attempt, 300);
        if (waitMs <= this.cfg.aiMaxWaitMs) {
          await sleep(waitMs);
          continue;
        }
      }
      throw new AIError(res.status, text, model);
    }
    throw new AIError(0, "انتهت المحاولات", model);
  }

  async downloadAsDataUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("رابط صورة غير مدعوم");
    if (!this.cfg.allowPrivateImageHosts && isPrivateHost(u.hostname)) throw new Error("رابط صورة داخلي ممنوع");
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) throw new Error(`تحميل الصورة فشل (${res.status})`);
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!type.startsWith("image/")) throw new Error("الرابط مو صورة");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3.5 * 1024 * 1024) throw new Error("الصورة كبيرة");
    return `data:${type};base64,${buf.toString("base64")}`;
  }

  async identifyFlag(url, { strict = false } = {}) {
    const text = strict ? FLAG_PROMPT_STRICT : FLAG_PROMPT;
    const build = (u) => ({
      max_completion_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: u } }] }],
    });
    let data;
    try {
      data = await this.complete("vision", build(url));
    } catch (e) {
      // ممكن Groq ما قدر يجيب الرابط: ننزّل الصورة ونرسلها base64
      if (e.status === 400 && /image|url|retriev|fetch|download/i.test(e.body) && !String(url).startsWith("data:")) {
        this.log.debug("Groq ما قدر يجيب الصورة، أنزّلها وأرسلها base64");
        data = await this.complete("vision", build(await this.downloadAsDataUrl(url)));
      } else throw e;
    }
    return data.choices?.[0]?.message?.content ?? "";
  }

  async chat({ system, history }) {
    const data = await this.complete("chat", {
      max_completion_tokens: 120,
      temperature: 0.7,
      messages: [{ role: "system", content: system }, ...history],
    });
    return data.choices?.[0]?.message?.content ?? "";
  }
}

module.exports = { AI, AIError };
