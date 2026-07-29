// Endpoints remotos glz (partida en curso / pregame) y pd (nombres, MMR).
import { requestOk, HttpError } from "./http.js";
import { CLIENT_PLATFORM } from "./localapi.js";
import { TtlCache } from "./cache.js";

// A nivel de modulo para que sobrevivan a los re-auth. El MMR caduca pronto
// (cambia tras cada partida); los nombres casi nunca.
const nameCache = new TtlCache(6 * 3600e3);
const mmrCache = new TtlCache(10 * 60e3);

export class RemoteApi {
  constructor({ region, shard, tokens, clientVersion }) {
    this.glz = `https://glz-${region}-1.${shard}.a.pvp.net`;
    this.pd = `https://pd.${shard}.a.pvp.net`;
    this.headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "X-Riot-Entitlements-JWT": tokens.entitlementsToken,
      "X-Riot-ClientPlatform": CLIENT_PLATFORM,
      "X-Riot-ClientVersion": clientVersion,
    };
    this.puuid = tokens.puuid;
  }

  async #get(url) {
    return requestOk(url, { headers: this.headers });
  }

  async #tryGet(url) {
    try {
      return await this.#get(url);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  // Partida en curso (los 10 jugadores). null si no estamos en partida.
  async getCoreGame() {
    const p = await this.#tryGet(`${this.glz}/core-game/v1/players/${this.puuid}`);
    if (!p?.MatchID) return null;
    return this.#get(`${this.glz}/core-game/v1/matches/${p.MatchID}`);
  }

  // Seleccion de agentes (solo tu equipo). null si no estamos en pregame.
  async getPreGame() {
    const p = await this.#tryGet(`${this.glz}/pregame/v1/players/${this.puuid}`);
    if (!p?.MatchID) return null;
    return this.#get(`${this.glz}/pregame/v1/matches/${p.MatchID}`);
  }

  // Nombres visibles a partir de PUUIDs. Solo pide a la API los que falten.
  async getNames(puuids) {
    const map = new Map();
    const missing = [];
    for (const id of puuids) {
      const hit = nameCache.get(id);
      if (hit !== undefined) map.set(id, hit);
      else missing.push(id);
    }
    if (missing.length) {
      const res = await requestOk(`${this.pd}/name-service/v2/players`, {
        method: "PUT",
        headers: this.headers,
        body: missing,
      });
      for (const e of res) {
        const name = `${e.GameName}#${e.TagLine}`;
        map.set(e.Subject, name);
        nameCache.set(e.Subject, name);
      }
    }
    return map;
  }

  // Rango competitivo actual y peak de un jugador.
  async getMmr(puuid) {
    const hit = mmrCache.get(puuid);
    if (hit !== undefined) return hit;
    try {
      const res = await requestOk(`${this.pd}/mmr/v1/players/${puuid}`, { headers: this.headers });
      const comp = res?.QueueSkills?.competitive;
      const latest = res?.LatestCompetitiveUpdate;
      let currentTier = latest?.TierAfterUpdate ?? 0;
      let rr = latest?.RankedRatingAfterUpdate ?? 0;
      let peakTier = 0;
      const seasons = comp?.SeasonalInfoBySeasonID ?? {};
      for (const s of Object.values(seasons)) {
        const best = s?.Rank ?? 0;
        if (best > peakTier) peakTier = best;
        const wins = s?.WinsByTier ?? {};
        for (const t of Object.keys(wins)) {
          if (Number(t) > peakTier) peakTier = Number(t);
        }
      }
      const out = { currentTier, rr, peakTier, games: latest ? undefined : 0 };
      mmrCache.set(puuid, out); // solo cacheamos respuestas buenas, los errores se reintentan
      return out;
    } catch (err) {
      if (err instanceof HttpError) return { currentTier: 0, rr: 0, peakTier: 0, error: err.status };
      throw err;
    }
  }
}
