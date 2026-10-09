"use strict";

const fs = require("fs");
const path = require("path");
const { normAr } = require("./text");

// قارئ .env بسيط بدون مكتبات
function loadEnvFile(file = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const has = (v) => v !== undefined && String(v).trim() !== "";
const num = (v, d) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (has(v) ? /^(1|true|yes|on)$/i.test(String(v).trim()) : d);
const list = (v) => (has(v) ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const range = (v, d) => {
  const m = String(v ?? "").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : d;
};

function loadAliases(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[normAr(k)] = String(v);
    return out;
  } catch {
    return {};
  }
}

function loadConfig(env = process.env) {
  const prefix = has(env.GAME_PREFIX) ? env.GAME_PREFIX.trim() : ".";
  const gameName = has(env.GAME_NAME) ? env.GAME_NAME.trim() : "اعلام";

  const cfg = {
    token: (env.DISCORD_TOKEN || "").trim(),
    tokenType: /^bot$/i.test(env.DISCORD_TOKEN_TYPE || "") ? "bot" : "user",
    channelId: (env.CHANNEL_ID || "").trim(),
    aiKey: (env.GROQ_API_KEY || env.AI_API_KEY || "").trim(),

    discordApiBase: (env.DISCORD_API_BASE || "https://discord.com/api/v10").replace(/\/$/, ""),
    aiApiBase: (env.AI_API_BASE || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    visionModels: has(env.VISION_MODELS) ? list(env.VISION_MODELS) : ["qwen/qwen3.8-27b"],
    chatModels: has(env.CHAT_MODELS) ? list(env.CHAT_MODELS) : ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    aiTimeoutMs: num(env.AI_TIMEOUT_MS, 12000),
    aiMaxWaitMs: num(env.AI_MAX_WAIT_MS, 4000),
    allowPrivateImageHosts: bool(env.ALLOW_PRIVATE_IMAGE_HOSTS, false),

    personality: has(env.PERSONALITY) ? env.PERSONALITY : "أنا لاعب محترف وسريع، أتكلم بالعربي وأمزح مع الناس في السيرفر",

    prefix,
    gameName,
    startCommand: has(env.GAME_START_COMMAND) ? env.GAME_START_COMMAND.trim() : `${prefix}${gameName}`,
    gameBotIds: list(env.GAME_BOT_IDS),
    autoStart: bool(env.AUTO_START, true),
    autoStartIntervalMs: num(env.AUTO_START_INTERVAL_SEC, 60) * 1000,
    gameIdleMs: num(env.GAME_IDLE_SEC, 45) * 1000,

    chatEnabled: bool(env.CHAT_ENABLED, true),
    chatReplyChance: Math.min(1, Math.max(0, num(env.CHAT_REPLY_CHANCE, 0.6))),
    chatCooldownMs: num(env.CHAT_COOLDOWN_SEC, 6) * 1000,
    historySize: num(env.HISTORY_SIZE, 16),

    pollMs: num(env.POLL_INTERVAL_MS, 1500),
    pollFastMs: num(env.POLL_FAST_MS, 1000),
    maxMessageAgeMs: num(env.MAX_MESSAGE_AGE_SEC, 20) * 1000,
    flagDelay: range(env.FLAG_DELAY_MS, [300, 700]),
    wordDelay: range(env.WORD_DELAY_MS, [200, 500]),
    chatDelay: range(env.CHAT_DELAY_MS, [1000, 3000]),
    maxSendsPerMin: num(env.MAX_SENDS_PER_MIN, 40),

    controlPrefix: has(env.CONTROL_PREFIX) ? env.CONTROL_PREFIX.trim() : "!bot",
    dryRun: bool(env.DRY_RUN, false),
    port: num(env.PORT, 0),
    logLevel: has(env.LOG_LEVEL) ? env.LOG_LEVEL : "info",
    aliases: loadAliases(path.join(__dirname, "..", "data", "aliases.json")),
  };
  return cfg;
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.token) problems.push("DISCORD_TOKEN ناقص");
  if (!/^\d{5,25}$/.test(cfg.channelId)) problems.push("CHANNEL_ID ناقص أو غلط (لازم أرقام فقط)");
  if (!cfg.aiKey) problems.push("GROQ_API_KEY ناقص (ملاحظة: الاسم الصحيح GROQ_API_KEY مو OPENAI_API_KEY)");
  return problems;
}

module.exports = { loadEnvFile, loadConfig, validateConfig };
