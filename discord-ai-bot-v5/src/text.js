"use strict";

// ── تطبيع النص العربي (للمقارنة فقط، مو للإرسال) ──────────────
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g; // تشكيل + تطويل

function normAr(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

const norm = (arr) => [...new Set(arr.map(normAr))];

// نفس قوائم الكود القديم، بس بعد التطبيع (أ/ا و ة/ه ما تفرق)
const START_PROMPTS = norm(["هل ترغب في بدء الايفنت", "هل ترغب في بدء الأيفنت"]);
const FLAG_KEYWORDS = norm(["اعلام", "علم", "يخمن"]);
const SKIP_WORDS = norm([
  "يكتب الكلمات", "يفوز", "قيد الانتظار", "قيد الأنتظار", "فاز", "الجولة", "لم يجب",
  "انتهت", "فاز باللعبة", "باللعبة", "اسرع شخص", "يخمن", "هل ترغب", "الايفنت", "بدء", "التالية",
]);

const hasAny = (normalizedText, patterns) => patterns.some((p) => normalizedText.includes(p));

// ── استخراج نص الرسالة + الـ embeds ────────────────────────────
function extractText(msg) {
  const parts = [msg.content || ""];
  for (const e of msg.embeds || []) {
    parts.push(e.title, e.description, e.author?.name, e.footer?.text);
    for (const f of e.fields || []) parts.push(f.name, f.value);
  }
  return parts.filter(Boolean).join("\n");
}

function extractImages(msg) {
  const out = [];
  for (const a of msg.attachments || []) {
    if (a.content_type?.startsWith("image/") || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url || "")) out.push(a.url);
  }
  for (const e of msg.embeds || []) {
    if (e.image?.url) out.push(e.image.url);
    if (e.thumbnail?.url) out.push(e.thumbnail.url);
  }
  return [...new Set(out.filter(Boolean))];
}

// مفتاح الكاش: الرابط بدون التوقيع (?ex=..&hm=..)
const urlKey = (u) => String(u).split(/[?#]/)[0];

// ── لعبة اسرع: كلمة نظيفة؟ ─────────────────────────────────────
function stripMarkdownWrap(s) {
  let t = String(s).trim().replace(/^```[a-z]*\n?|\n?```$/gi, "").trim();
  for (let i = 0; i < 3; i++) t = t.replace(/^([*_~`|]{1,3})(.+?)\1$/u, "$2").trim();
  return t;
}

function looksLikeWordPrompt(t) {
  if (!t || t.length < 2 || t.length > 50) return false;
  if (/\n/.test(t)) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/<(?:@|#|a?:)/.test(t)) return false; // منشن أو ايموجي مخصص
  return true;
}

// ── تنظيف جواب العلم ───────────────────────────────────────────
function stripThink(s) {
  let t = String(s ?? "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<think>/i.test(t)) return ""; // تفكير ما خلص = جواب ناقص
  return t.trim();
}

function cleanCountryAnswer(raw, aliases = {}) {
  let s = stripThink(raw).split(/\r?\n/)[0] ?? "";
  s = s.replace(DIACRITICS, "");
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  s = s.replace(/[*_`~"'«»“”‘’:؛,،.!؟?\-–—|<>]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:هذا|هذه|هو|هي)\s+/u, "");
  s = s.replace(/^(?:علم|راية|رايه)\s+(?:دولة\s+)?/u, "").replace(/^دولة\s+/u, "");
  s = s.split(" ").slice(0, 4).join(" ").trim();
  if (!/[\u0600-\u06FF]/.test(s)) return ""; // لازم عربي
  const alias = aliases[normAr(s)];
  return alias ? String(alias) : s;
}

// ── تنظيف رد الدردشة (حماية من البرومبت-إنجكشن) ─────────────────
function sanitizeChatReply(raw, maxLen = 160) {
  let s = stripThink(raw);
  s = s.replace(/https?:\/\/\S+|www\.\S+|discord\.gg\/\S+/gi, "");
  s = s.replace(/<(?:@[!&]?|#)\d+>/g, "");
  s = s.replace(/@(everyone|here)/gi, "$1").replace(/@/g, "");
  s = s.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[\w\u0600-\u06FF.\-]{1,32}\s*:\s+/u, ""); // "أحمد: ..." لو الموديل قلّد الصيغة
  s = s.replace(/^["“«]+|["”»]+$/g, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s+\S*$/, "");
  return s;
}

const isSkip = (s) => /^\W*skip\W*$/i.test(String(s).trim());

// رسالة الناس → نص نظيف للموديل
function cleanIncoming(content, myId) {
  return String(content)
    .replace(new RegExp(`<@!?${myId}>`, "g"), "")
    .replace(/<@[!&]?\d+>/g, "@مستخدم")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  normAr, hasAny, START_PROMPTS, FLAG_KEYWORDS, SKIP_WORDS,
  extractText, extractImages, urlKey, stripMarkdownWrap, looksLikeWordPrompt,
  stripThink, cleanCountryAnswer, sanitizeChatReply, isSkip, cleanIncoming,
};
