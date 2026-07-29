// Endpoints remotos glz (partida en curso / pregame) y pd (nombres, MMR).
import { requestOk, HttpError } from "./http.js";
import { CLIENT_PLATFORM } from "./localapi.js";
import { TtlCache } from "./cache.js";

// A nivel de modulo para que sobrevivan a los re-auth. El MMR caduca pronto
// (cambia tras cada partida); los nombres casi nunca.
const nameCache = new TtlCache(6 * 3600e3);
const mmrCache = new TtlCache(10 * 60e3);
const kdaCache = new TtlCache(30 * 60e3);
const matchStatsCache = new TtlCache(2 * 3600e3);
const rrCache = new TtlCache(10 * 60e3);

// Limitador global para match-details: cada respuesta pesa ~1 MB y sin esto
// una partida de 10 jugadores dispararia ~100 peticiones a la vez.
let detailsActive = 0;
const detailsQueue = [];
async function withDetailsSlot(fn) {
  if (detailsActive >= 5) await new Promise((r) => detailsQueue.push(r));
  detailsActive++;
  try {
    return await fn();
  } finally {
    detailsActive--;
    detailsQueue.shift()?.();
  }
}

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
      let seasonsPlayed = 0;
      let totalGames = 0;
      const seasons = comp?.SeasonalInfoBySeasonID ?? {};
      for (const s of Object.values(seasons)) {
        const best = s?.Rank ?? 0;
        if (best > peakTier) peakTier = best;
        const wins = s?.WinsByTier ?? {};
        for (const t of Object.keys(wins)) {
          if (Number(t) > peakTier) peakTier = Number(t);
        }
        const g = s?.NumberOfGames ?? 0;
        if (g > 0) seasonsPlayed++;
        totalGames += g;
      }
      const out = { currentTier, rr, peakTier, seasonsPlayed, totalGames, games: latest ? undefined : 0 };
      mmrCache.set(puuid, out); // solo cacheamos respuestas buenas, los errores se reintentan
      return out;
    } catch (err) {
      if (err instanceof HttpError) return { currentTier: 0, rr: 0, peakTier: 0, error: err.status };
      throw err;
    }
  }

  // IDs de las ultimas partidas competitivas del jugador.
  async getHistory(puuid, count = 10) {
    const res = await this.#tryGet(
      `${this.pd}/match-history/v1/history/${puuid}?startIndex=0&endIndex=${count}&queue=competitive`
    );
    return (res?.History ?? []).map((h) => h.MatchID);
  }

  // K/D/A e impactos (cabeza/cuerpo/piernas) de todos los jugadores de una
  // partida, cacheado por MatchID. El detalle pesa ~1 MB; guardamos lo minimo.
  async getMatchStats(matchId) {
    const hit = matchStatsCache.get(matchId);
    if (hit !== undefined) return hit;
    const res = await withDetailsSlot(() => this.#get(`${this.pd}/match-details/v1/matches/${matchId}`));
    const stats = {};
    for (const p of res.players ?? []) {
      stats[p.subject] = {
        k: p.stats?.kills ?? 0,
        d: p.stats?.deaths ?? 0,
        a: p.stats?.assists ?? 0,
        head: 0,
        body: 0,
        legs: 0,
      };
    }
    for (const round of res.roundResults ?? []) {
      for (const ps of round.playerStats ?? []) {
        const s = stats[ps.subject];
        if (!s) continue;
        for (const dmg of ps.damage ?? []) {
          s.head += dmg.headshots ?? 0;
          s.body += dmg.bodyshots ?? 0;
          s.legs += dmg.legshots ?? 0;
        }
      }
    }
    matchStatsCache.set(matchId, stats);
    return stats;
  }

  // Version sincrona: solo lo que ya este en cache (para no perder el KDA
  // al reconstruir filas con cada pick del pregame).
  peekKda(puuid) {
    return kdaCache.get(puuid) ?? null;
  }

  peekComp(puuid) {
    return rrCache.get(puuid) ?? null;
  }

  // Movimientos de RR recientes: victorias/derrotas y RR medio por victoria.
  // Un RR medio alto (+24 o mas) delata MMR muy por encima del rango visible.
  async getRecentComp(puuid, count = 10) {
    const hit = rrCache.get(puuid);
    if (hit !== undefined) return hit;
    const res = await this.#tryGet(
      `${this.pd}/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=${count}&queue=competitive`
    );
    const matches = res?.Matches ?? [];
    let wins = 0, losses = 0;
    const gains = [];
    for (const m of matches) {
      const rr = m.RankedRatingEarned ?? 0;
      if (rr > 0) {
        wins++;
        gains.push(rr);
      } else if (rr < 0) {
        losses++;
      }
    }
    const out = matches.length
      ? {
          wins,
          losses,
          games: matches.length,
          avgRrWin: gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : null,
        }
      : null;
    rrCache.set(puuid, out);
    return out;
  }

  // KDA agregado de las ultimas partidas competitivas: (K+A)/D.
  // null si el jugador no tiene historial accesible.
  async getKda(puuid, count = 10) {
    const hit = kdaCache.get(puuid);
    if (hit !== undefined) return hit;
    const ids = await this.getHistory(puuid, count);
    const perMatch = await Promise.all(ids.map((id) => this.getMatchStats(id).catch(() => null)));
    let kills = 0, deaths = 0, assists = 0, games = 0, head = 0, body = 0, legs = 0;
    for (const m of perMatch) {
      const s = m?.[puuid];
      if (!s) continue;
      kills += s.k;
      deaths += s.d;
      assists += s.a;
      head += s.head ?? 0;
      body += s.body ?? 0;
      legs += s.legs ?? 0;
      games++;
    }
    const shots = head + body + legs;
    const out = games
      ? {
          kda: (kills + assists) / Math.max(1, deaths),
          kills,
          deaths,
          assists,
          games,
          hsRate: shots > 0 ? head / shots : null,
        }
      : null;
    kdaCache.set(puuid, out);
    return out;
  }
}
