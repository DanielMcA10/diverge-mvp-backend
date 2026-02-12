// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const fs = require("fs")
const path = require ("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3001;

// ---- Config / Safety Limits ----
const MAX_INPUT_CHARS = 12000; // hard guard against runaway prompts
const MAX_TOKENS = 450; // keeps responses short (2–3 paragraphs)

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
  if (!["scene_only", "choice_point"].includes(body.scene_type)) {
    return "scene_type must be 'scene_only' or 'choice_point'";
  }
  return null;
}

function buildSystemPrompt(sceneType) {
  return `
You are the narrative engine for a text-only single-player pirate campaign.

MANDATORY RULES:
- Write immersive, literary prose. 2–3 paragraphs maximum.
- Never use tabletop / game-master tone. Never say “What do you do?”
- Foreground actionable objects clearly (do not hide interactables).
- Use descriptors over names; introduce at most ONE new proper name per response.
- Do not invent major plot beats beyond the provided event card.

TURN PROTOCOL (MANDATORY):
- If scene_type == scene_only: you may narrate the scene and end naturally.
- If scene_type == choice_point:
  - End narration after the final sentence.
  - DO NOT continue the story.
  - DO NOT narrate consequences.
  - Output MUST stop immediately.
  - End with the marker on its own line:
    [AWAIT PLAYER ACTION]

You must obey the Turn Protocol for the provided scene_type: ${sceneType}.
`.trim();
}

function buildUserPrompt({ event_id, world_summary, event_card, recent_memory, player_input }) {
  return `
WORLD SUMMARY:
${world_summary}

CURRENT EVENT CARD (FOLLOW THIS):
${event_card}

RECENT MEMORY (MOST RECENT LAST):
${recent_memory}

PLAYER INPUT:
${player_input}

Write the next response for event_id=${event_id}.
`.trim();
}

// ---- Routes ----
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
      recent_memory,
      player_input,
      session_id = "demo"
    } = req.body;

    // ---- Load Bible once ----
    const biblePath = path.join(__dirname, "bible.txt");
    const bible = fs.readFileSync(biblePath, "utf8");

    // ---- Build prompt ----
    const prompt = `
SYSTEM BIBLE:
${bible}

WORLD SUMMARY:
${world_summary}

EVENT:
${event_card}

RECENT MEMORY:
${recent_memory}

PLAYER ACTION:
${player_input}

Write the next scene in immersive prose.
Return ONLY story text.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an interactive narrative engine." },
        { role: "user", content: prompt }
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.9
    });

    const text = completion.choices[0]?.message?.content ?? "";

    return res.json({ text });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
});
// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`🚀 Diverge backend running on http://localhost:${PORT}`);
});