import React, { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import type { MatchMetadata, Participant } from "../../../types";
import {
  cancelMatchMinimap, getCameraZones, getMatchAttribution, getMatchPressure, getMinimapStatus, getPressureSummary,
  processMatchMinimap,
  type MinimapStatus, type PlayerCredit, type PressureSummary, type PressureWindow, type ZoneStat,
} from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import { sameRole } from "../../../core/roles";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PressureEpisodeCard } from "./PressureEpisodeCard";
import { RivalCard } from "./RivalCard";
import { formatGold, formatSigned } from "./pressureFormat";
import type { OpenMap } from "../mapFocus";
import "./ImpactTab.css";

/**
 * Pestaña Impacto del reproductor: qué significó tu partida. Vivía dentro de
 * VideoPlayer.tsx; se separó para poder rehacerla sin tocar el reproductor.
 * Se monta sólo con la pestaña abierta, así que lo que pide lo pide al abrirla.
 *
 * Orden, de la conclusión al detalle: tu impacto (puesto y de dónde salió),
 * tú contra tu rival, la presión que absorbiste y dónde miraste. Se fueron
 * «Crédito real» (la tabla de los diez con el desfase de oro de remates: habla
 * de la partida de todos, no de la tuya), «Muerte más cara» (salía la de otro
 * jugador) y «Análisis del vídeo» como sección propia: es estado, no
 * información, y cuando falta vive dentro de la presión, que es lo que mejora.
 */

export interface ImpactTabProps {
  match: MatchMetadata;
  participants: Participant[];
  /** Saltar en el vídeo (segundos de VÍDEO). */
  seekTo: (videoSeconds: number, play: boolean) => void;
  /** Abrir el Mapa en un momento con lo suyo dibujado. */
  onOpenMap: OpenMap;
}

