// UI del tracker: escucha /events (SSE) y pinta el estado.
// Todo el DOM se construye con createElement: los nombres vienen de Riot
// y no deben interpretarse nunca como HTML.

const FASES = {
  pregame: "Selección de agentes",
  core: "En partida",
  "lol-champselect": "Selección de campeones",
  "lol-game": "En partida",
  "tft-game": "En partida",
  "lol-eog": "Resumen de la partida",
  "lol-lobby": "Lobby",
};

// Color por indice de tier (0-27). El color es el dato: se lee desde lejos.
const COLORES_RANGO = [
  ["#7a8894", 0, 2], // sin rango
  ["#8b9096", 3, 5], // hierro
  ["#b06a43", 6, 8], // bronce
  ["#c6ccd2", 9, 11], // plata
  ["#e8c35c", 12, 14], // oro
  ["#3fb7c9", 15, 17], // platino
  ["#b18be8", 18, 20], // diamante
  ["#46b083", 21, 23], // ascendente
  ["#d24357", 24, 26], // inmortal
  ["#f5e39a", 27, 27], // radiante
];

function colorRango(tier) {
  for (const [color, desde, hasta] of COLORES_RANGO) {
    if (tier >= desde && tier <= hasta) return color;
  }
  return "#7a8894";
}

// Color distintivo por party: lo lleva la espina izquierda (mismo color =
// van juntos). El tamano del grupo queda en el tooltip de la espina.
const COLORES_PARTY = ["#ffd166", "#06d6a0", "#118ab2", "#ef476f", "#9b5de5"];

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Tooltip propio para data-tip. El title nativo se pierde cuando la fila se
// reconstruye bajo el cursor con cada evento SSE; este se posiciona solo y
// funciona por delegacion, asi que da igual cuantas veces se repinte el DOM.
const tip = el("div", "tip");
tip.hidden = true;
document.addEventListener("DOMContentLoaded", () => document.body.append(tip));

document.addEventListener("mouseover", (ev) => {
  const objetivo = ev.target.closest?.("[data-tip]");
  if (!objetivo) {
    tip.hidden = true;
    return;
  }
  tip.textContent = objetivo.dataset.tip;
  tip.hidden = false;
  const r = objetivo.getBoundingClientRect();
  tip.style.left = "0px"; // resetea para medir el ancho real
  tip.style.top = "0px";
  const ancho = tip.offsetWidth;
  const alto = tip.offsetHeight;
  let x = r.left + r.width / 2 - ancho / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - ancho - 8));
  let y = r.top - alto - 8;
  if (y < 8) y = r.bottom + 8;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});
document.addEventListener("scroll", () => { tip.hidden = true; }, true);

// Iconos oficiales en /rangos/{tier}.png; existen del 3 (Hierro 1) al 27
// (Radiante). Sin rango (0-2) no tiene icono.
function iconoRango(tier, clase) {
  if (tier < 3 || tier > 27) return null;
  const img = el("img", clase);
  img.src = `rangos/${tier}.png`;
  img.alt = "";
  return img;
}

// Fila con columnas fijas: [espina][retrato][insignia][identidad][KDA][RR].
// Cada dato vive SIEMPRE en la misma posicion; ninguna fila cambia de forma
// por llevar señales o textos largos.
function filaJugador(r, juego) {
  const rotuloRr = juego === "lol" ? "LP" : "RR";
  const li = el("li", "jugador");
  li.style.setProperty("--rango", colorRango(r.tier));

  const espina = el("i", "espina");
  if (r.party) {
    li.style.setProperty("--party", COLORES_PARTY[(r.party - 1) % COLORES_PARTY.length]);
    espina.dataset.tip = `Party de ${r.partySize} jugadores`;
    espina.style.cursor = "help";
  }

  const retrato = el("div", "retrato");
  const rutaCara = r.agentIcon ?? (r.agentId ? `agentes/${r.agentId}.png` : null);
  if (rutaCara) {
    const cara = el("img", "retrato-img");
    cara.src = rutaCara;
    cara.alt = "";
    cara.onerror = () => cara.remove(); // icono ausente: hueco limpio
    retrato.append(cara);
  }

  const insignia = el("div", "insignia");
  if (r.tierIcon) {
    const img = el("img", "insignia-img");
    img.src = r.tierIcon;
    img.alt = "";
    img.onerror = () => img.remove();
    insignia.append(img);
  } else {
    const icono = iconoRango(r.tier, "insignia-img");
    if (icono) insignia.append(icono);
  }

  // Columna de identidad: quien es (arriba) y que rango tiene (abajo).
  const cuerpo = el("div", "cuerpo");
  const linea1 = el("div", "linea1");
  // agent null = en ese modo no hay pick que ensenar (TFT, lobby); "-" si lo
  // hay pero todavia no se ha elegido.
  const sinPick = !r.agent || r.agent === "-";
  const agente = r.agent === null ? null : el("span", "agente" + (sinPick ? " sin-pick" : ""), sinPick ? "sin pick" : r.agent);
  const nombre = el("span", "nombre" + (r.incognito ? " oculto" : ""), r.name);
  // El detalle largo (build, runas, hechizos, rango) no cabe en la fila: vive
  // en el tooltip, que es donde la vista se para a mirar.
  if (r.tip) {
    const ancla = agente ?? nombre;
    ancla.dataset.tip = r.tip;
    ancla.style.cursor = "help";
  }
  if (agente) linea1.append(agente);
  if (r.me) nombre.append(el("span", "yo", "TU"));
  linea1.append(nombre);

  // La info de rango cede con puntos suspensivos; las señales NUNCA se cortan.
  const linea2 = el("div", "linea2");
  const izq = el("span", "l2-izq");
  if (r.tierLabel) izq.append(el("span", "rango-nombre", r.tierLabel));
  if (r.peak > r.tier) {
    // Solo "Peak" + medalla: el nombre del rango repetia la medalla y salia
    // truncado. El nombre completo queda en el tooltip.
    const peak = el("span", "peak", "Peak ");
    const peakIcono = iconoRango(r.peak, "peak-img");
    if (peakIcono) peak.append(peakIcono);
    else peak.append(document.createTextNode(" " + r.peakLabel));
    peak.dataset.tip = `Peak: ${r.peakLabel}`;
    izq.append(peak);
  }
  if (r.level != null) izq.append(el("span", "nivel", `Nv ${r.level}`));
  if (r.linea2extra) izq.append(el("span", "extra", r.linea2extra));
  linea2.append(izq);
  if (r.alertas?.length) {
    const flags = el("span", "flags");
    for (const a of r.alertas) {
      const chip = el("span", "alerta " + a.tipo, "¿" + a.texto.replace(/^Posible\s+/i, "") + "?");
      chip.dataset.tip = `${a.texto}: ${a.detalle}`;
      flags.append(chip);
    }
    linea2.append(flags);
  }
  cuerpo.append(linea1, linea2);

  // Bloques de estadistica: columnas fijas, los numeros protagonistas.
  const statKda = el("div", "stat");
  if (r.kda) {
    const valor = r.kda.kda;
    const b = el("b", valor >= 1.3 ? "bien" : valor <= 0.8 ? "mal" : "", valor.toFixed(2));
    statKda.append(b, el("small", null, "KDA"));
    const hs = r.kda.hsRate != null ? Math.round(r.kda.hsRate * 100) : null;
    // sub/tip propios: en LoL el bloque es de la partida en curso, no de un
    // historial, asi que el texto de apoyo lo decide quien manda la fila.
    const sub = r.kda.sub ?? (hs != null ? `HS ${hs}%` : `${r.kda.games} partidas`);
    statKda.append(el("span", "sub" + (hs != null && hs >= 30 ? " alto" : ""), sub));
    statKda.dataset.tip = r.kda.tip ?? `${r.kda.kills}/${r.kda.deaths}/${r.kda.assists} en ${r.kda.games} partidas`;
  } else {
    statKda.append(el("b", "vacio", "—"), el("small", null, "KDA"));
  }

  li.append(espina, retrato, insignia, cuerpo, statKda);

  // Segunda columna de stats. En LoL la llena el tracker segun la fase (CS en
  // partida, daño al acabar, maestria o winrate antes de empezar); en Valorant
  // es siempre el ADR. Misma anchura en los dos casos: la fila no se mueve.
  if (juego === "lol") {
    const stat2 = el("div", "stat stat-extra");
    if (r.stat2) {
      stat2.append(el("b", r.stat2.clase ?? "", r.stat2.valor ?? "—"), el("small", null, r.stat2.rotulo ?? ""));
      if (r.stat2.sub) stat2.append(el("span", "sub", r.stat2.sub));
      if (r.stat2.tip) stat2.dataset.tip = r.stat2.tip;
    } else {
      stat2.append(el("b", "vacio", "—"), el("small", null, "STATS"));
    }
    li.append(stat2);
  } else {
    const statAdr = el("div", "stat stat-adr");
    if (r.kda?.adr != null) {
      const adr = Math.round(r.kda.adr);
      const b = el("b", adr >= 160 ? "bien" : adr > 0 && adr <= 110 ? "mal" : "", String(adr));
      statAdr.append(b, el("small", null, "ADR"));
      const wr = r.kda.winRate != null ? Math.round(r.kda.winRate * 100) : null;
      if (wr != null) statAdr.append(el("span", "sub" + (wr >= 60 ? " alto" : ""), `WR ${wr}%`));
      if (r.kda.acs != null) statAdr.dataset.tip = `ACS ${Math.round(r.kda.acs)} · Daño por ronda: ${Math.round(r.kda.adr)}`;
    } else {
      statAdr.append(el("b", "vacio", "—"), el("small", null, "ADR"));
    }
    li.append(statAdr);
  }

  if (r.rr != null) {
    const statRr = el("div", "stat stat-rr");
    statRr.append(el("b", null, String(r.rr)), el("small", null, rotuloRr));
    li.append(statRr);
    const barra = el("div", "rr-barra");
    const relleno = el("i");
    relleno.style.width = Math.min(100, Math.max(0, r.rr)) + "%";
    barra.append(relleno);
    li.append(barra); // absoluta al pie de la carta: nunca altera la altura
  }
  return li;
}

