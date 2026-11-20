import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";

type CloudJob = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  crf: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  outputBytes?: number;
  runUrl?: string;
};
type CloudProject = { id: string; name: string };
type AssetListing = { assets?: { name: string }[] };
type MediaKind = "image" | "video" | "audio";

const TOKEN_KEY = "shotcraft-cloud-token-session";
const PROJECT_KEY = "shotcraft-cloud-project-id";
const API = "/api";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Kartu media dihitung dalam frame 30 fps (sourceFps kartu); store mengonversi ke fps proyek. */
const SOURCE_FPS = 30;

const MEDIA_TYPES = [
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
];
/** Sama dengan allowlist Worker (termasuk font untuk proyek lama). */
const ALLOWED_TYPES = [...MEDIA_TYPES, "font/woff2", "font/woff", "font/ttf", "font/otf"];

/** Beberapa browser/OS melaporkan MIME alternatif untuk format yang sama. */
const TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-ogg": "audio/ogg",
};

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const makeProjectId = () => "shotcraft-" + crypto.randomUUID().toLowerCase();
const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

const safeAssetName = (name: string) => {
  const clean = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-110)
    .replace(/^[^A-Za-z0-9]+/, "");
  if (!clean) throw new Error("Nama file tidak valid.");
  return "uploads/" + Date.now().toString(36) + "-" + clean;
};

/** Kembalikan MIME yang diizinkan Worker, atau string kosong bila tidak didukung. */
const contentTypeFor = (file: { name: string; type: string }): string => {
  const raw = ((file.type || "").split(";")[0] ?? "").trim().toLowerCase();
  const normalized = TYPE_ALIASES[raw] ?? raw;
  if (ALLOWED_TYPES.includes(normalized)) return normalized;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "";
};

/** Registry object URL media cloud; dibaca oleh kartu media (media-cards.tsx). */
const mediaRegistry = () =>
  ((window as Window & { __shotcraftCloudMedia?: Record<string, string> }).__shotcraftCloudMedia ??= {});

/** Durasi (detik) dari metadata media; null bila tidak terbaca dalam 5 detik. */
const probeDuration = (url: string, kind: "audio" | "video"): Promise<number | null> =>
  new Promise((resolve) => {
    const el = document.createElement(kind);
    let done = false;
    let timer = 0;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(value);
    };
    timer = window.setTimeout(() => finish(null), 5000);
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });

/** Ambil berkas aset: blob di registry (hasil upload/muat proyek) dulu, lalu path statis workbench. */
const readLocalAsset = async (file: string): Promise<Blob> => {
  const cached = mediaRegistry()[file];
  if (cached) {
    try {
      const r = await fetch(cached);
      if (r.ok) return await r.blob();
    } catch {
      /* object URL sudah dicabut: lanjut ke path statis */
    }
  }
  const source = await fetch("/" + encodePath(file));
  if (!source.ok) {
    throw new Error(`Aset lokal tidak ditemukan: ${file} (HTTP ${source.status}). Upload file dari browser terlebih dahulu.`);
  }
  const blob = await source.blob();
  // Dev server dapat mengembalikan index.html (200) untuk path yang tidak ada.
  if (blob.type.startsWith("text/html")) throw new Error(`Aset lokal tidak ditemukan: ${file}`);
  if (!blob.size) throw new Error(`Aset kosong: ${file}`);
  return blob;
};

