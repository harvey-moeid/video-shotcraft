// Video Shotcraft Personal Edition — Worker API (FASE 2 + FASE 3).
// FASE 2: auth token statis, penyimpanan project manifest dan aset di R2.
// FASE 3: render job. Worker memicu workflow GitHub Actions (render.yml); runner mengambil
// manifest/aset lewat API ini, me-render MP4 dengan Remotion, lalu mengunggah hasilnya ke R2.

export interface Env {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Secret: token statis untuk seluruh /api/* (kecuali /api/health). */
  API_TOKEN: string;
  /** Secret: fine-grained PAT dengan izin Actions: write pada repo render. */
  GH_DISPATCH_TOKEN?: string;
  GH_OWNER?: string;
  GH_REPO?: string;
  GH_REF?: string;
  RENDER_WORKFLOW?: string;
  MAX_ASSET_BYTES?: string;
  MAX_MANIFEST_BYTES?: string;
  MAX_OUTPUT_BYTES?: string;
  MAX_ACTIVE_JOBS?: string;
  /** Hanya untuk uji lokal/CI: "1" melewati panggilan ke GitHub (job tetap queued). Jangan set di production. */
  DISPATCH_DRY_RUN?: string;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ASSET_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_ASSET_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
];

/** Job aktif yang lebih tua dari ini dianggap macet dan tidak dihitung (workflow timeout 30 menit). */
const ACTIVE_TTL_MS = 60 * 60 * 1000;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

