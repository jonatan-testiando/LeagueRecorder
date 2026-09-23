import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import {
  Film, UploadCloud, Check, Copy, ExternalLink, RotateCcw, Heart,
  FolderOpen, PlaySquare, Trash2,
} from "lucide-react";
import { ClipMetadata, MatchMetadata } from "../../../types";
import { deleteClip, getHotkeys, toggleClipFavorite, type UploadProgress } from "../../../core/tauri-ipc";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useToast } from "../../../components/ui/Toaster";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { useT } from "../../../core/LanguageProvider";
import { streamUrl } from "../../../core/media";
import { matchAge } from "../../../core/time";
import { useAppStore, useMatches } from "../../../store/useAppStore";
import "./ClipsGallery.css";

/**
 * Límites de los servicios de subida, en un solo sitio.
 *
 * Estaban repartidos entre dos constantes y una frase escrita a mano ("200 MB
 * (permanent)"), así que cambiar uno de los dos números obligaba a acordarse
 * del tercero. Los valores son los de catbox y litterbox: el enlace permanente
 * admite menos que el temporal, que es lo contrario de lo que se espera y por
 * eso el aviso propone cambiar de opción en vez de solo decir que no cabe.
 */
const UPLOAD_LIMITS = {
  /** catbox.moe: enlace permanente, 200 MB. */
  permanent: 200 * 1024 * 1024,
  /** litterbox: enlace temporal (máx. 72 h), 1 GB. */
  temporary: 1024 * 1024 * 1024,
} as const;

const LIMIT_LABEL = {
  permanent: "200 MB",
  temporary: "1 GB",
} as const;

// "permanent" -> catbox.moe (enlace permanente). El resto -> litterbox (temporal, máx. 72 h).
const EXPIRY_OPTIONS = [
  { value: "72h", label: "Temporary · 72 h" },
  { value: "24h", label: "Temporary · 24 h" },
  { value: "12h", label: "Temporary · 12 h" },
  { value: "1h", label: "Temporary · 1 h" },
  { value: "permanent", label: "Permanent" },
];

const DURATION_MS: Record<string, number> = {
  "1h": 3600e3,
  "12h": 12 * 3600e3,
  "24h": 24 * 3600e3,
  "72h": 72 * 3600e3,
};

// Enlace subido, persistido en localStorage para que sobreviva a recargas de la app.
interface StoredLink {
  url: string;
  expiry: string;
  uploadedAt: number; // ms epoch
}

const LS_KEY = "clipLinks";

/**
 * Alto estimado de una fila: miniatura 16:9 de 256 px (144) más el relleno.
 * La altura real la mide `measureElement`, porque la fila crece con la barra
 * de subida o el aviso de tamaño.
 */
const ROW_ESTIMATE = 166;

type Sort = "newest" | "oldest" | "largest" | "smallest";

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "largest", label: "Largest" },
  { key: "smallest", label: "Smallest" },
];

const expiresAt = (l: StoredLink): number =>
  l.expiry === "permanent" ? Infinity : l.uploadedAt + (DURATION_MS[l.expiry] ?? 0);

// Carga los enlaces guardados, descartando los temporales que ya expiraron.
const loadStoredLinks = (): Record<string, StoredLink> => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed: Record<string, StoredLink> = JSON.parse(raw);
    const now = Date.now();
    const pruned: Record<string, StoredLink> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (expiresAt(v) > now) pruned[k] = v;
    }
    return pruned;
  } catch {
    return {};
  }
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

/**
 * `match_20260813_022120` → milisegundos. Es lo único que fecha un clip: el
 * backend no guarda cuándo se recortó, solo de qué partida salió.
 */
const clipTime = (matchId: string): number => {
  const m = /^match_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(matchId);
  if (!m) return 0;
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  ).getTime() || 0;
};

/**
 * Los clips, en filas como la Biblioteca: miniatura 16:9 que se reproduce ahí
 * mismo, titular a la derecha y chips debajo.
 *
 * El oro es UNO por pantalla: lo lleva la acción de compartir del clip
 * seleccionado (el primero, o el último que tocaste). Las demás filas llevan
 * el mismo botón en superficie — con seis clips a la vista eran seis botones
 * de acción compitiendo.
 */
