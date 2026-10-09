"use strict";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const C = useColor
  ? { reset: "\x1b[0m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m", dim: "\x1b[2m" }
  : { reset: "", green: "", cyan: "", yellow: "", red: "", magenta: "", blue: "", dim: "" };

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = "info") {
  const min = LEVELS[level] ?? LEVELS.info;
  const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
  const out = (lvl, icon, color, msg) => {
    if (LEVELS[lvl] < min) return;
    console.log(`${C.dim}[${stamp()}]${C.reset} ${color}${icon} ${msg}${C.reset}`);
  };
  return {
    C,
    debug: (m) => out("debug", "·", C.dim, m),
    info: (m, icon = "•", color = C.cyan) => out("info", icon, color, m),
    ok: (m) => out("info", "✅", C.green, m),
    warn: (m) => out("warn", "⚠️ ", C.yellow, m),
    error: (m) => out("error", "❌", C.red, m),
    game: (m) => out("info", "🎮", C.magenta, m),
    chat: (m) => out("info", "💬", C.blue, m),
    sent: (m) => out("info", "📤", C.green, m),
  };
}

module.exports = { createLogger, C };
