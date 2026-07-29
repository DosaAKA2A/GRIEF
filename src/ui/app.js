// UI del tracker: escucha /events (SSE) y pinta el estado.
// Todo el DOM se construye con createElement: los nombres vienen de Riot
// y no deben interpretarse nunca como HTML.

const FASES = {
  pregame: "Seleccion de agentes",
  core: "En partida",
  "lol-champselect": "Seleccion de campeones",
  "lol-game": "En partida",
  "dota-lobby": "Lobby",
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

// Color distintivo por party: lo lleva la espina izquierda y el chip Pn.
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

function filaJugador(r, juego) {
  const rotuloRr = juego === "lol" ? "LP" : "RR";
  const li = el("li", "jugador");
  li.style.setProperty("--rango", colorRango(r.tier));

  const espina = el("i", "espina");
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
  const cuerpo = el("div", "cuerpo");

  const linea1 = el("div", "linea1");
  const sinPick = !r.agent || r.agent === "-";
  if (!(sinPick && juego === "dota")) {
    linea1.append(el("span", "agente" + (sinPick ? " sin-pick" : ""), sinPick ? "sin pick" : r.agent));
  }
  const nombre = el("span", "nombre" + (r.incognito ? " oculto" : ""), r.name);
  if (r.me) nombre.append(el("span", "yo", "TU"));
  linea1.append(nombre);
  if (r.party) {
    li.style.setProperty("--party", COLORES_PARTY[(r.party - 1) % COLORES_PARTY.length]);
    const chip = el("span", `party party-c${((r.party - 1) % 5) + 1}`, "P" + r.party);
    chip.title = `Party de ${r.partySize} jugadores`;
    linea1.append(chip);
  }
  for (const a of r.alertas ?? []) {
    const chip = el("span", "alerta " + a.tipo, a.texto);
    chip.title = a.detalle;
    linea1.append(chip);
  }
  if (r.rr != null) {
    const rr = el("span", "rr");
    rr.append(el("b", null, String(r.rr)));
    rr.append(el("small", null, rotuloRr));
    linea1.append(rr);
  }

  const linea2 = el("div", "linea2");
  if (r.tierLabel) linea2.append(el("span", "rango-nombre", r.tierLabel));
  if (r.linea2extra) linea2.append(el("span", "kda", r.linea2extra));
  if (r.kda) {
    const kda = el("span", "kda", "KDA " + r.kda.kda.toFixed(2));
    const hs = r.kda.hsRate != null ? ` · HS ${Math.round(r.kda.hsRate * 100)}%` : "";
    kda.title = `${r.kda.kills}/${r.kda.deaths}/${r.kda.assists} en ${r.kda.games} partidas competitivas${hs}`;
    linea2.append(kda);
  }
  if (r.level != null) linea2.append(el("span", "nivel", `Nivel ${r.level}`));
  if (r.peak > r.tier) {
    const peak = el("span", "peak", "Peak ");
    const peakIcono = iconoRango(r.peak, "peak-img");
    if (peakIcono) peak.append(peakIcono);
    peak.append(document.createTextNode(" " + r.peakLabel));
    linea2.append(peak);
  }

  cuerpo.append(linea1, linea2);
  if (r.rr != null) {
    const barra = el("div", "rr-barra");
    const relleno = el("i");
    relleno.style.width = Math.min(100, Math.max(0, r.rr)) + "%";
    barra.append(relleno);
    cuerpo.append(barra);
  }
  li.append(espina);
  // El hueco del retrato se conserva donde hay picks (Valorant/LoL) para
  // alinear filas; en Dota no hay heroes en el lobby y el espacio sobra.
  if (juego !== "dota" || retrato.childNodes.length) li.append(retrato);
  li.append(insignia); // siempre: alinea insignias/medallas
  li.append(cuerpo);
  return li;
}

function pintar(estado) {
  $("estado").textContent = estado.status ?? "";
  $("juego").textContent = estado.gameLabel ?? "Valorant · LoL · Dota 2";

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

  // Tu equipo: el que contiene tu fila; sin ella, el equipo de la primera.
  const miFila = estado.rows.find((r) => r.me);
  const miEquipo = miFila ? miFila.team : estado.rows[0].team;
  let aliados = estado.rows.filter((r) => r.team === miEquipo);
  let rivales = estado.rows.filter((r) => r.team !== miEquipo);
  // Sin equipos distinguibles (lobby de Dota): una sola lista.
  if (!aliados.length || miEquipo === "-") {
    aliados = estado.rows;
    rivales = [];
  }
  $("titulo-aliado").textContent = estado.game === "dota" ? "Jugadores del lobby" : "Tu equipo";

  $("lista-aliado").replaceChildren(...aliados.map((r) => filaJugador(r, estado.game)));
  $("lista-rival").replaceChildren(...rivales.map((r) => filaJugador(r, estado.game)));

  $("panel-rival").hidden = rivales.length === 0;
  $("equipos").classList.toggle("solo-aliado", rivales.length === 0);
}

function conectar() {
  const fuente = new EventSource("/events");
  fuente.onmessage = (ev) => pintar(JSON.parse(ev.data));
  // EventSource reintenta solo la reconexion.
  fuente.onerror = () => {
    $("estado").textContent = "Sin conexion con el tracker. Reintentando...";
  };
}

conectar();
