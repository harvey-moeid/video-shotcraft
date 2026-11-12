# BASELINE-REPORT — FASE 1

Basis: main @ 6700db2 (sinkron dengan upstream). Dijalankan di GitHub Actions (ubuntu-latest, Node 22.23.4, npm 10.9.9, Python 3.14.4).
Run: baseline.yml #43150943666 (commit d275392), baseline-render.yml #43151073168 (commit b079e0c).

## Hasil
| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Root unit test (vitest) | LULUS, 23/23 | log run 43150943666 |
| Workbench `npm ci` | OK (265 paket) | log |
| Workbench `tsc -b` | OK, tanpa error | log |
| Workbench `vite build` | OK, 303 modul; `dist` 34 MB; bundle JS 1.99 MB (607 KB gzip) | log |
| test:themes | LULUS 8/8, tetapi ada peringatan async: `Cannot find module 'react/jsx-runtime'` dari `template/src/themes/visual-theme.tsx` (template tidak punya node_modules di CI ini; di upstream CI ditautkan manual) | log |
| test:platform | LULUS 26/26 | log |
| test:legacy | LULUS 6/6 | log |
| `remotion compositions` | Sukses (exit 0) | status step, run 43151073168 |
| `remotion still` frame 0 (Main, props default) | Sukses (exit 0) | status step |
| `remotion render` 60 frame H.264 + `ffprobe` | Sukses (exit 0; ffprobe berhasil membaca file) | status step |

## Inventaris aktual (bukan klaim README)
- Demo aktif (tsx, tanpa `_legacy`/`_fixtures`): **152**
- Demo legacy: **68**
- Per kategori: camera 14, data 9, effects 23, interaction 13, opening 10, outro 7, rhythm 8, transition 18, typography 25, ui-entrance 25 (jumlah 152)
- Angka README (150) dan komentar vite.config (158) tidak cocok dengan hitungan file; yang dipakai adalah hitungan di atas (jumlah file tsx, belum tentu = jumlah kartu di registry).

## Batas verifikasi (jujur)
- Render yang terbukti: Main dengan props default, 60 frame. Detail ffprobe (resolusi, fps, codec) tidak terbaca karena log tool terpotong; hanya exit code yang terverifikasi. Render project nyata (1920x1080 / 1080x1920, audio, subtitle) belum diuji — dikerjakan di FASE 3/5.
- Dev server, `parity` (butuh Pillow), UI Workbench di browser, dan export lewat `/api/export` belum diuji (tidak bisa interaktif lewat Actions).
- Runner image saat ini ubuntu-26.04: `ffmpeg` tidak ada bawaan, dipasang via apt.
- `npm audit`: root 5 kerentanan (1 moderate, 2 high, 2 critical), workbench 8 (1 moderate, 7 high). Belum dianalisis; dicatat untuk FASE 5.

## Temuan untuk FASE 2-3
- Render CLI berjalan di runner tanpa perubahan kode: jalur Actions layak.
- `public/` di workbench dibuat oleh skrip; untuk render headless perlu aset diambil dari R2 ke direktori nyata (bukan symlink).
