// Riset topik: membuat draft thread lewat Gemini (jika GEMINI_API_KEY diset)
// atau Anthropic (jika ANTHROPIC_API_KEY diset). Hanya user yang sudah login yang boleh memanggil.

const SYSTEM = `Kamu menulis draft thread Threads untuk akun brand UMKM Bertumbuh (aplikasi untuk UMKM).
Aturan:
- Bahasa Indonesia santai, tidak menggurui, sudut pandang orang ketiga atau pelaku usaha yang bercerita.
- Post 1 adalah hook yang memancing emosi (masalah nyata yang dialami pemilik usaha).
- Post berikutnya menjelaskan penyebab dan insight, lalu post terakhir berupa pertanyaan ajakan diskusi.
- Setiap post maksimal 500 karakter. Jangan pakai hashtag.
- Jangan membuat angka atau klaim yang tidak bisa dipertanggungjawabkan. Jika memakai contoh angka, tulis sebagai ilustrasi.
- Jangan menyebut nama aplikasi atau promosi keras di post pertama.
Balas HANYA dengan JSON valid, tanpa teks lain, dengan format:
{"topic": "...", "posts": [{"text": "..."}, ...], "image_idea": "..."}`;

const MAX_TEXT = 500;
const MAX_POSTS = 8;

export function buildUserMessage(brief, rejected) {
  const lines = [`Brief riset: ${brief.trim()}`];
  if (rejected.length) {
    lines.push("Topik berikut sudah ditolak, jangan dipakai lagi:");
    lines.push(...rejected.slice(-30).map((t) => `- ${t}`));
  }
  lines.push("Buat satu draft thread baru.");
  return lines.join("\n");
}

export function parseDraft(rawText) {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Balasan AI bukan JSON valid.");
  }
  const topic = String(data.topic || "").trim();
  const postsIn = Array.isArray(data.posts) ? data.posts : [];
  if (!topic) throw new Error("Draft tidak punya topik.");
  if (postsIn.length < 1 || postsIn.length > MAX_POSTS) {
    throw new Error(`Draft harus punya 1 sampai ${MAX_POSTS} post.`);
  }
  const posts = postsIn.map((p, i) => {
    const text = String(p.text || "").trim();
    if (!text) throw new Error(`Post ${i + 1} kosong.`);
    if (text.length > MAX_TEXT) throw new Error(`Post ${i + 1} lebih dari ${MAX_TEXT} karakter.`);
    return { text };
  });
  return { topic, posts, image_idea: String(data.image_idea || "").trim() };
}

async function callGemini(userMessage) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 1500, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`API Gemini gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const parts = body.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

async function callAnthropic(userMessage) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`API Anthropic gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Memastikan token yang dikirim browser adalah user yang sudah login di Supabase.
async function requireUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Gunakan POST." });

  const user = await requireUser(req);
  if (!user) return json(401, { error: "Login dulu." });

  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "GEMINI_API_KEY atau ANTHROPIC_API_KEY belum diset di Netlify." });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body harus JSON." });
  }
  const brief = String(body.brief || "");
  const rejected = Array.isArray(body.rejected) ? body.rejected.map(String).filter(Boolean) : [];
  if (!brief.trim()) return json(400, { error: "Isi brief riset dulu." });

  try {
    const userMessage = buildUserMessage(brief, rejected);
    const text = process.env.GEMINI_API_KEY
      ? await callGemini(userMessage)
      : await callAnthropic(userMessage);
    return json(200, { ok: true, draft: parseDraft(text) });
  } catch (err) {
    return json(502, { error: err.message });
  }
}