export const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useT();
  const navigate = useNavigate();
  const [uploading, setUploading] = useState<string | null>(null);
  // Segundos que lleva la subida en curso. Sigue haciendo falta: el primer
  // aviso de progreso puede tardar (el backend abre la conexión antes de
  // empezar a mandar bytes), y hasta que llegue lo honesto es una barra
  // indeterminada con el tiempo transcurrido al lado.
  const [uploadElapsed, setUploadElapsed] = useState(0);
  // Bytes ya enviados del clip en curso, según el evento `clip_upload_progress`.
  // null = todavía no ha llegado ninguno.
  const [uploadProg, setUploadProg] = useState<UploadProgress | null>(null);
  const [links, setLinks] = useState<Record<string, StoredLink>>(() => loadStoredLinks());
  const { showSuccess, showError, showConfirm } = useDialog();
  const { toast } = useToast();
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  // Fila seleccionada: la que lleva la acción de oro. null = la primera.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // La tecla del replay, para decirla en el estado vacío.
  const [replayKey, setReplayKey] = useState<string>("");

  // La biblioteca, para poder decir de qué partida salió cada clip con algo que
  // se pueda leer (campeón y fecha) en vez del id de la carpeta.
  const { matches } = useMatches();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);

  // OJO: todos los hooks van aquí arriba, antes de los `return` de "cargando" y
  // "sin clips". Declararlos después haría que el número de hooks cambiara entre
  // renders y React abortaría con "Rendered more hooks than during the previous render".
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const matchById = useMemo(() => {
    const map = new Map<string, MatchMetadata>();
    for (const m of matches) map.set(m.id, m);
    return map;
  }, [matches]);

  const favCount = useMemo(() => clips.filter((c) => c.favorite).length, [clips]);
  const totalBytes = useMemo(() => clips.reduce((n, c) => n + c.size, 0), [clips]);

  const visible = useMemo(() => {
    const list = onlyFavorites ? clips.filter((c) => c.favorite) : clips;
    const out = [...list];
    switch (sort) {
      case "largest": out.sort((a, b) => b.size - a.size); break;
      case "smallest": out.sort((a, b) => a.size - b.size); break;
      case "oldest": out.sort((a, b) => clipTime(a.match_id) - clipTime(b.match_id)); break;
      default: out.sort((a, b) => clipTime(b.match_id) - clipTime(a.match_id)); break;
    }
    return out;
  }, [clips, onlyFavorites, sort]);

  // La seleccionada tiene que estar a la vista: si el filtro la deja fuera,
  // pasa a serlo la primera.
  const selectedIndex = useMemo(() => {
    const i = selectedPath ? visible.findIndex((c) => c.path === selectedPath) : -1;
    return i >= 0 ? i : visible.length > 0 ? 0 : -1;
  }, [visible, selectedPath]);

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    // Estimación inicial; la altura real de cada fila se mide con `measureElement`,
    // porque la fila cambia de alto según el estado (barra de subida, aviso de
    // tamaño excedido...).
    estimateSize: () => ROW_ESTIMATE,
    overscan: 4,
  });

  // Mismo bug que la biblioteca: la ruta se oculta con display:none sin
  // desmontarse y el virtualizador cachea medidas a 0. Al reaparecer, se
  // remide — y los elementos que siguieron montados se remiden a mano,
  // porque measure() solo limpia la caché y su observer interno ya disparó.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let anchoPrevio = 0;
    const medir = () => {
      const w = el.clientWidth;
      if (anchoPrevio === 0 && w > 0) {
        rowVirtualizer.measure();
        requestAnimationFrame(() => {
          el.querySelectorAll("[data-index]").forEach((n) =>
            rowVirtualizer.measureElement(n as HTMLElement)
          );
        });
      }
      anchoPrevio = w;
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, clips.length, visible.length > 0]);

  // Al reordenar o filtrar, cada índice pasa a contener otro clip: las alturas
  // medidas antes ya no valen.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [sort, onlyFavorites, rowVirtualizer]);

  // Persistir los enlaces cada vez que cambian para que sobrevivan a recargas.
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(links));
  }, [links]);

  /**
   * Progreso real de la subida en curso.
   *
   * Se filtra por ruta porque el evento es global y puede haber más de una
   * subida viva; `total` viaja en cada aviso, así que entrar a mitad basta
   * para pintar el porcentaje.
   */
  useEffect(() => {
    if (!uploading) { setUploadProg(null); return; }
    let vivo = true;
    let quitar: (() => void) | null = null;
    listen<UploadProgress>("clip_upload_progress", (e) => {
      if (e.payload && e.payload.path === uploading) setUploadProg(e.payload);
    })
      .then((f) => { if (vivo) quitar = f; else f(); })
      .catch(console.error);
    return () => {
      vivo = false;
      if (quitar) quitar();
      setUploadProg(null);
    };
  }, [uploading]);

  // Cronómetro de la subida en curso.
  useEffect(() => {
    if (!uploading) { setUploadElapsed(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setUploadElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [uploading]);

  const fetchClips = async () => {
    try {
      const result = await invoke<ClipMetadata[]>("get_all_clips");
      setClips(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClips();
    getHotkeys().then((h) => setReplayKey(h.replay)).catch(() => {});
  }, []);

  const copyLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(link);
    setTimeout(() => setCopied(c => (c === link ? null : c)), 1500);
  };

  const handleUpload = async (clip: ClipMetadata) => {
    const exp = expiry[clip.path] ?? "72h";
    setUploading(clip.path);
    try {
      const url = await invoke<string>("upload_clip", { path: clip.path, expiry: exp });
      setLinks(prev => ({ ...prev, [clip.path]: { url, expiry: exp, uploadedAt: Date.now() } }));
      showSuccess(t("Clip uploaded. The link is on your clipboard."));
      await copyLink(url);
    } catch (e) {
      console.error(e);
      showError(t("Couldn't upload the clip: {msg}", { msg: String(e) }));
    } finally {
      setUploading(null);
    }
  };

  const clearLink = (path: string) => {
    setLinks(prev => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  const handleToggleFavorite = async (clipPath: string) => {
    try {
      const isFav = await toggleClipFavorite(clipPath);
      setClips(clips.map(c => c.path === clipPath ? { ...c, favorite: isFav } : c));
    } catch (err) {
      showError(t("Couldn't change the favourite: {msg}", { msg: String(err) }));
    }
  };

  /**
   * Borra el recorte del disco.
   *
   * Se pide confirmación porque no hay papelera: el backend borra el .mp4 y su
   * JSON de al lado. El enlace guardado se olvida a la vez — dejarlo apuntando
   * a un fichero que ya no está era ofrecer "Re-subir" de algo inexistente.
   */
  const handleDelete = async (clip: ClipMetadata) => {
    const ok = await showConfirm({
      title: t("Delete clip"),
      message: t("This clip is deleted for good. The game it came from is not touched."),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteClip(clip.path);
      setClips((prev) => prev.filter((c) => c.path !== clip.path));
      clearLink(clip.path);
    } catch (e) {
      toast({
        title: t("Couldn't delete the clip"),
        body: String(e),
        tone: "danger",
      });
    }
  };

  const handleReveal = async (clip: ClipMetadata) => {
    try {
      await revealItemInDir(clip.path);
    } catch (err) {
      showError(t("Couldn't open the folder: {msg}", { msg: String(err) }));
    }
  };

  /** Abre la partida de origen en el reproductor, igual que hace la biblioteca. */
  const openMatch = (match: MatchMetadata) => {
    setSelectedMatch(match);
    navigate("/review");
  };

  const formatRemaining = (ms: number): string => {
    const h = Math.floor(ms / 3600e3);
    if (h >= 1) return t("Expires in ~{h} h", { h });
    const m = Math.max(1, Math.floor(ms / 60e3));
    return t("Expires in ~{m} min", { m });
  };

  if (loading) {
    return (
      <div className="cg panel-enter">
        <div className="cg-center">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (clips.length === 0) {
    return (
      <div className="cg panel-enter">
        <div className="cg__head">
          <h1>{t("Clips")}</h1>
        </div>
        <div className="cg-center">
          <EmptyState
            icon={<Film size={30} color="var(--faint)" />}
            title={t("No clips yet")}
            text={t("Your best plays will live here. Clip a moment from the player, or save the last 30 seconds while a game is recording.")}
            action={
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                {/* La pantalla vacía lleva a donde se hacen los clips. */}
                <Button variant="primary" size="md" icon={<PlaySquare size={15} />} onClick={() => navigate("/review")}>
                  {t("Go to the Library")}
                </Button>
                {replayKey && (
                  <span className="u-meta" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {t("Save replay")}
                    <kbd className="u-kbd">{replayKey}</kbd>
                  </span>
                )}
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="cg panel-enter">
      <div className="cg__head">
        <h1>{t("Clips")}</h1>
        <span className="cg__count">
          {clips.length} {t(clips.length === 1 ? "clip" : "clips")} · {formatSize(totalBytes)}
        </span>
      </div>

      <div className="cg__tools">
        <div className="cg-seg" role="group" aria-label={t("Filter clips")}>
          <button type="button" aria-pressed={!onlyFavorites} onClick={() => setOnlyFavorites(false)}>
            {t("All clips")} <span className="cg-seg__n">{clips.length}</span>
          </button>
          <button type="button" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(true)}>
            <Heart size={13} fill={onlyFavorites ? "currentColor" : "transparent"} />
            {t("Favourites")} <span className="cg-seg__n">{favCount}</span>
          </button>
        </div>
        <span className="cg__spacer" />
        <span className="cg__toolLabel">{t("Sort")}</span>
        <div className="cg-seg" role="group" aria-label={t("Sort")}>
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="cg-center">
          <EmptyState
            icon={<Heart size={30} color="var(--faint)" />}
            title={t("No favourite clips yet")}
            text={t("Mark a clip with the heart and it shows up here.")}
            action={
              <Button variant="ghost" size="sm" onClick={() => setOnlyFavorites(false)}>
                {t("Show all clips")}
              </Button>
            }
          />
        </div>
      ) : (
      /* El scroll vive aquí y no en el contenedor: el virtualizador posiciona los
         items relativos a este div, así que si el elemento con scroll fuera el de
         fuera, la cabecera desplazaría todas las filas. */
      <div className="cg__list" ref={scrollRef}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const clip = visible[virtualRow.index];
          if (!clip) return null;
          const stored = links[clip.path];
          const isUploading = uploading === clip.path;
          const exp = expiry[clip.path] ?? "72h";
          const isPermanent = exp === "permanent";
          const kind = isPermanent ? "permanent" : "temporary";
          const tooBig = clip.size > UPLOAD_LIMITS[kind];
          const remaining = stored ? expiresAt(stored) - Date.now() : 0;
          const match = matchById.get(clip.match_id);
          const isSelected = virtualRow.index === selectedIndex;
          // El filo de debajo se esconde junto a la seleccionada (arriba y abajo).
          const hideDivider =
            isSelected || virtualRow.index === selectedIndex - 1 || virtualRow.index === visible.length - 1;

          return (
            <div
              key={clip.path}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {/* Tocar cualquier cosa de la fila (el vídeo, un botón, el
                  selector) la selecciona: no hace falta un clic aparte. */}
              <div
                className="cg-row"
                {...(isSelected ? { "data-selected": true } : {})}
                {...(hideDivider ? { "data-nodivider": true } : {})}
                onPointerDown={() => setSelectedPath(clip.path)}
                onFocusCapture={() => setSelectedPath(clip.path)}
              >
                <div className="cg-thumb">
                  <video src={streamUrl(clip.path)} controls preload="metadata" />
                </div>

                <div className="cg-body">
                  <div className="cg-top">
                    <div className="cg-top__text">
                      <span className="cg-title" title={clip.name}>{clip.name}</span>
                      {/* Era "De: match_20260813_022120", o sea el nombre de la
                          carpeta. Lo que ubica un clip es de qué partida salió. */}
                      <span className="cg-meta" title={clip.match_id}>
                        {match && <ChampionAvatar champion={match.champion} size={20} />}
                        <span>
                          {match
                            ? t("From {champion} · {date}", { champion: match.champion, date: matchAge(match.date, t) })
                            : t("From {id}", { id: clip.match_id })}
                        </span>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="cg-fav"
                      aria-pressed={clip.favorite}
                      onClick={() => handleToggleFavorite(clip.path)}
                      title={clip.favorite ? t("Remove from favourites") : t("Add to favourites")}
                      aria-label={clip.favorite ? t("Remove from favourites") : t("Add to favourites")}
                    >
                      <Heart size={16} fill={clip.favorite ? "currentColor" : "transparent"} />
                    </button>
                  </div>

                  <div className="cg-chips">
                    <Badge tone="neutral" emphasis="solid">{formatSize(clip.size)}</Badge>
                    {stored && (
                      <Badge tone="win" emphasis="solid">
                        {stored.expiry === "permanent" ? t("Permanent link") : formatRemaining(remaining)}
                      </Badge>
                    )}
                  </div>

                  <div className="cg-actions">
                    {match && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<PlaySquare size={14} />}
                        onClick={() => openMatch(match)}
                        title={t("Open the game this clip came from")}
                      >
                        {t("Open match")}
                      </Button>
                    )}
                    <Button
                      variant="icon"
                      size="sm"
                      icon={<FolderOpen size={15} />}
                      title={t("Reveal in folder")}
                      aria-label={t("Reveal in folder")}
                      onClick={() => handleReveal(clip)}
                    />
                    <Button
                      variant="icon"
                      size="sm"
                      icon={<Trash2 size={15} />}
                      title={t("Delete clip")}
                      aria-label={t("Delete clip")}
                      onClick={() => handleDelete(clip)}
                    />

                    <div className="cg-actions__end">
                      {stored ? (
                        <>
                          <div className="cg-link">
                            <input
                              readOnly
                              value={stored.url}
                              aria-label={t("Share link")}
                              onFocus={(e) => e.target.select()}
                            />
                            <button
                              type="button"
                              onClick={() => openUrl(stored.url)}
                              title={t("Open in browser")}
                              aria-label={t("Open in browser")}
                            >
                              <ExternalLink size={14} />
                            </button>
                          </div>
                          <Button
                            variant={isSelected ? "primary" : "ghost"}
                            size="sm"
                            icon={copied === stored.url ? <Check size={14} /> : <Copy size={14} />}
                            onClick={() => copyLink(stored.url)}
                          >
                            {t("Copy link")}
                          </Button>
                          <Button
                            variant="icon"
                            size="sm"
                            icon={<RotateCcw size={14} />}
                            onClick={() => clearLink(clip.path)}
                            title={t("Generate a new link")}
                            aria-label={t("Re-upload")}
                          />
                        </>
                      ) : (
                        <>
                          <select
                            className="cg-select"
                            value={exp}
                            disabled={isUploading}
                            onChange={(e) => setExpiry(prev => ({ ...prev, [clip.path]: e.target.value }))}
                            aria-label={t("How long the link lasts")}
                            title={t("How long the link lasts")}
                          >
                            {EXPIRY_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{t(o.label)}</option>
                            ))}
                          </select>
                          <Button
                            variant={isSelected ? "primary" : "ghost"}
                            size="sm"
                            disabled={isUploading || tooBig}
                            icon={
                              isUploading
                                ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                : <UploadCloud size={14} />
                            }
                            onClick={() => handleUpload(clip)}
                          >
                            {isUploading ? t("Uploading…") : t("Upload & share")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Con progreso del backend, barra de verdad con los MB. Sin
                      él todavía (los primeros segundos son handshake), la
                      indeterminada con el tiempo que lleva: una barra que
                      avanza sola sería una mentira útil, pero mentira. */}
                  {isUploading && (
                    uploadProg && uploadProg.total > 0 ? (
                      <div className="cg-progress">
                        <span className="cg-progress__track">
                          <span
                            className="cg-progress__fill"
                            style={{ width: `${Math.min(100, (100 * uploadProg.sent) / uploadProg.total)}%` }}
                          />
                        </span>
                        <span>
                          {t("{pct}% · {sent} of {total} MB", {
                            pct: Math.floor((100 * uploadProg.sent) / uploadProg.total),
                            sent: (uploadProg.sent / 1024 / 1024).toFixed(1),
                            total: (uploadProg.total / 1024 / 1024).toFixed(1),
                          })}
                        </span>
                      </div>
                    ) : (
                      <div className="cg-progress">
                        <span className="cg-progress__track">
                          <span className="cg-progress__fill cg-progress__fill--pulse" />
                        </span>
                        <span>{t("{s}s elapsed", { s: uploadElapsed })}</span>
                      </div>
                    )
                  )}
                  {!stored && tooBig && (
                    <p className="cg-warn">
                      {isPermanent
                        ? t("Over the {limit} limit of the permanent link. Pick a temporary one.", { limit: LIMIT_LABEL.permanent })
                        : t("Over the {limit} limit. Clip a shorter moment.", { limit: LIMIT_LABEL.temporary })}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
};
