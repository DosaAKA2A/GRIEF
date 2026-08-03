// Tracker de League of Legends y Teamfight Tactics. Tres fuentes en cascada:
//  - LCU (cliente): puerto+token via external-sessions del Riot Client. Da la
//    fase real (gameflow), la cola, los 10 jugadores con puuid y party, la
//    seleccion de campeones (ambos equipos) y el resumen de fin de partida.
//  - Live Client Data (https://127.0.0.1:2999, sin auth): stats en vivo de la
//    partida en curso (KDA, CS, vision, objetos, runas, hechizos, objetivos).
//  - Data Dragon: nombres de campeones e iconos de perfil.
// La fase manda: primero se pregunta al gameflow y luego se busca el detalle,
// asi que funciona en cualquier cola (reclutamiento, clasificatoria, ARAM,
// Arena, URF, bots, personalizada) y tambien en TFT, donde no existe API en
// vivo y todo sale del LCU.
import { EventEmitter } from "node:events";
import { readLockfile, readLeagueLockfile } from "./lockfile.js";
import { request, requestOk } from "./http.js";
import { TtlCache } from "./cache.js";

const TIERS_LOL = {
  IRON: "Hierro", BRONZE: "Bronce", SILVER: "Plata", GOLD: "Oro",
  PLATINUM: "Platino", EMERALD: "Esmeralda", DIAMOND: "Diamante",
  MASTER: "Maestro", GRANDMASTER: "Gran Maestro", CHALLENGER: "Retador",
};
const DIV = { I: "1", II: "2", III: "3", IV: "4" };
const SIN_DIVISION = ["MASTER", "GRANDMASTER", "CHALLENGER"];
// Escalas propias de TFT hiperrapido y de Arena (no son tiers normales).
const TIERS_RATED = {
  GRAY: "Gris", GREEN: "Verde", BLUE: "Azul", PURPLE: "Morado", HYPER: "Hyper",
  WOOD: "Madera", BRONZE: "Bronce", SILVER: "Plata", GOLD: "Oro",
  PLATINUM: "Platino", DIAMOND: "Diamante", GLADIATOR: "Gladiador",
};

// Nombre corto de cada cola. Sin cola conocida se cae al nombre que da el
// cliente: mejor su texto que un modo inventado en colas nuevas o rotativas.
const COLAS = {
  0: "Personalizada",
  400: "Reclutamiento", 430: "Selección a ciegas", 490: "Partida rápida",
  420: "Clasificatoria solo/dúo", 440: "Clasificatoria flexible",
  450: "ARAM", 700: "Clash", 720: "Clash ARAM",
  830: "Contra IA (intro)", 840: "Contra IA (principiante)", 850: "Contra IA (intermedio)",
  870: "Contra IA (intro)", 880: "Contra IA (principiante)", 890: "Contra IA (intermedio)",
  900: "ARURF", 1900: "URF", 1020: "Uno para todos", 1300: "Nexus Blitz", 1400: "Libro definitivo",
  1700: "Arena", 1710: "Arena", 1810: "Swarm", 1820: "Swarm", 1830: "Swarm", 1840: "Swarm",
  1090: "TFT normal", 1100: "TFT clasificatoria", 1110: "TFT tutorial",
  1130: "TFT hiperrápido", 1160: "TFT dúo", 1170: "TFT rotativo", 6000: "TFT pruebas de set",
  2000: "Tutorial", 2010: "Tutorial", 2020: "Tutorial",
};

const MODOS = {
  CLASSIC: "Grieta del Invocador", ARAM: "ARAM", TFT: "Teamfight Tactics",
  CHERRY: "Arena", STRAWBERRY: "Swarm", URF: "URF", ARURF: "ARURF",
  ONEFORALL: "Uno para todos", NEXUSBLITZ: "Nexus Blitz", ULTBOOK: "Libro definitivo",
  PRACTICETOOL: "Herramienta de práctica", DOOMBOTSTEEMO: "Bots del apocalipsis",
  ODYSSEY: "Odisea", TUTORIAL: "Tutorial",
};

const POSICIONES = {
  top: "TOP", jungle: "JUNGLA", middle: "MID", mid: "MID",
  bottom: "BOT", adc: "BOT", utility: "SUPP", support: "SUPP",
  none: "", "": "",
};

const HECHIZOS = {
  1: "Purificar", 3: "Agotar", 4: "Destello", 6: "Fantasma", 7: "Curar",
  11: "Castigar", 12: "Teletransporte", 13: "Claridad", 14: "Prender",
  21: "Barrera", 30: "¡A por el rey!", 31: "Lanzar poro", 32: "Marcar",
  39: "Marcar", 54: "Marcador", 55: "Marcador", 2201: "Huir", 2202: "Destello",
};

