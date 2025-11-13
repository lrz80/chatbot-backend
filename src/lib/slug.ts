import type { Pool } from "pg";

export function toSlug(base: string) {
  return (base || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function ensureUniqueSlug(pool: Pool, base: string, opts?: { excludeTenantId?: string }) {
  const root = toSlug(base) || "tenant";
  let slug = root;
  let n = 1;
  while (true) {
    const { rows } = await pool.query(
      `select 1 from tenants where slug = $1 and ($2::uuid is null or id <> $2) limit 1`,
      [slug, opts?.excludeTenantId ?? null]
    );
    if (rows.length === 0) return slug;
    n += 1;
    slug = `${root}-${n}`;
  }
}
