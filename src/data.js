// Datos estaticos: nombres de tiers competitivos y agentes.
// Los agentes se resuelven contra valorant-api.com con cache en memoria.
import { requestOk } from "./http.js";

export const TIERS = [
  "Sin rango", "?", "?",
  "Hierro 1", "Hierro 2", "Hierro 3",
  "Bronce 1", "Bronce 2", "Bronce 3",
  "Plata 1", "Plata 2", "Plata 3",
  "Oro 1", "Oro 2", "Oro 3",
  "Platino 1", "Platino 2", "Platino 3",
  "Diamante 1", "Diamante 2", "Diamante 3",
  "Ascendente 1", "Ascendente 2", "Ascendente 3",
  "Inmortal 1", "Inmortal 2", "Inmortal 3",
  "Radiante",
];

export function tierName(tier) {
  return TIERS[tier] ?? `Tier ${tier}`;
}

let agentCache = null;

export async function agentName(characterId) {
  if (!characterId) return "-";
  if (!agentCache) {
    try {
      const res = await requestOk("https://valorant-api.com/v1/agents?isPlayableCharacter=true");
      agentCache = new Map(res.data.map((a) => [a.uuid.toLowerCase(), a.displayName]));
    } catch {
      agentCache = new Map(); // sin red externa: mostramos el UUID
    }
  }
  return agentCache.get(characterId.toLowerCase()) ?? characterId;
}
