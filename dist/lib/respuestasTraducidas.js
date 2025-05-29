"use strict";
// src/lib/respuestasTraducidas.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.buscarRespuestaDesdeFlowsTraducido = buscarRespuestaDesdeFlowsTraducido;
exports.buscarRespuestaSimilitudFaqsTraducido = buscarRespuestaSimilitudFaqsTraducido;
const traducirTexto_1 = require("./traducirTexto");
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
async function buscarRespuestaDesdeFlowsTraducido(flows, mensajeUsuario, idioma) {
    const normalizado = normalizarTexto(mensajeUsuario);
    for (const flujo of flows) {
        for (const opcion of flujo.opciones || []) {
            const textoTraducido = await (0, traducirTexto_1.traducirTexto)(opcion.texto || '', idioma);
            if (normalizarTexto(textoTraducido) === normalizado) {
                return opcion.respuesta || opcion.submenu?.mensaje || null;
            }
            if (opcion.submenu) {
                for (const sub of opcion.submenu.opciones || []) {
                    const subTraducido = await (0, traducirTexto_1.traducirTexto)(sub.texto || '', idioma);
                    if (normalizarTexto(subTraducido) === normalizado) {
                        return sub.respuesta || null;
                    }
                }
            }
        }
    }
    return null;
}
async function buscarRespuestaSimilitudFaqsTraducido(faqs, mensaje, idioma) {
    const msg = normalizarTexto(mensaje);
    for (const faq of faqs) {
        const preguntaTraducida = await (0, traducirTexto_1.traducirTexto)(faq.pregunta || '', idioma);
        const pregunta = normalizarTexto(preguntaTraducida);
        const palabras = pregunta.split(' ').filter(Boolean);
        const coincidencias = palabras.filter(p => msg.includes(p));
        if (coincidencias.length >= 3)
            return faq.respuesta;
    }
    return null;
}
