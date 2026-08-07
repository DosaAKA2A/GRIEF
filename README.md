# GRIEF

Tracker ligero multi-juego: stats de los jugadores de tu partida antes de empezar. Sin overlay in-game, sin tocar el proceso del juego, sin Overwolf.

- **Valorant** (completo): API local del cliente de Riot — mapa y servidor, rangos, RR, KDA, HS%, nivel, parties y senales de cheater/smurf/booster.
- **League of Legends y TFT**: LCU + Live Client Data, en cualquier cola (reclutamiento, clasificatoria, ARAM, Arena, URF, bots, personalizada) y en TFT. Lobby con los rangos del grupo, seleccion de campeones con ambos equipos y baneos, partida en vivo con KDA, CS/min, vision, objetos, runas, hechizos y objetivos del equipo, y resumen al acabar con daño, oro, CS y vision de los diez.

- **Dota 2** (perfiles de controles): guarda tu configuracion de controles tal como esta y vuelve a ponerla en la cuenta de Steam que quieras, sin copiar carpetas a mano.

La app detecta sola que juego esta vivo y muestra ese.

(El *tracker* de Dota 2 se descarto: el cliente moderno no expone el roster del lobby por diseño de Valve — solo era posible tu propio estado via GSI y un informe post-partida, insuficiente para el objetivo de la herramienta.)

## Estado

Fase 4: multi-juego (Valorant / LoL) en app de escritorio (Electron), consola y UI en navegador. Ademas, gestor de perfiles de controles de Dota 2.

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
- `npm run lol:debug` vuelca lo que responden el LCU y la API en vivo con el
  cliente abierto: sirve para comprobar una cola concreta (`--crudo` para el
  JSON entero). Con `GRIEF_LCU=https://127.0.0.1:PUERTO` se apunta el tracker
  a otro LCU o a un simulacro.

## Como funciona

1. `src/lockfile.js` — lee `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` (puerto + password del cliente local).
2. `src/localapi.js` — basic auth contra `https://127.0.0.1:{port}`: tokens (access + entitlements + PUUID), version del cliente, y region/shard desde el log de VALORANT.
3. `src/remote.js` — con esos tokens consulta `glz` (pregame / core-game) y `pd` (name-service, MMR), con cache TTL por PUUID (`src/cache.js`: nombres 6 h, MMR 10 min).
4. `src/ws.js` — cliente WebSocket minimo (RFC 6455 sobre `node:tls`) contra el Riot Client; suscrito al riot-messaging-service, avisa de pregame/partida sin sondear.
5. `src/tracker.js` — el nucleo: conecta, detecta (websocket + sondeo de respaldo), enriquece jugadores, calcula senales y emite eventos.
6. `src/cli.js` — consumidor de consola. `src/serve.js` + `src/ui/` — servidor local con SSE y la interfaz (`src/server.js` es el CLI).
7. `electron/main.js` — la app de escritorio: misma UI en ventana propia.
8. `src/dota.js` — perfiles de controles de Dota 2. Dota guarda los controles fuera del juego, en `Steam\userdata\<steamid3>\570\` (`remote\` va a Steam Cloud, `local\` es de esta maquina). Un perfil es una copia de esos archivos en `%APPDATA%\GRIEF\dota-perfiles`; como no llevan nada atado a la cuenta, sirven igual en cualquiera. Aplicar exige Dota cerrado (al salir reescribe los controles) y siempre guarda antes un respaldo de lo que habia.

   Las **dos capas de controles viajan juntas**: dentro de `dotakeys_personal.lst` los globales estan en los bloques `Keys` e `Items` y los de cada heroe en `Units`, asi que copiar el archivo se las lleva las dos. La app lee ese KeyValues solo para contarlas y enseñar en cada ficha cuantos controles globales y que heroes con teclas propias trae el perfil.

El tracker en si sigue sin dependencias npm (Node >= 20 y modulos nativos); electron y electron-builder son solo devDependencies para la app.

## Limitaciones conocidas

- API interna no documentada: Riot puede cambiarla en cualquier parche.
- TFT no publica API en vivo (el puerto 2999 solo existe en partidas de LoL):
  de una partida de TFT se ven la mesa, los rangos de TFT y las parties, pero
  no oro, vida ni composicion en tiempo real.
- En la seleccion de campeones el rival solo aparece en las colas donde el
  cliente lo publica (reclutamiento, clasificatoria, torneos); en ciegas no.
- Un lockfile presente no garantiza cliente vivo (queda huerfano si el cliente muere); se detecta por `ECONNREFUSED`.
- Si el websocket local falla, se cae con gracia al sondeo cada 10 s.

## Roadmap

- [x] Deteccion de cambio de cuenta (re-auth ante 401)
- [x] Cache de MMR/nombres por PUUID
- [x] Websocket local para detectar pregame sin polling
- [x] UI (ventana ligera para segunda pantalla)
- [ ] Historial de partidas propias
- [ ] Empaquetado como app (icono, arranque con un doble clic)
