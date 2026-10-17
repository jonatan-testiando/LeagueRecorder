import React, { useEffect, useRef, useState } from "react";
import { Skull } from "lucide-react";
import { getEpisodeStrip, type EpisodeStrip as StripData } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import "./EpisodeStrip.css";

/**
 * Franja de un episodio de presión: tu vida y los rivales encima, segundo a
 * segundo.
 *
 * Existe por una cifra: en las partidas medidas con vídeo la presión sale
 * negativa por partida y casi todo lo que resta es morir en el sitio. El neto
 * en oro dice que el episodio fue caro, pero no CUÁNDO había que irse; esto sí:
 * se ve el segundo en que llegó el tercer rival con tu vida a la mitad.
 *
 * Dos fuentes que pueden faltar por separado: la vida sale del HUD (la lectura
 * de "Golpes que te comes") y los rivales del minimapa medido. Se dibuja lo que
 * haya y se dice qué falta; si el comando no responde (backend viejo), se dice
 * que no está disponible en vez de romper la tarjeta.
 */
export interface EpisodeStripProps {
  matchId: string;
  /** Tramo en segundos de PARTIDA: el episodio en sí. La franja pide y
   *  enseña además `PRE` s antes y `POST` s después, y sombrea [from, to]. */
  from: number;
  to: number;
  /** Instante actual (partida) para marcarlo en la franja, si se conoce. */
  now?: number;
  /** Saltar a un instante (segundos de PARTIDA). */
  onSeekGame?: (gameSeconds: number) => void;
  /** Versión compacta (dentro del Mapa). */
  compact?: boolean;
}

/** Segundos de antes y de después que se enseñan alrededor del episodio. Sin
 *  el "antes" no se ve llegar a los rivales, que es justo donde se decide. */
const PRE = 6;
const POST = 4;
/** Ancho del viewBox. El SVG se estira en horizontal (preserveAspectRatio
 *  none) y las líneas no engordan gracias a non-scaling-stroke. */
const W = 600;
/** Un hueco sin muestras más largo que esto corta la línea de vida: unir dos
 *  lecturas separadas por diez segundos dibujaría una vida que nadie leyó. */
const HUECO = 1.5;

