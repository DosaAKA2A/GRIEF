// grief-tft: calcula las mejores composiciones del parche a partir de partidas
// reales de Challenger con la API oficial de Riot, y las sirve como JSON para
// la app. Recalcula una vez al dia (cron) y guarda el resultado en KV, asi que
// la app nunca espera y la clave de Riot no sale de aqui.
//
// Rutas:
//   GET /comps    lista de comps ordenada (lo que consume GRIEF)
//   GET /estado   cuando se calculo, cuantas partidas entraron y con que parche
//   GET /refresca recalcula ahora mismo (requiere cabecera X-Clave con ADMIN)
//
// Secretos:  RIOT_KEY (clave de developer.riotgames.com), ADMIN (opcional)

const CLAVE_KV = "comps:v1";
const CDRAGON = "https://raw.communitydragon.org/latest/cdragon/tft/es_mx.json";

const cabeceras = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=1800",
};

const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: cabeceras });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/comps" || url.pathname === "/") {
      const guardado = await env.COMPS.get(CLAVE_KV, "json");
      if (guardado) return json(guardado);
      if (!env.RIOT_KEY) return json({ error: "falta la clave de Riot", comps: [] }, 503);
      const nuevo = await calcular(env);
      ctx.waitUntil(env.COMPS.put(CLAVE_KV, JSON.stringify(nuevo)));
      return json(nuevo);
    }
    if (url.pathname === "/estado") {
      const guardado = await env.COMPS.get(CLAVE_KV, "json");
      return json({
        hayClave: !!env.RIOT_KEY,
        calculado: guardado?.calculado ?? null,
        partidas: guardado?.partidas ?? 0,
        parche: guardado?.parche ?? null,
        comps: guardado?.comps?.length ?? 0,
      });
    }
    if (url.pathname === "/refresca") {
      if (!env.ADMIN || request.headers.get("X-Clave") !== env.ADMIN) return json({ error: "no autorizado" }, 401);
      const nuevo = await calcular(env);
      await env.COMPS.put(CLAVE_KV, JSON.stringify(nuevo));
      return json(nuevo);
    }
    return json({ error: "no existe" }, 404);
  },

  async scheduled(evento, env, ctx) {
    if (!env.RIOT_KEY) return;
    ctx.waitUntil(calcular(env).then((r) => env.COMPS.put(CLAVE_KV, JSON.stringify(r))));
  },
};

// ---- Riot API ----

async function riot(env, host, ruta) {
  const res = await fetch(`https://${host}.api.riotgames.com${ruta}`, {
    headers: { "X-Riot-Token": env.RIOT_KEY },
  });
  if (res.status === 429) {
    // Limite de peticiones: esperamos lo que diga Riot y reintentamos una vez.
    const espera = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.min(10, espera) * 1000));
    return riot(env, host, ruta);
  }
  if (!res.ok) throw new Error(`Riot ${res.status} en ${ruta}`);
  return res.json();
}

// ---- Datos del set (nombres, coste e iconos de unidades, rasgos y objetos) ----

async function datosDelSet() {
  const res = await fetch(CDRAGON);
  if (!res.ok) throw new Error("Community Dragon no responde");
  const data = await res.json();
  // El set activo es el de numero mas alto con unidades.
  const sets = Object.entries(data.sets ?? {})
    .map(([num, s]) => ({ num: Number(num), ...s }))
    .filter((s) => (s.champions ?? []).length)
    .sort((a, b) => b.num - a.num);
  const set = sets[0] ?? { champions: [], traits: [] };
  const icono = (ruta) =>
    ruta
      ? "https://raw.communitydragon.org/latest/game/" +
        String(ruta).toLowerCase().replace(/\.(tex|dds)$/, ".png").replace(/^\/+/, "")
      : null;
  return {
    numero: set.num ?? null,
    unidades: new Map(
      (set.champions ?? []).map((c) => [
        c.apiName,
        { id: c.apiName, nombre: c.name, coste: c.cost ?? 0, icono: icono(c.tileIcon ?? c.squareIcon), rasgos: c.traits ?? [] },
      ])
    ),
    rasgos: new Map((set.traits ?? []).map((t) => [t.apiName, { nombre: t.name, icono: icono(t.icon) }])),
    objetos: new Map((data.items ?? []).map((i) => [i.apiName ?? i.nameId, { nombre: i.name, icono: icono(i.icon) }])),
  };
}

// ---- Calculo ----

// La comp de un jugador se identifica por sus dos rasgos activos mas fuertes
// mas su carry (la unidad mas cara con objetos). Es la misma forma de nombrar
// que usan las tier lists, y sale de datos, no de opiniones.
function claveDeComp(p, set) {
  const activos = (p.traits ?? [])
    .filter((t) => (t.tier_current ?? 0) > 0)
    .sort((a, b) => (b.tier_current ?? 0) - (a.tier_current ?? 0) || (b.num_units ?? 0) - (a.num_units ?? 0))
    .slice(0, 2);
  const carry = [...(p.units ?? [])]
    .sort(
      (a, b) =>
        (b.itemNames?.length ?? 0) - (a.itemNames?.length ?? 0) ||
        (b.rarity ?? 0) - (a.rarity ?? 0) ||
        (b.tier ?? 0) - (a.tier ?? 0)
    )[0];
  const nombreRasgo = (t) => set.rasgos.get(t.name)?.nombre ?? String(t.name ?? "").replace(/^TFT\d+_/, "");
  const nombreUnidad = (u) => set.unidades.get(u?.character_id)?.nombre ?? String(u?.character_id ?? "").replace(/^TFT\d+_/, "");
  return {
    id: [...activos.map((t) => t.name), carry?.character_id].filter(Boolean).join("|"),
    nombre: [activos.map(nombreRasgo).join(" "), carry ? nombreUnidad(carry) : null].filter(Boolean).join(" · "),
    rasgos: activos.map((t) => ({ id: t.name, nombre: nombreRasgo(t), nivel: t.tier_current, unidades: t.num_units })),
    carry: carry ? { id: carry.character_id, nombre: nombreUnidad(carry) } : null,
  };
}

