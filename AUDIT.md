# AUDIT — Video Shotcraft Personal Edition (FASE 0)

Repo: harvey-moeid/video-shotcraft, fork sinkron dengan Vincentwei1021/video-shotcraft @ 6700db2. Lisensi repo: Apache-2.0 (Copyright 2026 Wei Yihao).

## Temuan utama
- Workbench (Vite + Remotion 4.0.484 + React 19) berjalan sebagai dev server lokal; export MP4 memanggil Remotion CLI via child_process di plugin Vite (`workbench/vite.config.ts`).
- Export bergantung pada symlink `public/` yang dibuat skrip lokal `open.mjs`; tidak ada backend; project hanya di localStorage.
- Upstream punya CI: `pr-checks.yml` (unit test, tsc strict, build workbench, smoke render demo) dan `deploy-pages.yml` (gallery).
- Jumlah demo tidak konsisten antar dokumen (150 vs 158); 66 demo legacy hanya untuk kompatibilitas. Angka aktual diukur di baseline.

## Lisensi
- Remotion: proprietary; gratis untuk individu / tim <=3 / nirlaba. Penggunaan ini murni pribadi. Lisensi 5.0 akan berubah — cek saat upgrade.
- BGM: 5 file (Mixkit Free License); `bgm-tech-house.mp3` asal-usul tidak terlacak (risiko diterima user untuk saat ini, wajib dicatat di LICENSES.md).
- SFX: Freesound per project, lisensi per file di manifest. Font/gambar: belum diaudit.

## Cloudflare Free (perlu verifikasi ke dokumentasi resmi sebelum FASE 2)
Workers 100K req/hari, CPU 10 ms; R2 10 GB, 1M Class A / 10M Class B per bulan, egress gratis; D1 5M baca / 100K tulis per hari, 5 GB; KV tulis 1K/hari.

## Risiko
Export dev-server-only; storage localStorage; secret handling; kuota R2/D1; parity preview vs render; lisensi BGM.

## Rencana
FASE 1 baseline di Actions -> FASE 2 Cloudflare (Worker API, R2, Pages) -> FASE 3 renderer Actions -> FASE 4 editor/storage -> FASE 5 QA -> FASE 6 dokumentasi.