export const EpisodeStrip: React.FC<EpisodeStripProps> = ({ matchId, from, to, now, onSeekGame, compact }) => {
  const t = useT();
  const a = Math.max(0, from - PRE);
  const b = Math.max(a + 1, to + POST);

  // Se pide al asomar en pantalla, no al montar: en Impacto hay una franja por
  // episodio y cada una lee el HUD y el minimapa de la partida en el backend.
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<StripData | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setData(null);
    setFailed(false);
    getEpisodeStrip(matchId, a, b)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [visible, matchId, a, b]);

  // Alturas en px reales: el SVG mide exactamente H de alto, así que el eje
  // vertical no se deforma y sólo el horizontal se estira.
  const H_HP = compact ? 26 : 38;
  const SEP = 6;
  const H_EN = compact ? 12 : 18;
  const H_AL = compact ? 7 : 10;
  const H = H_HP + SEP + H_EN + H_AL;
  const base = H_HP + SEP + H_EN; // línea entre rivales (arriba) y aliados (abajo)

  const x = (s: number) => ((s - a) / (b - a)) * W;

  const hp = data?.hp ?? [];
  const near = data?.near ?? [];
  const deaths = (data?.deaths ?? []).filter((d) => d >= a && d <= b);

  // Tramos de vida continuos, cortados donde faltan lecturas. Sin memo: son
  // ~4 muestras por segundo de un tramo de medio minuto.
  const hpPaths: { line: string; area: string }[] = [];
  {
    let seg: [number, number][] = [];
    const flush = () => {
      if (seg.length > 1) {
        const pts = seg.map(([s, v]) => `${x(s).toFixed(1)} ${(H_HP - Math.max(0, Math.min(1, v)) * H_HP).toFixed(1)}`);
        const line = `M ${pts.join(" L ")}`;
        hpPaths.push({ line, area: `${line} L ${x(seg[seg.length - 1][0]).toFixed(1)} ${H_HP} L ${x(seg[0][0]).toFixed(1)} ${H_HP} Z` });
      }
      seg = [];
    };
    for (const p of hp) {
      if (p[0] < a || p[0] > b) continue;
      if (seg.length && p[0] - seg[seg.length - 1][0] > HUECO) flush();
      seg.push(p);
    }
    flush();
  }

  // Escala común de rivales y aliados: 3 como mínimo para que "2 encima" no
  // llene la franja, 5 como máximo porque no hay más.
  const maxN = Math.min(5, Math.max(3, ...near.map(([, r, al]) => Math.max(r, al))));

  const nearBars = near
    .filter(([s]) => s >= a && s <= b)
    .map(([s, r, al], i, arr) => {
      const next = arr[i + 1]?.[0] ?? s + 0.5;
      const w = Math.max(0.5, x(Math.min(next, s + 1)) - x(s));
      return { s, w, r, al };
    });

  const sampleAt = <T extends [number, ...number[]]>(rows: T[], s: number): T | null => {
    let best: T | null = null;
    for (const row of rows) {
      if (best === null || Math.abs(row[0] - s) < Math.abs(best[0] - s)) best = row;
    }
    return best && Math.abs(best[0] - s) <= HUECO ? best : null;
  };

  const timeAt = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    return a + f * (b - a);
  };

  const count = (n: number, one: string, many: string) =>
    Math.round(n) === 1 ? t(one) : t(many, { n: Math.round(n) });

  // ---------------------------------------------------------------- estados
  if (failed) {
    return (
      <div ref={hostRef} className="es">
        <p className="es__note">{t("Second by second isn't available for this episode.")}</p>
      </div>
    );
  }
  if (data === null) {
    return (
      <div ref={hostRef} className="es" aria-busy="true">
        <div className="es__wait" style={{ height: H }} />
      </div>
    );
  }
  if (data.status === "no_riot") {
    return (
      <div ref={hostRef} className="es">
        <p className="es__note">{t("Second by second needs the game synced with Riot.")}</p>
      </div>
    );
  }

  const sinVida = hp.length === 0;
  const sinRivales = near.length === 0;
  const avisos = (
    <>
      {sinVida && (
        <p className="es__note">{t("Your health isn't read for this game yet: Match → Hits you take → Read the video.")}</p>
      )}
      {sinRivales && (
        <p className="es__note">{t("Enemies on you need the minimap measured with the video.")}</p>
      )}
    </>
  );
  if (sinVida && sinRivales) {
    return <div ref={hostRef} className="es">{avisos}</div>;
  }

  const hpH = hover !== null ? sampleAt(hp, hover) : null;
  const nearH = hover !== null ? sampleAt(near, hover) : null;

  return (
    <div ref={hostRef} className={`es${compact ? " es--compact" : ""}`}>
      <div className="es__plot">
        <svg
          className="es__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ height: H }}
          data-seek={onSeekGame ? "" : undefined}
          role="img"
          aria-label={t("Your health and the enemies on you, second by second")}
          onPointerMove={(e) => setHover(timeAt(e))}
          onPointerLeave={() => setHover(null)}
          onClick={onSeekGame ? (e) => onSeekGame(timeAt(e)) : undefined}
        >
          {/* El episodio en sí, sobre el antes y el después. */}
          <rect x={x(from)} y={0} width={Math.max(1, x(to) - x(from))} height={H} fill="var(--text)" fillOpacity={0.05} />

          {/* Vida: pista hundida, y encima lo leído del HUD. */}
          <rect x={0} y={0} width={W} height={H_HP} fill="var(--sunken)" fillOpacity={0.55} />
          {hpPaths.map((p, i) => (
            <g key={i}>
              <path d={p.area} fill="var(--cool)" fillOpacity={0.2} />
              <path d={p.line} fill="none" stroke="var(--cool)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          ))}

          {/* Rivales hacia arriba, aliados hacia abajo, desde la misma línea:
              donde el rojo pasa al gris es donde estabas en inferioridad. */}
          {nearBars.map((n, i) => (
            <g key={i}>
              {n.r > 0 && (
                <rect x={x(n.s)} y={base - (Math.min(n.r, maxN) / maxN) * H_EN} width={n.w}
                  height={(Math.min(n.r, maxN) / maxN) * H_EN} fill="var(--loss)" fillOpacity={0.85} />
              )}
              {n.al > 0 && (
                <rect x={x(n.s)} y={base} width={n.w} height={(Math.min(n.al, maxN) / maxN) * H_AL}
                  fill="var(--muted)" fillOpacity={0.35} />
              )}
            </g>
          ))}
          {!sinRivales && (
            <line x1={0} y1={base} x2={W} y2={base} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}

          {deaths.map((d) => (
            <line key={d} x1={x(d)} y1={0} x2={x(d)} y2={H} stroke="var(--loss)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          ))}
          {now !== undefined && now >= a && now <= b && (
            <line x1={x(now)} y1={0} x2={x(now)} y2={H} stroke="var(--brand)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          )}
          {hover !== null && (
            <line x1={x(hover)} y1={0} x2={x(hover)} y2={H} stroke="var(--muted)" strokeDasharray="2 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* La calavera en HTML: dentro del SVG estirado saldría deformada. */}
        {deaths.map((d) => (
          <span key={d} className="es__skull" style={{ left: `${(x(d) / W) * 100}%` }} title={t("Your death")}>
            <Skull size={compact ? 10 : 12} />
          </span>
        ))}
      </div>

      <div className="es__axis">
        <span className="u-time">{clock(a)}</span>
        {hover !== null ? (
          <span className="es__read">
            <span className="u-time">{clock(hover)}</span>
            {hpH && <> · {t("health {p}%", { p: Math.round(hpH[1] * 100) })}</>}
            {nearH && (
              <>
                {" · "}
                <span style={{ color: nearH[1] > 0 ? "var(--loss)" : undefined }}>{count(nearH[1], "1 enemy", "{n} enemies")}</span>
                {" · "}
                {count(nearH[2], "1 ally", "{n} allies")}
              </>
            )}
          </span>
        ) : compact ? (
          <span />
        ) : (
          <span className="es__legend">
            {!sinVida && <span className="es__key"><i className="es__sw es__sw--hp" />{t("Your health")}</span>}
            {!sinRivales && (
              <>
                <span className="es__key"><i className="es__sw es__sw--en" />{t("Enemies on you")}</span>
                <span className="es__key"><i className="es__sw es__sw--al" />{t("Allies near")}</span>
              </>
            )}
          </span>
        )}
        <span className="u-time">{clock(b)}</span>
      </div>
      {avisos}
    </div>
  );
};