// Tile de estadistica del perfil: valor grande + rotulo + contexto.
function tilePerfil(valor, rotulo, sub, clase) {
  const tile = el("div", "perfil-tile");
  tile.append(el("b", clase ?? "", valor ?? "—"), el("small", null, rotulo));
  if (sub) tile.append(el("span", "perfil-tile-sub", sub));
  return tile;
}

function filaPartida(p) {
  const li = el("li", "partida " + (p.won ? "ganada" : "perdida"));
  const mapa = el("div", "partida-mapa");
  if (p.slug) mapa.style.backgroundImage = `linear-gradient(90deg, rgba(15,25,35,0.35), rgba(15,25,35,0.8)), url("valorant/mapas/${p.slug}.jpg")`;
  mapa.append(el("b", null, p.mapa ?? "—"), el("small", null, p.won ? "Victoria" : "Derrota"));

  const retrato = el("div", "partida-agente");
  if (p.agentId) {
    const img = el("img", null);
    img.src = `agentes/${p.agentId}.png`;
    img.alt = "";
    img.onerror = () => img.remove();
    retrato.append(img);
  }

  const cuerpo = el("div", "partida-cuerpo");
  cuerpo.append(el("span", "partida-agente-nombre", p.agente ?? ""));
  if (p.modo) cuerpo.append(el("span", "partida-modo", p.modo));

  const stats = el("div", "partida-stats");
  const kdaTxt = `${p.k}/${p.d}/${p.a}`;
  const ratio = p.d > 0 ? (p.k + p.a) / p.d : p.k + p.a;
  for (const [valor, rotulo, clase] of [
    [kdaTxt, "KDA", ratio >= 1.3 ? "bien" : ratio <= 0.8 ? "mal" : ""],
    [p.acs, "ACS", ""],
    [p.adr, "ADR", ""],
    [p.hs != null ? p.hs + "%" : null, "HS", p.hs >= 30 ? "alto" : ""],
  ]) {
    const st = el("div", "partida-stat");
    st.append(el("b", clase, valor ?? "—"), el("small", null, rotulo));
    stats.append(st);
  }

  li.append(mapa, retrato, cuerpo, stats);
  return li;
}

// Fila de partida de LoL/TFT: cola y resultado, campeon, y los numeros de esa
// partida. Misma retícula que las de Valorant.
function filaPartidaLol(m) {
  const li = el("li", "partida " + (m.won ? "ganada" : "perdida"));
  const cabecera = el("div", "partida-mapa");
  const resultado = m.puesto ? `Puesto ${m.puesto}` : m.won ? "Victoria" : "Derrota";
  cabecera.append(el("b", null, m.modo || "Partida"), el("small", null, resultado));

  const retrato = el("div", "partida-agente");
  if (m.champId) {
    const img = el("img", null);
    img.src = `lol/champs/${m.champId}.png`;
    img.alt = "";
    img.onerror = () => img.remove();
    retrato.append(img);
  }

  const cuerpo = el("div", "partida-cuerpo");
  cuerpo.append(el("span", "partida-agente-nombre", m.campeon ?? ""));
  const mins = Math.round((m.duracion ?? 0) / 60);
  cuerpo.append(el("span", "partida-modo", mins ? `${mins} min` : ""));

  const stats = el("div", "partida-stats");
  const ratio = m.d > 0 ? (m.k + m.a) / m.d : m.k + m.a;
  for (const [valor, rotulo, clase] of [
    [m.champId ? `${m.k}/${m.d}/${m.a}` : null, "KDA", ratio >= 3 ? "bien" : ratio <= 1.5 ? "mal" : ""],
    [m.cs || null, "CS", ""],
    [m.daño ? Math.round(m.daño / 1000) + "k" : null, "DAÑO", ""],
    [m.vision || null, "VIS", ""],
  ]) {
    const st = el("div", "partida-stat");
    st.append(el("b", clase, valor ?? "—"), el("small", null, rotulo));
    stats.append(st);
  }

  li.append(cabecera, retrato, cuerpo, stats);
  return li;
}

