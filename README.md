# GRIEF

Tracker ligero multi-juego: stats de los jugadores de tu partida antes de empezar. Sin overlay in-game, sin tocar el proceso del juego, sin Overwolf.

- **Valorant** (completo): API local del cliente de Riot — rangos, RR, KDA, HS%, nivel, parties y senales de cheater/smurf/booster.
- **League of Legends**: LCU + Live Client Data — seleccion de campeones (tu equipo con rango/LP) y en partida los 10 con campeon, KDA en vivo y rango best-effort.
- **Dota 2** (parcial): requiere `-console -condebug` en las opciones de lanzamiento de Steam; GRIEF parsea el console.log para sacar los SteamID del lobby y consulta OpenDota (medalla, winrate, KDA). Los perfiles privados salen sin datos.

La app detecta sola que juego esta vivo y muestra ese.

## Estado

Fase 4: multi-juego (Valorant / LoL / Dota 2) en app de escritorio (Electron), consola y UI en navegador.

## Uso

Con el cliente de Riot abierto (y VALORANT arrancado al menos una vez):

```
npm start           # una pasada por consola: muestra la partida actual si la hay
npm run watch       # consola en vivo: detecta partida al instante (websocket)
npm run ui          # UI en el navegador (se abre sola): http://127.0.0.1:4327
npm run app         # la app de escritorio (ventana propia, puerto 43270)
npm run dist        # construye instalador NSIS + exe portable en dist/
```

- En seleccion de agentes muestra tu equipo (5) y refresca con cada pick.
- En partida muestra los 10 con equipo, agente, rango actual, RR, peak y KDA
  de las ultimas 10 competitivas: (K+A)/D. El KDA llega unos segundos despues
  del resto (match-details pesa ~1 MB por partida); con cache es inmediato.
- Jugadores en modo incognito salen como `(oculto)`.
- `npm run ui` acepta `--port N` y `--no-open`.

## Como funciona

1. `src/lockfile.js` — lee `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` (puerto + password del cliente local).
2. `src/localapi.js` — basic auth contra `https://127.0.0.1:{port}`: tokens (access + entitlements + PUUID), version del cliente, y region/shard desde el log de VALORANT.
3. `src/remote.js` — con esos tokens consulta `glz` (pregame / core-game) y `pd` (name-service, MMR), con cache TTL por PUUID (`src/cache.js`: nombres 6 h, MMR 10 min).
4. `src/ws.js` — cliente WebSocket minimo (RFC 6455 sobre `node:tls`) contra el Riot Client; suscrito al riot-messaging-service, avisa de pregame/partida sin sondear.
5. `src/tracker.js` — el nucleo: conecta, detecta (websocket + sondeo de respaldo), enriquece jugadores, calcula senales y emite eventos.
6. `src/cli.js` — consumidor de consola. `src/serve.js` + `src/ui/` — servidor local con SSE y la interfaz (`src/server.js` es el CLI).
7. `electron/main.js` — la app de escritorio: misma UI en ventana propia.

El tracker en si sigue sin dependencias npm (Node >= 20 y modulos nativos); electron y electron-builder son solo devDependencies para la app.

## Limitaciones conocidas

- API interna no documentada: Riot puede cambiarla en cualquier parche.
- Un lockfile presente no garantiza cliente vivo (queda huerfano si el cliente muere); se detecta por `ECONNREFUSED`.
- Si el websocket local falla, se cae con gracia al sondeo cada 10 s.

## Roadmap

- [x] Deteccion de cambio de cuenta (re-auth ante 401)
- [x] Cache de MMR/nombres por PUUID
- [x] Websocket local para detectar pregame sin polling
- [x] UI (ventana ligera para segunda pantalla)
- [ ] Historial de partidas propias
- [ ] Empaquetado como app (icono, arranque con un doble clic)
