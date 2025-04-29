"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizarTexto = normalizarTexto;
// 🔤 Elimina tildes, pone en minúsculas y remueve espacios innecesarios
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD') // descompone letras acentuadas
        .replace(/[\u0300-\u036f]/g, '') // elimina los signos diacríticos (tildes)
        .trim();
}