// Perfil de LoL/TFT: avatar y nivel, el rango de cada cola y las últimas
// partidas. Ocupa el mismo panel que el de Valorant.
function pintarPerfilLol(p) {
  const avatar = $("perfil-avatar");
  avatar.hidden = false;
  const img = $("perfil-avatar-img");
  img.src = p.icono ?? "";
  img.onerror = () => {
    if (p.iconoAlt && img.src !== p.iconoAlt) img.src = p.iconoAlt; // Data Dragon de respaldo
    else img.style.visibility = "hidden";
  };
  $("perfil-avatar-nivel").textContent = p.level != null ? p.level : "";

  // Rango principal: el de solo/dúo si lo hay; si no, el primero con dato.
  const principal = p.rangos?.[0] ?? null;
  $("perfil-rango-img").src = principal?.icon ?? "";
  $("perfil-rango-img").hidden = !principal?.icon;
  $("perfil-rango-nombre").textContent = principal ? `${principal.cola} · ${principal.label}` : "Sin clasificar";
  $("perfil-rango-nombre").style.color = "var(--claro)";
  $("perfil-rr").textContent = principal?.lp != null ? `${principal.lp} LP` : "";
  $("perfil-rr-relleno").style.width = Math.min(100, Math.max(0, principal?.lp ?? 0)) + "%";
  $("perfil-rr-relleno").style.background = "var(--teal)";

  $("perfil-nombre").textContent = p.name || "Tu perfil";
  $("perfil-sub").textContent = [
    p.level != null ? `Nivel ${p.level}` : null,
    p.xpPct != null ? `${p.xpPct}% al siguiente` : null,
    p.partidas?.length ? `${p.partidas.length} partidas recientes` : null,
  ].filter(Boolean).join(" · ");

  // Los dos huecos laterales llevan las otras colas con rango.
  const otros = (p.rangos ?? []).slice(1, 3);
  const lados = [
    ["perfil-peak-img", "perfil-peak", otros[0]],
    ["perfil-agente-img", "perfil-agente", otros[1]],
  ];
  for (const [idImg, idTexto, r] of lados) {
    $(idImg).src = r?.icon ?? "";
    $(idImg).hidden = !r?.icon;
    $(idTexto).textContent = r ? `${r.label}${r.lp != null ? ` · ${r.lp} LP` : ""}` : "—";
    const rotulo = $(idTexto).previousElementSibling;
    if (rotulo) rotulo.textContent = r?.cola ?? "—";
  }

  const k = p.kda;
  const tiles = [];
  if (k) {
    tiles.push(
      tilePerfil(k.kda.toFixed(2), "KDA", `${k.kills}/${k.deaths}/${k.assists}`, k.kda >= 3 ? "bien" : k.kda <= 1.5 ? "mal" : ""),
      tilePerfil(Math.round(k.winRate * 100) + "%", "WR", `últimas ${k.games}`, k.winRate >= 0.6 ? "bien" : k.winRate <= 0.4 ? "mal" : ""),
      tilePerfil(k.csMin.toFixed(1), "CS/MIN", "súbditos"),
      tilePerfil(Math.round(k.dañoMin), "DPM", "daño por minuto"),
      tilePerfil(Math.round(k.vision), "VISIÓN", "por partida")
    );
  }
  if (p.campeonTop) {
    tiles.push(
      tilePerfil(
        Math.round((p.campeonTop.wins / p.campeonTop.games) * 100) + "%",
        "Top",
        `${p.campeonTop.campeon ?? ""} · ${p.campeonTop.games}`
      )
    );
  }
  $("perfil-tiles").replaceChildren(...tiles);

  $("perfil-partidas-titulo").textContent = "Últimas partidas";
  $("perfil-lista").replaceChildren(...(p.partidas ?? []).slice(0, 5).map(filaPartidaLol));
}

function pintarPerfilValorant(p) {
  $("perfil-avatar").hidden = true;
  $("perfil-partidas-titulo").textContent = "Últimas competitivas";
  // Los dos huecos laterales son de LoL en su perfil: aqui vuelven a lo suyo.
  $("perfil-peak").previousElementSibling.textContent = "Peak";
  $("perfil-agente").previousElementSibling.textContent = "Agente top";
  const icono = p.tier >= 3 ? `rangos/${p.tier}.png` : null;
  $("perfil-rango-img").src = icono ?? "";
  $("perfil-rango-img").hidden = !icono;
  $("perfil-rango-nombre").textContent = p.tierLabel ?? "Sin rango";
  $("perfil-rango-nombre").style.color = colorRango(p.tier);
  $("perfil-rr").textContent = p.rr != null ? `${p.rr} RR` : "";
  $("perfil-rr-relleno").style.width = Math.min(100, Math.max(0, p.rr ?? 0)) + "%";
  $("perfil-rr-relleno").style.background = colorRango(p.tier);

  $("perfil-nombre").textContent = p.name || "Tu perfil";
  const partes = [];
  if (p.level != null) partes.push(`Nivel ${p.level}`);
  if (p.seasons) partes.push(`${p.seasons} temporada${p.seasons === 1 ? "" : "s"}`);
  if (p.totalGames) partes.push(`${p.totalGames} partidas en total`);
  $("perfil-sub").textContent = partes.join(" · ");

  const peakIcono = p.peak >= 3 ? `rangos/${p.peak}.png` : null;
  $("perfil-peak-img").src = peakIcono ?? "";
  $("perfil-peak-img").hidden = !peakIcono;
  $("perfil-peak").textContent = p.peakLabel ?? "—";
  const agTop = p.agenteTop;
  $("perfil-agente-img").src = agTop ? `agentes/${agTop.agentId}.png` : "";
  $("perfil-agente-img").hidden = !agTop;
  $("perfil-agente").textContent = agTop
    ? `${agTop.agente ?? ""} · ${Math.round((agTop.wins / agTop.games) * 100)}% WR`
    : "—";

  const k = p.kda;
  const tiles = [];
  if (k) {
    tiles.push(
      tilePerfil(k.kda.toFixed(2), "KDA", `${k.kills}/${k.deaths}/${k.assists}`, k.kda >= 1.3 ? "bien" : k.kda <= 0.8 ? "mal" : ""),
      tilePerfil(k.hsRate != null ? Math.round(k.hsRate * 100) + "%" : null, "HS", "headshots", k.hsRate >= 0.3 ? "alto" : ""),
      tilePerfil(k.adr != null ? Math.round(k.adr) : null, "ADR", "daño por ronda"),
      tilePerfil(k.acs != null ? Math.round(k.acs) : null, "ACS", "combat score"),
      tilePerfil(k.winRate != null ? Math.round(k.winRate * 100) + "%" : null, "WR", `últimas ${k.games}`, k.winRate >= 0.6 ? "bien" : k.winRate <= 0.4 ? "mal" : "")
    );
  }
  if (p.comp) {
    tiles.push(tilePerfil(`${p.comp.wins}W-${p.comp.losses}L`, "Balance", p.comp.avgRrWin != null ? `+${Math.round(p.comp.avgRrWin)} RR por victoria` : null));
  }
  $("perfil-tiles").replaceChildren(...tiles);

  $("perfil-lista").replaceChildren(...p.partidas.slice(0, 5).map(filaPartida));
}

function pintarPerfil(p) {
  if (p.game === "lol") pintarPerfilLol(p);
  else pintarPerfilValorant(p);
}

// ---- Comps de TFT (DESHABILITADO) ----
// Las calcula el worker grief-tft con partidas reales de Challenger; aqui solo
// se pintan. Se guarda la ultima respuesta para que la vista abra al instante
// (y siga sirviendo algo si el worker no contesta).
//
// La vista no es accesible: el unico dato crudo de TFT lo da la API de Riot y
// nuestra clave de desarrollo caduca cada 24 h, asi que el worker devolvia 401
// y la pantalla salia siempre vacia. Todo esto queda dormido hasta que haya una
// Personal API Key; el enganche al menu esta comentado al final del archivo.
const COMPS_URL = "https://grief-tft.studio-iris2026.workers.dev/comps";
const COSTES = { 1: "#7a8894", 2: "#46b083", 3: "#3fb7c9", 4: "#b18be8", 5: "#e8c35c" };
let compsDatos = null;

