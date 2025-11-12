export const normalizeEmail = (e?: string | null) =>
  (e || '').trim().toLowerCase();

import pool from './db';

export async function markTrialUsedByEmail(email: string, stripeCustomerId?: string) {
  const en = normalizeEmail(email);
  if (!en) return;
  await pool.query(
    `INSERT INTO trial_registry (email_normalized, first_email, stripe_customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (email_normalized) DO NOTHING`,
    [en, email, stripeCustomerId || null]
  );
}

export async function hasUsedTrialByEmail(email: string): Promise<boolean> {
  const en = normalizeEmail(email);
  if (!en) return false;
  const r = await pool.query(
    `SELECT 1 FROM trial_registry WHERE email_normalized = $1 LIMIT 1`,
    [en]
  );
  return !!r.rows[0];
}
