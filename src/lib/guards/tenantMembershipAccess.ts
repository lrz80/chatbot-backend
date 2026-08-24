//src/lib/guards/tenantMembershipAccess.ts

export type TenantMembershipLike = {
  membresia_activa?: boolean | null;
  es_trial?: boolean | null;
  membresia_vigencia?: string | Date | null;
};

export type TenantMembershipAccess = {
  trialActivo: boolean;
  planActivoOTrial: boolean;
  canEdit: boolean;
};

export function resolveTenantMembershipAccess(
  tenant: TenantMembershipLike,
  isAdmin: boolean
): TenantMembershipAccess {
  const now = new Date();

  const vigencia = tenant.membresia_vigencia
    ? new Date(tenant.membresia_vigencia)
    : null;

  const vigenciaValida =
    vigencia !== null &&
    !Number.isNaN(vigencia.getTime()) &&
    vigencia >= now;

  const trialActivo = Boolean(
    tenant.es_trial === true && vigenciaValida
  );

  const membresiaActiva = tenant.membresia_activa === true;

  const planActivoOTrial = Boolean(
    isAdmin ||
    membresiaActiva ||
    trialActivo
  );

  return {
    trialActivo,
    planActivoOTrial,
    canEdit: planActivoOTrial,
  };
}