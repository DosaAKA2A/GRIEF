// Tracker de League of Legends. Dos fuentes:
//  - LCU (cliente): puerto+token via external-sessions del Riot Client;
//    champ select (solo tu equipo) y rangos por puuid.
//  - Live Client Data (https://127.0.0.1:2999, sin auth): los 10 en partida.
// Emite los mismos eventos que el tracker de Valorant.
import { EventEmitter } from "node:events";
import { readLockfile } from "./lockfile.js";
import { request, requestOk } from "./http.js";
import { TtlCache } from "./cache.js";

const TIERS_LOL = {
  IRON: "Hierro", BRONZE: "Bronce", SILVER: "Plata", GOLD: "Oro",
  PLATINUM: "Platino", EMERALD: "Esmeralda", DIAMOND: "Diamante",
  MASTER: "Maestro", GRANDMASTER: "Gran Maestro", CHALLENGER: "Retador",
};
const DIV = { I: "1", II: "2", III: "3", IV: "4" };

const rankCache = new TtlCache(10 * 60e3);
let champMap = null; // { porId: id -> nombre, porNombre: nombre normalizado -> id }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function champions() {
  if (champMap) return champMap;
  try {
    const versions = await requestOk("https://ddragon.leagueoflegends.com/api/versions.json");
    const data = await requestOk(
      `https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/es_MX/champion.json`
    );
    const lista = Object.values(data.data);
    champMap = {
      porId: new Map(lista.map((c) => [Number(c.key), c.name])),
      porNombre: new Map(lista.flatMap((c) => [[norm(c.name), Number(c.key)], [norm(c.id), Number(c.key)]])),
    };
  } catch {
    champMap = { porId: new Map(), porNombre: new Map() };
  }
  return champMap;
}

export class LolTracker extends EventEmitter {
  #sig;
  status = "LoL: arrancando...";

  async start() {
    for (;;) {
      try {
        await this.#cycle();
      } catch (err) {
        this.#status(`LoL: ${err.message}`);
      }
      await sleep(10000);
    }
  }