function tarjetaComp(c) {
  const li = el("li", "comp tier-" + (c.tier ?? "C").toLowerCase());

  const cab = el("div", "comp-cab");
  cab.append(el("span", "comp-tier", c.tier ?? "?"), el("b", "comp-nombre", c.nombre ?? ""));
  const cifras = el("span", "comp-cifras");
  cifras.append(
    el("i", null, c.puesto != null ? c.puesto.toFixed(2) : "—"),
    el("small", null, "puesto medio"),
    el("i", null, c.top4 != null ? Math.round(c.top4 * 100) + "%" : "—"),
    el("small", null, "top 4"),
    el("i", null, String(c.partidas ?? 0)),
    el("small", null, "partidas")
  );
  cab.append(cifras);

  const unidades = el("div", "comp-unidades");
  for (const u of c.unidades ?? []) {
    const casilla = el("div", "comp-unidad");
    casilla.style.setProperty("--coste", COSTES[u.coste] ?? COSTES[1]);
    if (u.icono) {
      const img = el("img", null);
      img.src = u.icono;
      img.alt = "";
      img.onerror = () => img.remove();
      casilla.append(img);
    }
    casilla.append(el("span", "comp-unidad-nombre", u.nombre ?? ""));
    if (u.estrellas >= 3) casilla.append(el("span", "comp-estrellas", "3★"));
    casilla.dataset.tip = [
      `${u.nombre} · ${u.coste} de oro`,
      u.objetos?.length ? `Objetos: ${u.objetos.join(", ")}` : null,
    ].filter(Boolean).join(" · ");
    unidades.append(casilla);
  }

  const pie = el("div", "comp-pie");
  if (c.rasgos?.length) pie.append(el("span", null, c.rasgos.map((r) => `${r.nombre} ${r.unidades}`).join(" · ")));
  if (c.aumentos?.length) pie.append(el("span", "comp-aumentos", `Aumentos: ${c.aumentos.join(", ")}`));

  li.append(cab, unidades, pie);
  return li;
}

function pintarComps() {
  const lista = $("comps-lista");
  if (!compsDatos) {
    lista.replaceChildren(el("li", "comps-aviso", "Cargando las comps del parche..."));
    return;
  }
  if (compsDatos.error) {
    lista.replaceChildren(el("li", "comps-aviso", compsDatos.error));
    return;
  }
  const tier = $("comps-tier").value;
  const carry = $("comps-carry").value;
  const filtradas = (compsDatos.comps ?? []).filter(
    (c) => (!tier || c.tier === tier) && (!carry || c.carry?.id === carry)
  );
  $("comps-sub").textContent = [
    compsDatos.parche ? `Parche ${compsDatos.parche}` : null,
    compsDatos.set ? `Set ${compsDatos.set}` : null,
    compsDatos.partidas ? `${compsDatos.partidas} partidas de Challenger` : null,
    compsDatos.calculado ? new Date(compsDatos.calculado).toLocaleDateString("es-MX") : null,
  ].filter(Boolean).join(" · ");
  lista.replaceChildren(
    ...(filtradas.length ? filtradas.map(tarjetaComp) : [el("li", "comps-aviso", "No hay comps con ese filtro.")])
  );
}

async function cargarComps() {
  try {
    const guardado = localStorage.getItem("grief-comps");
    if (guardado && !compsDatos) {
      compsDatos = JSON.parse(guardado);
      pintarComps();
    }
  } catch {}
  try {
    const datos = await fetch(COMPS_URL).then((r) => r.json());
    if (datos?.comps?.length) {
      compsDatos = datos;
      try {
        localStorage.setItem("grief-comps", JSON.stringify(datos));
      } catch {}
      const carries = new Map();
      for (const c of datos.comps) if (c.carry?.id) carries.set(c.carry.id, c.carry.nombre);
      $("comps-carry").replaceChildren(
        el("option", null, "Cualquiera"),
        ...[...carries.entries()]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, nombre]) => {
            const o = el("option", null, nombre);
            o.value = id;
            return o;
          })
      );
    } else if (!compsDatos) {
      compsDatos = { error: datos?.error ? `El servicio de comps no está listo: ${datos.error}.` : "Todavía no hay comps calculadas." };
    }
  } catch {
    if (!compsDatos) compsDatos = { error: "No se pudo contactar con el servicio de comps." };
  }
  pintarComps();
}

function abrirComps() {
  for (const id of ["vacio", "perfil", "equipos", "fase", "dota"]) $(id).hidden = true;
  $("comps").hidden = false;
  $("juego").textContent = "Teamfight Tactics · Comps del parche";
  pintarComps();
  cargarComps();
}

// ---- Perfiles de controles de Dota 2 ----
// Guardas tus controles con un nombre y los aplicas a la cuenta que tengas
// abierta. Aplicar es un solo paso: escribe, reinicia Steam y vuelve a
// escribir. Los respaldos que permiten Deshacer son internos y no se listan.

let dotaDatos = null;
let dotaOcupado = false;

function dotaAviso(texto, clase) {
  const aviso = $("dota-aviso");
  if (!texto) {
    aviso.hidden = true;
    return;
  }
  aviso.className = "dota-aviso" + (clase ? " dota-aviso--" + clase : "");
  aviso.textContent = texto;
  aviso.hidden = false;
}

// A que cuenta se le escriben los controles. Por defecto la sesion abierta en
// Steam (viene primera de listarCuentas); si eliges otra, manda tu eleccion
// mientras esa cuenta siga existiendo.
let dotaCuentaId = null;

function cuentaElegida() {
  const cuentas = dotaDatos?.cuentas ?? [];
  return cuentas.find((c) => c.id === dotaCuentaId) ?? cuentas[0] ?? null;
}

// Los heroes se enseñan por nombre, pero sin convertir la ficha en un muro:
// los primeros y cuantos quedan.
function resumenHeroes(heroes) {
  if (!heroes?.length) return null;
  const visibles = heroes.slice(0, 8);
  const resto = heroes.length - visibles.length;
  return visibles.join(", ") + (resto > 0 ? ` y ${resto} más` : "");
}

