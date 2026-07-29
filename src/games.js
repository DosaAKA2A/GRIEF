// Supervisor multi-juego: corre los tres trackers a la vez y expone un
// estado combinado. El juego activo es el ultimo que tuvo partida; sin
// partida en ninguno, el estado agrega la situacion de cada juego.
import { EventEmitter } from "node:events";
import { Tracker } from "./tracker.js";
import { LolTracker } from "./lol.js";
import { DotaTracker } from "./dota.js";

const LABELS = { valorant: "VALORANT", lol: "League of Legends", dota: "Dota 2" };

export class MultiTracker extends EventEmitter {
  #snapshots = {
    valorant: { status: "Valorant: arrancando...", phase: null, label: null, rows: [], updatedAt: 0 },
    lol: { status: "LoL: arrancando...", phase: null, label: null, rows: [], updatedAt: 0 },
    dota: { status: "Dota 2: arrancando...", phase: null, label: null, rows: [], updatedAt: 0 },
  };
  #activo = null;

  start() {
    const children = {
      valorant: new Tracker({ watch: true }),
      lol: new LolTracker(),
      dota: new DotaTracker(),
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
        snap.phase = m.phase;
        snap.label = m.label;
        snap.rows = m.rows;
        snap.updatedAt = Date.now();
        this.#activo = game;
        this.#push();
      });
      t.on("no-match", () => {
        snap.phase = null;
        snap.label = null;
        snap.rows = [];
        snap.updatedAt = Date.now();
        this.#push();
      });
      t.start().catch((err) => {
        snap.status = `${LABELS[game]}: error fatal (${err.message})`;
        this.#push();
      });
    }
    this.#push();
  }

  getState() {
    // Juego activo: el ultimo con partida y que aun la tenga.
    let game = this.#activo && this.#snapshots[this.#activo].rows.length ? this.#activo : null;
    if (!game) {
      let mejor = 0;
      for (const [g, s] of Object.entries(this.#snapshots)) {
        if (s.rows.length && s.updatedAt > mejor) {
          mejor = s.updatedAt;
          game = g;
        }
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
      updatedAt: Math.max(...Object.values(this.#snapshots).map((s) => s.updatedAt)) || null,
    };
  }

  #push() {
    this.emit("update", this.getState());
  }
}
