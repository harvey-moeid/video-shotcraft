# HANDOFF

Diperbarui: 2026-11-12 (sinkron dengan kondisi aktual GitHub/Cloudflare, plus hasil FASE 3).

## Fase aktif
FASE 3 (render lewat GitHub Actions) selesai dikerjakan dan lulus CI di PR #5, menunggu persetujuan merge. Berikutnya: persiapan deploy (secret/variable) lalu FASE 4.

## Selesai
- FASE 0 audit (AUDIT.md). User: BGM `bgm-tech-house.mp3` dibiarkan meski lisensi tidak jelas; penggunaan murni pribadi (bukan PT WKB).
- FASE 1 baseline (BASELINE-REPORT.md): 23+8+26+6 test lulus, build OK, render still + MP4 60 frame OK di Actions.
- FASE 2 bagian 1 (sudah di `main`): Worker `video-shotcraft`: auth token statis (fail-closed), CRUD manifest proyek dan aset di R2, validasi ID/nama, batas ukuran, whitelist tipe konten, workbench statis lewat Static Assets. PR #1, #2, #3 sudah ditutup/merge.
- FASE 3 (PR #5, belum merge): lihat bagian berikut.

## FASE 3 — render job (PR #5, branch `feat/github-actions-renderer`, commit fe3af6e)
- Worker: `POST /api/projects/:id/render` (opsional `{crf: 15-35}`) mencatat job di R2 (`jobs/<id>/job.json`, penanda aktif `active/<id>`) lalu memicu `render.yml` via workflow_dispatch. Batas job aktif `MAX_ACTIVE_JOBS` (default 1; penanda macet kedaluwarsa 60 menit). Rute lain: `GET /api/jobs`, `GET|PATCH|DELETE /api/jobs/:id`, `GET|PUT /api/jobs/:id/output` (video/mp4, maks `MAX_OUTPUT_BYTES` 90 MB).
- Runner: `.github/workflows/render.yml` + `render/render-job.mjs`: lapor running, unduh manifest + aset ke `workbench/public`, `remotion render Main` dengan props `{project, renderExact: true}`, unggah MP4, lapor failed bila gagal.
- CI: `ci.yml` kini juga untuk PR ke `main`; job baru `render-e2e` menjalankan `wrangler dev --local` (R2 lokal, `DISPATCH_DRY_RUN=1`) + runner asli + Remotion asli lewat `render/e2e-local.mjs` (auth, validasi, 202/409/429, render nyata, MP4 `ftyp`, ukuran, jalur failed, pelepasan slot aktif).
- Hasil CI: run ci.yml #4 (commit fe3af6e) sukses; job `worker` (build, typecheck, wrangler dry-run) dan `render-e2e` keduanya success.

## Kondisi aktual (diverifikasi 2026-11-12)
- `main`: 52b736a. PR terbuka: #4 (docs HANDOFF) dan #5 (FASE 3). Branch lain: `cloudflare-free` d6048c2, `feat/cloudflare-deployment` 2ad9633, `chore/baseline` bde9480, `upstream` 6700db2 (jangan diubah).
- Cloudflare: bucket R2 `video-shotcraft` ada (dibuat 2026-11-12). Worker `video-shotcraft` BELUM di-deploy. (Worker `remotion-api` di akun adalah proyek lain, bukan bagian repo ini.)
- deploy.yml (manual, ketik DEPLOY, environment production) belum pernah dijalankan.

## Tertunda (butuh tindakan/persetujuan user)
- Merge PR #4 dan PR #5.
- Siapkan sebelum deploy: secret repo `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STUDIO_API_TOKEN`; variable repo `STUDIO_BASE_URL` (URL Worker, https); secret Worker `GH_DISPATCH_TOKEN` (fine-grained PAT, Actions: write, hanya repo ini). Belum diverifikasi sudah diset. deploy.yml perlu ditambah `GH_DISPATCH_TOKEN` ke daftar secrets Worker (belum dikerjakan).
- Deploy Worker ke production dan uji render nyata via dispatch GitHub (belum teruji; e2e lokal memakai dry-run).
- FASE 4-6.

## Masalah diketahui / risiko
- Dispatch ke GitHub (`dispatchWorkflow`) belum teruji end-to-end; hanya dry-run di CI.
- E2E memakai proyek tanpa klip (2 frame). Render proyek nyata (klip kartu, audio, 1920x1080/1080x1920, subtitle) belum diuji.
- Satu `API_TOKEN` dipakai pengguna dan runner. Pertimbangkan token terpisah (hak lebih sempit) di fase berikutnya.
- Batas body 100 MB Cloudflare Free vs `MAX_OUTPUT_BYTES` 90 MB: verifikasi ke dokumentasi resmi sebelum deploy.
- `test:themes` menampilkan peringatan async react/jsx-runtime (template tanpa node_modules).
- npm audit: 5 (root) dan 8 (workbench) kerentanan, belum dianalisis.
- Log tool terpotong 20 KB: verifikasi pakai status step + pipefail atau ringkasan pendek.
- Race kecil: dua POST render bersamaan bisa melewati batas job aktif (diterima untuk penggunaan pribadi).

## Catatan
- Jangan push ke main. Perubahan lewat feature branch dan PR; jangan merge sebelum pemeriksaan wajib hijau.
- Remotion hanya valid untuk penggunaan pribadi (Free License).
- Perubahan production tidak dilakukan tanpa persetujuan user.
- Tool: byga.ai; uji lewat GitHub Actions.

## Langkah berikutnya
1. Review dan merge PR #5 (CI hijau), lalu PR #4.
2. Siapkan secret/variable di atas, tambahkan `GH_DISPATCH_TOKEN` ke deploy.yml, dengan persetujuan user jalankan deploy.yml.
3. Uji render nyata via dispatch, lalu FASE 4.
