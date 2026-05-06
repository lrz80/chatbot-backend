// src/lib/billing/tenantSubscriptions.repo.ts
import pool from "../db";

export type UpsertTenantSubscriptionParams = {
  tenantId: string;
  planCode: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  stripeProductId: string | null;
  status: string;

  billingInterval: string;
  billingCommitment: string | null;
  contractTermMonths: number | null;

  contractStartDate: Date | null;
  contractEndDate: Date | null;

  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;

  trialStart: Date | null;
  trialEnd: Date | null;
  isTrial: boolean;

  cancelRequestedAt?: Date | null;
  cancelEffectiveAt?: Date | null;

  metadata?: Record<string, unknown>;
};

export async function upsertTenantSubscription(
  params: UpsertTenantSubscriptionParams
): Promise<void> {
  await pool.query(
    `
    INSERT INTO tenant_subscriptions (
      tenant_id,
      plan_code,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_product_id,
      status,
      billing_interval,
      billing_commitment,
      contract_term_months,
      contract_start_date,
      contract_end_date,
      current_period_start,
      current_period_end,
      trial_start,
      trial_end,
      is_trial,
      cancel_requested_at,
      cancel_effective_at,
      metadata,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19, NOW()
    )
    ON CONFLICT (stripe_subscription_id)
    DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      plan_code = EXCLUDED.plan_code,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_product_id = EXCLUDED.stripe_product_id,
      status = EXCLUDED.status,
      billing_interval = EXCLUDED.billing_interval,
      billing_commitment = EXCLUDED.billing_commitment,
      contract_term_months = EXCLUDED.contract_term_months,

      contract_start_date = COALESCE(
        tenant_subscriptions.contract_start_date,
        EXCLUDED.contract_start_date
      ),

      contract_end_date = COALESCE(
        tenant_subscriptions.contract_end_date,
        EXCLUDED.contract_end_date
      ),

      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      trial_start = EXCLUDED.trial_start,
      trial_end = EXCLUDED.trial_end,
      is_trial = EXCLUDED.is_trial,

      cancel_requested_at = EXCLUDED.cancel_requested_at,
      cancel_effective_at = EXCLUDED.cancel_effective_at,

      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    `,
    [
      params.tenantId,
      params.planCode,
      params.stripeCustomerId,
      params.stripeSubscriptionId,
      params.stripeProductId,
      params.status,

      params.billingInterval,
      params.billingCommitment,
      params.contractTermMonths,

      params.contractStartDate,
      params.contractEndDate,

      params.currentPeriodStart,
      params.currentPeriodEnd,

      params.trialStart,
      params.trialEnd,
      params.isTrial,

      params.cancelRequestedAt ?? null,
      params.cancelEffectiveAt ?? null,

      params.metadata ?? {},
    ]
  );
}

export async function getTenantSubscriptionByStripeSubscriptionId(
  stripeSubscriptionId: string
): Promise<{
  tenant_id: string;
  plan_code: string;
  status: string;
  billing_commitment: string | null;
  contract_end_date: Date | null;
} | null> {
  const { rows } = await pool.query(
    `
    SELECT
      tenant_id,
      plan_code,
      status,
      billing_commitment,
      contract_end_date
    FROM tenant_subscriptions
    WHERE stripe_subscription_id = $1
    LIMIT 1
    `,
    [stripeSubscriptionId]
  );

  return rows[0] ?? null;
}

export async function markTenantSubscriptionCancelRequested(params: {
  stripeSubscriptionId: string;
  cancelEffectiveAt: Date | null;
}): Promise<void> {
  await pool.query(
    `
    UPDATE tenant_subscriptions
    SET status = 'cancel_requested',
        cancel_requested_at = NOW(),
        cancel_effective_at = $2,
        updated_at = NOW()
    WHERE stripe_subscription_id = $1
    `,
    [params.stripeSubscriptionId, params.cancelEffectiveAt]
  );
}

export async function markTenantSubscriptionCanceled(
  stripeSubscriptionId: string
): Promise<void> {
  await pool.query(
    `
    UPDATE tenant_subscriptions
    SET status = 'canceled',
        updated_at = NOW()
    WHERE stripe_subscription_id = $1
    `,
    [stripeSubscriptionId]
  );
}