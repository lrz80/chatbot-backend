type Limits = {
  whatsapp: number;
  meta: number;
  followup: number;
  voz: number;
  sms: number;
  email: number;
  almacenamiento: number;
  contactos: number;
};

function n(v: any) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function limitsFromProductMetadata(metadata: Record<string, string> | null | undefined): Limits {
  const m = metadata || {};
  return {
    whatsapp: n(m.whatsapp_limit),
    meta: n(m.meta_limit),
    followup: n(m.followup_limit),
    voz: n(m.voz_limit),
    sms: n(m.sms_limit),
    email: n(m.email_limit),
    almacenamiento: n(m.almacenamiento_limit),
    contactos: n(m.contactos_limit),
  };
}

export function planKeyFromMetadata(metadata: Record<string, string> | null | undefined): string {
  const m = metadata || {};
  return (m.plan_key || "").toLowerCase().trim();
}
