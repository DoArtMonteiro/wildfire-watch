"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { LEGAL_ROUTES } from "@/lib/site";

/** Shared by the overview and the fire detail so the emergency notice and the
 * legal links stay one tap away whichever view the panel is showing. A view
 * whose data has a different delay can say so in `notice`, replacing the
 * general one rather than adding a second. */
export default function PanelFooter({ notice }: { notice?: string } = {}) {
  const { t } = useLocale();
  const linkClassName =
    "inline-flex min-h-6 items-center rounded-sm font-medium underline underline-offset-2 transition-colors hover:text-foreground";

  return (
    <footer className="mt-auto space-y-2 border-t border-border/60 pt-3 text-[11px] leading-4 text-foreground/65">
      <p role="note">{notice ?? t.legal.emergencyNotice}</p>
      <nav aria-label={t.legal.navLabel}>
        <ul className="flex flex-wrap gap-x-4">
          <li><Link href={LEGAL_ROUTES.about} className={linkClassName}>{t.legal.about}</Link></li>
          <li><Link href={LEGAL_ROUTES.privacy} className={linkClassName}>{t.legal.privacy}</Link></li>
          <li><Link href={LEGAL_ROUTES.terms} className={linkClassName}>{t.legal.terms}</Link></li>
        </ul>
      </nav>
    </footer>
  );
}
