import { SUPABASE_URL, SUPABASE_KEY } from "astro:env/server";
import { isAllowlistConfigured } from "@/lib/auth/allowlist";

export interface ConfigStatus {
  name: string;
  configured: boolean;
  message: string;
  docsUrl?: string;
  docsLabel?: string;
}

export const configStatuses: ConfigStatus[] = [
  {
    name: "Supabase",
    configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    message: "Supabase nie jest skonfigurowany — funkcje uwierzytelniania są wyłączone.",
    docsUrl: "https://github.com/przeprogramowani/10x-astro-starter#supabase-configuration",
    docsLabel: "Zobacz instrukcję konfiguracji",
  },
  {
    name: "Admin allow-list",
    configured: isAllowlistConfigured(),
    message: "ALLOWED_ADMIN_EMAILS nie jest ustawiony — logowanie administratora jest wyłączone (fail-closed).",
  },
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