function tarjetaPerfilDota(p) {
  const cuenta = cuentaElegida();
  const enUso = cuenta && cuenta.aplicado === p.id;
  const li = el("li", "dota-item" + (enUso ? " dota-item--activo" : ""));

  // La foto de la cuenta de la que se copio: es lo que hace reconocible al
  // preset sin leer nada. El envoltorio existe porque un <img> no admite el
  // ::after que cierra la esquina cortada.
  if (p.avatar) {
    const foto = el("span", "dota-item-foto");
    const img = document.createElement("img");
    img.src = `/dota/avatar/perfil/${encodeURIComponent(p.id)}`;
    img.alt = "";
    foto.append(img);
    li.append(foto);
  }

  // Izquierda: que es este preset. Derecha: la accion, una sola y destacada.
  const info = el("div", "dota-item-info");
  const cab = el("div", "dota-item-cab");
  // El nombre se edita donde se lee: un input que parece texto hasta que lo
  // tocas. Se guarda al salir del campo o con Enter; Escape deja lo que habia.
  const nombre = document.createElement("input");
  nombre.className = "dota-item-nombre";
  nombre.type = "text";
  nombre.maxLength = 48;
  nombre.value = p.nombre ?? p.id;
  nombre.setAttribute("aria-label", "Nombre del preset");
  nombre.dataset.tip = "Toca para cambiarle el nombre";
  nombre.disabled = dotaOcupado;
  nombre.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") nombre.blur();
    if (ev.key === "Escape") {
      nombre.value = p.nombre ?? p.id;
      nombre.blur();
    }
  });
  nombre.addEventListener("blur", () => renombrarPerfilDota(p, nombre));
  cab.append(nombre);
  if (enUso) cab.append(el("span", "dota-item-etiqueta", "En uso"));
  info.append(cab);

  const capas = p.capas ?? {};
  info.append(
    el(
      "span",
      "dota-item-detalle",
      `${capas.globales ?? 0} controles globales  ·  ${capas.heroes?.length ?? 0} héroes con teclas propias`
    )
  );
  const heroes = resumenHeroes(capas.heroes);
  if (heroes) info.append(el("span", "dota-item-heroes", heroes));

  const acciones = el("div", "dota-item-acciones");
  // Texto fijo: a que cuenta se escribe ya lo dice el selector de arriba y la
  // sesion de la barra, y ahi cabe entero sin recortar.
  const aplicar = el("button", "dota-boton dota-boton--usar", "Usar preset");
  aplicar.type = "button";
  aplicar.disabled = dotaOcupado || !cuenta;
  if (cuenta) aplicar.dataset.tip = `Escribe estos controles en ${cuenta.persona ?? cuenta.id}`;
  aplicar.addEventListener("click", () => aplicarPerfilDota(p));
  const borrar = el("button", "dota-boton dota-boton--tenue", "Borrar preset");
  borrar.type = "button";
  borrar.disabled = dotaOcupado;
  borrar.addEventListener("click", () => borrarPerfilDota(p));
  acciones.append(aplicar, borrar);

  li.append(info, acciones);
  return li;
}

// El banner de la cuenta: quien es, si es la sesion que tienes abierta y que
// tiene configurado. Debajo, las demas cuentas de esta computadora, para poder
// escribirle los controles a otra sin salir de aqui.
function pintarCabeceraDota() {
  const cuenta = cuentaElegida();
  const foto = $("dota-cab-foto");
  foto.hidden = !cuenta?.avatar;
  if (cuenta?.avatar) foto.src = `/dota/avatar/cuenta/${encodeURIComponent(cuenta.id)}`;

  $("dota-cab-nick").textContent = cuenta ? (cuenta.persona ?? cuenta.id) : "Sin cuentas de Dota";
  $("dota-cab-etiqueta").textContent = !cuenta
    ? ""
    : cuenta.activa
      ? "Sesión abierta en Steam"
      : "Cuenta elegida  ·  no es la sesión abierta";
  $("dota-cab-etiqueta").classList.toggle("dota-cab-etiqueta--ojo", !!cuenta && !cuenta.activa);

  // Con una sola cuenta no hay nada que elegir y el desplegable sobra.
  const varias = (dotaDatos?.cuentas?.length ?? 0) > 1;
  $("dota-otras").hidden = !varias;
  if (varias) {
    $("dota-cambiar-nombre").textContent = cuenta ? (cuenta.persona ?? cuenta.id) : "Elegir";
    $("dota-cambiar").disabled = dotaOcupado;
  }
  if (!varias || dotaOcupado) cerrarPanelCuentas();
}

// ---- Desplegable de cuentas ----
// Va en <body> con position:fixed, no dentro del banner: el banner lleva
// clip-path y recortaria cualquier panel que se saliera de su caja. Se coloca
// a mano bajo el boton, igual que el tooltip.
const panelCuentas = el("div", "dota-panel");
panelCuentas.hidden = true;
panelCuentas.setAttribute("role", "listbox");
document.addEventListener("DOMContentLoaded", () => document.body.append(panelCuentas));

function cerrarPanelCuentas() {
  panelCuentas.hidden = true;
  $("dota-cambiar")?.setAttribute("aria-expanded", "false");
}

function abrirPanelCuentas() {
  const cuenta = cuentaElegida();
  panelCuentas.replaceChildren(
    ...(dotaDatos?.cuentas ?? []).map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dota-opcion" + (c.id === cuenta?.id ? " dota-opcion--elegida" : "");
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(c.id === cuenta?.id));
      if (c.avatar) {
        const img = document.createElement("img");
        img.src = `/dota/avatar/cuenta/${encodeURIComponent(c.id)}`;
        img.alt = "";
        b.append(img);
      }
      const textos = el("span", "dota-opcion-textos");
      textos.append(el("span", "dota-opcion-nombre", c.persona ?? c.id));
      textos.append(
        el(
          "span",
          "dota-opcion-detalle",
          `${c.capas?.globales ?? 0} globales · ${c.capas?.heroes?.length ?? 0} héroes`
        )
      );
      b.append(textos);
      if (c.activa) b.append(el("span", "dota-opcion-marca", "Abierta"));
      b.addEventListener("click", () => {
        dotaCuentaId = c.id;
        cerrarPanelCuentas();
        dotaAviso(null);
        pintarDota();
      });
      return b;
    })
  );

  // Alineado por la derecha con el boton; si no cabe debajo, sube encima.
  const r = $("dota-cambiar").getBoundingClientRect();
  panelCuentas.hidden = false;
  panelCuentas.style.visibility = "hidden";
  panelCuentas.style.left = "0px";
  panelCuentas.style.top = "0px";
  const alto = panelCuentas.getBoundingClientRect().height;
  const cabeDebajo = r.bottom + 6 + alto <= window.innerHeight - 8;
  panelCuentas.style.left = `${Math.max(8, r.right - panelCuentas.getBoundingClientRect().width)}px`;
  panelCuentas.style.top = `${cabeDebajo ? r.bottom + 6 : Math.max(8, r.top - 6 - alto)}px`;
  panelCuentas.style.visibility = "";
  $("dota-cambiar").setAttribute("aria-expanded", "true");
}

// El aviso de deriva: que heroes ya no coinciden con el preset aplicado. Dota
// reescribe el archivo por su cuenta y lo normal es enterarse en mitad de una
// partida, semanas despues; esto lo dice al abrir.
function pintarDeriva() {
  const caja = $("dota-deriva");
  const d = cuentaElegida()?.deriva;
  const n = d?.distintos?.length ?? 0;
  if (!n) {
    caja.hidden = true;
    return;
  }
  $("dota-deriva-titulo").textContent =
    `${n} ${n === 1 ? "héroe ya no coincide" : "héroes ya no coinciden"} con "${d.nombre}"`;
  const nombres = d.distintos.slice(0, 6).map((x) => bonito(x.heroe));
  const resto = n - nombres.length;
  $("dota-deriva-lista").textContent = nombres.join(", ") + (resto > 0 ? ` y ${resto} más` : "");
  $("dota-deriva-restaurar").disabled = dotaOcupado;
  $("dota-deriva-ver").disabled = dotaOcupado;
  caja.hidden = false;
}

const bonito = (id) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function verDeriva() {
  const d = cuentaElegida()?.deriva;
  if (!d?.distintos?.length) return;
  const cuerpo = document.createElement("div");
  for (const x of d.distintos) {
    const bloque = el("div", "deriva-heroe");
    bloque.append(el("b", null, bonito(x.heroe)));
    if (x.motivo) {
      bloque.append(el("span", "deriva-cambio", x.motivo));
    } else {
      for (const c of x.cambios) {
        bloque.append(
          el("span", "deriva-cambio", `${c.ranura}:  ahora ${c.ahora}  —  guardado ${c.guardado}`)
        );
      }
    }
    cuerpo.append(bloque);
  }
  abrirModal(`Diferencias con "${d.nombre}"`, cuerpo);
}