export const ImpactTab: React.FC<ImpactTabProps> = ({ match, participants, seekTo, onOpenMap }) => {
  const t = useT();
  // Reparto de credito por dano real. Se pide al abrir la pestana de la partida
  // y no antes: la primera vez puede costar dos llamadas a la API, luego sale de
  // cache en disco. Ya no se enseña como tabla: de él salen el impacto (WPA) y
  // el de tu rival.
  const [credits, setCredits] = useState<PlayerCredit[] | null>(null);
  const [creditsErr, setCreditsErr] = useState<string | null>(null);
  // Tramos de presion absorbida. Se piden junto al credito, en la misma pestana.
  const [pressure, setPressure] = useState<PressureWindow[] | null>(null);
  const [pressureErr, setPressureErr] = useState<string | null>(null);
  // Procesado del minimapa: en que punto esta y como va la pasada actual.
  const [mmStatus, setMmStatus] = useState<MinimapStatus | null>(null);
  const [mmPct, setMmPct] = useState<number | null>(null);
  const [mmErr, setMmErr] = useState<string | null>(null);
  // Reparto de tus miradas por carril. Sale de la posición del clic de minimapa.
  const [zonas, setZonas] = useState<ZoneStat[]>([]);
  // La presión de todas tus partidas: sólo para la línea que explica para qué
  // sirve la franja, con tus cifras y no con unas de ejemplo. `undefined` es
  // "aún no ha respondido" (la línea espera, para no cambiar de texto delante
  // del usuario) y `null` que falló (sale la versión sin cifras).
  const [resumen, setResumen] = useState<PressureSummary | null | undefined>(undefined);

  // El reparto de credito se pide al abrir la pestana de la partida, una sola
  // vez por partida. Si falla no se reintenta en bucle: se guarda el motivo y se
  // enseña, que es mas util que un panel vacio.
  // OJO con las dependencias: `credits` NO puede estar aqui. Al estarlo, en
  // cuanto la atribucion respondia y hacia setCredits, el efecto se re-ejecutaba
  // y su limpieza ponia vivo=false, descartando la respuesta de presion que
  // seguia en vuelo. Funcionaba mientras las dos iban a la API (la presion
  // ganaba la carrera) y se rompio al cachear, cuando la atribucion paso a
  // responder primero. El "ya pedido" se lleva en un ref, que no dispara
  // re-ejecuciones.
  //
  // `intento` sube al pulsar Reintentar: es lo que permite volver a pedirlo sin
  // reabrir la pestaña. Un fallo de la API dejaba el panel muerto hasta cambiar
  // de partida y volver.
  const pedidoRef = useRef<string | null>(null);
  const [intento, setIntento] = useState(0);
  const reintentar = useCallback(() => {
    pedidoRef.current = null;
    setCredits(null);
    setCreditsErr(null);
    setPressure(null);
    setPressureErr(null);
    setIntento((n) => n + 1);
  }, []);
  useEffect(() => {
    if (match.is_vod) return;
    if (pedidoRef.current === match.id) return;
    pedidoRef.current = match.id;
    let vivo = true;
    getMatchAttribution(match.id)
      .then((rows) => { if (vivo) setCredits(rows); })
      .catch((e) => { if (vivo) setCreditsErr(String(e)); });
    // El error se ENSENA, no se traga: tragarselo hacia que un fallo del comando
    // y "esta partida no tuvo tramos" fueran indistinguibles.
    //
    // Aqui se lanzaba ADEMAS el procesado del video (dos minutos de Python) solo
    // por entrar en la pestana. Salia con consola propia -la ventana negra- y
    // cerrarla mataba el trabajo antes de que escribiera nada, asi que a la
    // siguiente visita vuelta a empezar. Ahora se pide desde el panel.
    getCameraZones(match.id)
      .then((z) => { if (vivo) setZonas(z); })
      .catch(() => { if (vivo) setZonas([]); });
    getMatchPressure(match.id)
      .then((ws) => { if (vivo) setPressure(ws); })
      .catch((e) => { if (vivo) { setPressure([]); setPressureErr(String(e)); } });
    return () => { vivo = false; };
  }, [match.id, match.is_vod, intento]);

  // Estado del procesado del video. Se consulta al abrir Impacto (y al cambiar
  // de partida) y se mantiene al dia con el evento de progreso del backend.
  useEffect(() => {
    if (match.is_vod) return;
    let vivo = true;
    setMmErr(null);
    getMinimapStatus(match.id)
      .then((st) => {
        if (!vivo) return;
        setMmStatus(st);
        // Si quedo trabajo a medias, la barra arranca donde se quedo: lo hecho
        // no se repite, y empezar de cero haria pensar que si.
        setMmPct(st.state === "en_curso" ? st.saved_progress ?? 0 : null);
      })
      .catch(() => { if (vivo) setMmStatus(null); });
    return () => { vivo = false; };
  }, [match.id, match.is_vod]);

  useEffect(() => {
    const un = listen<[string, number]>("minimap_progress", (e) => {
      const [id, pct] = e.payload;
      if (id !== match.id) return;
      if (pct < 0) {
        // -1 es "termino mal". Sin distinguirlo, el unico aviso de un fallo era
        // una barra congelada a la mitad.
        setMmPct(null);
        setMmErr(t("The video analysis failed. Check the log for details."));
        getMinimapStatus(match.id).then(setMmStatus).catch(() => {});
        return;
      }
      setMmPct(pct);
      if (pct >= 100) {
        setMmPct(null);
        getMinimapStatus(match.id).then(setMmStatus).catch(() => {});
        // Los tramos se recalculan: ahora tienen el video detras y sus bordes
        // dejan de ser una cota inferior.
        getMatchPressure(match.id).then(setPressure).catch(() => {});
      }
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [match.id, t]);

  const empezarMinimapa = async () => {
    setMmErr(null);
    setMmPct(mmStatus?.saved_progress ?? 0);
    try {
      await processMatchMinimap(match.id);
      setMmStatus(await getMinimapStatus(match.id));
    } catch (e) {
      setMmPct(null);
      setMmErr(t("Couldn't start the video analysis: {msg}", { msg: String(e) }));
    }
  };

  const pararMinimapa = async () => {
    try {
      await cancelMatchMinimap(match.id);
    } finally {
      setMmPct(null);
      setMmStatus(await getMinimapStatus(match.id).catch(() => null));
    }
  };

  // `participant_id` es 1..10 en el orden de Riot, el mismo de `participants`.
  const yoIdx = participants.findIndex((p) => p.is_self);
  const yo = yoIdx + 1;
  const mios = (pressure ?? [])
    .filter((w) => w.participant_id === yo)
    // Por fecha: se leen como la partida, en orden.
    .sort((a, b) => a.game_start - b.game_start);
  const hayEpisodios = mios.length > 0;

  // El resumen de todas las partidas se pide sólo si hay franjas que explicar.
  useEffect(() => {
    if (!hayEpisodios || resumen !== undefined) return;
    let vivo = true;
    getPressureSummary()
      .then((r) => { if (vivo) setResumen(r); })
      .catch(() => { if (vivo) setResumen(null); });
    return () => { vivo = false; };
  }, [hayEpisodios, resumen]);

  // Impacto responde "que significo", frente a Partida que responde "que
  // paso". Estaban mezcladas en la misma columna y lo mas diferencial quedaba
  // al final de un scroll largo.
  if (match.is_vod) {
    return (
      // La pestaña entera estaba condicionada a `!match.is_vod` sin decir
      // nada: en un VOD se abría vacía y parecía un fallo.
      <div className="insp">
        <EmptyState
          title={t("No impact for an imported VOD")}
          text={t("Impact needs a recorded game synced with Riot; imported VODs have no match data behind them.")}
        />
      </div>
    );
  }

  const offset = match.video_offset ?? 0;
  const conVideo = !!match.video_path;
  const creditOf = (pid: number) => credits?.find((c) => c.participant_id === pid);
  const mio = creditOf(yo);

  // El rival directo: el del otro equipo con tu mismo puesto, el criterio de
  // `rival_de_linea` en el backend (que es de quien salen las curvas). El rol
  // del marcador manda; el del reparto (mismo DTO de Riot) cubre las partidas
  // guardadas antes de que el marcador lo trajera. Sin rol no hay tarjeta:
  // adivinar el rival por el orden de la lista emparejaría a cualquiera.
  const yoP = yoIdx >= 0 ? participants[yoIdx] : undefined;
  const rolDe = (i: number) => participants[i]?.role || creditOf(i + 1)?.role || "";
  const miRol = yoIdx >= 0 ? rolDe(yoIdx) : "";
  const rivalIdx = yoP && miRol
    ? participants.findIndex((p, i) => p.team_id !== yoP.team_id && sameRole(rolDe(i), miRol))
    : -1;
  const rivalP = rivalIdx >= 0 ? participants[rivalIdx] : undefined;

  return (
    <div className="insp">
      {/* --------------------------------------- tu impacto
          El puesto y el percentil ya existian, pero solo en la columna de
          la biblioteca: quien abria esta pestana veia la tabla de los diez
          y tenia que buscarse. Y un puesto suelto no se puede revisar, asi
          que va con el desglose de DONDE salio. */}
      {(creditsErr !== null || mio) && (
        <section>
          <div className="sect__head">
            <span className="u-label">{t("Your impact")}</span>
            <i className="sect__rule" />
          </div>
          {creditsErr !== null ? (
            <>
              <p className="note">{t("Couldn't work out your impact: {msg}", { msg: creditsErr })}</p>
              <button className="btn btn--ghost btn--sm" onClick={reintentar}>
                <RefreshCw size={13} /> {t("Retry")}
              </button>
            </>
          ) : mio && credits ? (() => {
            // El percentil por rol se satura en 100: con dos jugadores en 100
            // salías «2º de 10» con +36,4 frente a +10,8. Desempata el WPA, que
            // es la cifra de debajo (el backend guarda el puesto igual).
            const puesto =
              [...credits]
                .sort((a, b) => b.role_percentile - a.role_percentile || b.wpa - a.wpa)
                .findIndex((c) => c.participant_id === yo) + 1;
            const partes: [string, number][] = [
              [t("kills"), mio.wpa_kills],
              [t("objectives"), mio.wpa_objectives],
              [t("structures"), mio.wpa_structures],
              [t("deaths"), mio.wpa_deaths],
            ];
            // Todas las barras contra la misma escala: la parte mas grande de
            // esta partida llena medio carril. Escalar cada una por su cuenta
            // haria que una aportacion minuscula pareciera enorme.
            const escala = Math.max(...partes.map(([, v]) => Math.abs(v)), 0.01);
            return (
              <>
                <div className="imp__head">
                  <span
                    className="imp__rank"
                    style={{ color: puesto === 1 ? "var(--win)" : puesto >= 8 ? "var(--loss)" : undefined }}
                  >
                    {/* El "º" es la abreviatura ORDINAL española, y salía
                        igual con la interfaz en inglés ("3º"). */}
                    {puesto === 1 ? t("MVP") : t("#{n}", { n: puesto })}
                  </span>
                  <span className="u-meta">{t("of")} {credits.length}</span>
                  {/* El total va arriba, junto al puesto: es la cifra por la
                      que se ordena, y la fila de «Total» de debajo repetía. */}
                  <span className="imt__score">
                    <span
                      className="u-metric imt__wpa"
                      style={{ color: mio.wpa >= 0 ? "var(--win)" : "var(--loss)" }}
                    >
                      {formatSigned(mio.wpa * 100)}
                    </span>
                    <span className="u-meta">{t("win %")}</span>
                    <span
                      className="u-meta"
                      title={`${t("vs role")}: ${Math.round(mio.role_percentile)} · ${mio.role}`}
                    >
                      · {Math.round(mio.role_percentile)} {t("vs role")}
                    </span>
                  </span>
                </div>
                <p className="note">
                  {t("Win probability you added, and where it came from. The four parts add up to your total.")}
                </p>
                {partes.map(([nombre, v]) => {
                  const ancho = (Math.abs(v) / escala) * 50;
                  const color = v >= 0 ? "var(--win)" : "var(--loss)";
                  return (
                    <div key={nombre} className="imp__row">
                      <span className="imp__rowName">{nombre}</span>
                      <span className="imp__track">
                        <span
                          className="imp__bar"
                          style={{
                            background: color,
                            width: `${ancho}%`,
                            left: v >= 0 ? "50%" : `${50 - ancho}%`,
                          }}
                        />
                      </span>
                      <span className="u-metric imp__rowNum" style={{ color }}>
                        {formatSigned(v * 100)}
                      </span>
                    </div>
                  );
                })}
              </>
            );
          })() : null}
        </section>
      )}

      {/* --------------------------------------- tú contra tu rival */}
      {yoP && rivalP && (
        <section>
          <div className="sect__head">
            <span className="u-label">{t("You vs your opponent")}</span>
            <i className="sect__rule" />
          </div>
          <RivalCard
            me={yoP}
            rival={rivalP}
            participants={participants}
            meCredit={mio}
            rivalCredit={creditOf(rivalIdx + 1)}
            frames={match.minute_frames}
            role={miRol}
            jungle={sameRole(miRol, "JUNGLE")}
            onSeekGame={conVideo ? (g) => seekTo(Math.max(0, g + offset), false) : undefined}
          />
        </section>
      )}

      {/* --------------------------------------- presión absorbida
          Los tramos en los que tuviste más rivales encima que aliados, y
          lo que tu equipo sacó al otro lado del mapa mientras tanto. En un
          marcador esto no existe: si acabas muerto, es "+1 muerte".

          Sólo se muestran los tuyos. Se detectan para los 10, pero los de
          los demás no ayudan a revisar tu partida. */}
      {(pressure !== null || pressureErr !== null) && (
        <section>
          <div className="sect__head">
            <span className="u-label">{t("Pressure you absorbed")}</span>
            <i className="sect__rule" />
          </div>
          {/* El resumen de la partida, en una frase: cuántas veces, cuántas
              acabaste muerto y lo que valió. Morir es lo que decide la
              cuenta, así que va delante del oro. */}
          {hayEpisodios && mios.some((w) => w.value) ? (() => {
            const neto = mios.reduce((a, w) => a + (w.value?.net ?? 0), 0);
            const muertes = mios.filter((w) => w.died || (w.losses ?? []).some((l) => l.kind === "death")).length;
            const gold = formatGold(neto, true);
            const frase = mios.length === 1
              ? t(muertes > 0
                ? "They came for you once and you died. It was worth {gold} gold."
                : "They came for you once and you got out alive. It was worth {gold} gold.", { gold })
              : muertes > 0
                ? t("They came for you {n} times and you died in {d} of them. All together: {gold} gold.", { n: mios.length, d: muertes, gold })
                : t("They came for you {n} times and you always got out alive. All together: {gold} gold.", { n: mios.length, gold });
            return <p className="pe-sum">{frase}</p>;
          })() : (
            <p className="note">{t("When 2 or more enemies come for you: how long you kept them busy and what it was worth in gold.")}</p>
          )}

          {/* Para qué está la franja de cada tarjeta, con tus cifras. */}
          {hayEpisodios && resumen !== undefined && (
            <p className="note imt__help">
              {(() => {
                const g = resumen?.games ?? 0;
                const neto = resumen && g > 0 ? resumen.net_gold / g : 0;
                const sitio = resumen && g > 0 ? resumen.local_gold / g : 0;
                const farmeo = resumen && g > 0 ? resumen.own_farm_lost / g : 0;
                // Sólo se dice que la pelea en el sitio es lo que más resta
                // cuando lo es: con otras cifras, la frase sería falsa.
                return g > 0 && neto < 0 && sitio < 0 && -sitio >= farmeo
                  ? t("Across your {games} games pressure works out at {net} gold per game, and what costs most is the fight where you are ({local} per game). The strip shows the second it was time to let go.", {
                      games: g,
                      net: formatGold(neto, true),
                      local: formatGold(sitio, true),
                    })
                  : t("The strip shows your health and the enemies on you, second by second: when it was time to let go.");
              })()}
            </p>
          )}

          {/* El procesado del vídeo vive aquí: es lo que convierte estos
              tramos de "al menos tanto" en una duración medida. Hecho, no es
              información: queda una línea. Antes se lanzaba solo al entrar,
              sin decirlo y sin poder pararlo; ahora se pide, se ve y se corta.
              El rótulo «Análisis del vídeo» se conserva porque Partida (ruta
              de jungla) manda aquí por ese nombre. */}
          {mmStatus !== null && (mmStatus.state === "hecha" ? (
            <p className="note">
              {t("Positions read from the video: the stretches below are measured, not estimated.")}
            </p>
          ) : (
            <div className="imt__video">
              <span className="u-label">{t("Video analysis")}</span>
              {mmStatus.state === "no_disponible" ? (
                <p className="note">
                  {t("Not available for this game: it needs the video, the detector and the Riot data.")}
                </p>
              ) : mmPct !== null ? (
                <>
                  <div className="mm__bar">
                    <div className="mm__fill" style={{ width: `${Math.max(2, mmPct)}%` }} />
                  </div>
                  <div className="mm__row">
                    <span className="u-metric">{Math.round(mmPct)}%</span>
                    <span className="u-meta">{t("reading the minimap, about two minutes")}</span>
                    <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={pararMinimapa}>
                      {t("Stop")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="note">
                    {t("Without it each stretch is a lower bound: the API only gives one position per minute. Takes about two minutes and can be stopped; what it has done is kept.")}
                  </p>
                  <button className="btn btn--primary btn--sm imt__videoBtn" onClick={empezarMinimapa}>
                    {mmStatus.saved_progress
                      ? `${t("Resume analysis")} (${Math.round(mmStatus.saved_progress)}%)`
                      : t("Analyze the video")}
                  </button>
                </>
              )}
              {mmErr !== null && <p className="note" style={{ color: "var(--loss)" }}>{mmErr}</p>}
            </div>
          ))}

          {/* Tres estados distinguibles: fallo, vacio de verdad, y datos. */}
          {pressureErr !== null && (
            <>
              <p className="note">{t("Couldn't load the pressure stretches: {msg}", { msg: pressureErr })}</p>
              <button className="btn btn--ghost btn--sm" onClick={reintentar}>
                <RefreshCw size={13} /> {t("Retry")}
              </button>
            </>
          )}
          {pressureErr === null && !hayEpisodios && (
            <p className="note">{t("No stretches detected in this game.")}</p>
          )}
          {mios.map((w) => (
            <PressureEpisodeCard
              key={w.participant_id + ":" + w.start}
              window={w}
              gameStart={w.game_start}
              gameEnd={w.game_end}
              matchId={match.id}
              onOpenMap={onOpenMap}
              onSeek={conVideo ? (time) => seekTo(Math.max(0, time - 5), true) : undefined}
              // Un clic en la franja es "enséñame ESTE segundo": un segundo
              // de margen, no los cinco de «Ver episodio».
              onSeekGame={conVideo ? (g) => seekTo(Math.max(0, g + offset - 1), true) : undefined}
            />
          ))}
        </section>
      )}

      {/* --------------------------------------- dónde miraste
          El clic de minimapa lleva posición, así que la pregunta deja de
          ser "¿miraste?" y pasa a ser "¿miraste DÓNDE?". El hueco por
          carril es lo que se corrige jugando: un número global no dice
          hacia qué lado tienes el punto ciego. */}
      {zonas.length > 0 && (() => {
        const CARRILES: Record<string, string> = { top: "Top", mid: "Mid", bot: "Bot" };
        const masMirado = Math.max(...zonas.map((z) => z.per_minute), 0.01);
        const peor = zonas.reduce((a, b) => (b.longest_gap_secs > a.longest_gap_secs ? b : a));
        return (
          <section>
            <div className="sect__head">
              <span className="u-label">{t("Where you looked")}</span>
              <i className="sect__rule" />
            </div>
            <p className="note">
              {t("Your minimap clicks, by lane. The gap is the longest stretch you left that lane unwatched.")}
            </p>
            {zonas.map((z) => {
              // Sólo se marca el PEOR. Con datos reales los tres huecos
              // pasan de dos minutos, así que pintarlos todos de rojo era
              // gritar sin decir cuál corregir.
              const malo = z.key === peor.key && z.longest_gap_secs > 120;
              return (
                <div key={z.key} className="imp__row">
                  <span className="imp__rowName">{t(CARRILES[z.key] ?? z.key)}</span>
                  <span className="imp__track imt__plain">
                    <span
                      className="imp__bar"
                      style={{
                        background: "var(--cool)",
                        width: `${(z.per_minute / masMirado) * 100}%`,
                        left: 0,
                      }}
                    />
                  </span>
                  <span
                    className="u-metric imp__rowNum"
                    style={{ color: malo ? "var(--loss)" : "var(--muted)" }}
                    title={`${z.looks} ${t("looks")} · ${z.per_minute.toFixed(1)}/min`}
                  >
                    {clock(z.longest_gap_secs)}
                  </span>
                </div>
              );
            })}
            <p className="note">
              {t("Longest blind spot")}: {t(CARRILES[peor.key] ?? peor.key)} · {clock(peor.longest_gap_secs)}
            </p>
          </section>
        );
      })()}
    </div>
  );
};
