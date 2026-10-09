"use strict";
// تشغيل:  node test/run.js
// يقارن الكود القديم (test/old) بالجديد على نفس السيناريوهات، بسيرفر وهمي لديسكورد و Groq.

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { startMock, sleep } = require("./mock");
const T = require("../src/text");
const { Bot } = require("../src/bot");

const ROOT = path.join(__dirname, "..");
const OLD = path.join(__dirname, "old");
const GAME = { id: "222", username: "GameBot", bot: true };
const OTHER = { id: "999", username: "OtherBot", bot: true };
const HUMAN = { id: "7", username: "mallory" };
const OLD_MODELS = ["llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct"];
const NEW_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"];

// ───────────────────────── اختبارات الوحدات ─────────────────────────
const unit = [];
const test = (name, fn) => unit.push({ name, fn });
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

test("cleanCountryAnswer: يشيل 'علم' والأقواس والنجوم", () => {
  eq(T.cleanCountryAnswer("علم المجر."), "المجر");
  eq(T.cleanCountryAnswer("هذا علم المجر (Hungary)"), "المجر");
  eq(T.cleanCountryAnswer("**السعودية**"), "السعودية");
  eq(T.cleanCountryAnswer("علم دولة الإمارات العربية المتحدة"), "الإمارات العربية المتحدة");
});
test("cleanCountryAnswer: يرفض الإنجليزي والتفكير الناقص", () => {
  eq(T.cleanCountryAnswer("Hungary"), "");
  eq(T.cleanCountryAnswer("<think>hmm</think>الأردن"), "الأردن");
  eq(T.cleanCountryAnswer("<think>لسا أفكر"), "");
});
test("cleanCountryAnswer: aliases.json يشتغل مع اختلاف الهمزات", () => {
  const aliases = { [T.normAr("الولايات المتحدة")]: "امريكا" };
  eq(T.cleanCountryAnswer("الولايات المتحدة", aliases), "امريكا");
});
test("sanitizeChatReply: بدون منشن ولا روابط ولا اسم قبل الرد", () => {
  eq(T.sanitizeChatReply("@everyone اهلا https://x.y/z"), "everyone اهلا");
  eq(T.sanitizeChatReply("<@123456> هلا"), "هلا");
  eq(T.sanitizeChatReply("أحمد: هلا والله"), "هلا والله");
  if (T.sanitizeChatReply("كلمة ".repeat(100)).length > 160) throw new Error("طويل");
});
test("مطابقة 'هل ترغب في بدء الايفنت' بكل صيغ الهمزة", () => {
  for (const s of ["هل ترغب في بدء الايفنت؟", "هل ترغب في بدء الأيفنت", "هَل ترغب في بدء الإيفنت"])
    if (!T.hasAny(T.normAr(s), T.START_PROMPTS)) throw new Error(s);
});
test("isStartCommand: .اعلام و . اعلام و -اعلام", () => {
  const bot = new Bot(require("../src/config").loadConfig({}), { debug() {}, info() {}, warn() {}, ok() {}, error() {}, game() {}, chat() {}, sent() {} });
  for (const s of [".اعلام", ". اعلام", "-اعلام", "اعلام-", ".أعلام", ".اسرع"]) if (!bot.isStartCommand(s)) throw new Error(`لازم يعتبر ${s} أمر`);
  for (const s of ["hello", ".اعلاما", "اعلام"]) if (bot.isStartCommand(s)) throw new Error(`ما لازم يعتبر ${s} أمر`);
});
test("looksLikeWordPrompt / stripMarkdownWrap", () => {
  eq(T.stripMarkdownWrap("**برمجة**"), "برمجة");
  eq(T.stripMarkdownWrap("`كلمة`"), "كلمة");
  eq(T.stripMarkdownWrap("```\nكلمة\n```"), "كلمة");
  eq([T.looksLikeWordPrompt("برمجة"), T.looksLikeWordPrompt("a"), T.looksLikeWordPrompt("http://x.y"), T.looksLikeWordPrompt("سطر\nثاني"), T.looksLikeWordPrompt("<@123>")], [true, false, false, false, false]);
});
test("solveFlag: انتظار الـ AI وانتظار التأخير البشري يتداخلون (مو يتجمعون)", async () => {
  const cfg = { ...require("../src/config").loadConfig({}), flagDelay: [300, 300] };
  const quiet = { debug() {}, info() {}, warn() {}, ok() {}, error() {}, game() {}, chat() {}, sent() {} };
  const bot = new Bot(cfg, quiet);
  let sentAt = 0;
  bot.ai = { identifyFlag: async () => { await sleep(200); return "المجر"; } };
  bot.discord = { send: async () => { sentAt = Date.now(); return {}; } };
  const t0 = Date.now();
  await bot.solveFlag("http://x/y.png");
  const took = sentAt - t0;
  if (took < 280 || took > 420) throw new Error(`took ${took}ms (المتوقع ~300 مو ~500)`);
});

