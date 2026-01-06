import pool from "./db";

export type FlowRow = {
  id: number;
  tenant_id: string;
  flow_key: string;
  enabled: boolean;
  name: string;
};

export type FlowStepRow = {
  id: number;
  flow_id: number;
  step_key: string;
  order_index: number;
  prompt_es: string;
  prompt_en: string;
  expected: any;
  on_success_next_step: string | null;
  on_fail_repeat: boolean;
};

export async function getFlowByKey(params: {
  tenantId: string;
  flowKey: string;
}): Promise<FlowRow | null> {
  const { tenantId, flowKey } = params;
  const res = await pool.query(
    `SELECT id, tenant_id, flow_key, enabled, name
       FROM flows
      WHERE tenant_id = $1 AND flow_key = $2
      LIMIT 1`,
    [tenantId, flowKey]
  );
  return res.rows[0] ?? null;
}

export async function getStepByKey(params: {
  flowId: number;
  stepKey: string;
}): Promise<FlowStepRow | null> {
  const { flowId, stepKey } = params;
  const res = await pool.query(
    `SELECT id, flow_id, step_key, order_index, prompt_es, prompt_en, expected,
            on_success_next_step, on_fail_repeat
       FROM flow_steps
      WHERE flow_id = $1 AND step_key = $2
      LIMIT 1`,
    [flowId, stepKey]
  );
  return res.rows[0] ?? null;
}
