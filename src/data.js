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
let mapCache = null;

// Info de mapa a partir del MapID de la partida ("/Game/Maps/Ascent/Ascent").
// El slug casa con src/ui/valorant/mapas/{slug}.png.
export async function mapInfo(mapId) {
  if (!mapId) return null;
  if (!mapCache) {
    try {
      const res = await requestOk("https://valorant-api.com/v1/maps");
      mapCache = new Map(
        res.data
          .filter((m) => m.mapUrl)
          .map((m) => [m.mapUrl.toLowerCase(), { nombre: m.displayName, slug: m.mapUrl.split("/").pop().toLowerCase() }])
      );
    } catch {
      mapCache = new Map(); // sin red: caemos al nombre crudo del MapID
    }
  }
  const crudo = mapId.split("/").pop();
  return mapCache.get(mapId.toLowerCase()) ?? { nombre: crudo, slug: crudo.toLowerCase() };
}

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