const rankCache = new TtlCache(10 * 60e3); // puuid -> queueMap crudo
const aliasCache = new TtlCache(30 * 60e3); // riotId -> puuid (no cambia en la sesion)
const sumCache = new TtlCache(30 * 60e3); // puuid -> { name, level, iconId }
const masteryCache = new TtlCache(30 * 60e3); // puuid|champId -> { nivel, puntos }
let champMap = null; // { porId: id -> nombre, porNombre: nombre normalizado -> id }
let ddVersion = null; // ultima version de Data Dragon (iconos de perfil)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const mmss = (seg) => {
  const s = Math.max(0, Math.floor(seg ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const miles = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(Math.round(n)));

async function champions() {
  if (champMap) return champMap;
  try {
    const versions = await requestOk("https://ddragon.leagueoflegends.com/api/versions.json");
    ddVersion = versions[0];
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

// Icono de perfil: Community Dragon los tiene todos desde el minuto uno del
// parche; Data Dragon tarda en incorporar los nuevos, asi que va de respaldo
// (la UI cambia de uno a otro si la imagen no carga).
const iconoPerfil = (id) =>
  id ? `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${id}.jpg` : null;
const iconoPerfilAlt = (id) =>
  ddVersion && id ? `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/profileicon/${id}.png` : null;

// Cola de clasificacion que toca mirar segun lo que se este jugando: en TFT
// no sirve el solo/duo, en Arena tampoco, y en normales se ensena el solo/duo
// como referencia (es el rango que la gente entiende como "su" rango).
function colasDeRango(queueId, gameMode) {
  if (queueId === 420) return ["RANKED_SOLO_5x5"];
  if (queueId === 440) return ["RANKED_FLEX_SR", "RANKED_SOLO_5x5"];
  if (queueId === 1130) return ["RANKED_TFT_TURBO", "RANKED_TFT"];
  if (queueId === 1160) return ["RANKED_TFT_DOUBLE_UP", "RANKED_TFT"];
  if (gameMode === "TFT" || (queueId >= 1090 && queueId <= 1180) || queueId === 6000) {
    return ["RANKED_TFT", "RANKED_TFT_DOUBLE_UP", "RANKED_TFT_TURBO"];
  }
  if (gameMode === "CHERRY" || queueId === 1700 || queueId === 1710) return ["CHERRY", "RANKED_SOLO_5x5"];
  return ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"];
}

const NOMBRE_COLA_RANGO = {
  RANKED_SOLO_5x5: "solo/dúo", RANKED_FLEX_SR: "flexible", RANKED_TFT: "TFT",
  RANKED_TFT_TURBO: "TFT hiperrápido", RANKED_TFT_DOUBLE_UP: "TFT dúo", CHERRY: "Arena",
};

// Una entrada de queueMap -> lo que pinta la UI. Cubre las dos formas: tier +
// division + LP (colas clasicas) y ratedTier + ratedRating (turbo y Arena).
function formatoRango(entrada, cola) {
  if (!entrada) return null;
  const wins = entrada.wins ?? null;
  const losses = entrada.losses ?? null;
  if (entrada.tier && entrada.tier !== "NONE" && entrada.tier !== "UNRANKED") {
    const div = SIN_DIVISION.includes(entrada.tier) ? "" : " " + (DIV[entrada.division] ?? entrada.division ?? "");
    return {
      label: `${TIERS_LOL[entrada.tier] ?? entrada.tier}${div}`.trim(),
      icon: `lol/rangos/${entrada.tier.toLowerCase()}.png`,
      lp: entrada.leaguePoints ?? null,
      wins, losses, cola: NOMBRE_COLA_RANGO[cola] ?? cola,
    };
  }
  if (entrada.ratedTier && entrada.ratedTier !== "NONE") {
    return {
      label: TIERS_RATED[entrada.ratedTier] ?? entrada.ratedTier,
      icon: TIERS_LOL[entrada.ratedTier] ? `lol/rangos/${entrada.ratedTier.toLowerCase()}.png` : null,
      lp: entrada.ratedRating ?? null,
      wins, losses, cola: NOMBRE_COLA_RANGO[cola] ?? cola,
    };
  }
  return null;
}

// Los objetivos grandes salen del registro de eventos de la partida en vivo.
// Torres e inhibidores se atribuyen por el nombre de la estructura (T1 es el
// lado azul), que es lo unico fiable cuando el ultimo golpe lo da un subdito.
function objetivos(eventos, equipoDe) {
  const cero = () => ({ dragones: 0, ancestral: 0, barones: 0, heraldos: 0, larvas: 0, torres: 0, inhibidores: 0 });
  const cuenta = { Azul: cero(), Rojo: cero() };
  const rachas = new Map(); // jugador -> mayor multikill
  for (const e of eventos ?? []) {
    const equipo = equipoDe.get(e.KillerName);
    switch (e.EventName) {
      case "DragonKill":
        if (equipo) cuenta[equipo][e.DragonType === "Elder" ? "ancestral" : "dragones"]++;
        break;
      case "BaronKill":
        if (equipo) cuenta[equipo].barones++;
        break;
      case "HeraldKill":
        if (equipo) cuenta[equipo].heraldos++;
        break;
      case "HordeKill":
        if (equipo) cuenta[equipo].larvas++;
        break;
      case "TurretKilled": {
        const gana = /_T1_|_T100_/.test(String(e.TurretKilled)) ? "Rojo" : "Azul";
        cuenta[gana].torres++;
        break;
      }
      case "InhibKilled": {
        const gana = /_T1_|_T100_/.test(String(e.InhibKilled)) ? "Rojo" : "Azul";
        cuenta[gana].inhibidores++;
        break;
      }
      case "Multikill":
        if (e.KillerName) rachas.set(e.KillerName, Math.max(rachas.get(e.KillerName) ?? 0, e.KillStreak ?? 0));
        break;
      default:
        break;
    }
  }
  return { cuenta, rachas };
}

const NOMBRE_MULTIKILL = { 2: "Doble", 3: "Triple", 4: "Cuádruple", 5: "Penta" };

// Colas que se ensenan en el perfil, en orden de importancia.
const COLAS_PERFIL = [
  ["RANKED_SOLO_5x5", "Solo/dúo"],
  ["RANKED_FLEX_SR", "Flexible"],
  ["RANKED_TFT", "TFT"],
  ["RANKED_TFT_DOUBLE_UP", "TFT dúo"],
  ["RANKED_TFT_TURBO", "TFT hiperrápido"],
  ["CHERRY", "Arena"],
];

export class LolTracker extends EventEmitter {
  #sig;
  #perfilCache = null; // { perfil, at } — el historial pesa; 5 min basta
  #lcuCache = null; // { creds, at } — evita pedir external-sessions cada ciclo
  #ritmo = 10000; // ritmo adaptativo: sin cliente de Riot, sondeo lento
  status = "LoL: arrancando...";

  async start() {
    for (;;) {
      try {
        await this.#cycle();
      } catch (err) {
        this.#status(`LoL: ${err.message}`);
      }
      await sleep(this.#ritmo);
    }
  }

  #status(text) {
    if (text === this.status) return; // no re-emitir lo mismo cada ciclo
    this.status = text;
    this.emit("status", text);
  }

  #emitIfChanged(phase, label, rows, sigExtra, extra = {}) {
    const sig = phase + "|" + sigExtra;
    if (sig === this.#sig) return;
    this.#sig = sig;
    this.emit("match", { phase, label, rows, ...extra });
  }

  #noMatch() {
    if (this.#sig !== null) {
      this.#sig = null;
      this.emit("no-match");
    }
  }

  // Credenciales del LCU sacadas del propio Riot Client (external-sessions).
  // Con cache de 5 min: no cambian mientras el cliente siga vivo, y pedirlas
  // cada ciclo era un handshake+peticion inutiles. Si el LCU deja de
  // responder, el llamador invalida con #lcuOlvidar().
  async #lcu() {
    // Puerta para pruebas y diagnostico: apunta el tracker a otro LCU (o a un
    // simulacro) sin tocar el cliente real.
    if (process.env.GRIEF_LCU) return { base: process.env.GRIEF_LCU, auth: process.env.GRIEF_LCU_AUTH ?? "" };
    if (this.#lcuCache && Date.now() - this.#lcuCache.at < 5 * 60e3) return this.#lcuCache.creds;

    // 1) El lockfile del propio cliente de League: es el que funciona hoy.
    const propio = await readLeagueLockfile();
    if (propio) {
      const creds = {
        base: `https://127.0.0.1:${propio.port}`,
        auth: "Basic " + Buffer.from(`riot:${propio.password}`).toString("base64"),
      };
      this.#lcuCache = { creds, at: Date.now() };
      return creds;
    }

    // 2) Respaldo historico: el Riot Client publicaba puerto y token de cada
    // producto en external-sessions. Se queda por si vuelve o en instalaciones
    // donde el lockfile de League no este donde toca.
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
        const creds = { base: `https://127.0.0.1:${port}`, auth: "Basic " + Buffer.from(`riot:${token}`).toString("base64") };
        this.#lcuCache = { creds, at: Date.now() };
        return creds;
      }
    }
    return null;
  }

  #lcuOlvidar() {
    this.#lcuCache = null;
  }

  #lcuGet(lcu, path) {
    return request(`${lcu.base}${path}`, { headers: { Authorization: lcu.auth }, insecure: true });
  }

  // GET que devuelve el cuerpo solo si respondio 200. Casi todo en el LCU es
  // best-effort: un 404 significa "esta version no lo expone", no un error.
  async #json(lcu, path) {
    try {
      const res = await this.#lcuGet(lcu, path);
      return res.status === 200 ? res.body : null;
    } catch {
      return null;
    }
  }

  // Primer endpoint de la lista que responda. El LCU renombra rutas entre
  // parches; probar en orden evita quedarnos sin dato por un cambio de nombre.
  async #jsonAlguno(lcu, paths) {
    for (const p of paths) {
      const body = await this.#json(lcu, p);
      if (body) return body;
    }
    return null;
  }

  // ---- Datos por jugador (todo cacheado: se piden una vez por sesion) ----

  async #queueMap(lcu, puuid) {
    if (!lcu || !puuid) return null;
    const hit = rankCache.get(puuid);
    if (hit !== undefined) return hit;
    const body = await this.#json(lcu, `/lol-ranked/v1/ranked-stats/${puuid}`);
    const qm = body?.queueMap ?? null;
    rankCache.set(puuid, qm);
    return qm;
  }

  // Rango del jugador en la cola que corresponde a lo que se esta jugando.
  async #rank(lcu, puuid, colas) {
    const qm = await this.#queueMap(lcu, puuid);
    if (!qm) return null;
    for (const cola of colas) {
      const r = formatoRango(qm[cola], cola);
      if (r) return r;
    }
    return null;
  }

  async #summoner(lcu, puuid) {
    if (!lcu || !puuid || /^0+(-0+)*$/.test(puuid)) return null;
    const hit = sumCache.get(puuid);
    if (hit !== undefined) return hit;
    const body = await this.#jsonAlguno(lcu, [
      `/lol-summoner/v2/summoners/puuid/${puuid}`,
      `/lol-summoner/v1/summoners/puuid/${puuid}`,
    ]);
    const out = body
      ? {
          name: body.gameName ? `${body.gameName}#${body.tagLine ?? ""}`.replace(/#$/, "") : body.displayName || null,
          level: body.summonerLevel ?? null,
          iconId: body.profileIconId ?? null,
        }
      : null;
    sumCache.set(puuid, out);
    return out;
  }

  async #puuidDe(lcu, riotId) {
    if (!lcu || !riotId) return null;
    const hit = aliasCache.get(riotId);
    if (hit !== undefined) return hit;
    const [gameName, tagLine] = riotId.split("#");
    const body = await this.#jsonAlguno(lcu, [
      `/lol-summoner/v1/alias/lookup?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine ?? "")}`,
      `/lol-summoner/v1/summoners?name=${encodeURIComponent(gameName)}`,
    ]);
    const puuid = body?.puuid ?? null;
    aliasCache.set(riotId, puuid);
    return puuid;
  }

  async #maestria(lcu, puuid, championId) {
    if (!lcu || !puuid || !championId) return null;
    const clave = `${puuid}|${championId}`;
    const hit = masteryCache.get(clave);
    if (hit !== undefined) return hit;
    const body = await this.#jsonAlguno(lcu, [
      `/lol-champion-mastery/v1/${puuid}/champion-mastery/${championId}`,
      `/lol-collections/v1/inventories/${puuid}/champion-mastery/${championId}`,
    ]);
    const out = body?.championLevel
      ? { nivel: body.championLevel, puntos: body.championPoints ?? 0 }
      : null;
    masteryCache.set(clave, out);
    return out;
  }

  // Party: en el gameflow los premades comparten teamParticipantId. Devuelve
  // un mapa id -> { indice, tamano } para pintar la espina de color.
  #parties(jugadores) {
    const grupos = new Map();
    for (const j of jugadores) {
      const id = j.teamParticipantId;
      if (!id) continue;
      grupos.set(id, (grupos.get(id) ?? 0) + 1);
    }
    const out = new Map();
    let i = 0;
    for (const [id, tamano] of grupos) {
      if (tamano < 2) continue;
      out.set(id, { indice: ++i, tamano });
    }
    return out;
  }

  // ---- Ciclo principal: la fase del gameflow decide donde mirar ----

  async #cycle() {
    this.#ritmo = 10000;
    const lcu = await this.#lcu().catch(() => null);

    // Sin cliente: aun asi puede haber una partida corriendo (LCU caido, el
    // juego no). La API en vivo no necesita credenciales.
    if (!lcu) {
      const vivo = await this.#live();
      if (vivo) return this.#enPartida(null, null, vivo, { modo: MODOS[vivo.gameData?.gameMode] ?? null });
      this.#ritmo = 20000;
      this.#status("LoL: cliente no detectado.");
      return this.#noMatch();
    }

    let gf;
    try {
      const res = await this.#lcuGet(lcu, "/lol-gameflow/v1/session");
      gf = res.status === 200 ? res.body : null;
    } catch (err) {
      this.#lcuOlvidar(); // el LCU cambio de puerto o murio: re-descubrir
      throw err;
    }

    const partida = this.#partidaDe(gf);
    switch (gf?.phase) {
      case "ChampSelect":
        return this.#champSelect(lcu, gf, partida);
      case "GameStart":
      case "InProgress":
      case "Reconnect": {
        this.#ritmo = 6000; // en partida los stats cambian: se mira mas fino
        const vivo = await this.#live();
        if (vivo && (partida.esTft || vivo.gameData?.gameMode === "TFT")) return this.#enPartidaTft(gf, vivo, partida);
        if (vivo) return this.#enPartida(lcu, gf, vivo, partida);
        return this.#partidaSinVivo(lcu, gf, partida); // TFT y carga inicial
      }
      case "WaitingForStats":
      case "PreEndOfGame":
      case "EndOfGame":
        return this.#finPartida(lcu, gf, partida);
      case "Lobby":
      case "Matchmaking":
      case "ReadyCheck":
      case "CheckedIntoTournament":
        return this.#lobby(lcu, partida);
      default: {
        // Sin fase util: puede haber partida igual (el gameflow tarda en
        // ponerse al dia al reconectar).
        const vivo = await this.#live();
        if (vivo) return this.#enPartida(lcu, gf, vivo, partida);
        this.#status("LoL: cliente abierto, sin partida.");
        this.#noMatch();
        return this.#perfil(lcu); // con el cliente abierto y sin partida, tu perfil
      }
    }
  }

  // Cola y modo de lo que se esta jugando, con nombre legible.
  #partidaDe(gf) {
    const q = gf?.gameData?.queue ?? {};
    const queueId = q.id ?? -1;
    const gameMode = q.gameMode ?? gf?.gameData?.gameMode ?? null;
    const nombre =
      COLAS[queueId] ??
      (typeof q.name === "string" && q.name.trim() ? q.name.replace(/\s*games?$/i, "") : null) ??
      MODOS[gameMode] ??
      null;
    return {
      queueId,
      gameMode,
      modo: nombre,
      esTft: gameMode === "TFT" || (queueId >= 1090 && queueId <= 1180) || queueId === 6000,
      gameId: gf?.gameData?.gameId ?? null,
      colasRango: colasDeRango(queueId, gameMode),
    };
  }

  // Toda la partida en vivo de una tacada. allgamedata trae jugadores,
  // eventos y datos de la partida; si no responde, se compone a mano.
  async #live() {
    const todo = await request("https://127.0.0.1:2999/liveclientdata/allgamedata", { insecure: true }).catch(() => null);
    if (todo?.status === 200 && Array.isArray(todo.body?.allPlayers) && todo.body.allPlayers.length) return todo.body;
    const lista = await request("https://127.0.0.1:2999/liveclientdata/playerlist", { insecure: true }).catch(() => null);
    if (lista?.status !== 200 || !Array.isArray(lista.body) || !lista.body.length) return null;
    const [stats, yo, ev] = await Promise.all([
      request("https://127.0.0.1:2999/liveclientdata/gamestats", { insecure: true }).catch(() => null),
      request("https://127.0.0.1:2999/liveclientdata/activeplayer", { insecure: true }).catch(() => null),
      request("https://127.0.0.1:2999/liveclientdata/eventdata", { insecure: true }).catch(() => null),
    ]);
    return {
      allPlayers: lista.body,
      gameData: stats?.body ?? {},
      activePlayer: yo?.status === 200 ? yo.body : null,
      events: ev?.status === 200 ? ev.body : { Events: [] },
    };
  }

  // ---- Fases ----

  // En partida con API en vivo: KDA, CS, vision, objetos, runas, hechizos,
  // oro propio y objetivos del equipo. Es el modo con mas informacion.
  async #enPartida(lcu, gf, vivo, partida) {
    const champs = await champions();
    const jugadores = vivo.allPlayers ?? [];
    const gd = vivo.gameData ?? {};
    const minutos = Math.max(1 / 60, (gd.gameTime ?? 0) / 60);

    const riotIdDe = (p) =>
      p.riotId ||
      (p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagLine ?? ""}`.replace(/#$/, "") : null) ||
      p.summonerName ||
      "?";
    const yo = vivo.activePlayer?.riotId ?? vivo.activePlayer?.summonerName ?? null;

    // Indice del gameflow: puuid, party y posicion elegida para cada jugador.
    const delGameflow = [
      ...(gf?.gameData?.teamOne ?? []).map((j) => ({ ...j, lado: "Azul" })),
      ...(gf?.gameData?.teamTwo ?? []).map((j) => ({ ...j, lado: "Rojo" })),
    ];
    const parties = this.#parties(delGameflow);
    const porNombre = new Map();
    const porChamp = new Map();
    for (const j of delGameflow) {
      if (j.summonerName) porNombre.set(norm(j.summonerName), j);
      if (j.puuid && j.gameName) porNombre.set(norm(`${j.gameName}#${j.tagLine ?? ""}`), j);
      if (j.championId) porChamp.set(`${j.lado}|${j.championId}`, j);
    }

    const equipoDe = new Map(); // nombre en eventos -> equipo, para los objetivos
    for (const p of jugadores) {
      const equipo = p.team === "ORDER" ? "Azul" : p.team === "CHAOS" ? "Rojo" : "-";
      equipoDe.set(riotIdDe(p), equipo);
      if (p.summonerName) equipoDe.set(p.summonerName, equipo);
    }
    const { cuenta, rachas } = objetivos(vivo.events?.Events, equipoDe);

    const rows = [];
    for (const p of jugadores) {
      const riotId = riotIdDe(p);
      const equipo = p.team === "ORDER" ? "Azul" : p.team === "CHAOS" ? "Rojo" : "-";
      const champId = champs.porNombre.get(norm(p.championName ?? p.rawChampionName));
      const meta = porNombre.get(norm(riotId)) ?? (champId ? porChamp.get(`${equipo}|${champId}`) : null);
      const s = p.scores ?? {};
      const cs = (s.creepScore ?? 0) + (s.neutralMinionsKilled ?? 0);
      const muertes = s.deaths ?? 0;
      const ratio = (s.kills ?? 0) + (s.assists ?? 0) === 0 ? 0 : ((s.kills ?? 0) + (s.assists ?? 0)) / Math.max(1, muertes);
      const party = meta?.teamParticipantId ? parties.get(meta.teamParticipantId) : null;
      const soyYo = yo != null && (riotId === yo || p.summonerName === yo);

      const pos = POSICIONES[String(p.position ?? meta?.selectedPosition ?? "").toLowerCase()] ?? "";
      const extra = [];
      if (pos) extra.push(pos);
      if (cs) extra.push(`${(cs / minutos).toFixed(1)} CS/min`);
      if (s.wardScore) extra.push(`VIS ${Math.round(s.wardScore)}`);
      if (p.isDead) extra.push(`muerto ${Math.round(p.respawnTimer ?? 0)}s`);

      // El detalle fino (build, runas, hechizos, oro) vive en el tooltip: la
      // fila no puede crecer, la ventana tiene tamano fijo.
      const objetos = (p.items ?? [])
        .filter((i) => !i.consumable)
        .map((i) => i.displayName)
        .filter(Boolean);
      const tip = [
        `${p.championName ?? "?"} nivel ${p.level ?? "?"}`,
        [p.summonerSpells?.summonerSpellOne?.displayName, p.summonerSpells?.summonerSpellTwo?.displayName].filter(Boolean).join(" + "),
        p.runes?.keystone?.displayName,
        rachas.get(riotId) >= 2 ? `${NOMBRE_MULTIKILL[Math.min(5, rachas.get(riotId))] ?? rachas.get(riotId)} kill` : null,
        soyYo && vivo.activePlayer?.currentGold != null ? `${miles(vivo.activePlayer.currentGold)} de oro encima` : null,
        objetos.length ? `Objetos: ${objetos.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      rows.push({
        puuid: meta?.puuid ?? riotId,
        team: equipo,
        name: p.isBot ? `${p.championName ?? riotId} (bot)` : riotId,
        agent: p.championName ?? "-",
        agentId: null,
        agentIcon: champId ? `lol/champs/${champId}.png` : null,
        tier: null,
        tierLabel: p.isBot ? "Bot" : "",
        tierIcon: null,
        rr: null,
        level: p.level ?? null,
        me: soyYo,
        incognito: false,
        alertas: [],
        party: party?.indice ?? null,
        partySize: party?.tamano ?? null,
        kda: {
          kda: ratio,
          kills: s.kills ?? 0,
          deaths: muertes,
          assists: s.assists ?? 0,
          games: 1,
          sub: `${s.kills ?? 0}/${muertes}/${s.assists ?? 0}`,
          tip: `${s.kills ?? 0} kills · ${muertes} muertes · ${s.assists ?? 0} asistencias`,
        },
        stat2: cs
          ? { valor: String(cs), rotulo: "CS", sub: `${(cs / minutos).toFixed(1)}/min`, tip: `${cs} súbditos · ${(cs / minutos).toFixed(1)} por minuto` }
          : s.wardScore
            ? { valor: String(Math.round(s.wardScore)), rotulo: "VIS", sub: "visión" }
            : null,
        tip,
        linea2extra: extra.join(" · "),
      });
    }

    await this.#pintarRangos(lcu, rows, partida);

    let lado = null;
    const mia = rows.find((r) => r.me);
    if (mia) lado = mia.team === "Azul" ? "azul" : mia.team === "Rojo" ? "rojo" : null;

    const kills = { Azul: 0, Rojo: 0 };
    for (const r of rows) kills[r.team] = (kills[r.team] ?? 0) + (r.kda?.kills ?? 0);
    const mios = lado === "rojo" ? "Rojo" : "Azul";
    const suyos = mios === "Azul" ? "Rojo" : "Azul";
    const contexto = [
      mmss(gd.gameTime),
      `${kills[mios] ?? 0}-${kills[suyos] ?? 0}`,
      cuenta[mios].torres + cuenta[suyos].torres ? `Torres ${cuenta[mios].torres}-${cuenta[suyos].torres}` : null,
      cuenta[mios].dragones + cuenta[suyos].dragones ? `Dragones ${cuenta[mios].dragones}-${cuenta[suyos].dragones}` : null,
      cuenta[mios].barones + cuenta[suyos].barones ? `Barón ${cuenta[mios].barones}-${cuenta[suyos].barones}` : null,
      cuenta[mios].heraldos + cuenta[suyos].heraldos ? `Heraldo ${cuenta[mios].heraldos}-${cuenta[suyos].heraldos}` : null,
      gd.mapTerrain && gd.mapTerrain !== "Default" ? `Terreno ${gd.mapTerrain}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const modo = partida?.modo ?? MODOS[gd.gameMode] ?? gd.gameMode ?? null;
    this.#status(`LoL: en partida${modo ? ` (${modo})` : ""}.`);
    this.#emitIfChanged(
      "lol-game",
      "EN PARTIDA",
      rows,
      rows.map((r) => `${r.name}:${r.agent}:${r.kda.sub}:${r.stat2?.valor ?? ""}:${r.linea2extra}`).join(",") + "|" + contexto,
      { lado, modo, contexto, prioridad: 3 }
    );
  }

  // Partida de TFT. La API en vivo SI responde (comprobado el 2026-08-03,
  // cola 1100, Map22), pero con el esquema de LoL vacio: de cada jugador solo
  // llegan el Riot ID, su NIVEL de TFT y si sigue en pie. No hay tablero, ni
  // banca, ni oro, ni rivales identificables (el gameflow de TFT solo te trae
  // a ti, y el alias/lookup no resuelve a los demas: sin puuid no hay rango).
  // Ojo: en TFT todos los rivales llegan marcados isBot; no es cierto.
  async #enPartidaTft(gf, vivo, partida) {
    const jugadores = vivo.allPlayers ?? [];
    const gd = vivo.gameData ?? {};
    const yo = vivo.activePlayer?.riotId ?? vivo.activePlayer?.summonerName ?? null;
    const riotIdDe = (p) =>
      p.riotId || (p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagLine ?? ""}`.replace(/#$/, "") : p.summonerName) || "?";

    const rows = jugadores.map((p) => {
      const riotId = riotIdDe(p);
      return {
        puuid: riotId,
        team: "-", // en TFT cada quien va a lo suyo: la UI lo pinta como FFA
        name: riotId,
        agent: null,
        agentId: null,
        agentIcon: null,
        tier: null,
        tierLabel: p.isDead ? "Eliminado" : "En juego",
        tierIcon: null,
        rr: null,
        level: null,
        me: yo != null && riotId === yo,
        incognito: false,
        alertas: [],
        kda: null,
        stat2: { valor: String(p.level ?? "?"), rotulo: "NIVEL", sub: p.isDead ? "eliminado" : null },
        tip: "TFT no publica el tablero ni la banca de nadie: solo nivel y quién sigue en pie",
        linea2extra: "",
      };
    });

    const vivos = rows.filter((r) => r.tierLabel !== "Eliminado").length;
    const modo = partida.modo ?? "Teamfight Tactics";
    this.#status(`TFT: en partida (${modo}).`);
    this.#emitIfChanged(
      "tft-game",
      "EN PARTIDA (TFT)",
      rows,
      rows.map((r) => `${r.name}:${r.stat2.valor}:${r.tierLabel}`).join(","),
      { modo, lado: null, contexto: `${mmss(gd.gameTime)} · ${vivos} de ${rows.length} en pie`, prioridad: 3 }
    );
  }

  // Partida sin API en vivo: TFT (no la expone) y los primeros segundos de
  // carga. El gameflow ya sabe quien juega, asi que se ensena la mesa con
  // rango, nivel y party de cada uno.
  async #partidaSinVivo(lcu, gf, partida) {
    const rows = await this.#filasDeGameflow(lcu, gf, partida);
    if (!rows.length) {
      this.#status(partida.esTft ? "TFT: cargando partida..." : "LoL: cargando partida...");
      return this.#noMatch();
    }
    const modo = partida.modo ?? (partida.esTft ? "Teamfight Tactics" : null);
    this.#status(`${partida.esTft ? "TFT" : "LoL"}: en partida${modo ? ` (${modo})` : ""}.`);
    this.#emitIfChanged(
      partida.esTft ? "tft-game" : "lol-game",
      partida.esTft ? "EN PARTIDA (TFT)" : "EN PARTIDA",
      rows,
      rows.map((r) => `${r.puuid}:${r.agent}:${r.tierLabel}`).join(","),
      {
        modo,
        lado: partida.esTft ? null : rows.find((r) => r.me)?.team === "Rojo" ? "rojo" : "azul",
        contexto: partida.esTft ? "TFT no publica stats en vivo: mesa, rangos y party" : "Cargando partida",
        prioridad: 3,
      }
    );
  }

  // Filas a partir del gameflow: sirve para TFT, para la carga y como red de
  // seguridad cuando la seleccion de campeones no responde.
  async #filasDeGameflow(lcu, gf, partida) {
    const champs = await champions();
    const jugadores = [
      ...(gf?.gameData?.teamOne ?? []).map((j) => ({ ...j, lado: "Azul" })),
      ...(gf?.gameData?.teamTwo ?? []).map((j) => ({ ...j, lado: "Rojo" })),
    ];
    if (!jugadores.length) return [];
    const parties = this.#parties(jugadores);
    const yo = await this.#json(lcu, "/lol-summoner/v1/current-summoner");
    const miPuuid = yo?.puuid ?? null;

    return Promise.all(
      jugadores.map(async (j) => {
        const [rango, datos] = await Promise.all([
          this.#rank(lcu, j.puuid, partida.colasRango),
          j.summonerName ? Promise.resolve(null) : this.#summoner(lcu, j.puuid),
        ]);
        const nombre = j.summonerName || datos?.name || "(oculto)";
        const party = j.teamParticipantId ? parties.get(j.teamParticipantId) : null;
        const champId = j.championId || null;
        // En TFT la posicion elegida no significa nada; el dato util es de que
        // cola es el rango que se esta ensenando (el W-L ya va en su bloque).
        const extra = [
          partida.esTft ? "" : POSICIONES[String(j.selectedPosition ?? "").toLowerCase()] ?? "",
          rango?.cola ? `cola ${rango.cola}` : "",
        ].filter(Boolean);
        return {
          puuid: j.puuid ?? String(j.summonerId ?? nombre),
          team: partida.esTft ? "-" : j.lado,
          name: nombre,
          agent: champId ? champs.porId.get(champId) ?? String(champId) : partida.esTft ? null : "-",
          agentId: null,
          agentIcon: champId
            ? `lol/champs/${champId}.png`
            : iconoPerfil(j.profileIconId ?? datos?.iconId),
          tier: null,
          tierLabel: rango?.label ?? "Sin clasificar",
          tierIcon: rango?.icon ?? "lol/rangos/unranked.png",
          rr: rango?.lp ?? null,
          level: datos?.level ?? null,
          me: !!miPuuid && j.puuid === miPuuid,
          incognito: nombre === "(oculto)",
          alertas: [],
          party: party?.indice ?? null,
          partySize: party?.tamano ?? null,
          kda: null,
          stat2: this.#bloqueWinrate(rango),
          tip: rango ? `Rango ${rango.cola}: ${rango.label}${rango.lp != null ? ` (${rango.lp} LP)` : ""}` : null,
          linea2extra: extra.join(" · "),
        };
      })
    );
  }

  #bloqueWinrate(rango) {
    if (!rango || rango.wins == null || rango.losses == null) return null;
    const total = rango.wins + rango.losses;
    if (!total) return null;
    const wr = Math.round((rango.wins / total) * 100);
    return {
      valor: `${wr}%`,
      rotulo: "WR",
      sub: `${rango.wins}W-${rango.losses}L`,
      clase: wr >= 60 ? "bien" : wr <= 40 ? "mal" : "",
      tip: `${total} partidas de ${rango.cola} esta temporada`,
    };
  }

  // Rango de cada fila cuando solo tenemos el riotId (partida en vivo): se
  // resuelve el puuid por alias y se cachea; sin LCU las filas van sin rango.
  async #pintarRangos(lcu, rows, partida) {
    if (!lcu) return;
    await Promise.all(
      rows.map(async (r) => {
        if (r.tierLabel === "Bot") return; // los bots no tienen rango que buscar
        try {
          const puuid = /^[0-9a-f-]{36}$/i.test(r.puuid) ? r.puuid : await this.#puuidDe(lcu, r.name);
          if (!puuid) return;
          const rango = await this.#rank(lcu, puuid, partida?.colasRango ?? ["RANKED_SOLO_5x5"]);
          if (!rango) {
            if (!r.tierLabel) {
              r.tierLabel = "Sin clasificar";
              r.tierIcon = "lol/rangos/unranked.png";
            }
            return;
          }
          r.tierLabel = rango.label;
          r.tierIcon = rango.icon;
          r.rr = rango.lp;
          if (rango.wins != null && rango.losses != null) {
            r.tip = [r.tip, `${rango.cola}: ${rango.wins}W-${rango.losses}L`].filter(Boolean).join(" · ");
          }
        } catch {
          // sin permiso o endpoint caido: la fila se queda sin rango
        }
      })
    );
  }

  // Seleccion de campeones: tu equipo siempre, el rival cuando el cliente lo
  // publica (reclutamiento, clasificatoria y torneos). Incluye baneos.
  async #champSelect(lcu, gf, partida) {
    const cs = await this.#json(lcu, "/lol-champ-select/v1/session");
    if (!cs || !Array.isArray(cs.myTeam) || !cs.myTeam.length) {
      // TFT y algunos modos no tienen seleccion: cae al roster del gameflow.
      const rows = await this.#filasDeGameflow(lcu, gf, partida);
      if (rows.length) {
        this.#status("LoL: emparejado, esperando partida.");
        return this.#emitIfChanged("lol-champselect", "PARTIDA ENCONTRADA", rows,
          rows.map((r) => r.puuid).join(","), { modo: partida.modo, prioridad: 3 });
      }
      this.#status("LoL: cliente abierto, sin partida.");
      return this.#noMatch();
    }
    const champs = await champions();
    const parties = this.#parties([...(gf?.gameData?.teamOne ?? []), ...(gf?.gameData?.teamTwo ?? [])]);
    const puuidParty = new Map();
    for (const j of [...(gf?.gameData?.teamOne ?? []), ...(gf?.gameData?.teamTwo ?? [])]) {
      if (j.puuid && j.teamParticipantId) puuidParty.set(j.puuid, parties.get(j.teamParticipantId));
    }

    const fila = async (m, equipo, rival) => {
      const champId = m.championId || m.championPickIntent || 0;
      const [rango, datos, maestria] = await Promise.all([
        this.#rank(lcu, m.puuid, partida.colasRango),
        this.#summoner(lcu, m.puuid),
        rival ? Promise.resolve(null) : this.#maestria(lcu, m.puuid, champId),
      ]);
      const nombre = datos?.name ?? (rival ? "Rival" : "(oculto)");
      const hechizos = [HECHIZOS[m.spell1Id], HECHIZOS[m.spell2Id]].filter(Boolean).join(" + ");
      const extra = [
        POSICIONES[String(m.assignedPosition ?? "").toLowerCase()] ?? "",
        rango?.wins != null ? `${rango.wins}W-${rango.losses}L` : "",
        hechizos,
      ].filter(Boolean);
      const party = m.puuid ? puuidParty.get(m.puuid) : null;
      return {
        puuid: m.puuid || String(m.cellId),
        team: equipo,
        name: nombre,
        agent: champId ? champs.porId.get(champId) ?? String(champId) : "-",
        agentId: null,
        agentIcon: champId ? `lol/champs/${champId}.png` : iconoPerfil(datos?.iconId),
        tier: null,
        tierLabel: rango?.label ?? "Sin clasificar",
        tierIcon: rango?.icon ?? "lol/rangos/unranked.png",
        rr: rango?.lp ?? null,
        level: datos?.level ?? null,
        me: m.cellId === cs.localPlayerCellId,
        incognito: nombre === "(oculto)" || nombre === "Rival",
        alertas: [],
        party: party?.indice ?? null,
        partySize: party?.tamano ?? null,
        kda: null,
        stat2: maestria
          ? { valor: String(maestria.nivel), rotulo: "MAESTRÍA", sub: `${miles(maestria.puntos)} pts`, tip: `${maestria.puntos.toLocaleString("es-MX")} puntos de maestría` }
          : this.#bloqueWinrate(rango),
        tip: [
          rango ? `Rango ${rango.cola}: ${rango.label}${rango.lp != null ? ` (${rango.lp} LP)` : ""}` : null,
          hechizos || null,
        ].filter(Boolean).join(" · "),
        linea2extra: extra.join(" · "),
      };
    };

    const mios = await Promise.all(cs.myTeam.map((m) => fila(m, "Azul", false)));
    const suyos = await Promise.all((cs.theirTeam ?? []).filter((m) => m.championId || m.puuid).map((m) => fila(m, "Rojo", true)));
    const rows = [...mios, ...suyos];

    const baneados = (ids) =>
      (ids ?? []).filter(Boolean).map((id) => champs.porId.get(id) ?? id).join(", ");
    const misBans = baneados(cs.bans?.myTeamBans);
    const susBans = baneados(cs.bans?.theirTeamBans);
    const contexto = [
      misBans ? `Baneos tuyos: ${misBans}` : null,
      susBans ? `Baneos rivales: ${susBans}` : null,
    ].filter(Boolean).join(" · ");

    // team 1 = lado azul (inferior), team 2 = lado rojo (superior)
    const lado = cs.myTeam[0]?.team === 2 ? "rojo" : "azul";
    this.#status(`LoL: selección de campeones${partida.modo ? ` (${partida.modo})` : ""}.`);
    this.#emitIfChanged(
      "lol-champselect",
      suyos.length ? "SELECCIÓN DE CAMPEONES" : "SELECCIÓN DE CAMPEONES (solo tu equipo)",
      rows,
      rows.map((r) => `${r.puuid}:${r.agent}:${r.stat2?.valor ?? ""}`).join(",") + "|" + contexto,
      { lado, modo: partida.modo, contexto, prioridad: 3 }
    );
  }

  // Fin de partida: el cliente publica el bloque de estadisticas completo de
  // los diez (daño, oro, CS, vision, multikills...). Es el resumen que antes
  // se perdia en cuanto acababa la partida.
  async #finPartida(lcu, gf, partida) {
    this.#perfilCache = null; // acaba de haber partida nueva: el perfil caduca
    const eog = await this.#jsonAlguno(lcu, [
      "/lol-end-of-game/v1/eog-stats-block",
      "/lol-end-of-game/v1/champion-mastery-updates",
    ]);
    const equipos = Array.isArray(eog?.teams) ? eog.teams : null;
    if (!equipos?.length) {
      // TFT no publica este bloque: mantenemos la mesa visible.
      const rows = await this.#filasDeGameflow(lcu, gf, partida);
      if (!rows.length) {
        this.#status("LoL: partida terminada.");
        return this.#noMatch();
      }
      return this.#emitIfChanged("lol-eog", "PARTIDA TERMINADA", rows,
        rows.map((r) => r.puuid).join(","), { modo: partida.modo, prioridad: 3 });
    }

    const champs = await champions();
    const yo = await this.#json(lcu, "/lol-summoner/v1/current-summoner");
    const miNombre = yo?.gameName ?? yo?.displayName ?? null;
    const num = (s, k) => Number(s?.[k] ?? 0);
    const rows = [];
    let gane = null;
    for (const equipo of equipos) {
      const esMio = (equipo.players ?? []).some(
        (p) => (p.puuid && yo?.puuid && p.puuid === yo.puuid) || (miNombre && (p.riotIdGameName === miNombre || p.summonerName === miNombre))
      );
      if (esMio) gane = !!equipo.isWinningTeam;
      for (const p of equipo.players ?? []) {
        const s = p.stats ?? {};
        const k = num(s, "CHAMPIONS_KILLED");
        const d = num(s, "NUM_DEATHS");
        const a = num(s, "ASSISTS");
        const cs = num(s, "MINIONS_KILLED") + num(s, "NEUTRAL_MINIONS_KILLED");
        const daño = num(s, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS");
        const oro = num(s, "GOLD_EARNED");
        const vision = num(s, "VISION_SCORE");
        const multi = num(s, "LARGEST_MULTI_KILL");
        const nombre = p.riotIdGameName
          ? `${p.riotIdGameName}#${p.riotIdTagLine ?? ""}`.replace(/#$/, "")
          : p.summonerName || "(oculto)";
        rows.push({
          puuid: p.puuid ?? nombre,
          team: esMio ? "Azul" : "Rojo",
          name: nombre,
          agent: champs.porId.get(p.championId) ?? "-",
          agentId: null,
          agentIcon: p.championId ? `lol/champs/${p.championId}.png` : null,
          tier: null,
          tierLabel: equipo.isWinningTeam ? "Victoria" : "Derrota",
          tierIcon: null,
          rr: null,
          level: num(s, "LEVEL") || null,
          me: !!(p.puuid && yo?.puuid && p.puuid === yo.puuid) || (!!miNombre && p.riotIdGameName === miNombre),
          incognito: false,
          alertas: [],
          kda: {
            kda: k + a === 0 ? 0 : (k + a) / Math.max(1, d),
            kills: k, deaths: d, assists: a, games: 1,
            sub: `${k}/${d}/${a}`,
            tip: `${k} kills · ${d} muertes · ${a} asistencias${multi >= 2 ? ` · ${NOMBRE_MULTIKILL[Math.min(5, multi)]} kill` : ""}`,
          },
          stat2: {
            valor: miles(daño),
            rotulo: "DAÑO",
            sub: `${miles(oro)} oro`,
            tip: `${daño.toLocaleString("es-MX")} de daño a campeones · ${num(s, "TOTAL_DAMAGE_TAKEN").toLocaleString("es-MX")} recibido`,
          },
          tip: [
            `${cs} CS`,
            vision ? `Visión ${vision}` : null,
            num(s, "WARD_PLACED") ? `${num(s, "WARD_PLACED")} guardianes puestos` : null,
            num(s, "WARD_KILLED") ? `${num(s, "WARD_KILLED")} destruidos` : null,
            num(s, "TURRETS_KILLED") ? `${num(s, "TURRETS_KILLED")} torres` : null,
            num(s, "TOTAL_HEAL") ? `${miles(num(s, "TOTAL_HEAL"))} de curación` : null,
          ].filter(Boolean).join(" · "),
          linea2extra: [`${cs} CS`, vision ? `VIS ${vision}` : null].filter(Boolean).join(" · "),
        });
      }
    }
    this.#status("LoL: resumen de la partida.");
    this.#emitIfChanged(
      "lol-eog",
      gane === null ? "RESUMEN DE LA PARTIDA" : gane ? "VICTORIA" : "DERROTA",
      rows,
      rows.map((r) => `${r.puuid}:${r.kda.sub}:${r.stat2.valor}`).join(","),
      {
        modo: partida.modo,
        lado: null,
        contexto: gane === null ? null : gane ? "Partida ganada" : "Partida perdida",
        prioridad: 3,
      }
    );
  }

  // Tu perfil: lo que se ve con el cliente abierto y sin partida. Icono de
  // perfil, nivel, rango de TODAS las colas (incluidas las de TFT) y las
  // ultimas partidas con sus stats. Se reconstruye cada 5 min o al acabar una
  // partida (el historial es la peticion mas pesada del LCU).
  async #perfil(lcu) {
    if (this.#perfilCache && Date.now() - this.#perfilCache.at < 5 * 60e3) {
      return this.emit("profile", this.#perfilCache.perfil);
    }
    const yo = await this.#json(lcu, "/lol-summoner/v1/current-summoner");
    if (!yo?.puuid) return;
    const champs = await champions();
    const [qm, hist] = await Promise.all([
      this.#queueMap(lcu, yo.puuid),
      this.#json(lcu, "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=19"),
    ]);

    const rangos = [];
    for (const [cola, nombre] of COLAS_PERFIL) {
      const r = formatoRango(qm?.[cola], cola);
      if (r) rangos.push({ ...r, cola: nombre });
      else if (cola === "RANKED_SOLO_5x5" || cola === "RANKED_TFT") {
        rangos.push({ label: "Sin clasificar", icon: "lol/rangos/unranked.png", lp: null, wins: null, losses: null, cola: nombre });
      }
    }

    // Historial: cada partida con lo suyo. En TFT y Arena lo que cuenta es el
    // puesto (subteamPlacement), no el KDA.
    const partidas = [];
    for (const g of hist?.games?.games ?? []) {
      const id = (g.participantIdentities ?? []).find((p) => p.player?.puuid === yo.puuid)?.participantId;
      const p = (g.participants ?? []).find((x) => x.participantId === id) ?? g.participants?.[0];
      if (!p) continue;
      const s = p.stats ?? {};
      const esTft = g.queueId >= 1090 && g.queueId <= 1180;
      partidas.push({
        gameId: g.gameId,
        modo: COLAS[g.queueId] ?? g.gameMode ?? "",
        champId: p.championId || null,
        campeon: champs.porId.get(p.championId) ?? null,
        k: s.kills ?? 0,
        d: s.deaths ?? 0,
        a: s.assists ?? 0,
        cs: (s.totalMinionsKilled ?? 0) + (s.neutralMinionsKilled ?? 0),
        oro: s.goldEarned ?? 0,
        daño: s.totalDamageDealtToChampions ?? 0,
        vision: s.visionScore ?? 0,
        nivel: s.champLevel ?? null,
        puesto: esTft || g.gameMode === "CHERRY" ? s.subteamPlacement || null : null,
        won: !!s.win,
        duracion: g.gameDuration ?? 0,
        fecha: g.gameCreationDate ?? null,
      });
    }

    // Medias de las ultimas partidas con campeon (las de TFT no suman KDA).
    const conKda = partidas.filter((m) => m.champId);
    const suma = (f) => conKda.reduce((t, m) => t + f(m), 0);
    const minutos = Math.max(1, suma((m) => m.duracion) / 60);
    const kda = conKda.length
      ? {
          kills: suma((m) => m.k), deaths: suma((m) => m.d), assists: suma((m) => m.a),
          kda: (suma((m) => m.k) + suma((m) => m.a)) / Math.max(1, suma((m) => m.d)),
          games: conKda.length,
          winRate: conKda.filter((m) => m.won).length / conKda.length,
          csMin: suma((m) => m.cs) / minutos,
          dañoMin: suma((m) => m.daño) / minutos,
          vision: suma((m) => m.vision) / conKda.length,
        }
      : null;

    const porCampeon = new Map();
    for (const m of conKda) {
      const e = porCampeon.get(m.champId) ?? { champId: m.champId, campeon: m.campeon, games: 0, wins: 0 };
      e.games++;
      if (m.won) e.wins++;
      porCampeon.set(m.champId, e);
    }
    const campeonTop = [...porCampeon.values()].sort((a, b) => b.games - a.games)[0] ?? null;

    const perfil = {
      game: "lol",
      name: yo.gameName ? `${yo.gameName}#${yo.tagLine ?? ""}`.replace(/#$/, "") : yo.displayName ?? "",
      level: yo.summonerLevel ?? null,
      xpPct: yo.percentCompleteForNextLevel ?? null,
      icono: iconoPerfil(yo.profileIconId),
      iconoAlt: iconoPerfilAlt(yo.profileIconId),
      rangos,
      kda,
      campeonTop,
      partidas,
    };
    this.#perfilCache = { perfil, at: Date.now() };
    this.emit("profile", perfil);
  }

  // Lobby y busqueda de partida: ensena a los premades con su rango antes de
  // entrar. Prioridad baja para no robarle la pantalla a una partida en curso.
  async #lobby(lcu, partida) {
    const lobby = await this.#json(lcu, "/lol-lobby/v2/lobby");
    const miembros = lobby?.members ?? [];
    if (!miembros.length) {
      this.#status("LoL: cliente abierto, sin partida.");
      return this.#noMatch();
    }
    const yo = await this.#json(lcu, "/lol-summoner/v1/current-summoner");
    const colas = colasDeRango(lobby?.gameConfig?.queueId ?? partida.queueId, partida.gameMode);
    const rows = await Promise.all(
      miembros.map(async (m) => {
        const [rango, datos] = await Promise.all([
          this.#rank(lcu, m.puuid, colas),
          this.#summoner(lcu, m.puuid),
        ]);
        return {
          puuid: m.puuid ?? String(m.summonerId),
          team: "Azul",
          name: datos?.name ?? m.summonerName ?? "(oculto)",
          agent: null, // en el lobby todavia no hay campeon que ensenar
          agentId: null,
          agentIcon: iconoPerfil(datos?.iconId),
          tier: null,
          tierLabel: rango?.label ?? "Sin clasificar",
          tierIcon: rango?.icon ?? "lol/rangos/unranked.png",
          rr: rango?.lp ?? null,
          level: datos?.level ?? null,
          me: !!(yo?.puuid && m.puuid === yo.puuid),
          incognito: false,
          alertas: [],
          kda: null,
          stat2: this.#bloqueWinrate(rango),
          tip: rango ? `Rango ${rango.cola}: ${rango.label}${rango.lp != null ? ` (${rango.lp} LP)` : ""}` : null,
          linea2extra: m.isLeader ? "líder del grupo" : "",
        };
      })
    );
    const nombreCola = COLAS[lobby?.gameConfig?.queueId] ?? partida.modo ?? null;
    this.#status(`LoL: en el lobby${nombreCola ? ` (${nombreCola})` : ""}.`);
    this.#emitIfChanged(
      "lol-lobby",
      "LOBBY",
      rows,
      rows.map((r) => `${r.puuid}:${r.tierLabel}`).join(",") + "|" + nombreCola,
      { modo: nombreCola, contexto: `${rows.length} en el grupo`, prioridad: 1 }
    );
  }
}
