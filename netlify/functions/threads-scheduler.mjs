// Penjadwal Threads untuk Netlify Scheduled Function.
// Berjalan setiap menit. Setiap pemanggilan hanya melakukan SATU langkah per thread
// (buat container, atau publish), karena fungsi serverless punya batas waktu eksekusi.
// Jeda 30 detik sebelum publish dan 60 detik antar post dicek dari timestamp di database.

export const config = { schedule: "* * * * *" };

const GRAPH = "https://graph.threads.com/v1.0";
export const CONTAINER_WAIT_MS = 30_000;
export const REPLY_DELAY_MS = 60_000;

// Menentukan langkah berikutnya untuk satu thread. Fungsi murni, mudah diuji.
export function nextAction(thread, now) {
  if (thread.status === "done" || thread.status === "failed") return null;
  if (new Date(thread.scheduled_at) > now) return null;

  if (thread.step >= thread.posts.length) return { type: "finish" };

  if (thread.last_published_at) {
    const sincePublish = now - new Date(thread.last_published_at);
    if (sincePublish < REPLY_DELAY_MS) return null;
  }

  if (!thread.creation_id) return { type: "create", index: thread.step };

  const sinceCreate = now - new Date(thread.creation_at);
  if (sinceCreate < CONTAINER_WAIT_MS) return null;

  return { type: "publish", index: thread.step };
}

// Mengubah langkah menjadi perubahan yang akan disimpan ke database.
// Mengembalikan null jika tidak ada perubahan, atau objek patch untuk tabel scheduled_threads.
export function applyResult(action, thread, result, now) {
  if (action.type === "create") {
    return { creation_id: result.id, creation_at: now.toISOString(), status: "running" };
  }
  if (action.type === "publish") {
    return {
      step: thread.step + 1,
      last_post_id: result.id,
      last_published_at: now.toISOString(),
      creation_id: null,
      creation_at: null,
      status: thread.step + 1 >= thread.posts.length ? "done" : "running",
    };
  }
  if (action.type === "finish") {
    return { status: "done" };
  }
  return null;
}

// Membangun parameter request Graph API untuk setiap langkah.
export function buildRequest(action, thread, userId, token) {
  if (action.type === "create") {
    const post = thread.posts[action.index];
    const params = new URLSearchParams({ access_token: token });
    if (post.image_url) {
      params.set("media_type", "IMAGE");
      params.set("image_url", post.image_url);
      if (post.text) params.set("text", post.text);
    } else {
      params.set("media_type", "TEXT");
      params.set("text", post.text);
    }
    if (thread.last_post_id) params.set("reply_to_id", thread.last_post_id);
    return { url: `${GRAPH}/${userId}/threads?${params}`, method: "POST" };
  }
  if (action.type === "publish") {
    const params = new URLSearchParams({ access_token: token, creation_id: thread.creation_id });
    return { url: `${GRAPH}/${userId}/threads_publish?${params}`, method: "POST" };
  }
  return null;
}

async function sbFetch(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Key format lama (JWT, diawali "eyJ") dikirim juga sebagai Bearer.
  // Key format baru (sb_secret_...) hanya dikirim lewat header apikey.
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...(options.headers || {}),
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${base}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler() {
  const now = new Date();
  const userId = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!userId || !token) return new Response("Token atau ID belum diset", { status: 500 });

  const due = await sbFetch(
    `scheduled_threads?status=in.(scheduled,running)&scheduled_at=lte.${now.toISOString()}&order=scheduled_at.asc`
  );

  const log = [];
  for (const thread of due) {
    const action = nextAction(thread, now);
    if (!action) continue;

    if (action.type === "finish") {
      await sbFetch(`scheduled_threads?id=eq.${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      });
      log.push(`${thread.id}: selesai`);
      continue;
    }

    try {
      const req = buildRequest(action, thread, userId, token);
      const res = await fetch(req.url, { method: req.method });
      const body = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 300));

      const patch = applyResult(action, thread, body, now);
      await sbFetch(`scheduled_threads?id=eq.${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...patch, error: null }),
      });
      log.push(`${thread.id}: ${action.type} post ${action.index + 1} ok`);
    } catch (err) {
      await sbFetch(`scheduled_threads?id=eq.${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "failed", error: String(err.message || err) }),
      });
      log.push(`${thread.id}: GAGAL ${err.message}`);
    }
  }

  return new Response(log.join("\n") || "tidak ada yang jatuh tempo", { status: 200 });
}
