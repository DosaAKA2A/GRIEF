// Tracker de Dota 2 "hasta donde Valve deja": no hay API local tipo Riot.
// Fuente: console.log del juego (requiere opciones de lanzamiento
// "-console -condebug" en Steam) — las lineas de lobby traen los SteamID
// [U:1:xxxx] de los jugadores. Con eso, stats publicas de OpenDota.
// Limite conocido: perfiles privados (sin "Expose Public Match Data")
// salen solo con su nombre y medalla desconocida.
import { EventEmitter } from "node:events";
import { stat, open } from "node:fs/promises";
import { requestOk } from "./http.js";
import { TtlCache } from "./cache.js";
import { instalarGsiSiFalta } from "./dotasetup.js";

const MEDALLAS = [
  "", "Heraldo", "Guardian", "Cruzado", "Arconte", "Leyenda", "Ancestral", "Divino", "Inmortal",
];

const LOG_CANDIDATOS = [
  process.env.GRIEF_DOTA_LOG,
  "C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta/game/dota/console.log",
  "D:/Steam/steamapps/common/dota 2 beta/game/dota/console.log",
  "Z:/Steam/steamapps/common/dota 2 beta/game/dota/console.log",
].filter(Boolean);

const playerCache = new TtlCache(30 * 60e3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DotaTracker extends EventEmitter {
  #sig;
  #offset = 0;
  #logPath = null;
  #lobbyRows = null; // ultimas filas del lobby (via console.log), si las hay
  #gsiSig = null;
  #matchId = null;
  #miCuenta = null; // accountid propio, para marcar tu fila en el informe
  status = "Dota 2: arrancando...";

  // Informe post-partida: los 10 jugadores de la partida recien terminada.
  // OpenDota tarda 1-3 min en tener la partida; reintenta con paciencia.
  async #informe(matchId) {
    this.#status("Dota 2: partida terminada, preparando informe post-partida...");
    for (let intento = 0; intento < 8; intento++) {
      await sleep(intento === 0 ? 20000 : 30000);
      let match;
      try {
        match = await requestOk(`https://api.opendota.com/api/matches/${matchId}`);
      } catch {
        continue;
      }
      if (!Array.isArray(match?.players) || !match.players.length) continue;
      const rows = await Promise.all(
        match.players.map(async (p) => {
          const perfil = p.account_id ? await this.#player(p.account_id) : null;
          return {
            puuid: String(p.account_id ?? `anon-${p.player_slot}`),
            team: p.isRadiant ?? p.player_slot < 128 ? "Radiant" : "Dire",
            name: p.personaname ?? perfil?.name ?? "Anonimo",
            agent: null,
            agentIcon: p.hero_id ? `dota/heroes/${p.hero_id}.png` : null,
            tier: null,
            tierLabel: perfil?.medalla ?? (p.account_id ? "" : "perfil anonimo"),
            tierIcon: perfil?.tierIcon ?? "dota/rangos/0.png",
            rr: null,
            me: this.#miCuenta != null && String(p.account_id) === String(this.#miCuenta),
            incognito: !p.account_id,
            alertas: [],
            kda: null,
            linea2extra: `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0} en la partida${perfil?.extra ? " · " + perfil.extra : ""}`,
          };
        })
      );
      this.#status("Dota 2: informe post-partida listo.");
      this.#sig = null;
      this.emit("match", { phase: "dota-post", label: "INFORME POST-PARTIDA (Dota 2)", rows, lado: null });
      return;
    }
    this.#status("Dota 2: OpenDota no tiene esa partida (¿bots o perfil privado del server?).");
    this.emit("no-match");
  }

  // Estado en vivo via GSI (Game State Integration oficial de Valve).
  // Da el bando (radiant/dire), tu heroe y tu K/D/A en tiempo real.
  gsi(data) {
    if (!this.gsiVivo) {
      this.gsiVivo = true;
      this.#status("Dota 2: GSI conectado, el juego esta hablando con GRIEF.");
    }
    const estado = data?.map?.game_state ?? "";
    const enJuego = /HERO_SELECTION|STRATEGY|SHOWCASE|TEAM_SHOWCASE|WAIT_FOR_MAP|PRE_GAME|IN_PROGRESS/.test(estado);
    // El MatchID es la llave del informe post-partida via OpenDota.
    if (data?.map?.matchid && data.map.matchid !== "0") this.#matchId = data.map.matchid;
    if (!enJuego) {
      const termino = /POST_GAME/.test(estado) || (this.#gsiSig !== null && this.#matchId);
      if (this.#gsiSig !== null) {
        this.#gsiSig = null;
        if (termino && this.#matchId) {
          const id = this.#matchId;
          this.#matchId = null;
          this.#informe(id); // async, emite cuando OpenDota tenga la partida
        } else if (this.#lobbyRows?.length) {
          this.emit("match", { phase: "dota-lobby", label: "LOBBY DETECTADO (Dota 2)", rows: this.#lobbyRows, lado: null });
        } else {
          this.#sig = null;
          this.emit("no-match");
        }
      }
      return;
    }
    const lado = data.player?.team_name === "dire" ? "dire" : data.player?.team_name === "radiant" ? "radiant" : null;
    if (data.player?.accountid) this.#miCuenta = data.player.accountid;
    const heroId = data.hero?.id > 0 ? data.hero.id : null;
    const k = data.player?.kills ?? 0, d = data.player?.deaths ?? 0, a = data.player?.assists ?? 0;
    const sig = `${lado}|${heroId}|${k}/${d}/${a}`;
    if (sig === this.#gsiSig) return;
    this.#gsiSig = sig;
    // Con lobby previo mostramos a los 10; sin el, al menos tu fila en vivo.
    const rows = this.#lobbyRows?.length
      ? this.#lobbyRows
      : [{
          puuid: "gsi-yo",
          team: "-",
          name: data.player?.name ?? "Tu",
          agent: null,
          agentIcon: heroId ? `dota/heroes/${heroId}.png` : null,
          tier: null,
          tierLabel: "",
          tierIcon: null,
          rr: null,
          me: true,
          incognito: false,
          alertas: [],
          kda: null,
          linea2extra: `${k}/${d}/${a} en vivo`,
        }];
    this.#status("Dota 2: en partida (GSI).");
    this.emit("match", { phase: "dota-game", label: "EN PARTIDA (Dota 2)", rows, lado });
  }

  async start() {
    // El cfg de GSI es el mecanismo oficial de Valve y se instala solo si
    // falta. Las opciones de lanzamiento NO se tocan aqui: eso lo decide el
    // usuario con `npm run configurar-dota` (requiere Steam cerrado).
    try {
      const aviso = await instalarGsiSiFalta();
      if (aviso) this.#status(aviso);
    } catch {}
    for (;;) {
      try {
        await this.#cycle();
      } catch (err) {
        this.#status(`Dota 2: ${err.message}`);
      }
      await sleep(10000);
    }
  }

  #status(text) {
    if (text === this.status) return; // no re-emitir lo mismo cada ciclo
    this.status = text;
    this.emit("status", text);
  }

  async #findLog() {
    for (const p of LOG_CANDIDATOS) {
      try {
        await stat(p);
        return p;
      } catch {}
    }
    return null;
  }

  // Lee solo lo nuevo del log desde la ultima pasada.
  async #readNew() {
    const s = await stat(this.#logPath);
    if (s.size < this.#offset) this.#offset = 0; // log rotado/truncado
    if (s.size === this.#offset) return "";
    const fh = await open(this.#logPath, "r");
    try {
      const len = s.size - this.#offset;
      const buf = Buffer.alloc(Math.min(len, 4 * 1024 * 1024));
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.#offset);
      this.#offset += bytesRead;
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  }

  // Stats publicas de un account_id via OpenDota (3 peticiones con cache).
  async #player(accountId) {
    const hit = playerCache.get(accountId);
    if (hit !== undefined) return hit;
    let out;
    try {
      const [perfil, wl, recientes] = await Promise.all([
        requestOk(`https://api.opendota.com/api/players/${accountId}`),
        requestOk(`https://api.opendota.com/api/players/${accountId}/wl?limit=20`).catch(() => null),
        requestOk(`https://api.opendota.com/api/players/${accountId}/recentMatches`).catch(() => null),
      ]);
      const privado = !perfil?.profile;
      let medalla = "";
      let nivelMedalla = 0;
      if (perfil?.rank_tier) {
        nivelMedalla = Math.floor(perfil.rank_tier / 10);
        const estrellas = perfil.rank_tier % 10;
        medalla = `${MEDALLAS[nivelMedalla] ?? "?"}${nivelMedalla < 8 ? " " + estrellas : ""}`;
        if (perfil.leaderboard_rank) medalla += ` #${perfil.leaderboard_rank}`;
      }
      let extra = "";
      if (wl && wl.win + wl.lose > 0) {
        extra = `WR ${Math.round((wl.win / (wl.win + wl.lose)) * 100)}% (${wl.win + wl.lose})`;
      }
      let kda = null;
      if (Array.isArray(recientes) && recientes.length) {
        let k = 0, d = 0, a = 0;
        for (const m of recientes.slice(0, 10)) {
          k += m.kills ?? 0;
          d += m.deaths ?? 0;
          a += m.assists ?? 0;
        }
        kda = {
          kda: (k + a) / Math.max(1, d),
          kills: k,
          deaths: d,
          assists: a,
          games: Math.min(10, recientes.length),
          hsRate: null,
        };
      }
      out = {
        name: perfil?.profile?.personaname ?? `(privado ${accountId})`,
        privado,
        medalla: privado && !medalla ? "perfil privado" : medalla || "sin medalla",
        tierIcon: `dota/rangos/${nivelMedalla}.png`,
        extra,
        kda,
      };
    } catch {
      out = { name: `ID ${accountId}`, privado: true, medalla: "sin datos", tierIcon: "dota/rangos/0.png", extra: "", kda: null };
    }
    playerCache.set(accountId, out);
    return out;
  }

  async #cycle() {
    if (!this.#logPath) {
      this.#logPath = await this.#findLog();
      if (!this.#logPath) {
        this.#status('Dota 2: sin console.log — anade "-console -condebug" en las opciones de lanzamiento de Steam.');
        return;
      }
      const s = await stat(this.#logPath);
      this.#offset = s.size; // solo lobbies nuevos a partir de ahora
      this.#status("Dota 2: log detectado, esperando lobby.");
    }
    const texto = await this.#readNew();
    if (!texto) return;

    // Lineas de lobby con SteamIDs [U:1:xxxx]; tomamos el ultimo grupo visto.
    let ids = null;
    for (const linea of texto.split("\n")) {
      if (!linea.includes("[U:1:")) continue;
      if (!/lobby/i.test(linea) && !/member/i.test(linea)) continue;
      const encontrados = [...linea.matchAll(/\[U:1:(\d+)\]/g)].map((m) => Number(m[1]));
      if (encontrados.length >= 2) ids = [...new Set(encontrados)].slice(0, 10);
    }
    if (!ids) return;

    const jugadores = await Promise.all(ids.map((id) => this.#player(id)));
    this.#lobbyRows = jugadores.map((j, i) => ({
      puuid: String(ids[i]),
      team: "-",
      name: j.name,
      agent: "-",
      agentId: null,
      tier: null,
      tierLabel: j.medalla,
      tierIcon: j.tierIcon,
      rr: null,
      me: false,
      incognito: j.privado,
      alertas: [],
      kda: j.kda,
      linea2extra: j.extra,
    }));
    this.#status(`Dota 2: lobby de ${this.#lobbyRows.length} jugadores.`);
    const sig = ids.join(",");
    if (sig === this.#sig) return;
    this.#sig = sig;
    this.emit("match", { phase: "dota-lobby", label: "LOBBY DETECTADO (Dota 2)", rows: this.#lobbyRows });
  }
}
