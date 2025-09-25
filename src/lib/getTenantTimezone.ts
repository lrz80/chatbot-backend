export function getTenantTimezone(tenant: any): string {
  try {
    const settings = typeof tenant?.settings === 'string'
      ? JSON.parse(tenant.settings)
      : tenant?.settings || {};

    return (
      settings?.timezone ||        // ✅ la fuente oficial
      tenant?.timezone ||          // soporta legado
      tenant?.time_zone ||         // soporta legado snake
      'UTC'                        // fallback neutro
    );
  } catch {
    return 'UTC';
  }
}
