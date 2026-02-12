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

    const combined = JSON.stringify(req.body).length;
    if (combined > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: "Input too large. Reduce world_summary/event_card/recent_memory." });
    }

    const payload = {
      session_id:clampString(req.body.session_id||"demo", 80),
      scene_type: req.body.scene_type,
      event_id: clampString(req.body.event_id, 200),
      world_summary: clampString(req.body.world_summary, 6000),
      event_card: clampString(req.body.event_card, 5000),
      recent_memory: clampString(req.body.recent_memory, 4000),
      player_input: clampString(req.body.player_input, 2000),
    };

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in .env" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: process.env.MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt(payload.scene_type) },
        { role: "user", content: buildUserPrompt(payload) },
      ],
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    const usage = completion.usage ?? null;

    return res.json({ text, usage });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});
// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`🚀 Diverge backend running on http://localhost:${PORT}`);
});