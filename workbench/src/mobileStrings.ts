import { useLocale, type Locale } from "./i18n";

/** Teks khusus lapisan mobile + export cloud. Dipisah dari i18n.ts supaya tabel utama tidak tersentuh. */
const EN = {
  "tab.library": "Library",
  "tab.timeline": "Timeline",
  "lib.add": "Add to timeline",

  "cloud.title": "Render the project in the cloud (GitHub Actions) and download the MP4",
  "cloud.export": "Export video",
  "cloud.tokenPrompt": "Enter the API token for this studio (kept only for this browser tab):",
  "cloud.uploading": "Uploading…",
  "cloud.queued": "Queued…",
  "cloud.rendering": "Rendering…",
  "cloud.downloading": "Downloading…",
  "cloud.done": "✓ Ready · Download",
  "cloud.again": "Export again",
  "cloud.failed": "Export failed · Retry",
  "cloud.unauthorized": "The token was rejected. Try again with the correct token.",
  "cloud.timeout": "The render took too long. Check the GitHub Actions run.",
} as const;

export type MsKey = keyof typeof EN;

const ZH: Record<MsKey, string> = {
  "tab.library": "素材库",
  "tab.timeline": "时间轨",
  "lib.add": "添加到时间轨",

  "cloud.title": "在云端渲染当前工程（GitHub Actions）并下载 MP4",
  "cloud.export": "导出成片",
  "cloud.tokenPrompt": "请输入此工作室的 API token（仅保存在当前浏览器标签页）：",
  "cloud.uploading": "上传中…",
  "cloud.queued": "排队中…",
  "cloud.rendering": "渲染中…",
  "cloud.downloading": "下载中…",
  "cloud.done": "✓ 已完成 · 下载",
  "cloud.again": "再次导出",
  "cloud.failed": "导出失败 · 重试",
  "cloud.unauthorized": "token 被拒绝，请用正确的 token 重试。",
  "cloud.timeout": "渲染耗时过长，请查看 GitHub Actions 运行记录。",
};

const RU: Record<MsKey, string> = {
  "tab.library": "Библиотека",
  "tab.timeline": "Таймлайн",
  "lib.add": "Добавить на таймлайн",

  "cloud.title": "Отрендерить проект в облаке (GitHub Actions) и скачать MP4",
  "cloud.export": "Экспорт видео",
  "cloud.tokenPrompt": "Введите API-токен этой студии (хранится только в текущей вкладке браузера):",
  "cloud.uploading": "Загрузка…",
  "cloud.queued": "В очереди…",
  "cloud.rendering": "Рендеринг…",
  "cloud.downloading": "Скачивание…",
  "cloud.done": "✓ Готово · Скачать",
  "cloud.again": "Экспортировать ещё раз",
  "cloud.failed": "Ошибка экспорта · Повторить",
  "cloud.unauthorized": "Токен отклонён. Повторите с правильным токеном.",
  "cloud.timeout": "Рендеринг занял слишком много времени. Проверьте запуск в GitHub Actions.",
};

const TABLES: Record<Locale, Record<MsKey, string>> = { en: EN, zh: ZH, ru: RU };

export const ms = (key: MsKey): string => TABLES[useLocale.getState().locale][key] ?? EN[key];

/** Di komponen: berlangganan perubahan bahasa. */
export const useMs = () => {
  useLocale((s) => s.locale);
  return ms;
};