function err(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function sha256(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** Perbandingan waktu-konstan lewat hash SHA-256 (panjang selalu sama). */
async function tokenValid(request: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN || env.API_TOKEN.length < 24) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !m[1]) return false;
  const [a, b] = await Promise.all([sha256(m[1]), sha256(env.API_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Baca body JSON kecil; kembalikan objek atau Response error. */
async function readSmallJson(request: Request, maxChars: number): Promise<Record<string, unknown> | Response> {
  const raw = await request.text();
  if (raw.length > maxChars) return err(413, "too_large", `body max ${maxChars} chars`);
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(400, "invalid_json", "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err(400, "invalid_body", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------- render jobs (FASE 3)

type JobStatus = "queued" | "running" | "succeeded" | "failed";

interface Job {
  id: string;
  projectId: string;
  status: JobStatus;
  crf: number;
  createdAt: string;
  updatedAt: string;
  runUrl?: string;
  error?: string;
  outputBytes?: number;
}

const jobKey = (id: string) => `jobs/${id}/job.json`;
const outputKey = (id: string) => `jobs/${id}/output.mp4`;
const activeKey = (id: string) => `active/${id}`;

async function readJob(env: Env, id: string): Promise<Job | null> {
  const obj = await env.BUCKET.get(jobKey(id));
  if (!obj) return null;
  try {
    return (await obj.json()) as Job;
  } catch {
    return null;
  }
}

async function writeJob(env: Env, job: Job): Promise<void> {
  await env.BUCKET.put(jobKey(job.id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Hitung job aktif; penanda macet (lebih tua dari TTL) dibersihkan. */
async function countActive(env: Env): Promise<number> {
  const listed = await env.BUCKET.list({ prefix: "active/", limit: 100 });
  const now = Date.now();
  let n = 0;
  for (const o of listed.objects) {
    if (now - o.uploaded.getTime() > ACTIVE_TTL_MS) await env.BUCKET.delete(o.key);
    else n++;
  }
  return n;
}

/** Kembalikan status HTTP dari GitHub (0 bila jaringan gagal). Token tidak pernah dicatat. */
async function dispatchWorkflow(env: Env, job: Job): Promise<number> {
  const owner = encodeURIComponent(env.GH_OWNER ?? "");
  const repo = encodeURIComponent(env.GH_REPO ?? "");
  const file = encodeURIComponent(env.RENDER_WORKFLOW ?? "render.yml");
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${file}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN ?? ""}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "video-shotcraft-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ref: env.GH_REF ?? "main",
        inputs: { job_id: job.id, project_id: job.projectId, crf: String(job.crf) },
      }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** POST /api/projects/:id/render  body opsional: { "crf": 15..35 } */
async function handleRender(request: Request, env: Env, projectId: string): Promise<Response> {
  if (request.method !== "POST") return err(405, "method_not_allowed", "POST only");

  const dryRun = env.DISPATCH_DRY_RUN === "1";
  if (!dryRun && !(env.GH_DISPATCH_TOKEN && env.GH_OWNER && env.GH_REPO)) {
    return err(503, "dispatch_not_configured", "render dispatch is not configured");
  }

  const manifest = await env.BUCKET.head(`projects/${projectId}/manifest.json`);
  if (!manifest) return err(404, "not_found", "project not found");

  const body = await readSmallJson(request, 1024);
  if (body instanceof Response) return body;
  let crf = 20;
  const rawCrf = body["crf"];
  if (rawCrf !== undefined) {
    if (typeof rawCrf !== "number" || !Number.isInteger(rawCrf) || rawCrf < 15 || rawCrf > 35) {
      return err(400, "invalid_crf", "crf must be an integer 15-35");
    }
    crf = rawCrf;
  }

  const maxActive = intVar(env.MAX_ACTIVE_JOBS, 1);
  if ((await countActive(env)) >= maxActive) {
    return err(429, "too_many_active_jobs", `max ${maxActive} active render job(s)`);
  }

  const now = new Date().toISOString();
  const job: Job = { id: crypto.randomUUID(), projectId, status: "queued", crf, createdAt: now, updatedAt: now };
  await env.BUCKET.put(activeKey(job.id), "", { customMetadata: { createdAt: now } });
  await writeJob(env, job);

  if (!dryRun) {
    const status = await dispatchWorkflow(env, job);
    if (status !== 204) {
      job.status = "failed";
      job.error = `GitHub dispatch failed (HTTP ${status})`;
      job.updatedAt = new Date().toISOString();
      await writeJob(env, job);
      await env.BUCKET.delete(activeKey(job.id));
      return err(502, "dispatch_failed", job.error);
    }
  }
  return json({ job }, 202);
}

async function handleJobs(request: Request, env: Env, parts: string[]): Promise<Response> {
  // GET /api/jobs  -> daftar id job
  if (parts.length === 0) {
    if (request.method !== "GET") return err(405, "method_not_allowed", "GET only");
    const listed = await env.BUCKET.list({ prefix: "jobs/", delimiter: "/", limit: 100 });
    const ids = listed.delimitedPrefixes.map((p) => p.slice("jobs/".length, -1));
    return json({ jobs: ids, truncated: listed.truncated });
  }

  const id = parts[0] ?? "";
  if (!JOB_ID.test(id)) return err(400, "invalid_job_id", "invalid job id");
  const job = await readJob(env, id);
  if (!job) return err(404, "not_found", "job not found");

  // /api/jobs/:id
  if (parts.length === 1) {
    if (request.method === "GET") return json({ job });

    if (request.method === "DELETE") {
      await Promise.all([
        env.BUCKET.delete(jobKey(id)),
        env.BUCKET.delete(outputKey(id)),
        env.BUCKET.delete(activeKey(id)),
      ]);
      return json({ ok: true, id });
    }

    // PATCH: dipakai runner untuk melaporkan running / failed.
    if (request.method === "PATCH") {
      if (job.status === "succeeded" || job.status === "failed") {
        return err(409, "job_finished", `job already ${job.status}`);
      }
      const body = await readSmallJson(request, 4096);
      if (body instanceof Response) return body;
      const next = body["status"];
      if (next !== "running" && next !== "failed") {
        return err(400, "invalid_status", "status must be running or failed");
      }
      const runUrl = body["runUrl"];
      if (runUrl !== undefined) {
        if (typeof runUrl !== "string" || !runUrl.startsWith("https://github.com/") || runUrl.length > 300) {
          return err(400, "invalid_run_url", "runUrl must be a github.com URL");
        }
        job.runUrl = runUrl;
      }
      const message = body["error"];
      if (message !== undefined) {
        if (typeof message !== "string") return err(400, "invalid_error", "error must be a string");
        job.error = message.slice(0, 500);
      }
      job.status = next;
      job.updatedAt = new Date().toISOString();
      await writeJob(env, job);
      if (next === "failed") await env.BUCKET.delete(activeKey(id));
      return json({ job });
    }
    return err(405, "method_not_allowed", "GET, PATCH, DELETE");
  }

  // /api/jobs/:id/output
  if (parts.length === 2 && parts[1] === "output") {
    if (request.method === "GET") {
      if (job.status !== "succeeded") return err(409, "not_ready", `job is ${job.status}`);
      const obj = await env.BUCKET.get(outputKey(id));
      if (!obj) return err(404, "not_found", "output not found");
      return new Response(obj.body, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(obj.size),
          etag: obj.httpEtag,
          "content-disposition": `attachment; filename="${job.projectId}-${id.slice(0, 8)}.mp4"`,
          ...SECURITY_HEADERS,
        },
      });
    }
    if (request.method === "PUT") {
      if (job.status !== "queued" && job.status !== "running") {
        return err(409, "job_finished", `job already ${job.status}`);
      }
      const maxOutput = intVar(env.MAX_OUTPUT_BYTES, 90 * 1024 * 1024);
      const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (type !== "video/mp4") return err(415, "unsupported_type", "content-type must be video/mp4");
      const declared = Number(request.headers.get("content-length") ?? "NaN");
      if (!Number.isFinite(declared) || declared <= 0) return err(411, "length_required", "content-length required");
      if (declared > maxOutput) return err(413, "too_large", `output max ${maxOutput} bytes`);
      if (!request.body) return err(400, "empty_body", "body required");
      await env.BUCKET.put(outputKey(id), request.body, {
        httpMetadata: { contentType: "video/mp4" },
        customMetadata: { uploadedAt: new Date().toISOString() },
      });
      job.status = "succeeded";
      job.outputBytes = declared;
      job.updatedAt = new Date().toISOString();
      delete job.error;
      await writeJob(env, job);
      await env.BUCKET.delete(activeKey(id));
      return json({ ok: true, id, bytes: declared });
    }
    return err(405, "method_not_allowed", "GET, PUT");
  }

  return err(404, "not_found", "unknown route");
}

// ---------------------------------------------------------------- projects (FASE 2)

async function handleProjects(request: Request, env: Env, parts: string[]): Promise<Response> {
  const maxManifest = intVar(env.MAX_MANIFEST_BYTES, 2 * 1024 * 1024);

  // GET /api/projects
  if (parts.length === 0) {
    if (request.method !== "GET") return err(405, "method_not_allowed", "GET only");
    const listed = await env.BUCKET.list({ prefix: "projects/", delimiter: "/", limit: 1000 });
    const ids = listed.delimitedPrefixes.map((p) => p.slice("projects/".length, -1));
    return json({ projects: ids, truncated: listed.truncated });
  }

  const id = parts[0] ?? "";
  if (!PROJECT_ID.test(id)) return err(400, "invalid_project_id", "id: a-z, 0-9, '-', 3-64 chars");
  const manifestKey = `projects/${id}/manifest.json`;

  // /api/projects/:id
  if (parts.length === 1) {
    if (request.method === "GET") {
      const obj = await env.BUCKET.get(manifestKey);
      if (!obj) return err(404, "not_found", "project not found");
      return new Response(obj.body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: obj.httpEtag,
          ...SECURITY_HEADERS,
        },
      });
    }
    if (request.method === "PUT") {
      const declared = Number(request.headers.get("content-length") ?? "NaN");
      if (!Number.isFinite(declared)) return err(411, "length_required", "content-length required");
      if (declared > maxManifest) return err(413, "too_large", `manifest max ${maxManifest} bytes`);
      const text = await request.text();
      if (text.length > maxManifest) return err(413, "too_large", `manifest max ${maxManifest} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return err(400, "invalid_json", "body must be JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return err(400, "invalid_manifest", "manifest must be a JSON object");
      }
      await env.BUCKET.put(manifestKey, text, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { updatedAt: new Date().toISOString() },
      });
      return json({ ok: true, id });
    }
    if (request.method === "DELETE") {
      await env.BUCKET.delete(manifestKey);
      return json({ ok: true, id });
    }
    return err(405, "method_not_allowed", "GET, PUT, DELETE");
  }

  // /api/projects/:id/render
  if (parts.length === 2 && parts[1] === "render") return handleRender(request, env, id);

  // /api/projects/:id/assets[/:name]
  if (parts[1] === "assets") {
    const prefix = `projects/${id}/assets/`;
    if (parts.length === 2) {
      if (request.method !== "GET") return err(405, "method_not_allowed", "GET only");
      const listed = await env.BUCKET.list({ prefix, limit: 1000 });
      return json({
        assets: listed.objects.map((o) => ({ name: o.key.slice(prefix.length), size: o.size })),
        truncated: listed.truncated,
      });
    }
    if (parts.length >= 3) {
      let name: string;
      try { name = parts.slice(2).map((part) => decodeURIComponent(part)).join("/"); }
      catch { return err(400, "invalid_asset_name", "invalid asset name"); }
      if (!ASSET_NAME.test(name)) return err(400, "invalid_asset_name", "invalid asset name");
      const key = prefix + name;
      if (request.method === "GET") {
        const obj = await env.BUCKET.get(key);
        if (!obj) return err(404, "not_found", "asset not found");
        return new Response(obj.body, {
          headers: {
            "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
            etag: obj.httpEtag,
            "content-disposition": "attachment",
            ...SECURITY_HEADERS,
          },
        });
      }
      if (request.method === "PUT") {
        const maxAsset = intVar(env.MAX_ASSET_BYTES, 50 * 1024 * 1024);
        const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        if (!ALLOWED_ASSET_TYPES.includes(type)) return err(415, "unsupported_type", "content-type not allowed");
        const declared = Number(request.headers.get("content-length") ?? "NaN");
        if (!Number.isFinite(declared) || declared <= 0) return err(411, "length_required", "content-length required");
        if (declared > maxAsset) return err(413, "too_large", `asset max ${maxAsset} bytes`);
        if (!request.body) return err(400, "empty_body", "body required");
        await env.BUCKET.put(key, request.body, {
          httpMetadata: { contentType: type },
          customMetadata: { uploadedAt: new Date().toISOString() },
        });
        return json({ ok: true, id, name });
      }
      if (request.method === "DELETE") {
        await env.BUCKET.delete(key);
        return json({ ok: true, id, name });
      }
      return err(405, "method_not_allowed", "GET, PUT, DELETE");
    }
  }

  return err(404, "not_found", "unknown route");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Semua non-API diserahkan ke Static Assets (workbench).
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "video-shotcraft", phase: 3 });
    }

    if (!(await tokenValid(request, env))) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "invalid or missing token" } }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer", ...SECURITY_HEADERS },
      });
    }

    const parts = url.pathname
      .slice("/api/".length)
      .split("/")
      .filter((p) => p.length > 0);

    try {
      if (parts[0] === "projects") return await handleProjects(request, env, parts.slice(1));
      if (parts[0] === "jobs") return await handleJobs(request, env, parts.slice(1));
      return err(404, "not_found", "unknown route");
    } catch (e) {
      console.error("api error", e instanceof Error ? e.message : String(e));
      return err(500, "internal_error", "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
