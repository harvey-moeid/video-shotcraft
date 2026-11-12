import React, { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { useMs, type MsKey } from "./mobileStrings";

/** Export lewat Worker (build produksi): PUT manifest -> POST render -> polling job -> unduh MP4.
 *  Dev server lokal tetap memakai alur Remotion lokal (lihat LocalExportButton di App.tsx). */

const TOKEN_KEY = "shotcraft-api-token"; // sessionStorage: hilang saat tab ditutup
const PROJECT_KEY = "shotcraft-cloud-project"; // localStorage: id proyek di R2
const JOB_KEY = "shotcraft-cloud-job"; // localStorage: job terakhir, supaya bisa dilanjutkan setelah reload
const POLL_MS = 3000;
const MAX_WAIT_MS = 40 * 60 * 1000;
const MAX_POLL_FAILS = 5;

type Step = "uploading" | "queued" | "rendering" | "downloading";
type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: Step }
  | { kind: "done"; jobId: string };

class AuthError extends Error {}

const session = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};
const local = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
const read = (s: Storage | undefined, key: string): string | null => {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (s: Storage | undefined, key: string, value: string | null) => {
  try {
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    /* penyimpanan penuh / mode privat: abaikan */
  }
};

const call = async (token: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  return res;
};

const serverMessage = async (res: Response): Promise<string> => {
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string } };
    return j?.error?.message ?? j?.error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const CloudExportButton: React.FC = () => {
  const ms = useMs();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const askToken = (): string | null => {
    const cached = read(session(), TOKEN_KEY);
    if (cached) return cached;
    const entered = window.prompt(ms("cloud.tokenPrompt"))?.trim();
    if (!entered) return null;
    write(session(), TOKEN_KEY, entered);
    return entered;
  };

  const fail = (e: unknown) => {
    if (!alive.current) return;
    setPhase({ kind: "idle" });
    let message: string;
    if (e instanceof AuthError) {
      write(session(), TOKEN_KEY, null);
      message = ms("cloud.unauthorized");
    } else {
      message = e instanceof Error ? e.message : String(e);
    }
    // alert (bukan tooltip): di layar sentuh tidak ada hover
    window.alert(`${ms("cloud.failed")}\n${message}`);
  };

  /** Polling sampai job selesai. Error jaringan sesaat (sinyal HP) ditoleransi beberapa kali. */
  const watch = async (token: string, jobId: string) => {
    const t0 = Date.now();
    let fails = 0;
    while (alive.current) {
      let res: Response | null = null;
      try {
        res = await call(token, `/api/jobs/${jobId}`);
        fails = 0;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (++fails >= MAX_POLL_FAILS) throw e;
      }
      if (res) {
        if (res.status === 404) {
          write(local(), JOB_KEY, null);
          setPhase({ kind: "idle" });
          return;
        }
        if (!res.ok) throw new Error(await serverMessage(res));
        const { job } = (await res.json()) as { job: { status: string; error?: string } };
        if (job.status === "succeeded") {
          if (alive.current) setPhase({ kind: "done", jobId });
          return;
        }
        if (job.status === "failed") {
          write(local(), JOB_KEY, null);
          throw new Error(job.error ?? "render failed");
        }
        if (alive.current) setPhase({ kind: "busy", step: job.status === "running" ? "rendering" : "queued" });
      }
      if (Date.now() - t0 > MAX_WAIT_MS) throw new Error(ms("cloud.timeout"));
      await sleep(POLL_MS);
    }
  };

  // Lanjutkan job yang sedang berjalan / sudah selesai setelah reload (mis. tab HP dibuang OS).
  useEffect(() => {
    const jobId = read(local(), JOB_KEY);
    const token = read(session(), TOKEN_KEY);
    if (!jobId || !token) return;
    setPhase({ kind: "busy", step: "queued" });
    watch(token, jobId).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    const token = askToken();
    if (!token) return;
    try {
      setPhase({ kind: "busy", step: "uploading" });
      let id = read(local(), PROJECT_KEY);
      if (!id || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
        id = `wb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        write(local(), PROJECT_KEY, id);
      }
      const put = await call(token, `/api/projects/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(useStore.getState().project),
      });
      if (!put.ok) throw new Error(await serverMessage(put));

      const rend = await call(token, `/api/projects/${id}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!rend.ok) throw new Error(await serverMessage(rend));
      const { job } = (await rend.json()) as { job: { id: string } };
      write(local(), JOB_KEY, job.id);

      setPhase({ kind: "busy", step: "queued" });
      await watch(token, job.id);
    } catch (e) {
      fail(e);
    }
  };

  const download = async (jobId: string) => {
    const token = askToken();
    if (!token) return;
    try {
      setPhase({ kind: "busy", step: "downloading" });
      const res = await call(token, `/api/jobs/${jobId}/output`);
      if (!res.ok) throw new Error(await serverMessage(res));
      const blob = await res.blob();
      const name = (useStore.getState().project.name || "video").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "video";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      if (alive.current) setPhase({ kind: "done", jobId });
    } catch (e) {
      fail(e);
    }
  };

  if (phase.kind === "busy")
    return (
      <button className="btn primary" disabled>
        {ms(`cloud.${phase.step}` as MsKey)}
      </button>
    );
  if (phase.kind === "done")
    return (
      <>
        <button className="btn primary" onClick={() => download(phase.jobId)}>
          {ms("cloud.done")}
        </button>
        <button className="btn" onClick={start}>
          {ms("cloud.again")}
        </button>
      </>
    );
  return (
    <button className="btn primary" title={ms("cloud.title")} onClick={start}>
      {ms("cloud.export")}
    </button>
  );
};