function pintarDota() {
  const lista = $("dota-lista");
  if (!dotaDatos) {
    lista.replaceChildren(el("li", "dota-vacio", "Leyendo las cuentas de Steam..."));
    return;
  }
  if (dotaDatos.error) {
    lista.replaceChildren(el("li", "dota-vacio", dotaDatos.error));
    return;
  }

  // Si la cuenta elegida ya no esta (cerraste sesion, quitaste el juego), se
  // vuelve sola a la primera, que es la sesion abierta.
  if (dotaCuentaId && !dotaDatos.cuentas.some((c) => c.id === dotaCuentaId)) dotaCuentaId = null;
  pintarCabeceraDota();

  const cuenta = cuentaElegida();
  $("dota-sub").textContent = cuenta
    ? `${cuenta.capas?.globales ?? 0} controles globales  ·  ${cuenta.capas?.heroes?.length ?? 0} héroes con teclas propias`
    : "Ninguna cuenta de Steam de esta computadora tiene Dota 2.";

  $("dota-nuevo").disabled = dotaOcupado || !cuenta;
  const deshacer = $("dota-deshacer");
  deshacer.hidden = !cuenta?.puedeDeshacer;
  deshacer.disabled = dotaOcupado;

  pintarDeriva();

  if (dotaDatos.procesos?.dota) {
    dotaAviso("Cierra Dota 2 para poder cambiar de perfil: al salir reescribe los controles.", "ojo");
  } else if (cuenta && !cuenta.activa) {
    dotaAviso(`Vas a escribir en ${cuenta.persona ?? cuenta.id}, que no es la sesión abierta en Steam.`, "ojo");
  }

  lista.replaceChildren(
    ...(dotaDatos.perfiles.length
      ? dotaDatos.perfiles.map(tarjetaPerfilDota)
      : [
          el(
            "li",
            "dota-vacio",
            "Todavía no tienes presets. Deja los controles como te gusten en Dota, cierra el juego y guárdalos aquí arriba con un nombre."
          ),
        ])
  );
}

async function cargarDota() {
  try {
    const datos = await fetch("/dota/estado").then((r) => r.json());
    dotaDatos = datos.error ? { error: datos.error } : datos;
  } catch {
    dotaDatos = { error: "No se pudo leer la carpeta de Steam." };
  }
  pintarDota();
}

async function accionDota(ruta, cuerpo) {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error ?? "No se pudo completar la acción.");
  return datos;
}

// Bloquea los botones mientras algo esta en marcha: aplicar reinicia Steam y
// tarda, y dos ordenes a la vez sobre los mismos archivos no acaban bien.
async function conBloqueo(fn) {
  dotaOcupado = true;
  pintarDota();
  try {
    await fn();
  } finally {
    dotaOcupado = false;
    await cargarDota();
  }
}

function guardarPerfilDota() {
  const nombre = $("dota-nombre").value.trim();
  const cuenta = cuentaElegida();
  if (!nombre) {
    dotaAviso("Ponle un nombre al perfil antes de guardarlo.", "error");
    return;
  }
  if (!cuenta) return;
  return conBloqueo(async () => {
    try {
      const p = await accionDota("/dota/guardar", { cuenta: cuenta.id, nombre });
      $("dota-nombre").value = "";
      dotaAviso(`Guardado "${p.nombre}".`, "ok");
    } catch (err) {
      dotaAviso(err.message, "error");
    }
  });
}

// Renombrar no reordena ni repinta la lista: la ficha ya muestra lo que
// escribiste, y repintar aqui te quitaria el foco de golpe.
async function renombrarPerfilDota(p, campo) {
  const nuevo = campo.value.trim();
  const viejo = p.nombre ?? p.id;
  if (!nuevo || nuevo === viejo) {
    campo.value = viejo; // vacio o sin cambios: se queda como estaba
    return;
  }
  try {
    const r = await accionDota("/dota/renombrar", { perfil: p.id, nombre: nuevo });
    p.nombre = r.nombre;
    const enDatos = dotaDatos?.perfiles?.find((x) => x.id === p.id);
    if (enDatos) enDatos.nombre = r.nombre;
    campo.value = r.nombre;
    dotaAviso(`Ahora se llama "${r.nombre}".`, "ok");
  } catch (err) {
    campo.value = viejo;
    dotaAviso(err.message, "error");
  }
}

function aplicarPerfilDota(p) {
  const cuenta = cuentaElegida();
  if (!cuenta) return;
  return conBloqueo(async () => {
    dotaAviso("Aplicando y reiniciando Steam. Puede tardar medio minuto.", "ojo");
    try {
      const r = await accionDota("/dota/aplicar", { perfil: p.id, cuenta: cuenta.id });
      const heroes = r.capas?.heroes?.length ?? 0;
      dotaAviso(
        `"${p.nombre ?? p.id}" puesto en ${r.destino?.persona ?? cuenta.id}: ` +
          `${r.capas?.globales ?? 0} globales y ${heroes} héroes.` +
          (r.reiniciado ? " Steam reiniciado; si te pide iniciar sesión, hazlo y entra a Dota." : ""),
        "ok"
      );
    } catch (err) {
      dotaAviso(err.message, "error");
    }
  });
}

function deshacerDota() {
  const cuenta = cuentaElegida();
  if (!cuenta) return;
  return conBloqueo(async () => {
    dotaAviso("Deshaciendo y reiniciando Steam.", "ojo");
    try {
      const r = await accionDota("/dota/deshacer", { cuenta: cuenta.id });
      dotaAviso(`Controles de ${r.destino?.persona ?? cuenta.id} devueltos a como estaban.`, "ok");
    } catch (err) {
      dotaAviso(err.message, "error");
    }
  });
}

function borrarPerfilDota(p) {
  return conBloqueo(async () => {
    try {
      await accionDota("/dota/borrar", { perfil: p.id });
      dotaAviso(`Perfil "${p.nombre ?? p.id}" borrado.`, "ok");
    } catch (err) {
      dotaAviso(err.message, "error");
    }
  });
}

// ---- Conmutador de plataforma ----
// Los dos botones de la barra son la unica navegacion entre mundos: Riot son
// los trackers (Valorant, LoL, TFT) y Steam los controles de Dota. El estado
// visual sale siempre de aqui; nadie toca aria-pressed por su cuenta.
function marcarPlataforma(cual) {
  $("plat-riot").setAttribute("aria-pressed", String(cual === "riot"));
  $("plat-steam").setAttribute("aria-pressed", String(cual === "steam"));
}

function abrirRiot() {
  $("dota").hidden = true;
  marcarPlataforma("riot");
  // Vuelve a lo que hubiera: la partida en curso, tu perfil o la pantalla vacia.
  if (ultimoEstado) pintar(ultimoEstado);
}

function abrirDota() {
  for (const id of ["vacio", "perfil", "equipos", "fase", "comps"]) $(id).hidden = true;
  $("dota").hidden = false;
  $("juego").textContent = "Dota 2 · Perfiles de controles";
  marcarPlataforma("steam");
  dotaAviso(null);
  pintarDota();
  cargarDota();
}


