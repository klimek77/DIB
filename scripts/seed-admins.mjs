/* eslint-disable no-console -- dev/ops CLI; console IS the output here */
// Mirror ALLOWED_ADMIN_EMAILS (the app-side single source of truth) into the
// public.admin_allowlist table that the RLS gate is_allowed_admin() reads.
//
// WHY THIS EXISTS: migration 20260605000000 creates admin_allowlist EMPTY, and
// the new submissions SELECT policy denies everyone whose email isn't in it — so
// an empty table locks out every admin. This script closes that footgun by making
// "migration applied" reliably lead to "admins seeded". Idempotent (ON CONFLICT
// DO NOTHING), so it is safe to re-run after every db:reset / env-var change.
//
// Run:  npm run db:seed-admins   (loads .env via node --env-file)
//
// Reads from process.env (same vars the app uses):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ADMIN_EMAILS
// The service-role key bypasses RLS — the only way to write the locked-down table.
// Never deletes rows: removing an admin stays a deliberate manual decision.

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rawAdmins = process.env.ALLOWED_ADMIN_EMAILS ?? "";

if (!url || !serviceRoleKey) {
  console.error(
    "seed-admins: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Set them in .env (npm run db:seed-admins loads it via --env-file).",
  );
  process.exit(1);
}

// Parse exactly like src/lib/auth/allowlist.ts: comma-separated, trimmed,
// lower-cased, empties dropped — then de-duped so the upsert payload is clean.
const emails = [
  ...new Set(
    rawAdmins
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
];

if (emails.length === 0) {
  console.warn(
    "seed-admins: ALLOWED_ADMIN_EMAILS is empty — nothing to seed. " +
      "With an empty admin_allowlist, NO admin can read submissions (fail-closed).",
  );
  process.exit(0);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { error } = await supabase
  .from("admin_allowlist")
  .upsert(
    emails.map((email) => ({ email })),
    { onConflict: "email", ignoreDuplicates: true },
  );

if (error) {
  console.error(`seed-admins: upsert failed — ${error.message}`);
  process.exit(1);
}

const { count, error: countError } = await supabase
  .from("admin_allowlist")
  .select("*", { count: "exact", head: true });

if (countError) {
  console.error(`seed-admins: row-count check failed — ${countError.message}`);
  process.exit(1);
}

console.log(
  `seed-admins: mirrored ${emails.length} email(s) from ALLOWED_ADMIN_EMAILS; ` +
    `admin_allowlist now has ${count} row(s).`,
);