function moda(mapa, n) {
  return [...mapa.entries()]
    .sort((a, b) => b[1].veces - a[1].veces)
    .slice(0, n)
    .map(([, v]) => v.dato);
}

async function calcular(env) {
  const set = await datosDelSet();
  const jugadores = Number(env.JUGADORES ?? 40);
  const porJugador = Number(env.PARTIDAS ?? 8);

  const liga = await riot(env, env.PLATAFORMA, "/tft/league/v1/challenger");
  const puuids = (liga.entries ?? [])
    .sort((a, b) => (b.leaguePoints ?? 0) - (a.leaguePoints ?? 0))
    .slice(0, jugadores)
    .map((e) => e.puuid)
    .filter(Boolean);

  const ids = new Set();
  for (const puuid of puuids) {
    try {
      const lista = await riot(env, env.RUTA, `/tft/match/v1/matches/by-puuid/${puuid}/ids?count=${porJugador}`);
      for (const id of lista) ids.add(id);
    } catch {
      // un jugador que falle no puede tumbar el calculo entero
    }
  }

  const comps = new Map();
  let partidas = 0;
  let parche = null;
  for (const id of ids) {
    let m;
    try {
      m = await riot(env, env.RUTA, `/tft/match/v1/matches/${id}`);
    } catch {
      continue;
    }
    // Solo partidas normales/clasificatorias de 8; fuera dobles y modos raros.
    const info = m.info ?? {};
    if ((info.participants ?? []).length !== 8) continue;
    if (info.queue_id != null && ![1090, 1100].includes(info.queue_id)) continue;
    parche = info.game_version ?? parche;
    partidas++;
    for (const p of info.participants) {
      const clave = claveDeComp(p, set);
      if (!clave.id) continue;
      let c = comps.get(clave.id);
      if (!c) {
        c = {
          id: clave.id, nombre: clave.nombre, rasgos: clave.rasgos, carry: clave.carry,
          partidas: 0, suma: 0, top4: 0, primeros: 0,
          unidades: new Map(), objetos: new Map(), aumentos: new Map(), niveles: new Map(),
        };
        comps.set(clave.id, c);
      }
      c.partidas++;
      c.suma += p.placement ?? 8;
      if ((p.placement ?? 8) <= 4) c.top4++;
      if ((p.placement ?? 8) === 1) c.primeros++;
      for (const u of p.units ?? []) {
        const info = set.unidades.get(u.character_id);
        const e = c.unidades.get(u.character_id) ?? {
          veces: 0,
          dato: { id: u.character_id, nombre: info?.nombre ?? u.character_id, coste: info?.coste ?? u.rarity + 1, icono: info?.icono ?? null, estrellas: u.tier ?? 1, objetos: [] },
        };
        e.veces++;
        e.dato.estrellas = Math.max(e.dato.estrellas, u.tier ?? 1);
        for (const it of u.itemNames ?? []) {
          const objeto = set.objetos.get(it)?.nombre ?? it;
          if (!e.dato.objetos.includes(objeto) && e.dato.objetos.length < 3) e.dato.objetos.push(objeto);
        }
        c.unidades.set(u.character_id, e);
      }
      for (const a of p.augments ?? []) {
        const e = c.aumentos.get(a) ?? { veces: 0, dato: a.replace(/^TFT\d*_?Augment_?/i, "").replace(/([a-z])([A-Z])/g, "$1 $2") };
        e.veces++;
        c.aumentos.set(a, e);
      }
    }
  }

  // Solo comps con muestra suficiente; el orden manda el puesto medio.
  const minimo = Math.max(3, Math.round(partidas * 0.02));
  const lista = [...comps.values()]
    .filter((c) => c.partidas >= minimo)
    .map((c) => ({
      id: c.id,
      nombre: c.nombre,
      rasgos: c.rasgos,
      carry: c.carry,
      partidas: c.partidas,
      puesto: c.suma / c.partidas,
      top4: c.top4 / c.partidas,
      primeros: c.primeros / c.partidas,
      unidades: moda(c.unidades, 9).sort((a, b) => b.coste - a.coste),
      aumentos: moda(c.aumentos, 3),
    }))
    .sort((a, b) => a.puesto - b.puesto)
    .slice(0, 24);

  // Tier por puesto medio: es la escala que usan las tier lists de TFT.
  for (const c of lista) {
    c.tier = c.puesto <= 4.0 ? "S" : c.puesto <= 4.35 ? "A" : c.puesto <= 4.6 ? "B" : "C";
  }

  return {
    calculado: new Date().toISOString(),
    parche: parche ? String(parche).split(" ")[0] : null,
    set: set.numero,
    region: env.PLATAFORMA,
    partidas,
    comps: lista,
  };
}