function pintar(estado) {
  // Con una vista del menu abierta, la partida no roba la pantalla.
  if (!$("comps").hidden || !$("dota").hidden) return;
  $("estado").textContent = "";
  const hayPartida = estado.rows && estado.rows.length > 0;
  const hayPerfil = !hayPartida && !!estado.perfil;

  $("juego").textContent = hayPerfil
    ? `${estado.perfil.game === "lol" ? "League of Legends" : "Valorant"} · Tu perfil`
    : estado.gameLabel ?? "Valorant · LoL";
  $("vacio").hidden = hayPartida || hayPerfil;
  $("perfil").hidden = !hayPerfil;
  $("equipos").hidden = !hayPartida;
  $("fase").hidden = !hayPartida;

  if (hayPerfil) {
    pintarPerfil(estado.perfil);
    return;
  }
  if (!hayPartida) return;

  $("fase-texto").textContent = FASES[estado.phase] ?? estado.label ?? "";

  // Banda de contexto: mapa+servidor (Valorant) o bando (LoL / Dota 2).
  const banda = $("banda");
  banda.hidden = false;
  banda.style.backgroundImage = "";
  if (estado.game === "valorant" && estado.mapa) {
    banda.className = "banda";
    banda.style.backgroundImage =
      `linear-gradient(90deg, rgba(15,25,35,0.95) 18%, rgba(15,25,35,0.35) 60%, rgba(15,25,35,0.75)), url("valorant/mapas/${estado.mapa.slug}.jpg")`;
    $("banda-titulo").textContent = estado.mapa.nombre ?? "";
    $("banda-sub").textContent = [estado.modo, estado.servidor ? `Servidor ${estado.servidor}` : null]
      .filter(Boolean)
      .join(" · ");
  } else if (estado.game === "lol" && (estado.lado || estado.modo || estado.contexto)) {
    // Titulo: la cola que se esta jugando (reclutamiento, ARAM, TFT...); si el
    // cliente no la da, el bando. Debajo, el marcador y los objetivos en vivo.
    banda.className = "banda" + (estado.lado ? " lado-" + estado.lado : "");
    const bando = estado.lado === "azul" ? "Lado azul" : estado.lado === "rojo" ? "Lado rojo" : null;
    $("banda-titulo").textContent = estado.modo ?? bando ?? "";
    $("banda-sub").textContent = [estado.modo && bando ? bando : null, estado.contexto]
      .filter(Boolean)
      .join(" · ");
  } else {
    banda.hidden = true;
  }

  // FFA (deathmatch y similares). Riot no es consistente con el TeamID en
  // estos modos (a veces uno por jugador, a veces el mismo para todos), asi
  // que la regla es por forma: mas de 6 filas sin ser un 2-equipos clasico,
  // o modo Deathmatch explicito. Todos en una lista a dos columnas
  // compactas para que entren sin scroll; tu fila primero.
  const equiposDistintos = new Set(estado.rows.map((r) => r.team)).size;
  const ffa = estado.rows.length > 6 && (equiposDistintos !== 2 || estado.modo === "Deathmatch");
  $("equipos").classList.toggle("ffa", ffa);

  // Tu equipo: el que contiene tu fila; sin ella, el equipo de la primera.
  const miFila = estado.rows.find((r) => r.me);
  const miEquipo = miFila ? miFila.team : estado.rows[0].team;
  let aliados = estado.rows.filter((r) => r.team === miEquipo);
  let rivales = estado.rows.filter((r) => r.team !== miEquipo);
  // Sin equipos distinguibles o FFA: una sola lista.
  if (ffa || !aliados.length || miEquipo === "-") {
    aliados = miFila ? [miFila, ...estado.rows.filter((r) => !r.me)] : estado.rows;
    rivales = [];
  }
  $("titulo-aliado").textContent = ffa ? "Jugadores" : "Tu equipo";
  $("titulo-rival").textContent = "Rival";

  $("lista-aliado").replaceChildren(...aliados.map((r) => filaJugador(r, estado.game)));
  $("lista-rival").replaceChildren(...rivales.map((r) => filaJugador(r, estado.game)));

  $("panel-rival").hidden = rivales.length === 0;
  $("equipos").classList.toggle("solo-aliado", rivales.length === 0);
}

// true si la version a es posterior a la b ("0.10.1" > "0.9.9")
function versionMayor(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

// Estado de version: compara la local con la ultima release publicada en
// GitHub. Lo usan el aviso automatico de la barra y el boton del menu.
async function estadoVersion() {
  const [local, release] = await Promise.all([
    fetch("/version").then((r) => r.json()),
    fetch("https://api.github.com/repos/DosaAKA2A/GRIEF/releases/latest").then((r) => r.json()),
  ]);
  const remota = (release.tag_name ?? "").replace(/^v/, "");
  const setup = release.assets?.find((a) => /setup/i.test(a.name) && a.name.endsWith(".exe"));
  return {
    local: local.version,
    remota: remota || null,
    nueva: !!remota && versionMayor(remota, local.version),
    url: setup?.browser_download_url ?? release.html_url ?? "https://github.com/DosaAKA2A/GRIEF/releases",
  };
}

// El chip del pie es la version y, solo cuando hay algo que instalar, el boton
// de actualizar. Antes el aviso era un boton aparte arriba en la barra que
// ocupaba sitio permanente para no decir nada el 99% del tiempo.
let versionLocal = null;
let versionNueva = null; // { remota, url } cuando la release es mas reciente

function pintarVersion() {
  const chip = $("pie-version");
  if (!versionLocal) return;
  if (versionNueva) {
    chip.textContent = `Actualizar a v${versionNueva.remota}`;
    chip.href = versionNueva.url;
    chip.classList.add("pie-version--nueva");
    chip.dataset.tip = `Estás en la v${versionLocal}. Se descarga e instala sola, y la app se reinicia.`;
  } else {
    chip.textContent = `v${versionLocal}`;
    chip.removeAttribute("href"); // sin href no es pulsable: en reposo es solo texto
    chip.classList.remove("pie-version--nueva");
    delete chip.dataset.tip;
  }
}

async function revisarActualizacion() {
  try {
    const v = await estadoVersion();
    versionLocal = v.local;
    versionNueva = v.nueva ? { remota: v.remota, url: v.url } : null;
    pintarVersion();
  } catch {
    // sin red o sin release: no molestamos
  }
}
revisarActualizacion();
setInterval(revisarActualizacion, 6 * 3600e3); // re-chequea cada 6 h

// ---- Menu de la app: encuadre, acerca de, terminos y actualizacion ----
const menuPanel = $("menu-panel");
const menuBoton = $("menu-boton");

function cerrarMenu() {
  menuPanel.hidden = true;
  menuBoton.setAttribute("aria-expanded", "false");
}

menuBoton.addEventListener("click", (ev) => {
  ev.stopPropagation();
  menuPanel.hidden = !menuPanel.hidden;
  menuBoton.setAttribute("aria-expanded", String(!menuPanel.hidden));
});
document.addEventListener("click", (ev) => {
  if (!menuPanel.hidden && !menuPanel.contains(ev.target)) cerrarMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  cerrarMenu();
  $("modal").hidden = true;
});

// Barra inferior: solo dentro de la app de escritorio (preload). En el
// navegador la barra ni aparece.
if (window.grief?.encuadrar) {
  $("pie").hidden = false;
  $("pie-encuadre").addEventListener("click", () => window.grief.encuadrar());
  fetch("/version")
    .then((r) => r.json())
    .then(({ version }) => {
      versionLocal = version;
      pintarVersion(); // si el chequeo ya encontro release, no lo pisa
    })
    .catch(() => {});
}

// Captura de la partida al portapapeles: recorta desde la banda del mapa
// hasta la ultima fila (la seccion visible completa) con un margen.
let avisoTimer = null;
function avisoPie(texto) {
  const aviso = $("pie-aviso");
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => {
    aviso.hidden = true;
  }, 2600);
}

