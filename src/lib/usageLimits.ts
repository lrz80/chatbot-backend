// src/lib/usageLimits.ts

export function getLimitesPorPlan(plan: string | null | undefined) {
  const p = (plan || '').toLowerCase();

  if (p === 'starter') {
    return {
      whatsapp: 1200,
      meta: 0,
      followup: 500,
      voz: 0,
      sms: 0,
      email: 0,
      almacenamiento: 5120,  // 5 GB
      contactos: 0,
    };
  }

  if (p === 'pro') {
    return {
      whatsapp: 3000,
      meta: 2000,
      followup: 2000,
      voz: 0,
      sms: 0,
      email: 0,
      almacenamiento: 5120,  // 5 GB
      contactos: 0,
    };
  }

  // PRO PLUS (plan de 139.99) por defecto
  return {
    whatsapp: 6000,
    meta: 3000,
    followup: 3500,
    voz: 0,
    sms: 300,
    email: 4000,
    almacenamiento: 10240, // 10 GB
    contactos: 1500,
  };
}
