// UI del tracker: escucha /events (SSE) y pinta el estado.
// Todo el DOM se construye con createElement: los nombres vienen de Riot
// y no deben interpretarse nunca como HTML.

const FASES = { pregame: "Seleccion de agentes", core: "En partida" };

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

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function filaJugador(r) {
  const li = el("li", "jugador");
  li.style.setProperty("--rango", colorRango(r.tier));

  const espina = el("i", "espina");
  const cuerpo = el("div", "cuerpo");

  const linea1 = el("div", "linea1");
  const sinPick = !r.agent || r.agent === "-";
  linea1.append(el("span", "agente" + (sinPick ? " sin-pick" : ""), sinPick ? "sin pick" : r.agent));
  const nombre = el("span", "nombre" + (r.incognito ? " oculto" : ""), r.name);
  if (r.me) nombre.append(el("span", "yo", "TU"));
  linea1.append(nombre);
  const rr = el("span", "rr");
  rr.append(el("b", null, String(r.rr)));
  rr.append(el("small", null, "RR"));
  linea1.append(rr);

  const linea2 = el("div", "linea2");
  linea2.append(el("span", "rango-nombre", r.tierLabel));
  if (r.peak > r.tier) linea2.append(el("span", "peak", "Peak " + r.peakLabel));

  const barra = el("div", "rr-barra");
  const relleno = el("i");
  relleno.style.width = Math.min(100, Math.max(0, r.rr)) + "%";
  barra.append(relleno);

  cuerpo.append(linea1, linea2, barra);
  li.append(espina, cuerpo);
  return li;
}

function pintar(estado) {
  $("estado").textContent = estado.status ?? "";

  const hayPartida = estado.rows && estado.rows.length > 0;
  $("vacio").hidden = hayPartida;
  $("equipos").hidden = !hayPartida;
  $("fase").hidden = !hayPartida;

  if (!hayPartida) {
    $("vacio-detalle").textContent =
      estado.phase === null && estado.updatedAt
        ? "Sin partida ahora mismo. En cuanto entres a una, aparece aqui."
        : estado.status ?? "";
    return;
  }

  $("fase-texto").textContent = FASES[estado.phase] ?? estado.label ?? "";

  // Tu equipo: el que contiene tu fila; si no hay (espectador), Blue.
  const miFila = estado.rows.find((r) => r.me);
  const miEquipo = miFila ? miFila.team : "Blue";
  const aliados = estado.rows.filter((r) => r.team === miEquipo);
  const rivales = estado.rows.filter((r) => r.team !== miEquipo);

  const listaAliado = $("lista-aliado");
  const listaRival = $("lista-rival");
  listaAliado.replaceChildren(...aliados.map(filaJugador));
  listaRival.replaceChildren(...rivales.map(filaJugador));

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