  #status(text) {
    this.status = text;
    this.emit("status", text);
  }

  #emitIfChanged(phase, label, rows, sigExtra) {
    const sig = phase + "|" + sigExtra;
    if (sig === this.#sig) return;
    this.#sig = sig;
    this.emit("match", { phase, label, rows });
  }

  #noMatch() {
    if (this.#sig !== null) {
      this.#sig = null;
      this.emit("no-match");
    }
  }

  // Credenciales del LCU sacadas del propio Riot Client (external-sessions).
  async #lcu() {
    const lock = await readLockfile();
    const auth = "Basic " + Buffer.from(`riot:${lock.password}`).toString("base64");
    const sessions = await requestOk(`https://127.0.0.1:${lock.port}/product-session/v1/external-sessions`, {
      headers: { Authorization: auth },
      insecure: true,
    });
    for (const key of Object.keys(sessions)) {
      const s = sessions[key];
      if (s?.productId !== "league_of_legends") continue;
      const args = s.launchConfiguration?.arguments ?? [];
      const port = args.find((a) => a.startsWith("--app-port="))?.split("=")[1];
      const token = args.find((a) => a.startsWith("--remoting-auth-token="))?.split("=")[1];
      if (port && token) {
        return { base: `https://127.0.0.1:${port}`, auth: "Basic " + Buffer.from(`riot:${token}`).toString("base64") };
      }
    }
    return null;
  }

  #lcuGet(lcu, path) {
    return request(`${lcu.base}${path}`, { headers: { Authorization: lcu.auth }, insecure: true });
  }

  // Rango solo/duo de un puuid via LCU. Best-effort con cache.
  async #rank(lcu, puuid) {
    if (!puuid) return null;
    const hit = rankCache.get(puuid);
    if (hit !== undefined) return hit;
    let out = null;
    try {
      const res = await this.#lcuGet(lcu, `/lol-ranked/v1/ranked-stats/${puuid}`);
      const solo = res.status === 200 ? res.body?.queueMap?.RANKED_SOLO_5x5 : null;
      if (solo?.tier && solo.tier !== "NONE" && solo.tier !== "UNRANKED") {
        const esDivisible = !["MASTER", "GRANDMASTER", "CHALLENGER"].includes(solo.tier);
        out = {
          label: `${TIERS_LOL[solo.tier] ?? solo.tier}${esDivisible ? " " + (DIV[solo.division] ?? solo.division ?? "") : ""}`.trim(),
          icon: `lol/rangos/${solo.tier.toLowerCase()}.svg`,
          lp: solo.leaguePoints ?? null,
          wins: solo.wins ?? null,
          losses: solo.losses ?? null,
        };
      }
    } catch {
      // sin permiso o endpoint caido: fila sin rango
    }
    rankCache.set(puuid, out);
    return out;
  }

  async #cycle() {
    // 1) En partida: Live Client Data expone a los 10 sin auth.
    const live = await request("https://127.0.0.1:2999/liveclientdata/playerlist", {
      insecure: true,
    }).catch(() => null);
    if (live?.status === 200 && Array.isArray(live.body) && live.body.length) {
      let yo = null;
      try {
        const ap = await request("https://127.0.0.1:2999/liveclientdata/activeplayer", { insecure: true });
        yo = ap.body?.riotId ?? null;
      } catch {}
      const lcu = await this.#lcu().catch(() => null);
      const champs = await champions();
      const rows = [];
      for (const p of live.body) {
        if (p.isBot) continue;
        const riotId = p.riotIdGameName
          ? `${p.riotIdGameName}#${p.riotIdTagLine ?? ""}`.replace(/#$/, "")
          : p.summonerName ?? "?";
        const champId = champs.porNombre.get(norm(p.championName));
        rows.push({
          puuid: riotId,
          team: p.team === "ORDER" ? "Azul" : "Rojo",
          name: riotId,
          agent: p.championName ?? "-",
          agentId: null,
          agentIcon: champId ? `lol/champs/${champId}.png` : null,
          tier: null,
          tierLabel: "",
          tierIcon: null,
          rr: null,
          me: yo != null && riotId === yo,
          incognito: false,
          alertas: [],
          kda: null,
          linea2extra: `${p.scores?.kills ?? 0}/${p.scores?.deaths ?? 0}/${p.scores?.assists ?? 0} en vivo · nivel ${p.level ?? "?"}`,
        });
      }
      // Rangos best-effort para quien podamos resolver via LCU (aliases)
      if (lcu) {
        await Promise.all(
          rows.map(async (r) => {
            try {
              const [gameName, tagLine] = r.name.split("#");
              const look = await this.#lcuGet(
                lcu,
                `/lol-summoner/v1/alias/lookup?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine ?? "")}`
              );
              const puuid = look.status === 200 ? look.body?.puuid : null;
              const rank = await this.#rank(lcu, puuid);
              if (rank) {
                r.tierLabel = rank.label;
                r.tierIcon = rank.icon;
                r.rr = rank.lp;
                if (rank.wins != null && rank.losses != null) {
                  r.linea2extra += ` · ${rank.wins}W-${rank.losses}L`;
                }
              }
            } catch {}
          })
        );
      }
      this.#status("LoL: en partida.");
      this.#emitIfChanged(
        "lol-game",
        "EN PARTIDA (LoL)",
        rows,
        rows.map((r) => `${r.name}:${r.agent}:${r.linea2extra}`).join(",")
      );
      return;
    }

    // 2) Seleccion de campeones via LCU (solo tu equipo).
    const lcu = await this.#lcu().catch(() => null);
    if (!lcu) {
      this.#status("LoL: cliente no detectado.");
      this.#noMatch();
      return;
    }
    const cs = await this.#lcuGet(lcu, "/lol-champ-select/v1/session");
    if (cs.status !== 200 || !Array.isArray(cs.body?.myTeam) || !cs.body.myTeam.length) {
      this.#status("LoL: cliente abierto, sin partida.");
      this.#noMatch();
      return;
    }
    const champs = await champions();
    const rows = await Promise.all(
      cs.body.myTeam.map(async (m) => {
        const rank = await this.#rank(lcu, m.puuid);
        let name = "(oculto)";
        try {
          if (m.puuid) {
            const s = await this.#lcuGet(lcu, `/lol-summoner/v2/summoners/puuid/${m.puuid}`);
            if (s.status === 200 && s.body?.gameName) name = `${s.body.gameName}#${s.body.tagLine ?? ""}`.replace(/#$/, "");
          }
        } catch {}
        return {
          puuid: m.puuid || String(m.cellId),
          team: "Azul",
          name,
          agent: champs.porId.get(m.championId) ?? (m.championId ? String(m.championId) : "-"),
          agentId: null,
          agentIcon: m.championId ? `lol/champs/${m.championId}.png` : null,
          tier: null,
          tierLabel: rank?.label ?? "Sin clasificar",
          tierIcon: rank?.icon ?? "lol/rangos/unranked.svg",
          rr: rank?.lp ?? null,
          me: false,
          incognito: name === "(oculto)",
          alertas: [],
          kda: null,
          linea2extra: rank?.wins != null ? `${rank.wins}W-${rank.losses}L esta temporada` : "",
        };
      })
    );
    this.#status("LoL: seleccion de campeones.");
    this.#emitIfChanged(
      "lol-champselect",
      "SELECCION DE CAMPEONES (solo tu equipo)",
      rows,
      rows.map((r) => `${r.puuid}:${r.agent}`).join(",")
    );
  }
}
