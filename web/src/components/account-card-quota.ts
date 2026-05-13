import type { Account, AccountQuotaWindow } from "../../../shared/types";

export type AccountQuotaSectionKind = "primary" | "secondary";
export type AccountQuotaSectionState = "used" | "limit_reached" | "unavailable";

export interface AccountQuotaSection {
  kind: AccountQuotaSectionKind;
  labelKey: "current5hUsage" | "weeklyUsage";
  percentage: number | null;
  resetAt: number | null;
  state: AccountQuotaSectionState;
}

function buildQuotaSection(
  kind: AccountQuotaSectionKind,
  labelKey: AccountQuotaSection["labelKey"],
  window?: AccountQuotaWindow | null,
): AccountQuotaSection {
  if (window?.limit_reached) {
    return {
      kind,
      labelKey,
      percentage: 100,
      resetAt: window.reset_at ?? null,
      state: "limit_reached",
    };
  }

  if (window?.used_percent != null) {
    return {
      kind,
      labelKey,
      percentage: Math.round(window.used_percent),
      resetAt: window.reset_at ?? null,
      state: "used",
    };
  }

  return {
    kind,
    labelKey,
    percentage: null,
    resetAt: window?.reset_at ?? null,
    state: "unavailable",
  };
}

function buildBlockedPrimarySection(
  primary?: AccountQuotaWindow | null,
  secondary?: AccountQuotaWindow | null,
): AccountQuotaSection {
  return {
    kind: "primary",
    labelKey: "current5hUsage",
    percentage: 100,
    resetAt: secondary?.reset_at ?? primary?.reset_at ?? null,
    state: "limit_reached",
  };
}

export function buildAccountQuotaSections(
  account: Pick<Account, "status" | "planType" | "quota" | "usage">,
): AccountQuotaSection[] {
  const sections: AccountQuotaSection[] = [];
  const primary = account.quota?.rate_limit;
  const secondary = account.quota?.secondary_rate_limit;
  const secondaryBlocksPrimary = secondary?.limit_reached === true;

  if (account.planType === "free") {
    const weekly = isWeeklyQuotaWindow(primary) ? primary : secondary;
    if (weekly) {
      sections.push(buildQuotaSection("secondary", "weeklyUsage", weekly));
    }
    return sections;
  }

  if (primary || secondaryBlocksPrimary || account.status === "active") {
    sections.push(
      secondaryBlocksPrimary
        ? buildBlockedPrimarySection(primary, secondary)
        : buildQuotaSection("primary", "current5hUsage", primary),
    );
  }

  if (secondary) {
    sections.push(buildQuotaSection("secondary", "weeklyUsage", secondary));
  }

  // Fallback: If no official quota data but we have local usage, show a placeholder section
  if (sections.length === 0 && account.usage && (account.usage.window_request_count ?? 0) > 0) {
    sections.push({
      kind: "primary",
      labelKey: "current5hUsage",
      percentage: null,
      resetAt: null,
      state: "used",
    });
  }

  return sections;
}

function isWeeklyQuotaWindow(window?: AccountQuotaWindow | null): boolean {
  return (window?.limit_window_seconds ?? 0) >= 604_800;
}
