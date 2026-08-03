// Supervisor multi-juego: corre los trackers a la vez y expone un estado
// combinado. El juego activo es el ultimo que tuvo partida; sin partida en
// ninguno, el estado agrega la situacion de cada juego.
import { EventEmitter } from "node:events";
import { Tracker } from "./tracker.js";
import { LolTracker } from "./lol.js";

const LABELS = { valorant: "VALORANT", lol: "League of Legends" };

export class MultiTracker extends EventEmitter {
  #snapshots = {
    valorant: { status: "Valorant: arrancando...", phase: null, label: null, rows: [], extra: {}, prioridad: 0, updatedAt: 0 },
    lol: { status: "LoL: arrancando...", phase: null, label: null, rows: [], extra: {}, prioridad: 0, updatedAt: 0 },
  };
  #activo = null;

  start() {
    const children = {
      valorant: new Tracker({ watch: true }),
      lol: new LolTracker(),
    };
    for (const [game, t] of Object.entries(children)) {
      const snap = this.#snapshots[game];
      t.on("status", (s) => {
        const texto = game === "valorant" ? `Valorant: ${s}` : s;
        if (texto === snap.status) return;
        snap.status = texto;
        this.#push();
      });
      t.on("match", (m) => {
        // Todo lo que no sea fase/etiqueta/filas viaja tal cual a la UI: cada
        // juego adjunta el contexto que tenga (mapa, bando, cola, marcador).
        const { phase, label, rows, prioridad, ...extra } = m;
        snap.phase = phase;
        snap.label = label;
        snap.rows = rows;
        snap.extra = extra;
        snap.prioridad = prioridad ?? 3;
        snap.updatedAt = Date.now();
        this.#activo = game;
        this.#push();
      });
      t.on("no-match", () => {
        snap.phase = null;
        snap.label = null;
        snap.rows = [];
        snap.extra = {};
        snap.prioridad = 0;
        snap.updatedAt = Date.now();
        this.#push();
      });
      t.on("profile", (p) => {
        // Cada juego trae su perfil; gana el que se haya refrescado ultimo,
        // que en la practica es el del cliente que este abierto ahora.
        snap.perfil = p.game ? p : { ...p, game };
        snap.perfilAt = Date.now();
        this.#push();
      });
      t.start().catch((err) => {
        // Ultima red de seguridad: mensaje humano en la UI, detalle en consola.
        console.error(`[${game}] error fatal:`, err);
        snap.status = `${LABELS[game]}: no disponible. Reinicia GRIEF para reintentar.`;
        this.#push();
      });
    }
    this.#push();
  }

  getState() {
    // Juego activo: manda la prioridad (una partida en curso siempre le gana
    // a un lobby abierto de fondo) y, a igualdad, el ultimo en actualizarse.
    let game = null;
    let mejor = [0, 0];
    for (const [g, s] of Object.entries(this.#snapshots)) {
      if (!s.rows.length) continue;
      const peso = [s.prioridad ?? 3, s.updatedAt];
      const actual = g === this.#activo ? [peso[0], peso[1] + 1] : peso;
      if (actual[0] > mejor[0] || (actual[0] === mejor[0] && actual[1] > mejor[1])) {
        mejor = actual;
        game = g;
      }
    }
    if (game) {
      const s = this.#snapshots[game];
      return {
        game,
        gameLabel: LABELS[game],
        status: s.status,
        phase: s.phase,
        label: s.label,
        rows: s.rows,
        mapa: null,
        servidor: null,
        lado: null,
        modo: null,
        ...s.extra,
        perfil: this.#perfilActivo(),
        updatedAt: s.updatedAt,
      };
    }
    return {
      game: null,
      gameLabel: null,
      status: Object.values(this.#snapshots).map((s) => s.status).join("  ·  "),
      phase: null,
      label: null,
      rows: [],
      perfil: this.#perfilActivo(),
      updatedAt: Math.max(...Object.values(this.#snapshots).map((s) => s.updatedAt)) || null,
    };
  }

  // Perfil a la vista: el ultimo refrescado. Cada tracker solo emite el suyo
  // mientras su cliente este vivo, asi que gana el juego que tengas abierto.
  #perfilActivo() {
    let mejor = null;
    let cuando = -1;
    for (const s of Object.values(this.#snapshots)) {
      if (s.perfil && (s.perfilAt ?? 0) > cuando) {
        cuando = s.perfilAt ?? 0;
        mejor = s.perfil;
      }
    }
    return mejor;
  }

  #push() {
    this.emit("update", this.getState());
  }
}
