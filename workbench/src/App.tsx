import React, { useEffect, useRef, useState } from "react";
import { LibraryPanel } from "./panels/LibraryPanel";
import { Inspector } from "./panels/Inspector";
import { PreviewPanel } from "./preview/PreviewPanel";
import { Timeline } from "./timeline/Timeline";
import { resetProject, useStore } from "./store";
import { seekTo, togglePlay } from "./playerRef";
import type { ProjectData } from "./types";
import { applyLocaleToDocument, LOCALES, useLocale, useT, type Locale, type StringKey } from "./i18n";
import type { ExportError } from "./export-errors";
import { CloudExportButton } from "./CloudExportButton";
import { useMs } from "./mobileStrings";
import "./mobile.css";

const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 面板尺寸：可拖拽调整，落 localStorage */
const usePanelSize = (key: string, def: number) => {
  const [v, setV] = useState<number>(() => {
    const s = localStorage.getItem(key);
    return s ? Number(s) : def;
  });
  useEffect(() => {
    localStorage.setItem(key, String(v));
  }, [key, v]);
  return [v, setV] as const;
};

/** 拖拽分隔条：pointerdown 后跟踪位移，交给回调换算尺寸 */
const startSplit = (
  e: React.PointerEvent,
  onMove: (dx: number, dy: number) => void,
) => {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const mm = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy);
  const up = () => window.removeEventListener("pointermove", mm);
  window.addEventListener("pointermove", mm);
  window.addEventListener("pointerup", up, { once: true });
};

/** Error dari dev server (ExportError) atau dari Worker ({ code, message }). */
type AnyExportError = { code: string; details?: string; message?: string };

/** Teks error yang selalu terisi: terjemahan i18n -> message dari server -> code mentah.
 *  t() mengembalikan undefined untuk key yang tidak ada (mis. "unauthorized" dari Worker),
 *  jadi harus ada fallback supaya alert tidak pernah menampilkan "undefined". */
const describeExportError = (
  t: (key: StringKey) => string,
  error: AnyExportError,
): string => {
  const base = t(`export.${error.code}` as StringKey) || error.message || error.code;
  return error.details ? `${base}\n${error.details}` : base;
};

