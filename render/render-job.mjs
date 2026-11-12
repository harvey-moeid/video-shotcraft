// Sisi runner untuk satu render job (FASE 3). Dijalankan oleh .github/workflows/render.yml.
// Alur: lapor running -> ambil manifest + aset dari Worker -> remotion render (Main) -> unggah MP4.
// Env wajib: STUDIO_BASE_URL, STUDIO_API_TOKEN, JOB_ID, PROJECT_ID. Opsional: CRF (default 20).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.join(ROOT, "workbench");
const PUBLIC_DIR = path.join(WB, "public");
const OUT_DIR = path.join(WB, "out");

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const BASE = (process.env.STUDIO_BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STUDIO_API_TOKEN ?? "";
const JOB_ID = process.env.JOB_ID ?? "";
const PROJECT_ID = process.env.PROJECT_ID ?? "";
const CRF = Number(process.env.CRF ?? "20");
const RENDER_TIMEOUT_MS = 25 * 60 * 1000;

const log = (msg) => console.log(`[render-job] ${msg}`);

function fatalNoReport(msg) {
  console.error(`[render-job] ${msg}`);
  process.exit(1);
}

// Validasi input sebelum menyentuh jaringan/disk.
if (!BASE || !TOKEN) fatalNoReport("STUDIO_BASE_URL dan STUDIO_API_TOKEN wajib diisi (repo variable/secret)");
if (!JOB_ID_RE.test(JOB_ID)) fatalNoReport("JOB_ID tidak valid");
if (!PROJECT_ID_RE.test(PROJECT_ID)) fatalNoReport("PROJECT_ID tidak valid");
if (!Number.isInteger(CRF) || CRF < 15 || CRF > 35) fatalNoReport("CRF harus bilangan bulat 15-35");
{
  let u;
  try {
    u = new URL(BASE);
  } catch {
    fatalNoReport("STUDIO_BASE_URL bukan URL");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    fatalNoReport("STUDIO_BASE_URL harus https (kecuali localhost)");
  }
}

async function api(method, p, { body, headers } = {}) {
  return fetch(BASE + p, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(headers ?? {}) }, body });
}

async function patchJob(status, extra = {}) {
  const res = await api("PATCH", `/api/jobs/${JOB_ID}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, ...extra }),
  });
  if (!res.ok) throw new Error(`PATCH job ${status} gagal (HTTP ${res.status})`);
}

/** Jalankan perintah; simpan hanya ekor output supaya log pendek. */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d) => {
      tail = (tail + d.toString()).slice(-3000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), RENDER_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, tail: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, tail });
    });
  });
}

async function main() {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  await patchJob("running", runUrl && runUrl.startsWith("https://github.com/") ? { runUrl } : {});
  log(`job ${JOB_ID} running (project ${PROJECT_ID})`);

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });

  // 1) manifest proyek = ProjectData untuk komposisi Main
  const mRes = await api("GET", `/api/projects/${PROJECT_ID}`);
  if (!mRes.ok) throw new Error(`ambil manifest gagal (HTTP ${mRes.status})`);
  const project = await mRes.json();
  for (const k of ["fps", "width", "height"]) {
    if (typeof project?.[k] !== "number" || !(project[k] > 0)) throw new Error(`manifest tidak valid: ${k}`);
  }
  if (!Array.isArray(project.tracks)) throw new Error("manifest tidak valid: tracks");
  const propsFile = path.join(OUT_DIR, "props.json");
  writeFileSync(propsFile, JSON.stringify({ project, renderExact: true }));

  // 2) aset -> workbench/public/<name> (file nyata, bukan symlink)
  const lRes = await api("GET", `/api/projects/${PROJECT_ID}/assets`);
  if (!lRes.ok) throw new Error(`ambil daftar aset gagal (HTTP ${lRes.status})`);
  const { assets } = await lRes.json();
  let assetCount = 0;
  for (const a of assets ?? []) {
    const name = String(a?.name ?? "");
    if (!ASSET_NAME_RE.test(name)) throw new Error("nama aset tidak valid");
    const dest = path.join(PUBLIC_DIR, name);
    if (path.dirname(dest) !== PUBLIC_DIR) throw new Error("path aset tidak valid");
    const res = await api("GET", `/api/projects/${PROJECT_ID}/assets/${encodeURIComponent(name)}`);
    if (!res.ok || !res.body) throw new Error(`unduh aset gagal (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    assetCount++;
  }
  log(`manifest ok, ${assetCount} aset diunduh`);

  // 3) render
  const outFile = path.join(OUT_DIR, "output.mp4");
  const r = await run(
    "npx",
    [
      "remotion", "render", "src/remotion/index.ts", "Main", outFile,
      `--props=${propsFile}`, "--codec=h264", `--crf=${CRF}`,
    ],
    WB,
  );
  if (r.code !== 0) throw new Error(`remotion render gagal (exit ${r.code}): ${r.tail.slice(-400)}`);
  const size = statSync(outFile).size;
  if (size <= 0) throw new Error("output kosong");
  log(`render ok, ${size} byte`);

  // 4) unggah
  const up = await api("PUT", `/api/jobs/${JOB_ID}/output`, {
    headers: { "content-type": "video/mp4" },
    body: readFileSync(outFile),
  });
  if (!up.ok) throw new Error(`unggah output gagal (HTTP ${up.status})`);
  log("output diunggah, job succeeded");
}

try {
  await main();
} catch (e) {
  const msg = String(e?.message ?? e).slice(0, 500);
  console.error(`[render-job] GAGAL: ${msg}`);
  try {
    await patchJob("failed", { error: msg });
  } catch (e2) {
    console.error(`[render-job] gagal melapor: ${String(e2?.message ?? e2)}`);
  }
  process.exit(1);
}
