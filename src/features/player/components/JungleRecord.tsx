import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Play, X } from "lucide-react";
import type { CampClear, JungleRoute, RecordClear } from "../../../core/tauri-ipc";
import { useJungleRecords } from "../useMatchData";
import { champLabel } from "../../../core/matchEvents";
import { matchAge, mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { Button } from "../../../components/ui/Button";
import { campLabel } from "../jungleRoute";
import "./JungleRecord.css";

/**
 * Tu primer clear frente al récord de tu campeón, de la hoja comunitaria de
 * clears de jungla (src-tauri/src/jungle_records.rs: copia local que se
 * refresca cada día).
 *
 * Récord = el clear completo (6 campamentos) más rápido de ese campeón en el
 * parche de la partida o anteriores. Se ponen las dos rutas una encima de la
 * otra y, si es de YouTube, su vídeo se ve aquí mismo, en su segundo de inicio.
 */

type T = ReturnType<typeof useT>;

export const SEIS = ["blue", "gromp", "wolves", "raptors", "red", "krugs"];

/** Tu primera vuelta como pasos: campamentos y vueltas a base, en orden.
 *
 *  Un campamento tarda 2:15 en reaparecer, así que en la primera vuelta cada
 *  uno cae una sola vez. El rastro, en cambio, a veces pisa uno dos veces: el
 *  red queda a la vista camino de los lobos (medido: red 5 s, krugs, red 12 s).
 *  Vale la estancia más larga; la otra es pasar por al lado. */
export function pasosTuyos(r: JungleRoute): string[] {
  const fin = r.first_clear_end;
  if (fin == null || r.clears.length === 0) return [];
  const inicio = r.clears[0].start;
  const mejor = new Map<string, CampClear>();
  for (const c of r.clears) {
    if (c.start > fin) continue;
    const k = `${c.camp}:${c.side}`;
    const previa = mejor.get(k);
    if (!previa || c.end - c.start > previa.end - previa.start) mejor.set(k, c);
  }
  const pasos: { t: number; k: string }[] = [...mejor.values()].map((c) => ({
    t: c.start,
    k: c.camp.startsWith("scuttle") ? "scuttle" : c.side === "enemy" ? `enemy:${c.camp}` : c.camp,
  }));
  for (const b of r.recalls) if (b > inicio && b < fin) pasos.push({ t: b, k: "recall" });
  return pasos.sort((a, b) => a.t - b.t).map((p) => p.k);
}

const etiqueta = (k: string, t: T): string =>
  k === "recall"
    ? t("Recall (short)")
    : k === "scuttle"
      ? t("Scuttle")
      : k.startsWith("enemy:")
        ? t("{camp} (enemy)", { camp: campLabel(k.slice(6), t) })
        : campLabel(k, t);

/** Una ruta como pasos con flechas. También la usa la pantalla Clears. */
export const Pasos: React.FC<{ pasos: string[]; t: T }> = ({ pasos, t }) => (
  <ol className="jrec__path">
    {pasos.map((k, i) => (
      <li key={i} data-k={k === "recall" || k === "scuttle" || k.startsWith("enemy:") ? k.split(":")[0] : undefined}>
        {etiqueta(k, t)}
      </li>
    ))}
  </ol>
);

/** Enlace al vídeo en su segundo (para abrirlo fuera). */
export function enlaceExterno(rec: RecordClear): string {
  if (rec.youtubeId) return `https://www.youtube.com/watch?v=${rec.youtubeId}${rec.startS ? `&t=${rec.startS}s` : ""}`;
  return rec.videoUrl;
}

interface Props {
  route: JungleRoute;
  champion: string;
  /** Parche de la partida ("16.21"); sin él no se filtra por parche. */
  patch: string | null;
}

export const JungleRecord: React.FC<Props> = ({ route: r, champion, patch }) => {
  const t = useT();
  const datos = useJungleRecords(champion, patch);
  const [viendo, setViendo] = useState<RecordClear | null>(null);
  const nombre = champLabel(champion);

  // Cargando: nada (la ruta de arriba ya está a la vista).
  if (datos === undefined) return null;
  const titulo = (
    <div className="mt-sub">
      <span className="u-label">{t("Record clear")}</span>
      <i className="sect__rule" />
    </div>
  );
  if (datos === null || datos.unavailable) {
    return (
      <>
        {titulo}
        <p className="jrec__note">{t("Couldn't download the community sheet of record clears. It will retry on its own.")}</p>
      </>
    );
  }
  const rec = datos.records[0];
  if (!rec) {
    return (
      <>
        {titulo}
        <p className="jrec__note">
          {datos.anyForChampion
            ? t("The community sheet has no full clear of {champ} up to this patch.", { champ: nombre })
            : t("The community sheet has no record clear of {champ} yet.", { champ: nombre })}
        </p>
      </>
    );
  }

  const tuyos = pasosTuyos(r);
  const delta = r.full_clear && r.first_clear_end != null ? Math.round(r.first_clear_end - rec.clearS) : null;
  const ordenTuyo = tuyos.filter((k) => SEIS.includes(k)).join(">");
  const ordenRecord = rec.route.filter((k) => SEIS.includes(k)).join(">");
  const mismoOrden = r.full_clear && ordenTuyo === ordenRecord;
  const mismoInicio = tuyos.length > 0 && rec.route.length > 0 && tuyos[0] === rec.route[0];
  // Si el récord va por otro lado, el más rápido de la hoja con TU ruta (o, si
  // no lo hay, con tu mismo primer campamento): con él se compara de verdad.
  const orden = (route: string[]) => route.filter((k) => SEIS.includes(k)).join(">");
  const parecido =
    tuyos.length > 0 && !mismoOrden
      ? (r.full_clear ? datos.records.find((x) => x !== rec && orden(x.route) === ordenTuyo) : undefined) ??
        (mismoInicio ? undefined : datos.records.find((x) => x !== rec && x.route[0] === tuyos[0]))
      : undefined;
  const parecidoMismaRuta = parecido != null && orden(parecido.route) === ordenTuyo;
  const deltaParecido =
    parecido && r.full_clear && r.first_clear_end != null ? Math.round(r.first_clear_end - parecido.clearS) : null;

  let comparacion: string | null = null;
  if (delta != null) {
    comparacion =
      delta > 0
        ? t("You: {you} · {s} s slower", { you: mmss(r.first_clear_end as number), s: delta })
        : delta < 0
          ? t("You: {you} · {s} s faster", { you: mmss(r.first_clear_end as number), s: -delta })
          : t("You: {you} · same time", { you: mmss(r.first_clear_end as number) });
  } else if (r.first_clear_end != null) {
    comparacion = t("Your first round wasn't a full clear ({n} camps)", { n: r.first_clear_camps });
  }

  const ver = (x: RecordClear) => {
    if (x.youtubeId) setViendo(x);
    else openUrl(enlaceExterno(x)).catch(() => {});
  };

  return (
    <>
      {titulo}
      <div className="jrec">
        <div className="jrec__head">
          <div className="jrec__time">
            <b className="u-metric">{mmss(rec.clearS)}</b>
            <span>
              {[rec.player, t("patch {p}", { p: rec.patch }), rec.smites === 1 ? t("1 smite") : t("{n} smites", { n: rec.smites })]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={rec.youtubeId ? <Play size={13} /> : <ExternalLink size={13} />}
            onClick={() => ver(rec)}
            title={rec.youtubeId ? undefined : t("Opens in your browser")}
          >
            {t("Watch the record")}
          </Button>
        </div>
        {comparacion && <p className="jrec__vs">{comparacion}</p>}

        <dl className="jrec__routes">
          {tuyos.length > 0 && (
            <>
              <dt>{t("You")}</dt>
              <dd>
                <Pasos pasos={tuyos} t={t} />
              </dd>
            </>
          )}
          <dt>{t("Record clear")}</dt>
          <dd>
            <Pasos pasos={rec.route} t={t} />
          </dd>
          {parecido && (
            <>
              <dt>{parecidoMismaRuta ? t("Your same route") : t("Your same start")}</dt>
              <dd className="jrec__alt">
                <Pasos pasos={parecido.route} t={t} />
                <span className="jrec__alt-meta">
                  <b className="u-metric">{mmss(parecido.clearS)}</b>
                  {` · ${parecido.player} · ${t("patch {p}", { p: parecido.patch })}`}
                  {deltaParecido != null &&
                    ` · ${
                      deltaParecido > 0
                        ? t("you, {s} s slower", { s: deltaParecido })
                        : deltaParecido < 0
                          ? t("you, {s} s faster", { s: -deltaParecido })
                          : t("you, same time")
                    }`}
                </span>
                <button type="button" className="jrec__link" onClick={() => ver(parecido)}>
                  {t("Watch")}
                </button>
              </dd>
            </>
          )}
        </dl>
        {tuyos.length > 0 && (
          <p className="jrec__note">
            {mismoOrden
              ? t("Same camp order as the record.")
              : mismoInicio
                ? t("Same start as the record, different order after it.")
                : t("Different start from the record.")}
          </p>
        )}
        {rec.notes && (
          <p className="jrec__note" title={t("Abilities and runes of the record, as the sheet writes them")}>
            {t("Sheet notes: {notes}", { notes: rec.notes })}
          </p>
        )}
        <p className="jrec__src">
          <button type="button" className="jrec__link" onClick={() => openUrl(datos.sheetUrl).catch(() => {})}>
            {t("Community jungle clear sheet")}
          </button>
          {datos.season && ` · ${datos.season}`}
          {datos.updatedMs != null && ` · ${t("updated {when}", { when: matchAge(new Date(datos.updatedMs).toISOString(), t) })}`}
        </p>
      </div>
      {viendo && <VideoRecord rec={viendo} champion={nombre} onClose={() => setViendo(null)} />}
    </>
  );
};

/** El vídeo del récord en un diálogo, con el reproductor de YouTube. */
const VideoRecord: React.FC<{ rec: RecordClear; champion: string; onClose: () => void }> = ({ rec, champion, onClose }) => {
  const t = useT();
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onClose]);
  const src = `https://www.youtube-nocookie.com/embed/${rec.youtubeId}?start=${rec.startS}&autoplay=1&rel=0`;
  const titulo = `${champion} · ${mmss(rec.clearS)} · ${rec.player}`;
  return createPortal(
    <div className="jrec-dlg" onClick={onClose}>
      <div className="jrec-dlg__box" role="dialog" aria-modal="true" aria-label={titulo} onClick={(e) => e.stopPropagation()}>
        <div className="jrec-dlg__head">
          <span className="jrec-dlg__title">{titulo}</span>
          <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />} onClick={() => openUrl(enlaceExterno(rec)).catch(() => {})}>
            {t("Open on YouTube")}
          </Button>
          <button type="button" className="jrec-dlg__close" onClick={onClose} aria-label={t("Close")} title={t("Close")}>
            <X size={18} />
          </button>
        </div>
        <div className="jrec-dlg__frame">
          <iframe
            src={src}
            title={titulo}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>,
    document.body
  );
};
