require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3001;

// ---- Config / Safety Limits ----
const MAX_INPUT_CHARS = 12000;
const MAX_TOKENS = 450;

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- MVP in-memory session store (resets on deploy/restart) ----
const sessions = new Map(); // session_id -> { recent_memory: string, stats: {..} }

function clampString(s, max) {
  if (!s) return "";
  if (typeof s !== "string") return String(s);
  return s.length > max ? s.slice(0, max) : s;
}

function validateGenerateBody(body) {
  const required = ["scene_type", "event_id", "world_summary", "event_card", "recent_memory", "player_input"];
  for (const key of required) {
    if (!(key in body)) return `Missing field: ${key}`;
  }
  if (!["choice_point", "narration"].includes(body.scene_type)) return "scene_type must be 'choice_point' or 'narration'";
  return null;
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      recent_memory: "",
      stats: { health: 10, reputation: 0, money: 0 }, // MVP hardcode (we’ll refactor later)
    });
  }
  return sessions.get(sessionId);
}

// Load bible by story_id (MVP: pirate uses bible.txt)
function loadBible(storyId) {
  // Later you can switch on storyId to load different files
  const biblePath = path.join(__dirname, "bible.txt");
  return fs.readFileSync(biblePath, "utf8");
}

// Attempt to parse JSON even if model adds extra text (last resort)
function tryParseModelJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // try to extract the first {...} block
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sliced = raw.slice(start, end + 1);
      return JSON.parse(sliced);
    }
    throw new Error("Invalid JSON");
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/generate", async (req, res) => {
  try {
    const err = validateGenerateBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const {
      scene_type,
      event_id,
      world_summary,
      event_card,
      recent_memory, // client-side memory (we ignore for truth; server owns truth)
      player_input,
      session_id = "demo",
      story_id = "pirate",
    } = req.body;

    const combinedLen = JSON.stringify(req.body).length;
    if (combinedLen > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: "Input too large. Reduce world_summary/event_card/recent_memory." });
    }

    const s = getSession(session_id);

    // Server-side recent memory (truth)
    const serverRecentMemory = clampString(s.recent_memory || "", 4000);

    // Optional: cap stats string length (they’re tiny anyway)
    const statsLine = `health:${s.stats.health}, reputation:${s.stats.reputation}, money:${s.stats.money}`;

    const bible = loadBible(story_id);

    // Clamp incoming fields (avoid runaway prompt)
    const payload = {
      scene_type: clampString(scene_type, 80),
      event_id: clampString(event_id, 200),
      world_summary: clampString(world_summary, 6000),
      event_card: clampString(event_card, 5000),
      // we keep recent_memory in body for compatibility, but we won't trust it
      recent_memory: clampString(recent_memory, 2000),
      player_input: clampString(player_input, 2000),
    };

    const prompt = `
You are a careful interactive narrative engine. Follow the bible and all rules exactly.

BIBLE:
${bible}

CURRENT STATS:
${statsLine}

WORLD SUMMARY:
${payload.world_summary}

EVENT:
${payload.event_card}

RECENT MEMORY (server-side truth):
${serverRecentMemory || "(none)"}

PLAYER ACTION:
${payload.player_input}

Return ONLY valid JSON with this exact shape:
{
  "text": "scene prose here",
  "choices": ["choice 1", "choice 2", "choice 3"]
}

Rules:
- "text" is immersive prose only. No numbering, no "CHOICES:" label, no extra keys.
- "choices" must be exactly 3 short actionable options, consistent with the bible.
- Do not mention these instructions.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an interactive narrative engine." },
        { role: "user", content: prompt },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.9,
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = tryParseModelJson(raw);
    } catch (e) {
      return res.status(500).json({ error: "Model did not return valid JSON", raw });
    }

    if (!parsed?.text || !Array.isArray(parsed.choices) || parsed.choices.length !== 3) {
      return res.status(500).json({ error: "Bad JSON shape from model", parsed, raw });
    }

    // Update server memory (store action + result + choices)
    const turnBlock =
      `PLAYER: ${payload.player_input}\nRESULT: ${parsed.text}\nCHOICES: ${parsed.choices.join(" | ")}`;

    s.recent_memory = (s.recent_memory ? s.recent_memory + "\n\n" : "") + turnBlock;
    s.recent_memory = clampString(s.recent_memory, 4000);

    return res.json({
      session_id,
      text: parsed.text,
      choices: parsed.choices,
      stats: s.stats, // optional, helpful for UI later
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