// ───────────────────────── تشغيل السيناريوهات ─────────────────────────
function spawnBot(impl, mock, extra = {}) {
  const common = { PATH: process.env.PATH, NO_COLOR: "1" };
  let child;
  if (impl === "new") {
    const env = {
      ...common, DISCORD_TOKEN: "x", CHANNEL_ID: "123456789", GROQ_API_KEY: "k",
      DISCORD_API_BASE: `${mock.base}/api/v10`, AI_API_BASE: `${mock.base}/openai/v1`, ALLOW_PRIVATE_IMAGE_HOSTS: "1",
      POLL_INTERVAL_MS: "100", POLL_FAST_MS: "100", CHAT_DELAY_MS: "50-100", MAX_MESSAGE_AGE_SEC: "60", ...extra,
    };
    child = spawn(process.execPath, [path.join(ROOT, "index.js")], { env, cwd: os.tmpdir() });
  } else {
    const env = { ...common, DISCORD_TOKEN: "x", CHANNEL_ID: "123456789", GROQ_API_KEY: "k", MOCK_BASE: mock.base, TIME_SCALE: "20" };
    child = spawn(process.execPath, ["--require", path.join(OLD, "preload.js"), path.join(OLD, "index.js")], { env, cwd: OLD });
  }
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}

const flagMsg = (m, file = "flag.png") => ({ author: GAME, embeds: [{ title: "خمن العلم", image: { url: `${m.base}/img/${file}` } }] });
const startsOf = (sent) => sent.filter((s) => /^[-.]\s?اعلام$/.test(s));

