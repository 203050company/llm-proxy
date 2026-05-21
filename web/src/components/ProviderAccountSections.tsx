import type { ComponentChildren } from "preact";
import { useT } from "../../../shared/i18n/context";

export function ProviderAccountSections(props: {
  codex: ComponentChildren;
}) {
  const t = useT();

  return (
    <div class="flex flex-col gap-6">
      <section>
        <h2 class="text-[0.95rem] font-bold tracking-tight mb-3 text-slate-800 dark:text-text-main">{t("codexAccounts")}</h2>
        {props.codex}
      </section>
    </div>
  );
}
