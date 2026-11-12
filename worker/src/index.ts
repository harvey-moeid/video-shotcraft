// Video Shotcraft Personal Edition — Worker API (FASE 2).
// Cakupan: auth token statis, penyimpanan project manifest dan aset di R2.
// Render job / callback ditambahkan di FASE 3 (feat/github-actions-renderer).

export interface Env {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Secret: token statis untuk seluruh /api/* (kecuali /api/health). */
  API_TOKEN: string;
  MAX_ASSET_BYTES?: string;
  MAX_MANIFEST_BYTES?: string;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
    if (parts.length === 3) {
      const name = parts[2] ?? "";
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
      return json({ ok: true, service: "video-shotcraft", phase: 2 });
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
      return err(404, "not_found", "unknown route");
    } catch (e) {
      console.error("api error", e instanceof Error ? e.message : String(e));
      return err(500, "internal_error", "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