/** 导出成片（本地 dev server）：提交当前工程给 dev server 的 Remotion 渲染任务，轮询进度 */
const LocalExportButton: React.FC = () => {
  const t = useT();
  const [job, setJob] = useState<{
    id: string;
    status: "running" | "done" | "error";
    progress: number;
    lastLine?: string;
    error?: ExportError;
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const poll = (id: string) => {
    timer.current = window.setInterval(async () => {
      const r = await fetch(`/api/export/${id}`);
      if (!r.ok) return;
      const j = await r.json();
      setJob({ id, ...j });
      if (j.status !== "running") window.clearInterval(timer.current);
    }, 1000);
  };

  const start = async () => {
    const project = useStore.getState().project;
    let r: Response;
    try {
      r = await fetch("/api/export", { method: "POST", body: JSON.stringify({ project }) });
    } catch {
      window.alert(t("export.startFailed"));
      return;
    }
    // Respons non-JSON (mis. 404 HTML dari static assets) tidak boleh membuat handler crash.
    const j = await r.json().catch(() => ({} as { id?: string; error?: AnyExportError }));
    if (!r.ok) {
      const error: AnyExportError | undefined = j.error;
      window.alert(
        error
          ? describeExportError(t, error)
          : `${t("export.startFailed")} (HTTP ${r.status})`,
      );
      return;
    }
    setJob({ id: j.id, status: "running", progress: 0 });
    poll(j.id);
  };

  useEffect(() => () => window.clearInterval(timer.current), []);

  if (job?.status === "running")
    return (
      <button className="btn primary" disabled>
        {t("export.running", { pct: Math.round(job.progress * 100) })}
      </button>
    );
  if (job?.status === "done")
    return (
      <>
        <button
          className="btn"
          title={t("export.revealTitle")}
          onClick={() => fetch(`/api/export/${job.id}/reveal`, { method: "POST" })}
        >
          {t("export.done")}
        </button>
        <button className="btn primary" onClick={start}>
          {t("export.again")}
        </button>
      </>
    );
  if (job?.status === "error") {
    const error = job.error ?? { code: "renderFailed" as const, details: job.lastLine };
    return (
      <button
        className="btn danger"
        title={describeExportError(t, error)}
        onClick={start}
      >
        {t("export.failedRetry")}
      </button>
    );
  }
  return (
    <button
      className="btn primary"
      title={t("export.title")}
      onClick={start}
    >
      {t("export.film")}
    </button>
  );
};

/** Dev (npm run dev): render lokal lewat Vite. Build produksi (workers.dev): render cloud lewat Worker. */
const ExportButton: React.FC = () => (import.meta.env.DEV ? <LocalExportButton /> : <CloudExportButton />);

type MobileTab = "library" | "inspector" | "timeline";

export const App: React.FC = () => {
  const t = useT();
  const ms = useMs();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  useEffect(() => applyLocaleToDocument(locale), [locale]);
  const project = useStore((s) => s.project);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const updateName = (name: string) =>
    useStore.setState((s) => ({ project: { ...s.project, name } }));
  const fileRef = useRef<HTMLInputElement>(null);
  const [libW, setLibW] = usePanelSize("wb-lib-w", 224);
  const [inspW, setInspW] = usePanelSize("wb-insp-w", 300);
  const [tlH, setTlH] = usePanelSize("wb-tl-h", 264);
  /** Hanya dipakai di layar sempit (CSS menyembunyikan panel lain); di desktop diabaikan. */
  const [mobileTab, setMobileTab] = useState<MobileTab>("timeline");

  // Setelah item ditambahkan dari library lewat tombol "+", tampilkan timeline di layar sempit.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const onAdded = () => {
      if (mq.matches) setMobileTab("timeline");
    };
    window.addEventListener("wb:clip-added", onAdded);
    return () => window.removeEventListener("wb:clip-added", onAdded);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const s = useStore.getState();
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (s.selectedClipId) s.removeClip(s.selectedClipId);
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        if (s.selectedClipId) s.splitClip(s.selectedClipId, s.playhead);
      } else if (e.key.toLowerCase() === "d" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (s.selectedClipId) s.duplicateClip(s.selectedClipId);
      } else if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        const f = Math.max(0, s.playhead + step);
        seekTo(f);
        s.setPlayhead(f);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name || "workbench-project"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (file: File) => {
    file.text().then((text) => {
      try {
        const p = JSON.parse(text) as ProjectData;
        if (!p || !Array.isArray(p.tracks)) throw new Error("bad format");
        useStore.getState().setProject(p);
      } catch {
        window.alert(t("import.invalid"));
      }
    });
  };

  const tabs: { id: MobileTab; icon: string; label: string }[] = [
    { id: "library", icon: "▦", label: ms("tab.library") },
    { id: "inspector", icon: "⚙", label: t("insp.title") },
    { id: "timeline", icon: "≣", label: ms("tab.timeline") },
  ];

  return (
    <div className="app" data-tab={mobileTab}>
      <header className="topbar">
        <span className="logo">ShotCraft <b>Workbench</b></span>
        <input
          className="project-name"
          value={project.name}
          onChange={(e) => updateName(e.target.value)}
          spellCheck={false}
        />
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!canUndo} onClick={undo} title={t("undo.title")}>
          {t("undo")}
        </button>
        <button className="btn" disabled={!canRedo} onClick={redo} title={t("redo.title")}>
          {t("redo")}
        </button>
        <span className="tl-sep" />
        <ExportButton />
        <button className="btn" onClick={exportJson}>{t("exportJson")}</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>{t("import")}</button>
        <button
          className="btn"
          onClick={() => window.confirm(t("reset.confirm")) && resetProject()}
        >
          {t("reset")}
        </button>
        <span className="tl-sep" />
        <select
          className="btn"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          title={t("lang.title")}
          aria-label={t("lang.title")}
        >
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = "";
          }}
        />
      </header>

      <main className="main">
        <div className="panel-wrap pw-lib" style={{ width: libW }}>
          <LibraryPanel />
        </div>
        <div
          className="splitter v"
          title={t("split.library")}
          onPointerDown={(e) => {
            const start = libW;
            startSplit(e, (dx) => setLibW(clamp(start + dx, 160, 440)));
          }}
        />
        <PreviewPanel />
        <div
          className="splitter v"
          title={t("split.inspector")}
          onPointerDown={(e) => {
            const start = inspW;
            startSplit(e, (dx) => setInspW(clamp(start - dx, 220, 500)));
          }}
        />
        <div className="panel-wrap pw-insp" style={{ width: inspW }}>
          <Inspector />
        </div>
      </main>

      <div
        className="splitter h"
        title={t("split.timeline")}
        onPointerDown={(e) => {
          const start = tlH;
          startSplit(e, (_dx, dy) => setTlH(clamp(start - dy, 150, 600)));
        }}
      />
      <div className="panel-wrap pw-tl" style={{ height: tlH }}>
        <Timeline />
      </div>

      <nav className="mobile-tabs">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={`mobile-tab${mobileTab === tb.id ? " on" : ""}`}
            aria-pressed={mobileTab === tb.id}
            onClick={() => setMobileTab(tb.id)}
          >
            <span className="ico" aria-hidden>{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </nav>
    </div>
  );
};
