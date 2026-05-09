const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const OpenAI = require("openai");
const gtts = require("node-gtts")("en");
const { Storage } = require("@google-cloud/storage");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
const MEMORY_OBJECT = "memory.json";

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const memoryFile = storage.bucket(BUCKET_ID).file(MEMORY_OBJECT);

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const judgePrompt = `
You are a strict memory filter.

Decide if the sentence is a real personal fact.

Save ONLY:
- name
- location
- preferences
- long-term info
- personal details
- facts about the user
Do NOT save:
- questions
- greetings
- nonsense
- incomplete sentences

Reply ONLY JSON:
{"save": true/false, "fact": "cleaned sentence"}
`;
// ========= helpers =========
function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\\/g, "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadMemory() {
  try {
    const [exists] = await memoryFile.exists();
    if (!exists) return [];
    const [buf] = await memoryFile.download();
    const parsed = JSON.parse(buf.toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("loadMemory error:", err.message);
    return [];
  }
}

async function saveMemory(memory) {
  try {
    await memoryFile.save(JSON.stringify(memory, null, 2), {
      contentType: "application/json",
      resumable: false,
    });
  } catch (err) {
    console.error("saveMemory error:", err.message);
  }
}

// ========= root =========
app.get("/", (req, res) => {
  res.send("AI Server Running");
});

// ========= CHAT (OpenRouter) =========
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = cleanText(req.body?.message || "");
    const normalized = userMessage
      .toLowerCase()
      .replace(/[.,!?]/g, "") // remove punctuation
      .trim();
    if (!userMessage) {
      return res.status(400).send("Empty message");
    }

    let memory = await loadMemory();

    if (normalized === "reset") {
      await saveMemory([]);
      return res.send("Memory cleared");
    }
    if (normalized === "remember") {
      return res.send("MEMORY_MODE");
    }
    if (normalized.startsWith("remember ")) {
      const fact = cleanText(userMessage.replace(/^remember\s+/i, ""));
      if (!fact) return res.send("Nothing to remember.");

      // 🧠 AI FILTER
      const judgeRes = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            messages: [
              { role: "system", content: judgePrompt },
              { role: "user", content: fact },
            ],
            max_tokens: 50,
            temperature: 0,
          }),
        },
      );

      const judgeData = await judgeRes.json();

      let decision;
      try {
        decision = JSON.parse(judgeData.choices[0].message.content);
      } catch {
        return res.send("Couldn't understand.");
      }

      // ❌ reject useless
      if (!decision.save) {
        return res.send("Say a real fact.");
      }

      const finalFact = decision.fact;

      // 🚫 DUPLICATE CHECK
      const normalizedFact = finalFact.toLowerCase().trim();

      const exists = memory.some((m) => {
        const existing = (m.content || "").toLowerCase().trim();
        return existing === normalizedFact;
      });

      if (exists) {
        return res.send("Already know that.");
      }

      // ✅ SAVE
      memory.push({ role: "user", content: finalFact });
      await saveMemory(memory);

      return res.send("Got it, saved.");
    }
    const messages = [
      {
        role: "system",
        content:
          "You are Luna, a personal AI assistant. Always respond in few sentences. Be concise and direct. Use user's memory if relevant.",
      },
      ...memory,
      { role: "user", content: userMessage },
    ];

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://replit.com",
          "X-Title": "ESP32 AI Voice Assistant",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages,
          max_tokens: 70,
          temperature: 0.7,
        }),
      },
    );

    const data = await response.json().catch(() => ({}));

    let reply = "AI error";
    if (response.ok && data?.choices?.[0]?.message?.content) {
      reply = data.choices[0].message.content;
    } else if (data?.error?.message) {
      reply = data.error.message;
    }

    reply = cleanText(reply);
    if (!reply) reply = "AI error";

    res.send(reply);
  } catch (err) {
    console.error("CHAT ERROR:", err.response?.data || err.message);
    res.status(500).send("Server error");
  }
});

// ========= TTS =========
// Accepts both:
// GET  /api/tts?text=Hello
// POST /api/tts { "text": "Hello" }
app.all("/api/tts", async (req, res) => {
  try {
    let text = "";

    if (req.method === "POST") {
      text = cleanText(req.body?.text || "");
    } else {
      text = cleanText(req.query.text || "");
    }

    if (!text) text = "Hello";

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
    const wavPath = path.join(tempDir, "voice.wav");

    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-filter:a",
      "volume=0.75",
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ]);

    const chunks = [];
    const ttsStream = gtts.stream(text);
    ttsStream.pipe(ffmpeg.stdin);

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));

    ffmpeg.stdout.on("end", () => {
      const wav = Buffer.concat(chunks);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Length", wav.length);
      res.end(wav);

      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    ffmpeg.stderr.on("data", () => {});
    ffmpeg.on("error", (err) => {
      console.error("ffmpeg error:", err.message);
      if (!res.headersSent) res.status(500).send("TTS Error");
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });
  } catch (err) {
    console.error("TTS ERROR:", err.message);
    res.status(500).send("TTS Error");
  }
});

