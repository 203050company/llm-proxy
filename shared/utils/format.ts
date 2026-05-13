import type { LangCode } from "../i18n/translations";

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatWindowDuration(seconds: number, lang: LangCode): string {
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400);
    if (lang === "zh") return `${days}\u5929`;
    if (lang === "ko") return `${days}\uc77c`;
    return `${days}d`;
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    if (lang === "zh") return `${hours}\u5c0f\u65f6`;
    if (lang === "ko") return `${hours}\uc2dc\uac04`;
    return `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  if (lang === "zh") return `${minutes}\u5206\u949f`;
  if (lang === "ko") return `${minutes}\ubd84`;
  return `${minutes}m`;
}

export function formatResetTime(unixSec: number, lang: LangCode): string {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    if (lang === "zh") return "\u660e\u5929 " + time;
    if (lang === "ko") return "\ub0b4\uc77c " + time;
    return "Tomorrow " + time;
  }

  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return date + " " + time;
}
