// Riset topik: membuat draft post Threads lewat Gemini.
// Hanya user yang sudah login yang boleh memanggil.
// format: "thread" (post berantai) atau "single" (1 post saja).

const MAX_TEXT = 500;
const MAX_POSTS = 8;

const BASE_RULES = `Kamu menulis draft post Threads untuk akun brand UMKM Bertumbuh (aplikasi untuk UMKM).
Aturan umum:
- Bahasa Indonesia santai, tidak menggurui, sudut pandang orang ketiga atau pelaku usaha yang bercerita.
- Hook di awal harus memancing emosi lewat masalah nyata yang dialami pemilik usaha.
- Setiap post maksimal 500 karakter. Jangan pakai hashtag.
- Jangan membuat angka atau klaim yang tidak bisa dipertanggungjawabkan. Jika memakai contoh angka, tulis sebagai ilustrasi.
- Jangan menyebut nama aplikasi atau promosi keras di post pertama.`;

const FORMAT_RULES = {
  thread: `Format: thread berantai, 4 sampai 6 post.
- Post 1: hook masalah.
- Post berikutnya: penyebab dan insight, satu gagasan per post.
- Post terakhir: pertanyaan ajakan diskusi.`,
  single: `Format: 1 post saja, dalam satu paragraf pendek sampai maksimal 500 karakter.
- Mulai dengan hook masalah, lalu tutup dengan pertanyaan ajakan diskusi.
- Hanya satu item di array posts.`,
};

export function buildSystem(format) {
  return `${BASE_RULES}\n${FORMAT_RULES[format] || FORMAT_RULES.thread}
Balas HANYA dengan JSON valid, tanpa teks lain, dengan format:
{"topic": "...", "posts": [{"text": "..."}], "image_idea": "..."}`;
}

export function buildUserMessage(brief, rejected) {
  const lines = [`Brief riset: ${brief.trim()}`];
  if (rejected.length) {
    lines.push("Topik berikut sudah ditolak, jangan dipakai lagi:");
    lines.push(...rejected.slice(-30).map((t) => `- ${t}`));
  }
  lines.push("Buat satu draft baru.");
  return lines.join("\n");
}

export function parseDraft(rawText, format) {
  // Ambil blok JSON pertama dari teks, membuang pagar ``` atau teks tambahan di sekitarnya.
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  let data;
  try {
    data = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new Error(`Balasan Gemini bukan JSON valid. Potongan balasan: ${rawText.slice(0, 200)}`);
  }
  const topic = String(data.topic || "").trim();
  const postsIn = Array.isArray(data.posts) ? data.posts : [];
  if (!topic) throw new Error("Draft tidak punya topik.");
  const max = format === "single" ? 1 : MAX_POSTS;
  if (postsIn.length < 1 || postsIn.length > max) {
    throw new Error(`Draft harus punya 1 sampai ${max} post.`);
  }
  const posts = postsIn.map((p, i) => {
    const text = String(p.text || "").trim();
    if (!text) throw new Error(`Post ${i + 1} kosong.`);
    if (text.length > MAX_TEXT) throw new Error(`Post ${i + 1} lebih dari ${MAX_TEXT} karakter.`);
    return { text };
  });
  return { topic, posts, image_idea: String(data.image_idea || "").trim() };
}

async function callGemini(system, userMessage) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 4000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`API Gemini gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const parts = body.candidates?.[0]?.content?.parts || [];
  // Lewati bagian "thought" (proses berpikir model), hanya ambil jawabannya.
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
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

  if (!process.env.GEMINI_API_KEY) {
    return json(500, { error: "GEMINI_API_KEY belum diset di Netlify." });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body harus JSON." });
  }
  const brief = String(body.brief || "");
  const rejected = Array.isArray(body.rejected) ? body.rejected.map(String).filter(Boolean) : [];
  const format = body.format === "single" ? "single" : "thread";
  if (!brief.trim()) return json(400, { error: "Isi brief riset dulu." });

  try {
    const text = await callGemini(buildSystem(format), buildUserMessage(brief, rejected));
    return json(200, { ok: true, draft: parseDraft(text, format) });
  } catch (err) {
    return json(502, { error: err.message });
  }
}
