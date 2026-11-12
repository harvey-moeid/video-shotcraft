# HANDOFF

Diperbarui: 2026-11-12 (setelah deploy production pertama).

## Fase aktif
FASE 3 sudah di `main` dan Worker sudah di-deploy ke production. Tinggal mengaktifkan dispatch render (secret `GH_DISPATCH_TOKEN`, variable `STUDIO_BASE_URL`) dan menguji render nyata, lalu FASE 4.

## Selesai
- FASE 0 audit (AUDIT.md). User: BGM `bgm-tech-house.mp3` dibiarkan meski lisensi tidak jelas; penggunaan murni pribadi (bukan PT WKB).
- FASE 1 baseline (BASELINE-REPORT.md): 23+8+26+6 test lulus, build OK, render still + MP4 60 frame OK di Actions.
- FASE 2 bagian 1: Worker `video-shotcraft`: auth token statis (fail-closed), CRUD manifest proyek dan aset di R2, validasi ID/nama, batas ukuran, whitelist tipe konten, workbench statis lewat Static Assets.
- FASE 3 (PR #5, merge): render job. Worker: `POST /api/projects/:id/render` (opsional `{crf: 15-35}`) mencatat job di R2 (`jobs/<id>/job.json`, penanda aktif `active/<id>`) lalu memicu `render.yml` via workflow_dispatch; batas job aktif `MAX_ACTIVE_JOBS` (default 1, penanda macet kedaluwarsa 60 menit); rute `GET /api/jobs`, `GET|PATCH|DELETE /api/jobs/:id`, `GET|PUT /api/jobs/:id/output` (video/mp4, maks 90 MB). Runner: `render.yml` + `render/render-job.mjs`. CI: job `render-e2e` (wrangler dev lokal + runner asli + Remotion asli, dry-run dispatch); ci.yml run #4 sukses.
- PR #1-#5 sudah ditutup/merge. PR #4 (sinkron HANDOFF) sudah merge.
- Deploy production pertama sukses: deploy.yml run #1 (id 43157942763), Worker `video-shotcraft` aktif; secret `API_TOKEN` terpasang. Diverifikasi 2026-11-12: `GET /api/health` -> 200 `{"ok":true,"service":"video-shotcraft","phase":3}`; `GET /api/projects` tanpa token -> 401.

## Kondisi aktual (diverifikasi 2026-11-12)
- URL Worker: https://video-shotcraft.harveymoeid.workers.dev
- Binding Worker: `API_TOKEN` (secret), `ASSETS`, `BUCKET` (R2 `video-shotcraft`), vars GH_OWNER/GH_REPO/GH_REF/RENDER_WORKFLOW/MAX_*. Belum ada secret `GH_DISPATCH_TOKEN` -> `POST .../render` akan menjawab 503 `dispatch_not_configured`.
- Percobaan deploy pertama gagal karena secret repo `STUDIO_API_TOKEN` kosong; setelah diisi (minimal 24 karakter) deploy berhasil.
- Branch lain: `cloudflare-free`, `feat/cloudflare-deployment`, `chore/baseline`, `upstream` (jangan diubah).
- Worker `remotion-api` di akun adalah proyek lain, bukan bagian repo ini.

## Tertunda (butuh tindakan/persetujuan user)
- Buat PAT fine-grained (hanya repo `harvey-moeid/video-shotcraft`, izin Actions: Read and write), simpan sebagai secret repo `GH_DISPATCH_TOKEN`.
- Buat variable repo `STUDIO_BASE_URL` = `https://video-shotcraft.harveymoeid.workers.dev`.
- Merge PR `fix/deploy-dispatch-token` (deploy.yml meneruskan `GH_DISPATCH_TOKEN`), lalu jalankan ulang deploy.yml (butuh persetujuan user).
- Uji render nyata via dispatch GitHub (belum teruji; e2e lokal memakai dry-run).
- FASE 4-6.

## Masalah diketahui / risiko
- Dispatch ke GitHub (`dispatchWorkflow`) belum teruji end-to-end; hanya dry-run di CI.
- E2E memakai proyek tanpa klip (2 frame). Render proyek nyata (klip kartu, audio, 1920x1080/1080x1920, subtitle) belum diuji.
- Satu `API_TOKEN` dipakai pengguna dan runner. Pertimbangkan token terpisah (hak lebih sempit).
- Batas body 100 MB Cloudflare Free vs `MAX_OUTPUT_BYTES` 90 MB: verifikasi ke dokumentasi resmi.
- `test:themes` menampilkan peringatan async react/jsx-runtime (template tanpa node_modules).
- npm audit: 5 (root) dan 8 (workbench) kerentanan, belum dianalisis.
- Log tool terpotong 20 KB: verifikasi pakai status step + pipefail atau ringkasan pendek.
- Race kecil: dua POST render bersamaan bisa melewati batas job aktif (diterima untuk penggunaan pribadi).

## Catatan
- Jangan push ke main. Perubahan lewat feature branch dan PR; jangan merge sebelum pemeriksaan wajib hijau.
- Remotion hanya valid untuk penggunaan pribadi (Free License).
- Perubahan production tidak dilakukan tanpa persetujuan user.
- Tool: byga.ai; uji lewat GitHub Actions.
- Jangan menaruh token di chat/catatan/kode; simpan di GitHub Secrets dan password manager.

## Langkah berikutnya
1. Siapkan `GH_DISPATCH_TOKEN` dan `STUDIO_BASE_URL`, merge PR `fix/deploy-dispatch-token`, jalankan ulang deploy.yml.
2. Uji render nyata: PUT proyek + aset, `POST /api/projects/:id/render`, pantau job sampai succeeded, unduh MP4.
3. FASE 4.
