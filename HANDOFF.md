# HANDOFF

Diperbarui: 2026-11-12 (setelah deploy ulang dengan GH_DISPATCH_TOKEN).

## Fase aktif
FASE 3 selesai, ada di `main`, dan sudah di-deploy ke production. Menunggu uji render nyata via dispatch GitHub (dijalankan user dengan curl), lalu FASE 4.

## Selesai
- FASE 0 audit (AUDIT.md). User: BGM `bgm-tech-house.mp3` dibiarkan meski lisensi tidak jelas; penggunaan murni pribadi (bukan PT WKB).
- FASE 1 baseline (BASELINE-REPORT.md): 23+8+26+6 test lulus, build OK, render still + MP4 60 frame OK di Actions.
- FASE 2 bagian 1: Worker `video-shotcraft`: auth token statis (fail-closed, token minimal 24 karakter), CRUD manifest proyek dan aset di R2, validasi ID/nama, batas ukuran, whitelist tipe konten, workbench statis lewat Static Assets.
- FASE 3 (PR #5): render job. Worker: `POST /api/projects/:id/render` (opsional `{crf: 15-35}`) mencatat job di R2 (`jobs/<id>/job.json`, penanda aktif `active/<id>`) lalu memicu `render.yml` via workflow_dispatch; batas job aktif `MAX_ACTIVE_JOBS` (default 1, penanda macet kedaluwarsa 60 menit); rute `GET /api/jobs`, `GET|PATCH|DELETE /api/jobs/:id`, `GET|PUT /api/jobs/:id/output` (video/mp4, maks 90 MB). Runner: `.github/workflows/render.yml` + `render/render-job.mjs`. CI: job `render-e2e` (wrangler dev lokal + runner asli + Remotion asli, dispatch dry-run); ci.yml run #4 sukses.
- PR #6 (merge, commit 641c71e): `deploy.yml` meneruskan secret `GH_DISPATCH_TOKEN` ke Worker; CI run #5 sukses.
- PR #1-#6 semuanya sudah ditutup/merge.
- Deploy production: deploy.yml run #1 (43157942763) sukses; run #2 (43159578710, setelah PR #6) sukses.

## Kondisi aktual (diverifikasi 2026-11-12)
- URL Worker: https://video-shotcraft.harveymoeid.workers.dev
- Verifikasi setelah run #1: `GET /api/health` -> 200 `{"ok":true,"service":"video-shotcraft","phase":3}`; `GET /api/projects` tanpa token -> 401. Belum diulang setelah run #2.
- Secret Worker terpasang: `API_TOKEN`, `GH_DISPATCH_TOKEN` (diverifikasi lewat daftar secret Cloudflare; nilainya tidak pernah dibaca).
- Binding Worker: `ASSETS`, `BUCKET` (R2 `video-shotcraft`), vars GH_OWNER/GH_REPO/GH_REF/RENDER_WORKFLOW/MAX_*.
- Secret repo yang dipakai: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STUDIO_API_TOKEN`, `GH_DISPATCH_TOKEN`. Variable repo `STUDIO_BASE_URL` dilaporkan user sudah dibuat, tetapi belum bisa diverifikasi oleh Claude.
- Percobaan deploy pertama gagal karena secret repo `STUDIO_API_TOKEN` kosong; setelah diisi deploy berhasil.
- Branch lain: `cloudflare-free`, `feat/cloudflare-deployment`, `chore/baseline`, `upstream` (jangan diubah).
- Worker `remotion-api` di akun adalah proyek lain, bukan bagian repo ini.

## Tertunda
- Uji render nyata via dispatch GitHub: user menjalankan curl (PUT proyek `uji-render`, `POST /api/projects/uji-render/render`, pantau `GET /api/jobs/:id`, unduh output). Hasil (JSON job) belum diterima Claude.
- Uji dengan proyek berisi klip nyata (kartu, audio, 1920x1080 / 1080x1920, subtitle).
- Verifikasi batas body Cloudflare Free (100 MB) ke dokumentasi resmi vs `MAX_OUTPUT_BYTES` 90 MB.
- Hapus proyek uji `uji-render` dan job uji di R2 setelah selesai.
- FASE 4-6.

## Masalah diketahui / risiko
- Dispatch ke GitHub (`dispatchWorkflow`) belum teruji end-to-end; CI hanya dry-run. Jika `STUDIO_BASE_URL` salah/kosong, runner berhenti sebelum melapor sehingga job tetap `queued` (slot aktif habis sendiri setelah 60 menit); cek log run Render job.
- E2E memakai proyek tanpa klip (2 frame). Render proyek nyata belum diuji.
- Satu `API_TOKEN` dipakai pengguna dan runner. Pertimbangkan token terpisah (hak lebih sempit).
- PAT `GH_DISPATCH_TOKEN` punya masa berlaku; render berhenti saat kedaluwarsa. Catat tanggalnya dan perbarui secret repo lalu jalankan ulang deploy.yml.
- `test:themes` menampilkan peringatan async react/jsx-runtime (template tanpa node_modules).
- npm audit: 5 (root) dan 8 (workbench) kerentanan, belum dianalisis.
- Log tool terpotong 20 KB: verifikasi pakai status step + pipefail atau ringkasan pendek.
- Race kecil: dua POST render bersamaan bisa melewati batas job aktif (diterima untuk penggunaan pribadi).

## Catatan
- Jangan push ke main. Perubahan lewat feature branch dan PR; jangan merge sebelum pemeriksaan wajib hijau.
- Remotion hanya valid untuk penggunaan pribadi (Free License).
- Perubahan production (deploy) hanya dengan persetujuan user; deploy dijalankan user lewat deploy.yml (ketik DEPLOY).
- Tool: byga.ai; uji lewat GitHub Actions.
- Jangan menaruh token di chat/catatan/kode; simpan di GitHub Secrets dan password manager.

## Langkah berikutnya
1. User menjalankan uji render nyata (curl) dan mengirim JSON job; Claude membaca hasil dan log run bila gagal.
2. Jika berhasil: uji proyek berisi klip nyata, lalu bersihkan data uji di R2.
3. FASE 4.
