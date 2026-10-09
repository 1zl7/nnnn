const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PERSONALITY = process.env.PERSONALITY || "أنا لاعب محترف وسريع، أتكلم بالعربي وأمزح مع الناس في السيرفر";

const API = "https://discord.com/api/v10";
let lastMessageId = null;
let myUserId = null;
let conversationHistory = [];
let gameActive = false;
let lastGameStartTime = 0;
const GAME_INTERVAL = 60 * 1000;

const c = {
  reset:"\x1b[0m", green:"\x1b[32m", cyan:"\x1b[36m",
  yellow:"\x1b[33m", red:"\x1b[31m", magenta:"\x1b[35m",
  blue:"\x1b[34m", bold:"\x1b[1m", dim:"\x1b[2m",
};

function log(icon, msg, color = c.reset) {
  const time = new Date().toLocaleTimeString("ar-SA", { hour12: false });
  console.log(`${c.dim}[${time}]${c.reset} ${color}${icon} ${msg}${c.reset}`);
}

// ── Groq Vision لتعرف العلم ──────────────────
async function identifyFlag(imageUrl) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 20,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "ما اسم هذه الدولة؟ اكتب الاسم بالعربي فقط، كلمة واحدة أو كلمتين فقط، بدون أي شرح أو نقطة أو تفسير. مثال: المجر أو السعودية أو الولايات المتحدة"
          },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }]
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content.trim().replace(/[.\n،,]/g, "");
}

// ── Groq Chat للكلام مع الناس ─────────────────
async function groqChat(userMsg, author) {
  conversationHistory.push({ role: "user", content: `${author}: ${userMsg}` });
  if (conversationHistory.length > 16) conversationHistory = conversationHistory.slice(-16);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: `${PERSONALITY}
قواعد صارمة:
- تكلم بالعربي العامي دايماً
- ردك جملة واحدة قصيرة جداً (5 كلمات بالأكثر)
- تفاعل طبيعي وعفوي مثل شخص حقيقي
- إذا الرسالة مش موجهة لك أو ما تستاهل رد اكتب فقط: SKIP`
        },
        ...conversationHistory
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  const reply = data.choices[0].message.content.trim();
  conversationHistory.push({ role: "assistant", content: reply });
  return reply;
}