if (window.grief?.capturar) {
  $("pie-captura").addEventListener("click", async () => {
    const seccion = !$("equipos").hidden ? $("equipos") : !$("perfil").hidden ? $("perfil") : null;
    if (!seccion) {
      avisoPie("No hay nada que capturar todavía.");
      return;
    }
    const r = seccion.getBoundingClientRect();
    const margen = 14;
    const rect = {
      x: Math.max(0, Math.round(r.left - margen)),
      y: Math.max(0, Math.round(r.top - margen)),
      width: Math.round(Math.min(window.innerWidth, r.width + margen * 2)),
      height: Math.round(Math.min(window.innerHeight, r.height + margen * 2)),
    };
    try {
      await window.grief.capturar(rect);
      avisoPie("Captura copiada. Pégala donde quieras.");
    } catch {
      avisoPie("No se pudo copiar la captura.");
    }
  });
}

// Acepta el id de una <template> (acerca de, terminos) o un nodo ya montado,
// para los contenidos que se arman al vuelo.
function abrirModal(titulo, contenido) {
  $("modal-titulo").textContent = titulo;
  $("modal-cuerpo").replaceChildren(
    typeof contenido === "string"
      ? document.getElementById(contenido).content.cloneNode(true)
      : contenido
  );
  $("modal").hidden = false;
  cerrarMenu();
}

$("menu-acerca").addEventListener("click", async () => {
  abrirModal("Acerca de", "tpl-acerca");
  try {
    const { version } = await fetch("/version").then((r) => r.json());
    const span = document.getElementById("acerca-version");
    if (span) span.textContent = `v${version}`;
  } catch {}
});
// Las comps de TFT estan DESHABILITADAS: el worker que las calcula necesita una
// clave de Riot que no tenemos (ver el bloque "Comps de TFT" mas arriba). El
// codigo y la seccion siguen aqui; para reactivarlas basta devolver el boton
// #menu-comps al menu de index.html y descomentar estos cuatro listeners.
// $("menu-comps").addEventListener("click", () => {
//   cerrarMenu();
//   abrirComps();
// });
// $("comps-cerrar").addEventListener("click", () => {
//   $("comps").hidden = true;
//   if (ultimoEstado) pintar(ultimoEstado); // vuelve a la partida, al perfil o al vacio
// });
// $("comps-tier").addEventListener("change", pintarComps);
// $("comps-carry").addEventListener("change", pintarComps);
$("plat-riot").addEventListener("click", () => {
  cerrarMenu();
  abrirRiot();
});
$("plat-steam").addEventListener("click", () => {
  cerrarMenu();
  abrirDota();
});
$("dota-deriva-ver").addEventListener("click", verDeriva);
$("dota-deriva-restaurar").addEventListener("click", () => {
  const d = cuentaElegida()?.deriva;
  const p = dotaDatos?.perfiles?.find((x) => x.id === d?.perfil);
  if (p) aplicarPerfilDota(p);
});

$("dota-cambiar").addEventListener("click", (ev) => {
  ev.stopPropagation(); // si no, el listener de document lo cierra al vuelo
  if (panelCuentas.hidden) abrirPanelCuentas();
  else cerrarPanelCuentas();
});
document.addEventListener("click", (ev) => {
  if (!panelCuentas.hidden && !panelCuentas.contains(ev.target)) cerrarPanelCuentas();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") cerrarPanelCuentas();
});
window.addEventListener("resize", cerrarPanelCuentas);

$("dota-nuevo").addEventListener("click", guardarPerfilDota);
$("dota-deshacer").addEventListener("click", deshacerDota);
$("dota-nombre").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") guardarPerfilDota();
});
$("menu-terminos").addEventListener("click", () => abrirModal("Términos y condiciones", "tpl-terminos"));
$("modal-cerrar").addEventListener("click", () => { $("modal").hidden = true; });
$("modal").addEventListener("click", (ev) => {
  if (ev.target === $("modal")) $("modal").hidden = true;
});

// ---- Actualizacion integrada ----
// Dentro de la app instalada, "actualizar" descarga el instalador silencioso
// y la app se reinicia sola con la version nueva: nunca hay que tocar un exe.
// En el navegador o en la version portable se cae al enlace de descarga.
let instalando = false;

function avisoActualizacion(texto) {
  const estado = $("menu-estado");
  estado.hidden = false;
  estado.replaceChildren(texto);
  // El progreso se cuenta en el propio chip, que es de donde salio la orden.
  const chip = $("pie-version");
  if (chip.classList.contains("pie-version--nueva")) chip.textContent = texto;
}

function enlaceDescarga(url, version) {
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.target = "_blank";
  enlace.rel = "noopener";
  enlace.textContent = version ? `Descargar v${version}` : "Descargar";
  return enlace;
}

async function instalarActualizacion(v) {
  if (instalando) return;
  instalando = true;
  avisoActualizacion("Descargando actualización...");
  try {
    const res = await window.grief.actualizar();
    if (res?.portable) {
      const url = v?.url ?? versionNueva?.url ?? "https://github.com/DosaAKA2A/GRIEF/releases/latest";
      $("menu-estado").hidden = false;
      $("menu-estado").replaceChildren("La versión portable no se actualiza sola. ", enlaceDescarga(url, v?.remota));
      instalando = false;
      return;
    }
    avisoActualizacion("Instalando... la app se reinicia sola.");
  } catch {
    avisoActualizacion("No se pudo descargar la actualización.");
    instalando = false;
  }
}

window.grief?.onProgreso?.((pct) => avisoActualizacion(`Descargando actualización... ${pct}%`));

// El chip del pie: instala dentro de la app; en navegador es un enlace. En
// reposo no tiene href, asi que un clic ahi no hace nada.
$("pie-version").addEventListener("click", (ev) => {
  if (!versionNueva || !window.grief?.actualizar) return;
  ev.preventDefault();
  instalarActualizacion(versionNueva);
});

// Actualizar app desde el menu: chequeo bajo demanda + instalacion integrada.
$("menu-actualizar").addEventListener("click", async () => {
  const estado = $("menu-estado");
  estado.hidden = false;
  if (instalando) return;
  estado.replaceChildren("Buscando actualización...");
  try {
    const v = await estadoVersion();
    versionLocal = v.local;
    versionNueva = v.nueva ? { remota: v.remota, url: v.url } : null;
    pintarVersion(); // el chequeo a mano deja el chip como debe quedar
    if (!v.nueva) {
      estado.replaceChildren(`Estás en la última versión (v${v.local}).`);
    } else if (window.grief?.actualizar) {
      instalarActualizacion(v);
    } else {
      estado.replaceChildren("Hay versión nueva. ", enlaceDescarga(v.url, v.remota));
    }
  } catch {
    estado.replaceChildren("No se pudo comprobar (sin conexión).");
  }
});

let ultimoEstado = null;

function conectar() {
  const fuente = new EventSource("/events");
  fuente.onmessage = (ev) => {
    ultimoEstado = JSON.parse(ev.data);
    pintar(ultimoEstado);
  };
  // EventSource reintenta solo la reconexion.
  fuente.onerror = () => {
    $("estado").textContent = "Sin conexión con el tracker. Reintentando...";
  };
}

conectar();

// Con la ventana oculta (minimizada/tapada) las animaciones se pausan:
// cero trabajo de compositor mientras nadie mira.
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("oculta", document.hidden);
});