// ========= STT =========
// ESP32 sends raw WAV bytes with Content-Type: audio/wav
app.post(
  "/api/stt",
  express.raw({
    type: ["audio/wav", "audio/x-wav", "application/octet-stream"],
    limit: "12mb",
  }),
  async (req, res) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-"));
    const wavPath = path.join(tempDir, "input.wav");

    try {
      if (!process.env.GROQ_API_KEY) {
        return res.status(500).send("Missing GROQ_API_KEY");
      }

      const audioBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body || []);

      if (!audioBuffer.length) {
        return res.status(400).send("No audio");
      }

      fs.writeFileSync(wavPath, audioBuffer);

      const result = await groq.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "whisper-large-v3-turbo",
        response_format: "text",
        language: "en",
        temperature: 0,
      });

      let transcript = typeof result === "string" ? result : result?.text || "";
      transcript = cleanText(transcript);
      if (transcript.toLowerCase().trim() === "Thank you.") {
        return res.send(""); // ignore fake input
      }
      res.send(transcript);
    } catch (err) {
      console.error("STT ERROR:", err.response?.data || err.message);
      res.status(500).send("STT Error");
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  },
);

// ========= MEMORY VIEW / EDIT =========
// JSON API: GET all memories
app.get("/api/memory", async (req, res) => {
  const memory = await loadMemory();
  res.json(memory);
});

// JSON API: replace entire memory list
app.put("/api/memory", async (req, res) => {
  const body = req.body;
  if (!Array.isArray(body)) {
    return res.status(400).json({ error: "Body must be an array" });
  }
  const cleaned = body
    .map((m) => ({
      role: "user",
      content: cleanText(typeof m === "string" ? m : m?.content || ""),
    }))
    .filter((m) => m.content);
  await saveMemory(cleaned);
  res.json({ ok: true, count: cleaned.length });
});

// JSON API: delete one memory by index
app.delete("/api/memory/:index", async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const memory = await loadMemory();
  if (isNaN(idx) || idx < 0 || idx >= memory.length) {
    return res.status(404).json({ error: "Index out of range" });
  }
  memory.splice(idx, 1);
  await saveMemory(memory);
  res.json({ ok: true, count: memory.length });
});

// Browser UI: view & edit memories
app.get("/memory", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Luna Memory</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;background:#0e0e10;color:#eee}
  h1{font-size:22px;margin:0 0 16px}
  .row{display:flex;gap:8px;margin:8px 0;align-items:center}
  input[type=text]{flex:1;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a1d;color:#eee;font-size:15px}
  button{padding:10px 14px;border-radius:8px;border:0;background:#5b8cff;color:#fff;cursor:pointer;font-size:14px}
  button.del{background:#c0392b}
  button.add{background:#27ae60}
  .empty{opacity:.6;font-style:italic;margin-top:20px}
  .hint{opacity:.6;font-size:13px;margin-bottom:14px}
</style></head>
<body>
<h1>Luna's Memory</h1>
<div class="hint">Edit any line, click Save. Delete with the X button. Add new facts at the bottom.</div>
<div id="list"></div>
<div class="row">
  <input type="text" id="newFact" placeholder="Add a new fact..."/>
  <button class="add" onclick="addFact()">Add</button>
</div>
<div class="row">
  <button onclick="saveAll()">Save All</button>
  <button onclick="load()">Reload</button>
</div>
<script>
let data = [];
async function load(){
  const r = await fetch('/api/memory');
  data = await r.json();
  render();
}
function render(){
  const list = document.getElementById('list');
  if(!data.length){ list.innerHTML = '<div class="empty">No memories saved yet.</div>'; return; }
  list.innerHTML = '';
  data.forEach((m,i)=>{
    const row = document.createElement('div');
    row.className = 'row';
    const inp = document.createElement('input');
    inp.type='text'; inp.value = m.content || '';
    inp.oninput = e => data[i].content = e.target.value;
    const del = document.createElement('button');
    del.className='del'; del.textContent='X';
    del.onclick = async () => {
      await fetch('/api/memory/'+i,{method:'DELETE'});
      load();
    };
    row.appendChild(inp); row.appendChild(del);
    list.appendChild(row);
  });
}
function addFact(){
  const v = document.getElementById('newFact').value.trim();
  if(!v) return;
  data.push({role:'user',content:v});
  document.getElementById('newFact').value='';
  render();
}
async function saveAll(){
  const r = await fetch('/api/memory',{
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(data)
  });
  const j = await r.json();
  alert('Saved '+j.count+' memories');
  load();
}
load();
</script>
</body></html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
