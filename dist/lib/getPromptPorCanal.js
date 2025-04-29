"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPromptPorCanal = getPromptPorCanal;
exports.getBienvenidaPorCanal = getBienvenidaPorCanal;
function getPromptPorCanal(canal, tenant) {
    if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
        return tenant.prompt_meta || tenant.prompt || 'Eres un asistente virtual.';
    }
    return tenant.prompt || tenant.prompt_meta || 'Eres un asistente virtual.';
}
function getBienvenidaPorCanal(canal, tenant) {
    if (canal === 'facebook' || canal === 'instagram' || canal === 'preview-meta') {
        return tenant.bienvenida_meta || tenant.bienvenida || '¡Hola! ¿En qué puedo ayudarte?';
    }
    return tenant.bienvenida || tenant.bienvenida_meta || '¡Hola! ¿En qué puedo ayudarte?';
}