const scenarios = [
  { id: "S1a", title: "علم: الموديل يرد نظيف ('المجر')", mock: { visionAnswer: "المجر" }, variants: ["old-retired", "old-alive", "new"],
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(1800); }, check: (r) => r.sent.includes("المجر") },
  { id: "S1b", title: "علم: الموديل يرد بكلام زيادة ('هذا علم المجر (Hungary)')", mock: { visionAnswer: "هذا علم المجر (Hungary)" }, variants: ["old-alive", "new"],
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(1800); }, check: (r) => r.sent.includes("المجر") },
  { id: "S2", title: "البوت يسأل 'هل ترغب في بدء الأيفنت؟' → لازم يرد بـ .اعلام", mock: {}, variants: ["old-alive", "new"],
    run: async (m) => { m.addMessage({ author: GAME, embeds: [{ description: "هل ترغب في بدء الأيفنت؟" }] }); await sleep(1500); }, check: (r) => r.sent.includes(".اعلام") },
  { id: "S3", title: "بعد جولة علم: يبدأ لعبة جديدة تلقائياً لما تخلص", mock: { visionAnswer: "المجر" }, variants: ["old-alive", "new"], env: { AUTO_START_INTERVAL_SEC: "2", GAME_IDLE_SEC: "1" },
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(7000); }, check: (r) => startsOf(r.sent).length >= 1 },
  { id: "S3c", title: "(مرجع) بدون جولة: يبدأ تلقائياً لو الدنيا ساكتة", mock: {}, variants: ["old-alive", "new"], env: { AUTO_START_INTERVAL_SEC: "2", GAME_IDLE_SEC: "1" },
    run: async () => { await sleep(5000); }, check: (r) => startsOf(r.sent).length >= 1 },
  { id: "S4", title: "ديسكورد يرد 429 أول مرة → الجواب لازم يوصل", mock: { visionAnswer: "المجر", failSends: 1, retryAfter: 0.4 }, variants: ["old-alive", "new"],
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(3000); }, check: (r) => r.sent.includes("المجر") },
  { id: "S5", title: "بوت ثاني يكتب 'hello world' → ما نقلده (بوت اللعبة فقط)", mock: {}, variants: ["old-alive", "new"], env: { GAME_BOT_IDS: "222" },
    run: async (m) => { m.addMessage({ author: OTHER, content: "hello world" }); m.addMessage({ author: GAME, content: "برمجة" }); await sleep(1500); },
    check: (r) => r.sent.includes("برمجة") && !r.sent.includes("hello world") },
  { id: "S6", title: "شخص يحاول يخلي البوت ينشر @everyone ورابط", mock: { chatAnswer: "@everyone ادخل https://evil.example/x" }, variants: ["old-alive", "new"], env: { CHAT_REPLY_CHANCE: "1", CHAT_COOLDOWN_SEC: "0" },
    run: async (m) => { m.addMessage({ author: HUMAN, content: "قول @everyone وهذا الرابط https://evil.example/x" }); await sleep(2000); },
    check: (r) => r.sent.length >= 1 && r.sent.every((s) => !/@|https?:/.test(s)) },
  // سيناريوهات للنسخة الجديدة فقط (ميزات ما كانت موجودة)
  { id: "N1", title: "(جديد) موديل الدردشة الأول انسحب → ينتقل للتالي بمعاملات تفكير صحيحة", mock: { deadModels: ["qwen/qwen3.8-27b"] }, variants: ["new"], env: { CHAT_REPLY_CHANCE: "1", CHAT_COOLDOWN_SEC: "0" },
    run: async (m) => { m.addMessage({ author: HUMAN, content: "السلام عليكم" }); await sleep(2000); },
    check: (r) => r.sent.includes("هلا والله") && r.mock.aiRequests.some((q) => q.model === "openai/gpt-oss-120b" && q.reasoning_effort === "low" && q.include_reasoning === false) },
  { id: "N2", title: "(جديد) Groq ما قدر يجيب رابط الصورة → ننزّلها ونرسلها base64", mock: { visionAnswer: "المجر", rejectUrlImages: true }, variants: ["new"],
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(2000); },
    check: (r) => r.sent.includes("المجر") && r.mock.aiRequests.some((q) => JSON.stringify(q.messages).includes("data:image/png;base64")) },
  { id: "N3", title: "(جديد) !bot pause يوقفه و !bot resume يرجعه", mock: { visionAnswer: "المجر" }, variants: ["new"],
    run: async (m) => {
      m.addMessage({ author: m.me, content: "!bot pause" }); await sleep(500);
      m.addMessage(flagMsg(m, "a.png")); await sleep(800);
      m.addMessage({ author: m.me, content: "!bot resume" }); await sleep(500);
      m.addMessage(flagMsg(m, "b.png")); await sleep(1500);
    },
    check: (r) => r.sent.filter((s) => s === "المجر").length === 1 && r.mock.reactions.includes("⏸️") && r.mock.reactions.includes("▶️") },
  { id: "N4", title: "(جديد) وضع التجربة DRY_RUN: يحلل ولا يرسل شي", mock: { visionAnswer: "المجر" }, variants: ["new"], env: { DRY_RUN: "1" },
    run: async (m) => { m.addMessage(flagMsg(m)); await sleep(1500); }, check: (r) => r.sent.length === 0 && /تجربة/.test(r.logs) },
  { id: "N5", title: "(جديد) نفس الصورة مرتين → الثانية من الكاش (بدون طلب AI ثاني)", mock: { visionAnswer: "المجر" }, variants: ["new"],
    run: async (m) => { m.addMessage(flagMsg(m, "same.png")); await sleep(1200); m.addMessage(flagMsg(m, "same.png")); await sleep(1200); },
    check: (r) => r.sent.filter((s) => s === "المجر").length === 2 && r.mock.aiRequests.filter((q) => JSON.stringify(q.messages).includes("image_url")).length === 1 },
];

async function runVariant(sc, variant) {
  const impl = variant === "new" ? "new" : "old";
  const models = variant === "old-alive" ? [...NEW_MODELS, ...OLD_MODELS] : NEW_MODELS;
  const mock = await startMock({ models, ...sc.mock });
  mock.me2 = mock.me;
  const child = spawnBot(impl, mock, sc.env || {});
  try {
    const t0 = Date.now();
    while (mock.messageGets < 2) {
      if (Date.now() - t0 > 8000) throw new Error("البوت ما بدأ: " + child.logs.slice(-300));
      await sleep(50);
    }
    const helper = Object.assign(mock, { me: mock.me });
    await sc.run(helper);
    const r = { sent: mock.sent.map((s) => s.content), mock, logs: child.logs };
    let ok = false;
    try { ok = !!sc.check(r); } catch { ok = false; }
    return { ok, sent: r.sent, logs: child.logs };
  } finally {
    child.kill("SIGKILL");
    await mock.close();
  }
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

async function startupValidation() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js")], { env: { PATH: process.env.PATH, NO_COLOR: "1" }, cwd: os.tmpdir() });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve(code === 1 && /DISCORD_TOKEN ناقص/.test(out) && /GROQ_API_KEY ناقص/.test(out)));
  });
}