export const CloudRenderButton: React.FC = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [tokenDraft, setTokenDraft] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [selectedProject, setSelectedProject] = useState(() => localStorage.getItem(PROJECT_KEY) ?? "");
  const [jobs, setJobs] = useState<CloudJob[]>([]);
  const [crf, setCrf] = useState(20);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [assets, setAssets] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const currentToken = sessionStorage.getItem(TOKEN_KEY);
    if (!currentToken) throw new Error("Masukkan API_TOKEN Worker terlebih dahulu.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${currentToken}`);
    const response = await fetch(API + path, { ...init, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    }
    return response;
  }, []);

  const rememberProject = (id: string) => {
    setSelectedProject(id);
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  };

  const saveToken = () => {
    if (tokenDraft.length < 24) {
      setMessage("Token harus minimal 24 karakter.");
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, tokenDraft);
    setToken(tokenDraft);
    setTokenDraft("");
    setShowToken(false);
    setMessage("Token disimpan di sesi tab ini.");
  };

  /**
   * Muat daftar proyek dan job. Sengaja TIDAK memilih proyek otomatis: proyek terpilih harus
   * selalu proyek yang manifest-nya sudah ada di editor, supaya PUT tidak menimpa proyek lain.
   */
  const loadProjectsAndJobs = useCallback(async () => {
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    try {
      const [pr, jr] = await Promise.all([request("/projects"), request("/jobs")]);
      const pData = (await pr.json()) as { projects?: string[] };
      const jData = (await jr.json()) as { jobs?: string[] };
      const projectRows = await Promise.all(
        (pData.projects ?? []).map(async (id): Promise<CloudProject> => {
          try {
            const r = await request(`/projects/${encodeURIComponent(id)}`);
            const m = await r.json();
            return { id, name: typeof m.name === "string" ? m.name : id };
          } catch {
            return { id, name: id };
          }
        }),
      );
      const jobRows = await Promise.all(
        (jData.jobs ?? []).map(async (id): Promise<CloudJob | null> => {
          try {
            const r = await request(`/jobs/${id}`);
            return (await r.json()).job as CloudJob;
          } catch {
            return null;
          }
        }),
      );
      setProjects(projectRows.sort((a, b) => a.name.localeCompare(b.name)));
      setJobs(jobRows.filter((j): j is CloudJob => !!j).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      setMessage(errText(e));
    }
  }, [request]);
  useEffect(() => {
    void loadProjectsAndJobs();
  }, [loadProjectsAndJobs, token]);

  const putManifest = async (id: string) => {
    const project = useStore.getState().project;
    await request(`/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    });
  };

  /** Simpan proyek editor ke proyek terpilih; bila belum ada, buat proyek baru (tidak menimpa yang lain). */
  const ensureProject = async () => {
    let id = selectedProject;
    if (!id) {
      id = makeProjectId();
      rememberProject(id);
      const name = useStore.getState().project.name || id;
      setProjects((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, name }]));
    }
    await putManifest(id);
    return id;
  };

  /** Unggah aset yang direferensikan klip tetapi belum ada di proyek cloud; kembalikan daftar aset lengkap. */
  const syncReferencedAssets = async (id: string): Promise<string[]> => {
    const project = useStore.getState().project;
    const referenced = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const f = clip.props?.file;
        if (typeof f === "string" && f.trim()) referenced.add(f.replace(/^\/+/, ""));
      }
    }
    const listing = (await (await request(`/projects/${encodeURIComponent(id)}/assets`)).json()) as AssetListing;
    const present = new Set((listing.assets ?? []).map((a) => a.name));
    for (const file of referenced) {
      if (present.has(file)) continue;
      if (file.split("/").some((part) => part === ".." || !part)) throw new Error(`Path aset tidak valid: ${file}`);
      const blob = await readLocalAsset(file);
      const type = contentTypeFor({ name: file, type: blob.type });
      if (!type) throw new Error(`Tipe aset tidak didukung: ${file}`);
      setMessage(`Sinkronisasi aset ${file}…`);
      await uploadBlob(id, file, blob, type);
      present.add(file);
    }
    return [...present];
  };

  const createProject = async () => {
    setBusy(true);
    try {
      const id = makeProjectId();
      await putManifest(id);
      rememberProject(id);
      setAssets([]);
      let note = "Proyek cloud baru dibuat.";
      try {
        setAssets(await syncReferencedAssets(id));
      } catch (e) {
        note = `Proyek dibuat, tetapi aset belum tersinkron: ${errText(e)}`;
      }
      setMessage(note);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
    await loadProjectsAndJobs();
  };

  /**
   * Buka proyek cloud. Urutan penting: manifest + blob aset dimuat dulu, baru registry diganti dan
   * setProject dipanggil (memicu render ulang preview). Proyek terpilih baru berubah setelah semua
   * berhasil, sehingga kegagalan tidak membuat editor dan proyek terpilih tidak sinkron.
   */
  const switchProject = async (id: string) => {
    if (!id) {
      rememberProject("");
      setAssets([]);
      return;
    }
    setBusy(true);
    try {
      const manifest = await (await request(`/projects/${encodeURIComponent(id)}`)).json();
      if (!manifest || !Array.isArray(manifest.tracks)) throw new Error("Manifest proyek tidak valid.");
      const listing = (await (await request(`/projects/${encodeURIComponent(id)}/assets`)).json()) as AssetListing;
      const names = (listing.assets ?? []).map((a) => a.name);
      const fresh: Record<string, string> = {};
      for (const name of names) {
        try {
          const r = await request(`/projects/${encodeURIComponent(id)}/assets/${encodePath(name)}`);
          fresh[name] = URL.createObjectURL(await r.blob());
        } catch {
          /* aset rusak dilaporkan saat render */
        }
      }
      const registry = mediaRegistry();
      for (const [name, url] of Object.entries(registry)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        delete registry[name];
      }
      Object.assign(registry, fresh);
      setAssets(names);
      useStore.getState().setProject(manifest);
      rememberProject(id);
      setMessage(`Proyek "${manifest.name || id}" dibuka.`);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadBlob = async (id: string, name: string, blob: Blob, type: string) => {
    await request(`/projects/${encodeURIComponent(id)}/assets/${encodePath(name)}`, {
      method: "PUT",
      headers: { "Content-Type": type },
      body: blob,
    });
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const id = await ensureProject();
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const type = contentTypeFor(file);
        if (!MEDIA_TYPES.includes(type)) throw new Error(`Format tidak didukung: ${file.name}`);
        if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(`Ukuran file harus 1 byte–50 MB: ${file.name}`);
        const name = safeAssetName(file.name);
        setMessage(`Mengunggah ${file.name}…`);
        await uploadBlob(id, name, file, type);
        const objectUrl = URL.createObjectURL(file);
        mediaRegistry()[name] = objectUrl;
        uploaded.push(name);

        const kind: MediaKind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : "audio";
        const seconds = kind === "image" ? null : await probeDuration(objectUrl, kind);
        const duration = seconds
          ? Math.max(1, Math.round(seconds * SOURCE_FPS))
          : kind === "image"
            ? 90
            : kind === "video"
              ? 150
              : Math.max(90, Math.round((file.size / 16000) * SOURCE_FPS));
        useStore.getState().addClip(`${kind}-clip`, undefined, undefined, {
          props: { file: name },
          label: file.name,
          duration,
        });
      }
      setAssets((prev) => [...new Set([...prev, ...uploaded])]);
      setMessage(`${uploaded.length} aset diunggah dan ditambahkan ke timeline.`);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
    await loadProjectsAndJobs();
  };

  const downloadOutput = async (id: string) => {
    const response = await request(`/jobs/${id}/output`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shotcraft-${id.slice(0, 8)}.mp4`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const start = async () => {
    setBusy(true);
    try {
      const id = await ensureProject();
      setAssets(await syncReferencedAssets(id));
      setMessage("Mengirim render cloud…");
      const createdResponse = await request(`/projects/${encodeURIComponent(id)}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crf }),
      });
      const created = await createdResponse.json();
      const newJob = created.job as CloudJob;
      if (!newJob?.id) throw new Error("Worker tidak mengembalikan ID job.");
      setJobs((prev) => [newJob, ...prev.filter((j) => j.id !== newJob.id)]);
      setMessage(`Job ${newJob.id.slice(0, 8)} masuk antrean.`);
      const deadline = Date.now() + 26 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const response = await request(`/jobs/${newJob.id}`);
        const latest = (await response.json()).job as CloudJob;
        setJobs((prev) => [latest, ...prev.filter((j) => j.id !== latest.id)]);
        if (latest.status === "succeeded") {
          setMessage("Render selesai. Mengunduh MP4…");
          await downloadOutput(latest.id);
          setMessage("Render selesai dan MP4 diunduh.");
          return;
        }
        if (latest.status === "failed") throw new Error(latest.error || "Render gagal. Periksa log Actions.");
        setMessage(latest.status === "queued" ? "Menunggu runner GitHub Actions…" : "Render berjalan di cloud…");
      }
      throw new Error("Batas pemantauan tercapai. Job tetap tersimpan di daftar job cloud.");
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
      void loadProjectsAndJobs();
    }
  };

  return (
    <div className="cloud-tools">
      <div className="cloud-toolbar">
        <button className="btn primary" type="button" disabled={busy || !token} onClick={start}>
          Cloud render
        </button>
        <label className="cloud-crf">
          CRF
          <select value={crf} onChange={(e) => setCrf(Number(e.target.value))} disabled={busy}>
            {Array.from({ length: 21 }, (_, i) => i + 15).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => fileRef.current?.click()}>
          ＋ Upload media
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4"
          hidden
          onChange={(e) => void uploadFiles(e.target.files)}
        />
        <button className="btn" type="button" onClick={() => setShowToken((v) => !v)}>
          {token ? "Token ✓" : "Atur token"}
        </button>
      </div>
      {showToken && (
        <div className="cloud-token-panel">
          <label htmlFor="cloud-token">API_TOKEN Worker (minimal 24 karakter)</label>
          <input
            id="cloud-token"
            type="password"
            autoComplete="off"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="Tempel token di sini"
          />
          <button className="btn primary" type="button" onClick={saveToken}>
            Simpan token sesi
          </button>
          {token && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                sessionStorage.removeItem(TOKEN_KEY);
                setToken("");
                setMessage("Token sesi dihapus.");
              }}
            >
              Hapus token
            </button>
          )}
        </div>
      )}
      <div className="cloud-project-row">
        <label>
          Proyek cloud
          <select value={selectedProject} onChange={(e) => void switchProject(e.target.value)} disabled={busy || !token}>
            <option value="">Pilih proyek aktif</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.id.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => void createProject()}>
          ＋ Proyek baru
        </button>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => void loadProjectsAndJobs()}>
          Refresh
        </button>
      </div>
      {assets.length > 0 && (
        <div className="cloud-assets">
          <b>Aset cloud</b> · {assets.length} file <span>{assets.slice(-4).join(", ")}</span>
        </div>
      )}
      <div className="cloud-jobs">
        <b>Riwayat render ({jobs.length})</b>
        {jobs.slice(0, 6).map((j) => (
          <div className="cloud-job" key={j.id}>
            <span className={`cloud-status ${j.status}`}>{j.status}</span>
            <span>
              {j.projectId.slice(0, 18)} · CRF {j.crf}
            </span>
            <span>{new Date(j.createdAt).toLocaleString()}</span>
            {j.runUrl && (
              <a href={j.runUrl} target="_blank" rel="noreferrer">
                Log
              </a>
            )}
            {j.status === "succeeded" && (
              <button className="mini" disabled={busy} onClick={() => void downloadOutput(j.id)}>
                Unduh
              </button>
            )}
          </div>
        ))}
      </div>
      {message && (
        <div className="cloud-message" role="status" aria-live="polite">
          {message}
        </div>
      )}
    </div>
  );
};
