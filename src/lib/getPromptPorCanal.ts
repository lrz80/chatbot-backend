export function getPromptPorCanal(canal: string, tenant: any): string {
  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return tenant.prompt_meta || tenant.prompt || 'Eres un asistente virtual.';
  }

  return tenant.prompt || tenant.prompt_meta || 'Eres un asistente virtual.';
}

export function getBienvenidaPorCanal(canal: string, tenant: any): string {
  if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
    return tenant.bienvenida_meta || tenant.bienvenida || '¡Hola! ¿En qué puedo ayudarte?';
  }

  return tenant.bienvenida || tenant.bienvenida_meta || '¡Hola! ¿En qué puedo ayudarte?';
}