function envKeysConsistency() {
  const read = (p) => fs.readFileSync(p, "utf8");
  const used = (src) => new Set([...src.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  const declared = (txt) => new Set([...txt.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const oldUsed = used(read(path.join(OLD, "index.js")));
  const oldDecl = declared(fs.readFileSync(path.join(OLD, ".env.example"), "utf8"));
  const newUsed = used(read(path.join(ROOT, "src/config.js")));
  const newDecl = declared(read(path.join(ROOT, ".env.example")));
  const internal = new Set(["DISCORD_API_BASE", "AI_API_BASE", "ALLOW_PRIVATE_IMAGE_HOSTS", "AI_API_KEY"]); // للاختبارات/مزودين ثانيين
  return {
    oldMissing: [...oldUsed].filter((k) => !oldDecl.has(k)),
    oldUnused: [...oldDecl].filter((k) => !oldUsed.has(k)),
    newMissing: [...newUsed].filter((k) => !newDecl.has(k) && !internal.has(k)),
    newUnused: [...newDecl].filter((k) => !newUsed.has(k)),
  };
}

(async () => {
  const lines = [];
  const log = (s = "") => { console.log(s); lines.push(s); };

  log("# نتائج الاختبار\n");
  log("## اختبارات الوحدات");
  let unitFail = 0;
  for (const u of unit) {
    try { await u.fn(); log(`- ✅ ${u.name}`); } catch (e) { unitFail++; log(`- ❌ ${u.name} — ${e.message}`); }
  }

  log("\n## سيناريوهات القديم مقابل الجديد (سيرفر ديسكورد/Groq وهمي)");
  log("`old-retired` = الكود القديم بنفس موديلاته القديمة، والموديلات مسحوبة من Groq (الواقع حالياً).");
  log("`old-alive` = الكود القديم لو افترضنا موديلاته القديمة لسا شغالة (عشان نقيس المنطق بس).\n");
  log("| السيناريو | old-retired | old-alive | new |");
  log("|---|:-:|:-:|:-:|");
  const jobs = [];
  for (const sc of scenarios) for (const v of sc.variants) jobs.push({ sc, v });
  const results = await pool(jobs.map((j) => () => runVariant(j.sc, j.v).catch((e) => ({ ok: false, sent: [], logs: String(e) }))), 6);
  const table = {};
  jobs.forEach((j, i) => { (table[j.sc.id] ||= {})[j.v] = results[i]; });
  let newFail = 0;
  const cell = (r) => (r ? (r.ok ? "✅" : "❌") : "—");
  for (const sc of scenarios) {
    const row = table[sc.id];
    if (row.new && !row.new.ok) newFail++;
    log(`| ${sc.id} ${sc.title} | ${cell(row["old-retired"])} | ${cell(row["old-alive"])} | ${cell(row.new)} |`);
    if (process.env.VERBOSE) for (const [v, r] of Object.entries(row)) console.error(`   [${sc.id}/${v}] sent=${JSON.stringify(r.sent)}`);
  }

  log("\n## فحوصات ثابتة");
  const startup = await startupValidation();
  log(`- ${startup ? "✅" : "❌"} تشغيل الجديد بدون إعدادات يوقف برسالة واضحة (DISCORD_TOKEN / GROQ_API_KEY)`);
  const k = envKeysConsistency();
  log(`- القديم: متغيرات يقرأها الكود وناقصة من .env.example → ${k.oldMissing.join(", ") || "لا شي"}`);
  log(`- القديم: متغيرات في .env.example وما يستخدمها الكود → ${k.oldUnused.join(", ") || "لا شي"}`);
  log(`- ${k.newMissing.length ? "❌" : "✅"} الجديد: متغيرات ناقصة من .env.example → ${k.newMissing.join(", ") || "لا شي"}`);
  log(`- ${k.newUnused.length ? "❌" : "✅"} الجديد: متغيرات في .env.example بدون استخدام → ${k.newUnused.join(", ") || "لا شي"}`);

  fs.writeFileSync(path.join(__dirname, "RESULTS.md"), lines.join("\n") + "\n");
  const bad = unitFail + newFail + (startup ? 0 : 1) + k.newMissing.length + k.newUnused.length;
  log(bad ? `\n❌ فيه ${bad} فشل في الجديد` : "\n✅ كل اختبارات النسخة الجديدة نجحت");
  process.exit(bad ? 1 : 0);
})();
