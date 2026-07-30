// UI del tracker: escucha /events (SSE) y pinta el estado.
// Todo el DOM se construye con createElement: los nombres vienen de Riot
// y no deben interpretarse nunca como HTML.

const FASES = {
  pregame: "Seleccion de agentes",
  core: "En partida",
  "lol-champselect": "Seleccion de campeones",
  "lol-game": "En partida",
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
    espina.title = `Party de ${r.partySize} jugadores`;
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
  const sinPick = !r.agent || r.agent === "-";
  linea1.append(el("span", "agente" + (sinPick ? " sin-pick" : ""), sinPick ? "sin pick" : r.agent));
  const nombre = el("span", "nombre" + (r.incognito ? " oculto" : ""), r.name);
  if (r.me) nombre.append(el("span", "yo", "TU"));
  linea1.append(nombre);

  // La info de rango cede con puntos suspensivos; las señales NUNCA se cortan.
  const linea2 = el("div", "linea2");
  const izq = el("span", "l2-izq");
  if (r.tierLabel) izq.append(el("span", "rango-nombre", r.tierLabel));
  if (r.peak > r.tier) {
    const peak = el("span", "peak", "Peak ");
    const peakIcono = iconoRango(r.peak, "peak-img");
    if (peakIcono) peak.append(peakIcono);
    peak.append(document.createTextNode(" " + r.peakLabel));
    izq.append(peak);
  }
  if (r.level != null) izq.append(el("span", "nivel", `Nv ${r.level}`));
  if (r.linea2extra) izq.append(el("span", "extra", r.linea2extra));
  linea2.append(izq);
  if (r.alertas?.length) {
    const flags = el("span", "flags");
    for (const a of r.alertas) {
      const chip = el("span", "alerta " + a.tipo, "¿" + a.texto.replace(/^Posible\s+/i, "") + "?");
      chip.title = `${a.texto}: ${a.detalle}`;
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
    statKda.append(el("span", "sub" + (hs != null && hs >= 30 ? " alto" : ""), hs != null ? `HS ${hs}%` : `${r.kda.games} partidas`));
    statKda.title = `${r.kda.kills}/${r.kda.deaths}/${r.kda.assists} en ${r.kda.games} partidas`;
  } else {
    statKda.append(el("b", "vacio", "—"), el("small", null, "KDA"));
  }

  li.append(espina, retrato, insignia, cuerpo, statKda);

  // ADR + win rate de las ultimas competitivas (solo Valorant: sale del
  // detalle de partida). Mismo sitio en todas las filas, con o sin dato.
  if (juego !== "lol") {
    const statAdr = el("div", "stat stat-adr");
    if (r.kda?.adr != null) {
      const adr = Math.round(r.kda.adr);
      const b = el("b", adr >= 160 ? "bien" : adr > 0 && adr <= 110 ? "mal" : "", String(adr));
      statAdr.append(b, el("small", null, "ADR"));
      const wr = r.kda.winRate != null ? Math.round(r.kda.winRate * 100) : null;
      if (wr != null) statAdr.append(el("span", "sub" + (wr >= 60 ? " alto" : ""), `WR ${wr}%`));
      if (r.kda.acs != null) statAdr.title = `ACS ${Math.round(r.kda.acs)} · ${Math.round(r.kda.adr)} de dano medio por ronda`;
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

function pintar(estado) {
  $("estado").textContent = estado.status ?? "";
  $("juego").textContent = estado.gameLabel ?? "Valorant · LoL";

  const hayPartida = estado.rows && estado.rows.length > 0;
  $("vacio").hidden = hayPartida;
  $("equipos").hidden = !hayPartida;
  $("fase").hidden = !hayPartida;

  if (!hayPartida) {
    // Sin partida: el detalle por juego va bajo el radar, una linea cada uno.
    $("estado").textContent = "";
    const s = estado.status ?? "";
    $("vacio-detalle").textContent = s.includes("·")
      ? s.split("·").map((x) => x.trim()).filter(Boolean).join("\n")
      : s;
    return;
  }

  $("fase-texto").textContent = FASES[estado.phase] ?? estado.label ?? "";

  // Banda de contexto: mapa+servidor (Valorant) o bando (LoL / Dota 2).
  const banda = $("banda");
  banda.hidden = false;
  banda.style.backgroundImage = "";
  if (estado.game === "valorant" && estado.mapa) {
    banda.className = "banda";
    banda.style.backgroundImage =
      `linear-gradient(90deg, rgba(15,25,35,0.95) 18%, rgba(15,25,35,0.35) 60%, rgba(15,25,35,0.75)), url("valorant/mapas/${estado.mapa.slug}.png")`;
    $("banda-titulo").textContent = estado.mapa.nombre ?? "";
    $("banda-sub").textContent = estado.servidor ? `Servidor · ${estado.servidor}` : "";
  } else if (estado.game === "lol" && estado.lado) {
    banda.className = "banda lado-" + estado.lado;
    $("banda-titulo").textContent = estado.lado === "azul" ? "Lado azul" : "Lado rojo";
    $("banda-sub").textContent = estado.lado === "azul" ? "Mitad inferior del mapa" : "Mitad superior del mapa";
  } else {
    banda.hidden = true;
  }

  // Tu equipo: el que contiene tu fila; sin ella, el equipo de la primera.
  const miFila = estado.rows.find((r) => r.me);
  const miEquipo = miFila ? miFila.team : estado.rows[0].team;
  let aliados = estado.rows.filter((r) => r.team === miEquipo);
  let rivales = estado.rows.filter((r) => r.team !== miEquipo);
  // Sin equipos distinguibles: una sola lista.
  if (!aliados.length || miEquipo === "-") {
    aliados = estado.rows;
    rivales = [];
  }
  $("titulo-aliado").textContent = "Tu equipo";
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

async function revisarActualizacion() {
  try {
    const v = await estadoVersion();
    if (!v.nueva) return;
    const boton = $("actualizar");
    boton.textContent = `Actualizar a v${v.remota}`;
    boton.href = v.url;
    boton.hidden = false;
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

// Encuadre perfecto: barra inferior, solo dentro de la app de escritorio
// (preload). En el navegador la barra ni aparece.
if (window.grief?.encuadrar) {
  $("pie").hidden = false;
  $("pie-encuadre").addEventListener("click", () => window.grief.encuadrar());
}

function abrirModal(titulo, tplId) {
  $("modal-titulo").textContent = titulo;
  $("modal-cuerpo").replaceChildren(document.getElementById(tplId).content.cloneNode(true));
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
$("menu-terminos").addEventListener("click", () => abrirModal("Terminos y condiciones", "tpl-terminos"));
$("modal-cerrar").addEventListener("click", () => { $("modal").hidden = true; });
$("modal").addEventListener("click", (ev) => {
  if (ev.target === $("modal")) $("modal").hidden = true;
});

// Actualizar app: chequeo bajo demanda con resultado visible en el menu.
$("menu-actualizar").addEventListener("click", async () => {
  const estado = $("menu-estado");
  estado.hidden = false;
  estado.replaceChildren("Buscando actualizacion...");
  try {
    const v = await estadoVersion();
    if (v.nueva) {
      const enlace = document.createElement("a");
      enlace.href = v.url;
      enlace.target = "_blank";
      enlace.rel = "noopener";
      enlace.textContent = `Descargar v${v.remota}`;
      estado.replaceChildren("Hay version nueva. ", enlace);
    } else {
      estado.replaceChildren(`Estas en la ultima version (v${v.local}).`);
    }
  } catch {
    estado.replaceChildren("No se pudo comprobar (sin conexion).");
  }
});

function conectar() {
  const fuente = new EventSource("/events");
  fuente.onmessage = (ev) => pintar(JSON.parse(ev.data));
  // EventSource reintenta solo la reconexion.
  fuente.onerror = () => {
    $("estado").textContent = "Sin conexion con el tracker. Reintentando...";
  };
}

conectar();
