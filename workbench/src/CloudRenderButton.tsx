import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";

type CloudJob = {
  id: string; projectId: string; status: "queued" | "running" | "succeeded" | "failed";
  crf: number; createdAt: string; updatedAt: string; error?: string; outputBytes?: number; runUrl?: string;
};
type CloudProject = { id: string; name: string; updatedAt?: string };
const TOKEN_KEY = "shotcraft-cloud-token-session";
const PROJECT_KEY = "shotcraft-cloud-project-id";
const API = "/api";
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const makeProjectId = () => "shotcraft-" + crypto.randomUUID().toLowerCase();
const safeAssetName = (name: string) => {
  const clean = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-110);
  if (!clean || !/^[A-Za-z0-9]/.test(clean)) throw new Error("Nama file tidak valid.");
  return "uploads/" + Date.now().toString(36) + "-" + clean;
};
const contentTypeFor = (file: File) => {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",
    mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4",mp4:"video/mp4",webm:"video/webm",
  };
  return types[ext ?? ""] ?? "";
};
const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

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

  const saveToken = () => {
    if (tokenDraft.length < 24) { setMessage("Token harus minimal 24 karakter."); return; }
    sessionStorage.setItem(TOKEN_KEY, tokenDraft);
    setToken(tokenDraft); setTokenDraft(""); setShowToken(false);
    setMessage("Token disimpan di sesi tab ini.");
  };

  const loadProjectsAndJobs = useCallback(async () => {
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    try {
      const [pr, jr] = await Promise.all([request("/projects"), request("/jobs")]);
      const pData = await pr.json() as { projects: string[] };
      const jData = await jr.json() as { jobs: string[] };
      const projectRows = await Promise.all((pData.projects ?? []).map(async (id) => {
        try {
          const r = await request(`/projects/${encodeURIComponent(id)}`);
          const manifest = await r.json();
          return { id, name: typeof manifest.name === "string" ? manifest.name : id } as CloudProject;
        } catch { return { id, name: id } as CloudProject; }
      }));
      const jobRows = await Promise.all((jData.jobs ?? []).map(async (id) => {
        try { const r = await request(`/jobs/${id}`); return (await r.json()).job as CloudJob; }
        catch { return null; }
      }));
      setProjects(projectRows.sort((a,b) => a.name.localeCompare(b.name)));
      setJobs(jobRows.filter((j): j is CloudJob => !!j).sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
      if (!selectedProject && projectRows[0]) {
        setSelectedProject(projectRows[0].id); localStorage.setItem(PROJECT_KEY, projectRows[0].id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [request, selectedProject]);

  useEffect(() => { void loadProjectsAndJobs(); }, [loadProjectsAndJobs]);

  const ensureProject = async () => {
    const id = selectedProject || makeProjectId();
    if (!selectedProject) { setSelectedProject(id); localStorage.setItem(PROJECT_KEY, id); }
    const project = useStore.getState().project;
    await request(`/projects/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project),
    });
    return id;
  };

  const createProject = async () => {
    setBusy(true);
    try {
      const id = makeProjectId();
      const project = useStore.getState().project;
      await request(`/projects/${id}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(project) });
      setSelectedProject(id); localStorage.setItem(PROJECT_KEY,id);
      setMessage("Proyek cloud baru dibuat.");
      await loadProjectsAndJobs();
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const switchProject = async (id: string) => {
    setSelectedProject(id); localStorage.setItem(PROJECT_KEY,id);
    if (!id) return;
    setBusy(true);
    try {
      const response = await request(`/projects/${encodeURIComponent(id)}`);
      const manifest = await response.json();
      if (!manifest || !Array.isArray(manifest.tracks)) throw new Error("Manifest proyek tidak valid.");
      useStore.getState().setProject(manifest);
      const ar = await request(`/projects/${encodeURIComponent(id)}/assets`);
      const data = await ar.json() as { assets?: {name:string}[] };
      setAssets((data.assets ?? []).map(a => a.name));
      setMessage(`Proyek "${manifest.name || id}" dibuka.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const downloadOutput = async (id: string) => {
    const response = await request(`/jobs/${id}/output`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `shotcraft-${id.slice(0,8)}.mp4`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const id = await ensureProject();
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const type = contentTypeFor(file);
        if (!["image/png","image/jpeg","image/webp","image/gif","audio/mpeg","audio/wav","audio/ogg","audio/mp4","video/mp4","video/webm"].includes(type))
          throw new Error(`Format tidak didukung: ${file.name}`);
        if (!file.size || file.size > 50 * 1024 * 1024) throw new Error(`Ukuran file harus 1 byte–50 MB: ${file.name}`);
        const name = safeAssetName(file.name);
        setMessage(`Mengunggah ${file.name}…`);
        await request(`/projects/${encodeURIComponent(id)}/assets/${encodePath(name)}`, {
          method:"PUT", headers:{"Content-Type":type}, body:file,
        });
        const objectUrl = URL.createObjectURL(file);
        const registry = ((window as Window & { __shotcraftCloudMedia?: Record<string,string> }).__shotcraftCloudMedia ??= {});
        registry[name] = objectUrl;
        uploaded.push(name);
        const cardId = type.startsWith("image/") ? "image-clip" : type.startsWith("video/") ? "video-clip" : "audio-clip";
        const duration = cardId === "video-clip" ? 150 : cardId === "image-clip" ? 90 : Math.max(90, Math.round((file.size / 16000) * 30));
        useStore.getState().addClip(cardId, undefined, undefined, { props:{file:name}, label:file.name, duration });
      }
      setAssets(prev => [...new Set([...prev, ...uploaded])]);
      setMessage(`${uploaded.length} aset diunggah dan ditambahkan ke timeline.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const start = async () => {
    setBusy(true);
    try {
      const id = await ensureProject();
      setMessage("Mengirim render cloud…");
      const createdResponse = await request(`/projects/${encodeURIComponent(id)}/render`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({crf}),
      });
      const created = await createdResponse.json();
      const newJob = created.job as CloudJob;
      if (!newJob?.id) throw new Error("Worker tidak mengembalikan ID job.");
      setMessage(`Job ${newJob.id.slice(0,8)} masuk antrean.`);
      await loadProjectsAndJobs();
      const deadline = Date.now() + 26 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const response = await request(`/jobs/${newJob.id}`);
        const latest = (await response.json()).job as CloudJob;
        setJobs(prev => [latest, ...prev.filter(j => j.id !== latest.id)]);
        if (latest.status === "succeeded") { setMessage("Render selesai. Mengunduh MP4…"); await downloadOutput(latest.id); setMessage("Render selesai dan MP4 diunduh."); return; }
        if (latest.status === "failed") throw new Error(latest.error || "Render gagal. Periksa log Actions.");
        setMessage(latest.status === "queued" ? "Menunggu runner GitHub Actions…" : "Render berjalan di cloud…");
      }
      throw new Error("Batas pemantauan tercapai. Job tetap tersimpan di daftar job cloud.");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="cloud-tools">
      <div className="cloud-toolbar">
        <button className="btn primary" type="button" disabled={busy || !token} onClick={start}>Cloud render</button>
        <label className="cloud-crf">CRF
          <select value={crf} onChange={e => setCrf(Number(e.target.value))} disabled={busy}>
            {[15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => fileRef.current?.click()}>＋ Upload media</button>
        <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4" hidden onChange={e => void uploadFiles(e.target.files)} />
        <button className="btn" type="button" onClick={() => setShowToken(v => !v)}>{token ? "Token ✓" : "Atur token"}</button>
      </div>
      {showToken && <div className="cloud-token-panel">
        <label htmlFor="cloud-token">API_TOKEN Worker (minimal 24 karakter)</label>
        <input id="cloud-token" type="password" autoComplete="off" value={tokenDraft} onChange={e => setTokenDraft(e.target.value)} placeholder="Tempel token di sini" />
        <button className="btn primary" type="button" onClick={saveToken}>Simpan token sesi</button>
        {token && <button className="btn" type="button" onClick={() => {sessionStorage.removeItem(TOKEN_KEY);setToken("");setMessage("Token sesi dihapus.");}}>Hapus token</button>}
      </div>}
      <div className="cloud-project-row">
        <label>Proyek cloud
          <select value={selectedProject} onChange={e => void switchProject(e.target.value)} disabled={busy || !token}>
            <option value="">Pilih proyek aktif</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.id.slice(0,12)}</option>)}
          </select>
        </label>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => void createProject()}>＋ Proyek baru</button>
        <button className="btn" type="button" disabled={busy || !token} onClick={() => void loadProjectsAndJobs()}>Refresh</button>
      </div>
      {assets.length > 0 && <div className="cloud-assets"><b>Aset cloud</b> · {assets.length} file <span>{assets.slice(-4).join(", ")}</span></div>}
      <div className="cloud-jobs">
        <b>Riwayat render ({jobs.length})</b>
        {jobs.slice(0,6).map(j => <div className="cloud-job" key={j.id}>
          <span className={`cloud-status ${j.status}`}>{j.status}</span>
          <span>{j.projectId.slice(0,18)} · CRF {j.crf}</span>
          <span>{new Date(j.createdAt).toLocaleString()}</span>
          {j.runUrl && <a href={j.runUrl} target="_blank" rel="noreferrer">Log</a>}
          {j.status === "succeeded" && <button className="mini" disabled={busy} onClick={() => void downloadOutput(j.id)}>Unduh</button>}
        </div>)}
      </div>
      {message && <div className="cloud-message" role="status" aria-live="polite">{message}</div>}
    </div>
  );
};
