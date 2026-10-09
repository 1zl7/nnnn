"use strict";

const http = require("http");
const pkg = require("./package.json");
const { loadEnvFile, loadConfig, validateConfig } = require("./src/config");
const { createLogger, C } = require("./src/log");
const { Bot } = require("./src/bot");
const { sleep, backoff } = require("./src/http");

loadEnvFile();
const cfg = loadConfig();
const log = createLogger(cfg.logLevel);

console.log(`\n${C.magenta}╔════════════════════════════════════╗
║  🤖 Discord AI Bot v${pkg.version.padEnd(14)}║
║  اعلام + اسرع + كلام طبيعي         ║
╚════════════════════════════════════╝${C.reset}\n`);

const problems = validateConfig(cfg);
if (problems.length) {
  problems.forEach((p) => log.error(p));
  log.info("انسخ .env.example إلى .env واملأ القيم، أو أضفها في Variables عند الاستضافة.", "ℹ️");
  process.exit(1);
}

if (cfg.tokenType === "user") {
  log.warn("تستخدم توكن حساب شخصي (self-bot): هذا يخالف شروط ديسكورد وممكن ينحظر الحساب. الأفضل حساب ثانوي.");
}
log.info(`أمر بدء اللعبة: ${cfg.startCommand}`, "🎮");

const bot = new Bot(cfg, log);

if (cfg.port) {
  http
    .createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
      if (req.url === "/stats") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(bot.snapshot())); }
      res.writeHead(404); res.end();
    })
    .listen(cfg.port, "0.0.0.0", () => log.info(`health: http://0.0.0.0:${cfg.port}/health`, "🩺"));
}

let stopping = false;
const shutdown = (sig) => {
  if (stopping) return;
  stopping = true;
  log.info(`${sig}: يقفل بهدوء... ${JSON.stringify(bot.snapshot())}`, "👋");
  bot.stop();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => log.error(`unhandledRejection: ${e?.message || e}`));
process.on("uncaughtException", (e) => { log.error(`uncaughtException: ${e?.stack || e}`); process.exit(1); });

(async () => {
  let attempt = 0;
  while (!stopping) {
    try {
      await bot.start();
      if (stopping) break;
    } catch (e) {
      if (e.fatal) {
        log.error(`خطأ قاتل (ما راح أعيد المحاولة): ${e.message}`);
        if (e.status === 401) log.info("التوكن غلط أو منتهي. جدّده وحطه في DISCORD_TOKEN / GROQ_API_KEY.", "ℹ️");
        process.exit(1);
      }
      attempt++;
      const wait = Math.min(backoff(attempt, 1000, 60000), 60000);
      log.error(`توقف البوت: ${e.message} — يعيد التشغيل بعد ${(wait / 1000).toFixed(0)} ثانية`);
      await sleep(wait);
    }
  }
})();