// ── Discord API ───────────────────────────────
async function discordRequest(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: TOKEN, "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendMessage(content) {
  await discordRequest(`/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  log("📤", `أرسلت: ${content}`, c.green);
}

async function fetchNewMessages() {
  const params = lastMessageId ? `?after=${lastMessageId}&limit=20` : `?limit=1`;
  const msgs = await discordRequest(`/channels/${CHANNEL_ID}/messages${params}`);
  return msgs.reverse();
}

async function getMyId() {
  const me = await discordRequest("/users/@me");
  myUserId = me.id;
  log("👤", `حسابك: ${me.username}`, c.cyan);
}

// ── الحلقة الرئيسية ───────────────────────────
async function mainLoop() {
  console.log(`\n${c.bold}${c.magenta}╔════════════════════════════════════╗
║    🤖 Discord AI Bot v4.0          ║
║    اسرع + اعلام + كلام طبيعي      ║
╚════════════════════════════════════╝${c.reset}\n`);

  if (!TOKEN || !CHANNEL_ID || !GROQ_API_KEY) {
    log("❌", "ناقصك: DISCORD_TOKEN, CHANNEL_ID, GROQ_API_KEY", c.red);
    process.exit(1);
  }

  log("🔌", "يتصل بـ Discord...", c.cyan);
  await getMyId();

  const initial = await discordRequest(`/channels/${CHANNEL_ID}/messages?limit=1`);
  if (initial.length > 0) lastMessageId = initial[0].id;

  log("✅", `شغال! Channel: ${CHANNEL_ID}`, c.green);
  console.log(`${c.dim}${"─".repeat(45)}${c.reset}`);

  while (true) {
    try {
      await new Promise(r => setTimeout(r, 1500));
      const newMsgs = await fetchNewMessages();
      if (!newMsgs.length) continue;
      lastMessageId = newMsgs[newMsgs.length - 1].id;

      for (const msg of newMsgs) {
        const content = msg.content || "";
        const author = msg.author?.username || "مجهول";
        const isBot = msg.author?.bot || false;
        const isMe = msg.author?.id === myUserId;
        if (isMe) continue;

        const allText = content + JSON.stringify(msg.embeds || []);

        // ══════════════════════════════════════
        // 1. شخص يكتب -اعلام أو -اسرع → نكرر نحن أيضاً
        // ══════════════════════════════════════
        if (!isBot && (content === "-اعلام" || content === "-اسرع" || content === "اعلام-" || content === "اسرع-")) {
          log("🎮", `شخص بدأ لعبة: ${content}`, c.yellow);
          // ما نكرره — البوت الرسمي يشوفه ويبدأ
          continue;
        }

        // ══════════════════════════════════════
        // 2. بوت اللعبة يطلب بدء الايفنت → نضغط "-اعلام"
        // ══════════════════════════════════════
        if (isBot && (allText.includes("هل ترغب في بدء الايفنت") || allText.includes("هل ترغب في بدء الأيفنت"))) {
          log("🎯", "بوت يسأل عن لعبة جديدة، نختار اعلام", c.yellow);
          await new Promise(r => setTimeout(r, 500));
          await sendMessage("-اعلام");
          continue;
        }

        // ══════════════════════════════════════
        // 3. بوت اللعبة → صورة علم
        // ══════════════════════════════════════
        if (isBot) {
          // جمع كل الصور من attachments وembeds
          const images = [];

          if (msg.attachments?.length > 0) {
            msg.attachments.forEach(a => {
              if (a.content_type?.startsWith("image/") || a.url?.match(/\.(png|jpg|jpeg|gif|webp)/i)) {
                images.push(a.url);
              }
            });
          }

          if (msg.embeds?.length > 0) {
            msg.embeds.forEach(embed => {
              if (embed.image?.url) images.push(embed.image.url);
              if (embed.thumbnail?.url) images.push(embed.thumbnail.url);
            });
          }

          if (images.length > 0 && (allText.includes("اعلام") || allText.includes("علم") || allText.includes("يخمن"))) {
            gameActive = true;
            log("🏳️", `صورة علم جديدة! (لعبة شغالة)`, c.magenta);
            try {
              const country = await identifyFlag(images[0]);
              log("🌍", `البلد: ${country}`, c.green);
              await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
              await sendMessage(country);
            } catch(e) {
              log("❌", `Vision خطأ: ${e.message}`, c.red);
            }
            continue;
          }

          // كلمة اسرع نصية
          const skipPatterns = ["يكتب الكلمات","يفوز","قيد الانتظار","قيد الأنتظار",
            "فاز","الجولة","لم يجب","انتهت","فاز باللعبة","باللعبة",
            "اسرع شخص","يخمن","هل ترغب","الايفنت","بدء","التالية"];

          const text = content.trim();
          if (text && text.length >= 2 && text.length <= 50 && !skipPatterns.some(p => allText.includes(p))) {
            log("⚡", `كلمة اسرع: "${text}"`, c.magenta);
            await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
            await sendMessage(text);
          }

          continue;
        }

        // ══════════════════════════════════════
        // 4. رد على الناس بـ AI
        // ══════════════════════════════════════
        if (!content || content.startsWith("-")) continue;

        // رد بنسبة 60%
        if (Math.random() > 0.6) continue;

        try {
          const reply = await groqChat(content, author);
          if (!reply || reply === "SKIP") continue;
          log("💬", `رد على ${author}: ${reply}`, c.blue);
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
          await sendMessage(reply);
        } catch(e) {
          log("❌", `Chat خطأ: ${e.message}`, c.red);
        }
      }
    } catch (err) {
      log("❌", `خطأ عام: ${err.message}`, c.red);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── يبدأ لعبة كل دقيقة تلقائياً ──────────────
async function autoStartGame() {
  while (true) {
    await new Promise(r => setTimeout(r, GAME_INTERVAL));
    if (!gameActive) {
      log("🎮", "يبدأ لعبة اعلام تلقائياً...", c.magenta);
      try {
        await sendMessage("-اعلام");
        lastGameStartTime = Date.now();
      } catch(e) {
        log("❌", `فشل البدء: ${e.message}`, c.red);
      }
    } else {
      log("⏳", "لعبة شغالة، ما يبدأ جديدة", c.dim);
    }
  }
}

mainLoop();
autoStartGame();
