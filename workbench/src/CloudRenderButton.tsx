import React, { useState } from "react";
import { useStore } from "./store";

type CloudJob = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string;
  outputBytes?: number;
  runUrl?: string;
};

const TOKEN_KEY = "shotcraft-cloud-token-session";
const PROJECT_KEY = "shotcraft-cloud-project-id";
const API = "/api";
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const projectId = () => {
  let id = localStorage.getItem(PROJECT_KEY);
  if (!id) {
    id = "shotcraft-" + crypto.randomUUID().toLowerCase();
    localStorage.setItem(PROJECT_KEY, id);
  }
  return id;
};

const safeAssetPath = (value: string) => {
  const path = value.replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = path.split("/");
  if (!path || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
    throw new Error("Nama file media tidak valid: " + value);
  }
  return parts.join("/");
};

export const CloudRenderButton: React.FC = () => {
  const [job, setJob] = useState<CloudJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const request = async (path: string, init: RequestInit = {}) => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) throw new Error("Token Cloudflare belum diatur.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(API + path, { ...init, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    }
    return response;
  };

  const configureToken = () => {
    const value = window.prompt("Masukkan API_TOKEN Worker Cloudflare (minimal 24 karakter). Token hanya disimpan selama tab/sesi browser ini.");
    if (!value) return;
    if (value.length < 24) { window.alert("Token minimal 24 karakter."); return; }
    sessionStorage.setItem(TOKEN_KEY, value);
    setMessage("Token tersimpan sementara di sesi browser.");
  };

  const downloadOutput = async (id: string) => {
    const response = await request(`/jobs/${id}/output`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shotcraft-${id.slice(0, 8)}.mp4`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const start = async () => {
    if (!sessionStorage.getItem(TOKEN_KEY)) { configureToken(); return; }
    setBusy(true);
    setMessage("Menyimpan proyek dan menyiapkan aset…");
    try {
      const project = useStore.getState().project;
      const id = projectId();
      await request(`/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });

      // Upload semua file media yang direferensikan clip (video, gambar, audio).
      const files = new Set<string>();
      for (const track of project.tracks) for (const clip of track.clips) {
        const file = clip.props?.file;
        if (typeof file === "string" && file.trim()) files.add(safeAssetPath(file));
      }
      let uploaded = 0;
      for (const file of files) {
        setMessage(`Mengunggah aset ${++uploaded}/${files.size}: ${file}`);
        const source = await fetch("/" + file.split("/").map(encodeURIComponent).join("/"));
        if (!source.ok) throw new Error(`Aset tidak ditemukan di Workbench: ${file} (HTTP ${source.status})`);
        const blob = await source.blob();
        if (!blob.size) throw new Error(`Aset kosong: ${file}`);
        await request(`/projects/${id}/assets/${file.split("/").map(encodeURIComponent).join("/")}`, {
          method: "PUT",
          headers: { "Content-Type": blob.type || "application/octet-stream" },
          body: blob,
        });
      }

      setMessage("Mengirim pekerjaan render ke GitHub Actions…");
      const createdResponse = await request(`/projects/${id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crf: 20 }),
      });
      const created = await createdResponse.json();
      const newJob: CloudJob = created.job;
      if (!newJob?.id) throw new Error("Worker tidak mengembalikan ID render job.");
      setJob(newJob);
      setMessage("Render berjalan di cloud…");

      const deadline = Date.now() + 26 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const statusResponse = await request(`/jobs/${newJob.id}`);
        const latest: CloudJob = (await statusResponse.json()).job;
        setJob(latest);
        if (latest.status === "succeeded") {
          setMessage("Render selesai. Mengunduh MP4…");
          await downloadOutput(newJob.id);
          setMessage("Render selesai dan MP4 berhasil diunduh.");
          return;
        }
        if (latest.status === "failed") throw new Error(latest.error || "Render gagal. Periksa log GitHub Actions.");
        setMessage(latest.status === "queued" ? "Menunggu runner GitHub Actions…" : "Render sedang diproses di cloud…");
      }
      throw new Error("Waktu tunggu habis. Job mungkin masih berjalan; periksa status di GitHub Actions.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button className="btn" type="button" disabled={busy} onClick={start} title="Simpan proyek ke R2, render melalui GitHub Actions, lalu unduh MP4">
        {busy ? "Cloud render…" : job?.status === "succeeded" ? "Render cloud ✓" : "Cloud render"}
      </button>
      <button className="btn" type="button" disabled={busy} onClick={configureToken} title="Atur ulang token API sesi">Token</button>
      {message && <span role="status" aria-live="polite" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: job?.status === "failed" ? "#ff8078" : "var(--text-dim)" }}>{message}</span>}
      {job?.runUrl && <a href={job.runUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Log</a>}
    </div>
  );
};
