// Uji end-to-end lokal (CI): Worker (wrangler dev, R2 lokal) + render-job.mjs asli + Remotion asli.
// Tidak menyentuh Cloudflare/GitHub. Env: E2E_BASE (default http://127.0.0.1:8787), E2E_TOKEN.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8787";
const TOKEN = process.env.E2E_TOKEN ?? "";
const PROJECT = "e2e-project";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const NESTED_ASSET = Buffer.from("video-shotcraft nested asset e2e");
const NESTED_ASSET_PATH = path.join(ROOT, "workbench", "public", "audio", "e2e-nested-test.wav");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failures++;
};
const req = (method, p, { headers = {}, body, noAuth = false } = {}) =>
  fetch(BASE + p, {
    method,
    headers: { ...(noAuth ? {} : { authorization: `Bearer ${TOKEN}` }), ...headers },
    body,
  });

let jobId = "";
try {
  // auth + health
  let r = await req("GET", "/api/health", { noAuth: true });
  const health = await r.json();
  check("health (tanpa token)", r.status === 200 && health.phase === 3, `status ${r.status}`);
  r = await req("GET", "/api/projects", { noAuth: true });
  check("tanpa token -> 401", r.status === 401, `status ${r.status}`);

  // proyek minimal + 1 aset
  const project = {
    name: "e2e", fps: 30, width: 640, height: 360,
    tracks: [{ id: "t1", name: "T", clips: [] }],
  };
  r = await req("PUT", `/api/projects/${PROJECT}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(project),
  });
  check("PUT manifest", r.status === 200, `status ${r.status}`);
  r = await req("PUT", `/api/projects/${PROJECT}/assets/e2e-pixel.png`, {
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  check("PUT aset", r.status === 200, `status ${r.status}`);
  r = await req("PUT", \`/api/projects/\${PROJECT}/assets/audio/e2e-nested-test.wav\`, {
    headers: { "content-type": "audio/wav" }, body: NESTED_ASSET,
  });
  check("PUT nested asset", r.status === 200, \`status \${r.status}\`);
  r = await req("GET", \`/api/projects/\${PROJECT}/assets/audio/e2e-nested-test.wav\`);
  const nested = Buffer.from(await r.arrayBuffer());
  check("GET nested asset", r.status === 200 && nested.equals(NESTED_ASSET), \`status \${r.status}\`);


  // validasi endpoint render
  r = await req("POST", "/api/projects/no-such-project/render");
  check("render proyek tak ada -> 404", r.status === 404, `status ${r.status}`);
  r = await req("POST", `/api/projects/${PROJECT}/render`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ crf: 99 }),
  });
  check("crf tidak valid -> 400", r.status === 400, `status ${r.status}`);
  r = await req("GET", `/api/projects/${PROJECT}/render`);
  check("GET render -> 405", r.status === 405, `status ${r.status}`);

  // buat job (dry-run: tidak memanggil GitHub)
  r = await req("POST", `/api/projects/${PROJECT}/render`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ crf: 28 }),
  });
  const created = await r.json();
  jobId = created?.job?.id ?? "";
  check("POST render -> 202 queued", r.status === 202 && created?.job?.status === "queued", `status ${r.status}`);

  r = await req("POST", `/api/projects/${PROJECT}/render`);
  check("job aktif kedua -> 429", r.status === 429, `status ${r.status}`);
  r = await req("GET", `/api/jobs/${jobId}/output`);
  check("output sebelum selesai -> 409", r.status === 409, `status ${r.status}`);

  // jalankan runner asli
  const run = spawnSync("node", ["render/render-job.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      STUDIO_BASE_URL: BASE, STUDIO_API_TOKEN: TOKEN,
      JOB_ID: jobId, PROJECT_ID: PROJECT, CRF: "28",
    },
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  check("render-job.mjs exit 0", run.status === 0, `exit ${run.status}\n${String(run.stdout).slice(-1200)}\n${String(run.stderr).slice(-1200)}`);
  const nestedOnDisk = existsSync(NESTED_ASSET_PATH) && readFileSync(NESTED_ASSET_PATH).equals(NESTED_ASSET);
  check("runner restores nested asset path", nestedOnDisk, NESTED_ASSET_PATH);


  r = await req("GET", `/api/jobs/${jobId}`);
  const done = (await r.json()).job;
  check("job succeeded + outputBytes", done?.status === "succeeded" && done?.outputBytes > 0, JSON.stringify(done));

  r = await req("GET", `/api/jobs/${jobId}/output`);
  const buf = Buffer.from(await r.arrayBuffer());
  check("output MP4 (ftyp)", r.status === 200 && buf.length > 0 && buf.subarray(4, 8).toString() === "ftyp", `status ${r.status}, ${buf.length} byte`);
  check("ukuran output = outputBytes", buf.length === done?.outputBytes, `${buf.length} vs ${done?.outputBytes}`);

  r = await req("PATCH", `/api/jobs/${jobId}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "failed" }),
  });
  check("job selesai tak bisa diubah -> 409", r.status === 409, `status ${r.status}`);

  // jalur gagal: job baru, lapor failed, penanda aktif harus lepas
  r = await req("POST", `/api/projects/${PROJECT}/render`);
  const second = (await r.json())?.job?.id ?? "";
  check("job kedua dibuat setelah yang pertama selesai", r.status === 202, `status ${r.status}`);
  r = await req("PATCH", `/api/jobs/${second}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "failed", error: "uji jalur gagal" }),
  });
  check("PATCH failed", r.status === 200, `status ${r.status}`);
  r = await req("POST", `/api/projects/${PROJECT}/render`);
  const third = (await r.json())?.job?.id ?? "";
  check("slot aktif lepas setelah failed", r.status === 202, `status ${r.status}`);
  for (const id of [second, third]) if (id) await req("DELETE", `/api/jobs/${id}`);
} catch (e) {
  check("e2e tanpa exception", false, String(e?.stack ?? e).slice(0, 600));
} finally {
  try {
    if (jobId) await req("DELETE", `/api/jobs/${jobId}`);
    await req("DELETE", `/api/projects/${PROJECT}/assets/e2e-pixel.png`);
    await req("DELETE", `/api/projects/${PROJECT}/assets/audio/e2e-nested-test.wav`);
    if (existsSync(NESTED_ASSET_PATH)) rmSync(NESTED_ASSET_PATH, { force: true });
    await req("DELETE", `/api/projects/${PROJECT}`);
  } catch {}
}

console.log(failures === 0 ? "E2E OK" : `E2E GAGAL: ${failures} pemeriksaan`);
process.exit(failures === 0 ? 0 : 1);
