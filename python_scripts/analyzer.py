import cv2
import numpy as np
import sys
import json
import os
import math
import statistics

# ------------------ CONFIGURACIÓN (TUNABLES) ------------------
# Todos ajustables por variable de entorno sin recompilar nada. Antes estaban
# repartidos como "números mágicos" por el código.
def _envf(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

def _envi(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

# FPS objetivo del análisis (estela). 30 = comportamiento original.
# Bajarlo (p.ej. 20) acelera el análisis a costa de una estela algo menos fluida.
TARGET_FPS         = _envf("VOD_TARGET_FPS", 30.0)
# Confianza mínima para aceptar una coincidencia de cursor.
MATCH_THRESHOLD    = _envf("VOD_MATCH_THRESHOLD", 0.85)
# Por debajo de esto re-escaneamos toda la librería de cursores.
RESCAN_THRESHOLD   = _envf("VOD_RESCAN_THRESHOLD", 0.88)
# Coincidencia "lo bastante buena" para cortar el re-escaneo antes.
EARLY_EXIT_MATCH   = _envf("VOD_EARLY_EXIT", 0.95)
# Anti-spam de clics (en frames analizados).
COOLDOWN_FRAMES    = _envi("VOD_COOLDOWN_FRAMES", 8)
# Píxeles brillantes mínimos para considerar "explosión de color" de un clic.
BRIGHT_PIXELS_MIN  = _envi("VOD_BRIGHT_PIXELS", 30)
# Radio de búsqueda alrededor del último punto conocido.
SEARCH_PADDING     = _envi("VOD_SEARCH_PADDING", 150)
# Rechazo de "teletransportes": si el cursor salta más que esto (px) entre dos
# frames y la confianza no es altísima, lo tratamos como falso positivo.
TELEPORT_MAX_JUMP  = _envf("VOD_TELEPORT_JUMP", 600.0)
TELEPORT_TRUST     = _envf("VOD_TELEPORT_TRUST", 0.93)
# Cuando perdemos el rastro, el escaneo global a pantalla completa es caro.
# Solo lo reintentamos cada N frames analizados (backoff) para no quemar CPU en
# tramos de menú/cinemática sin cursor.
GLOBAL_SEARCH_STRIDE = _envi("VOD_GLOBAL_STRIDE", 2)
# Predicción inercial ("coasting"): si perdemos el cursor en ROI, predecimos su
# posición por velocidad y seguimos buscando en ROI estos frames antes de caer a
# la costosa búsqueda global. Reduce huecos por VFX brillantes y acelera. 0 = off.
GRACE_FRAMES = _envi("VOD_GRACE_FRAMES", 4)

# ------------------ MEJORAS DE DETECCIÓN ------------------
# Método de matching. 'sqdiff' (TM_SQDIFF_NORMED) es más robusto frente a zonas
# brillantes (VFX de peleas) que el 'ccorr' clásico, que tiende a falsos positivos.
def _match_method():
    m = os.environ.get("VOD_MATCH_METHOD", "ccorr").strip().lower()
    if m in ("sqdiff", "sqdiff_normed"):
        return cv2.TM_SQDIFF_NORMED, True   # (método, menor_es_mejor)
    return cv2.TM_CCORR_NORMED, False
MATCH_CV_METHOD, MATCH_LOWER_BETTER = _match_method()

# Usar máscara de transparencia es MUY lento en OpenCV y anula casi toda
# la aceleración por GPU. Ponerlo a 0 acelera el escaneo x4, pero ROMPE
# la precisión si el fondo no es negro. Lo dejamos a 1 por defecto.
USE_MASK = os.environ.get("VOD_USE_MASK", "1").strip().lower() not in ("0", "", "false", "no")

# Escalas de template a probar (multi-escala). Crucial cuando el VOD no está a la
# misma resolución/DPI que los cursores base (p.ej. metraje 1440p). "1.0" = original.
def _parse_scales():
    raw = os.environ.get("VOD_SCALES", "1.0")
    out = []
    for p in raw.split(","):
        p = p.strip()
        if not p:
            continue
        try:
            v = float(p)
            if v > 0:
                out.append(v)
        except ValueError:
            pass
    return out or [1.0]
SCALES = _parse_scales()

# Modo diagnóstico: emite un resumen de métricas (METRICS:{...}) por stderr para
# poder comparar configuraciones de forma objetiva sobre el mismo VOD.
DIAGNOSTIC = os.environ.get("VOD_DIAGNOSTIC", "0").strip().lower() not in ("0", "", "false", "no")


def match_score(search_umat, t_bgr, t_mask):
    """Devuelve (score, loc) con score en [0..1] donde MÁS ALTO = MEJOR,
    sea cual sea el método configurado. Unifica CCORR (max) y SQDIFF (min)."""
    if USE_MASK:
        res = cv2.matchTemplate(search_umat, t_bgr, MATCH_CV_METHOD, mask=t_mask)
    else:
        res = cv2.matchTemplate(search_umat, t_bgr, MATCH_CV_METHOD)
        
    res_cpu = res.get() if hasattr(res, 'get') else res
    if MATCH_LOWER_BETTER:
        # SQDIFF enmascarado puede dar NaN/inf en bordes: solo entonces limpiamos.
        res_cpu = np.nan_to_num(res_cpu, nan=1.0, posinf=1.0, neginf=0.0)
        min_v, _, min_l, _ = cv2.minMaxLoc(res_cpu)
        return (1.0 - min_v), min_l
    _, max_v, _, max_l = cv2.minMaxLoc(res_cpu)
    return max_v, max_l


def load_template(path):
    # Leer imagen con canal alfa
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None, None
        
    # Recortar los bordes transparentes para hacer el template más pequeño y rápido
    if img.shape[2] == 4:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
        
        # Encontrar los límites de la parte no transparente
        y_indices, x_indices = np.where(alpha > 0)
        if len(y_indices) == 0 or len(x_indices) == 0:
            return bgr, alpha
            
        y_min, y_max = y_indices.min(), y_indices.max()
        x_min, x_max = x_indices.min(), x_indices.max()
        
        bgr_cropped = bgr[y_min:y_max+1, x_min:x_max+1]
        alpha_cropped = alpha[y_min:y_max+1, x_min:x_max+1]
        return bgr_cropped, alpha_cropped
        
    return img, None

def analyze(video_path, cursors_dir=None):
    # Activar Aceleración por GPU (OpenCL Transparente)
    cv2.ocl.setUseOpenCL(True)

    # El directorio de cursores llega por argumento (robusto al empaquetado).
    # Si no, caemos a la ruta relativa al script (modo desarrollo).
    if not cursors_dir or not os.path.isdir(cursors_dir):
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cursors_dir = os.path.join(base_dir, "assets", "cursors")
    sys.stderr.write(f"[INFO] Usando cursores en: {cursors_dir}\n")
    sys.stderr.flush()

    # Cargar las diferentes variantes de cursor (base y upscaled)
    target_files = [
        # (filename, event_type, hotspot_x, hotspot_y)
        ("hand1.png", "move", 9, 9),
        ("hand2.png", "move", 9, 9),
        ("hoverenemy.png", "attack", 2, 2),
        ("hover_precise.png", "move", 24, 24),
        ("hover_enemy_precise_colorblind.png", "attack", 24, 24)
    ]
    
    templates = []        # Para el seguimiento por ROI (multi-escala)
    templates_half = []   # Para el escaneo global (media resolución, escala única)
    for fname, evt_type, h_x, h_y in target_files:
        for folder in [cursors_dir, os.path.join(cursors_dir, "upscaled")]:
            path = os.path.join(folder, fname)
            if os.path.exists(path):
                b, m = load_template(path)
                if b is not None:
                    # Multi-escala: una variante por cada escala configurada. El
                    # hotspot escala igual. Así toleramos cursores más grandes/pequeños
                    # que el template (resoluciones/DPI distintos, p.ej. 1440p).
                    for s in SCALES:
                        if abs(s - 1.0) < 1e-6:
                            bs, ms = b, m
                        else:
                            interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_LINEAR
                            bs = cv2.resize(b, (0, 0), fx=s, fy=s, interpolation=interp)
                            ms = cv2.resize(m, (0, 0), fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
                        templates.append((cv2.UMat(bs), cv2.UMat(ms), evt_type, h_x * s, h_y * s))

                    # Versión pequeña (escala única) para el Escaneo Global Ultrarápido
                    b_half = cv2.resize(b, (0,0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
                    m_half = cv2.resize(m, (0,0), fx=0.5, fy=0.5, interpolation=cv2.INTER_NEAREST)
                    templates_half.append((cv2.UMat(b_half), cv2.UMat(m_half), evt_type, h_x/2.0, h_y/2.0))

    sys.stderr.write(f"[INFO] Método: {'sqdiff' if MATCH_LOWER_BETTER else 'ccorr'} | escalas: {SCALES} | "
                     f"templates ROI: {len(templates)} | global: {len(templates_half)}\n")
    sys.stderr.flush()
    
    # ------------------ UMBRALES DE COLOR (HSV) ------------------
    # Definimos los rangos de color de las partículas del juego
    # Verde fluorescente (clic de movimiento normal)
    lower_green = np.array([40, 150, 150])
    upper_green = np.array([85, 255, 255])
    
    # Cian / Azul Claro (clic de movimiento modo daltónico)
    lower_cyan = np.array([85, 150, 150])
    upper_cyan = np.array([105, 255, 255])
    
    # Rojo Intenso y Naranja Fuerte (clic de ataque normal y daltónico)
    # El rojo en HSV cruza el valor 0, así que necesitamos dos rangos (rojo bajo y rojo alto)
    lower_red1 = np.array([0, 180, 180])
    upper_red1 = np.array([15, 255, 255])
    lower_red2 = np.array([165, 180, 180])
    upper_red2 = np.array([180, 255, 255])
    
    # Contador anti-spam (debounce). COOLDOWN_FRAMES viene de la config global.
    frames_since_last_click = 0

    # ------------------ TRACKING INERCIAL ------------------
    prev_x, prev_y = -1, -1
    velocities = []

    # ------------------ MÉTRICAS DE DIAGNÓSTICO ------------------
    frames_analyzed = 0
    frames_tracked = 0
    track_losses = 0
    n_clicks = 0
    confidences = []

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"events": [], "duration": 0.0, "width": 0, "height": 0}))
        return
        
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0: fps = 30.0
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sys.stderr.write(f"Iniciando analisis... Total frames: {total_frames}\n")
    
    # Imprimir info de diagnóstico de GPU
    has_ocl = cv2.ocl.haveOpenCL()
    uses_ocl = cv2.ocl.useOpenCL()
    sys.stderr.write(f"[HARDWARE] Aceleracion GPU Activa: {uses_ocl}\n")
    if uses_ocl:
        try:
            device = cv2.ocl.Device.getDefault()
            sys.stderr.write(f"[HARDWARE] Dispositivo: {device.name()} ({device.vendorName()})\n")
        except:
            pass
            
    sys.stderr.flush()
    
    # Asumimos resoluciones similares, o podemos escalar la imagen
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    events = []
    frame_count = 0
    
    # Submuestreo a TARGET_FPS para la estela (30 = comportamiento original).
    skip_frames = max(1, int(round(fps / TARGET_FPS)))

    last_loc = None
    last_best_template_idx = 0 # Sticky Template Index
    lost_frames = 0            # frames analizados consecutivos sin rastro (para el backoff)
    last_vel = (0.0, 0.0)      # velocidad estimada para la predicción inercial
    grace_left = 0             # frames de "coasting" restantes antes de declarar pérdida

    while True:
        # Usar grab() para saltar frames MUCHO más rápido sin decodificarlos
        ret = cap.grab()
        if not ret:
            break
            
        frame_count += 1
        if frame_count % skip_frames != 0:
            continue
            
        # Decodificar solo el frame que necesitamos
        ret, frame = cap.retrieve()
        if not ret:
            continue
            
        time_sec = frame_count / fps

        # Backoff del escaneo global: cuando hemos perdido el rastro, el barrido a
        # pantalla completa es lo más caro del análisis. En tramos sin cursor
        # (menús, cinemáticas) solo lo reintentamos cada GLOBAL_SEARCH_STRIDE
        # frames en vez de en todos, recortando mucho el tiempo total.
        if last_loc is None:
            lost_frames += 1
            # Intentamos en el 1.er frame perdido y luego cada STRIDE (así no se
            # retrasa la adquisición inicial, pero sí se aligeran los tramos largos
            # sin cursor).
            if GLOBAL_SEARCH_STRIDE > 1 and ((lost_frames - 1) % GLOBAL_SEARCH_STRIDE) != 0:
                continue

        frames_analyzed += 1

        # Determinar el área de búsqueda (ROI - Region Of Interest)
        roi_offset_x = 0
        roi_offset_y = 0

        is_global_search = False
        if last_loc is not None:
            lx, ly = int(last_loc[0]), int(last_loc[1])
            # Crear un cuadro de búsqueda delimitado a los bordes de la pantalla
            x_min = max(0, lx - SEARCH_PADDING)
            y_min = max(0, ly - SEARCH_PADDING)
            x_max = min(frame_width, lx + 50 + SEARCH_PADDING)
            y_max = min(frame_height, ly + 50 + SEARCH_PADDING)
            
            search_frame = frame[y_min:y_max, x_min:x_max]
            roi_offset_x = x_min
            roi_offset_y = y_min
            search_frame_umat = cv2.UMat(search_frame)
            active_templates = templates
        else:
            # Scaled Global Search: Buscar a mitad de tamaño es 4x más rápido matemáticamente
            is_global_search = True
            frame_half = cv2.resize(frame, (0,0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
            search_frame_umat = cv2.UMat(frame_half)
            active_templates = templates_half
            search_frame = frame
        
        # --- FASE 1: STICKY TEMPLATE MATCHING ---
        # Solo comparamos con el cursor que estaba activo en el frame anterior.
        # El índice sticky se comparte entre las listas ROI/global (de distinto
        # tamaño con multi-escala): lo acotamos para no salirnos de rango.
        sticky_idx = last_best_template_idx if last_best_template_idx < len(active_templates) else 0
        t_bgr, t_mask, t_type, h_x, h_y = active_templates[sticky_idx]
        best_val, best_loc = match_score(search_frame_umat, t_bgr, t_mask)
        best_type = t_type
        best_hotspot = (h_x, h_y)
        last_best_template_idx = sticky_idx

        # --- FASE 2: CLASIFICACIÓN (Solo si el cursor cambió de forma o perdimos calidad) ---
        # Si la similitud cae por debajo del umbral de re-escaneo, recorremos toda la
        # librería de cursores (incluyendo todas las escalas).
        if best_val < RESCAN_THRESHOLD:
            best_val = 0
            for i, (t_bgr, t_mask, t_type, h_x, h_y) in enumerate(active_templates):
                if i == sticky_idx:
                    continue # Ya lo probamos

                mv, ml = match_score(search_frame_umat, t_bgr, t_mask)

                if mv > best_val:
                    best_val = mv
                    best_loc = ml
                    best_type = t_type
                    best_hotspot = (h_x, h_y)
                    last_best_template_idx = i # Memorizar el nuevo cursor/escala

                # Optimización matemática: Si hallamos una coincidencia altísima
                if best_val > EARLY_EXIT_MATCH:
                    break
                
        if is_global_search:
            # Restaurar la coordenada encontrada a la escala de video nativo 1080p/1440p
            best_loc = (int(best_loc[0] * 2), int(best_loc[1] * 2))
            best_hotspot = (int(best_hotspot[0] * 2), int(best_hotspot[1] * 2))
        
        # Umbral estricto para evitar falsos positivos
        if best_val > MATCH_THRESHOLD:
            # Reajustar coordenadas si estábamos usando un recorte pequeño
            real_x = float(best_loc[0]) + roi_offset_x
            real_y = float(best_loc[1]) + roi_offset_y

            # Rechazo de "teletransportes": en seguimiento continuo (no global),
            # si el cursor salta una distancia inverosímil y la confianza no es
            # altísima, lo tratamos como falso positivo y soltamos el rastro.
            if last_loc is not None and not is_global_search and best_val < TELEPORT_TRUST:
                jump = math.hypot(real_x - last_loc[0], real_y - last_loc[1])
                if jump > TELEPORT_MAX_JUMP:
                    last_loc = None
                    lost_frames = 0
                    track_losses += 1
                    continue

            # Métrica: frame con rastro válido aceptado
            frames_tracked += 1
            confidences.append(best_val)

            # --- 2. DETECCIÓN HSV (EXPLOSIÓN DE COLOR PARA CLICS) ---
            # En lugar de usar toda la pantalla, aplicamos el filtro de color
            # SOLO en un cuadrado muy pequeño debajo de la punta del cursor
            
            # Coordenadas donde se dibuja el evento visual del click
            click_x = int(real_x + best_hotspot[0])
            click_y = int(real_y + best_hotspot[1])
            
            # Recortamos 60x60 píxeles alrededor de la punta del cursor (HotSpot)
            cy1 = max(0, click_y - 30)
            cy2 = min(frame.shape[0], click_y + 30)
            cx1 = max(0, click_x - 30)
            cx2 = min(frame.shape[1], click_x + 30)
            
            particle_roi = frame[cy1:cy2, cx1:cx2]

            evt_to_register = "move"

            # Cooldown anti-spam: se incrementa UNA sola vez por frame aceptado,
            # pase lo que pase con el ROI de partículas. (Antes se incrementaba dos
            # veces, lo que reducía el debounce efectivo a la mitad.)
            frames_since_last_click += 1

            if particle_roi.size > 0:
                particle_roi_umat = cv2.UMat(particle_roi)
                hsv_roi = cv2.cvtColor(particle_roi_umat, cv2.COLOR_BGR2HSV)
                
                # Crear las máscaras
                mask_green = cv2.inRange(hsv_roi, lower_green, upper_green)
                mask_cyan = cv2.inRange(hsv_roi, lower_cyan, upper_cyan)
                mask_red1 = cv2.inRange(hsv_roi, lower_red1, upper_red1)
                mask_red2 = cv2.inRange(hsv_roi, lower_red2, upper_red2)
                mask_red = cv2.bitwise_or(mask_red1, mask_red2)
                
                # Juntar todas las máscaras luminosas de forma segura para UMat
                combined_mask = cv2.bitwise_or(cv2.bitwise_or(mask_green, mask_cyan), mask_red)
                bright_pixels = cv2.countNonZero(combined_mask)
                
                # --- 3. DETECCIÓN INERCIAL Y DE ASSET (TRACKING HÍBRIDO) ---
                is_brake = False
                speed = 0
                if prev_x != -1:
                    speed = math.hypot(real_x - prev_x, real_y - prev_y)
                    velocities.append(speed)
                    if len(velocities) > 10:
                        velocities.pop(0)
                        
                    avg_speed = sum(velocities) / len(velocities)
                    # Micro-freno: Venía rápido y cayó en seco
                    if avg_speed > 15 and speed < 4:
                        is_brake = True
                
                # Guardar posición para el próximo frame
                prev_x, prev_y = real_x, real_y
                
                # Cambio de Asset: Si el jugador forzó el cursor de espada (Attack)
                asset_is_click = (best_type in ["attack", "right_click"])
                
                # TRIPLE REDUNDANCIA: Clic por Color OR Clic por Freno Físico OR Clic por Asset
                if (bright_pixels > BRIGHT_PIXELS_MIN or is_brake or asset_is_click) and frames_since_last_click >= COOLDOWN_FRAMES:
                    # Determinar si fue clic normal o ataque
                    green_cyan_pixels = cv2.countNonZero(cv2.bitwise_or(mask_green, mask_cyan))
                    red_pixels = cv2.countNonZero(mask_red)
                    
                    if red_pixels > green_cyan_pixels or best_type == "attack":
                        evt_to_register = "left_click" # Ataque
                    else:
                        evt_to_register = "right_click" # Movimiento
                        
                    frames_since_last_click = 0

            # Si el tracker visual detectó el sprite de espada, forzamos que al menos diga attack
            if evt_to_register == "move" and best_type != "move":
                evt_to_register = best_type

            # Guardamos la ubicación exitosa para el predictivo y estimamos velocidad
            new_loc = (int(real_x), int(real_y))
            if last_loc is not None:
                last_vel = (new_loc[0] - last_loc[0], new_loc[1] - last_loc[1])
            last_loc = new_loc
            lost_frames = 0      # rastro recuperado: reinicia el backoff global
            grace_left = GRACE_FRAMES  # recargamos el "colchón" de coasting
            
            # Corregimos la coordenada exportada con el HotSpot para que en la app de React
            # el punto se dibuje exactamente en la punta de la espada/mano y no descuadrado
            final_x = int(real_x + best_hotspot[0])
            final_y = int(real_y + best_hotspot[1])
            
            events.append({
                "t": time_sec,
                "x": final_x,
                "y": final_y,
                "evt": evt_to_register
            })
            if evt_to_register in ("left_click", "right_click"):
                n_clicks += 1
        else:
            # No encontramos el cursor en este frame.
            if last_loc is not None and not is_global_search and grace_left > 0:
                # Coasting: predecimos por velocidad y seguimos en ROI unos frames
                # antes de rendirnos. No emitimos evento (no hay match confirmado),
                # solo movemos el centro de búsqueda para reengancharlo.
                grace_left -= 1
                px = max(0, min(frame_width, last_loc[0] + last_vel[0]))
                py = max(0, min(frame_height, last_loc[1] + last_vel[1]))
                last_loc = (int(px), int(py))
            else:
                # Rastro realmente perdido → siguiente frame hará búsqueda global.
                if last_loc is not None:
                    track_losses += 1
                last_loc = None
            
        # Emitir progreso
        if frame_count % (skip_frames * 20) == 0:
            if total_frames > 0:
                progress = (frame_count / total_frames) * 100
                # Línea legible para el log + línea estructurada para la barra de progreso
                sys.stderr.write(f"Analizando VOD: {time_sec/60:.1f} min ({progress:.1f}%)\n")
                sys.stderr.write(f"PROGRESS:{progress:.1f}\n")
                sys.stderr.flush()

    sys.stderr.write("Analisis finalizado, exportando JSON...\n")

    # Resumen de métricas para comparar configuraciones de forma objetiva.
    if DIAGNOSTIC:
        mean_c = (sum(confidences) / len(confidences)) if confidences else 0.0
        med_c = statistics.median(confidences) if confidences else 0.0
        tracked_pct = (100.0 * frames_tracked / frames_analyzed) if frames_analyzed else 0.0
        metrics = {
            "method": "sqdiff" if MATCH_LOWER_BETTER else "ccorr",
            "scales": SCALES,
            "frames_analyzed": frames_analyzed,
            "tracked_pct": round(tracked_pct, 1),
            "mean_conf": round(mean_c, 4),
            "median_conf": round(med_c, 4),
            "track_losses": track_losses,
            "clicks": n_clicks,
        }
        sys.stderr.write("METRICS:" + json.dumps(metrics) + "\n")
    sys.stderr.flush()
    cap.release()

    # Duración real del VOD a partir de los frames realmente recorridos.
    # (Antes el backend la hardcodeaba a 1800s, descuadrando el eje del timeline.)
    video_duration = (frame_count / fps) if fps > 0 else 0.0

    print(json.dumps({
        "events": events,
        "duration": video_duration,
        "width": frame_width,
        "height": frame_height,
    }))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyzer.py <video_path> [cursors_dir]")
        sys.exit(1)

    # Desactivar logs de opencv y tensorflow/ort si los hubiera en el backend de c++
    os.environ['OPENCV_LOG_LEVEL'] = 'OFF'

    cursors_dir = sys.argv[2] if len(sys.argv) > 2 else None
    analyze(sys.argv[1], cursors_dir)
