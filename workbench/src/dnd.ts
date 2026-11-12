import type React from "react";
import { findClip, useStore } from "./store";

/** 素材库 → 时间轨 的拖拽负载协议 */
export const DRAG_MIME = "application/x-wb-item";

export type DragPayload = {
  cardId: string;
  props?: Record<string, unknown>;
  label?: string;
  duration?: number;
};

export const setDragPayload = (e: React.DragEvent, payload: DragPayload) => {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copy";
};

export const readDragPayload = (e: React.DragEvent): DragPayload | null => {
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
};

/** Pengganti drag-and-drop untuk layar sentuh: taruh item di playhead.
 *  Track tujuan = track klip yang sedang dipilih; kalau tidak ada, track paling bawah (perilaku addClip).
 *  Tanpa track sama sekali -> buat satu dulu. Mengirim event "wb:clip-added" agar UI mobile pindah ke tab timeline. */
export const addPayloadToTimeline = (payload: DragPayload) => {
  if (useStore.getState().project.tracks.length === 0) useStore.getState().addTrack();
  const s = useStore.getState();
  const sel = s.selectedClipId ? findClip(s.project, s.selectedClipId) : null;
  s.addClip(payload.cardId, sel?.track.id, undefined, {
    props: payload.props,
    label: payload.label,
    duration: payload.duration,
  });
  window.dispatchEvent(new CustomEvent("wb:clip-added"));
};
