import cv2
import numpy as np
import sys
import json
import os
import math

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

def analyze(video_path):
    # Activar Aceleración por GPU (OpenCL Transparente)
    cv2.ocl.setUseOpenCL(True)

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cursors_dir = os.path.join(base_dir, "assets", "cursors")
    
    # Cargar las diferentes variantes de cursor (base y upscaled)
    target_files = [
        # (filename, event_type, hotspot_x, hotspot_y)
        ("hand1.png", "move", 9, 9),
        ("hand2.png", "move", 9, 9),
        ("hoverenemy.png", "attack", 2, 2),
        ("hover_precise.png", "move", 24, 24),
        ("hover_enemy_precise_colorblind.png", "attack", 24, 24)
    ]
    
    templates = []
    templates_half = []
    for fname, evt_type, h_x, h_y in target_files:
        for folder in [cursors_dir, os.path.join(cursors_dir, "upscaled")]:
            path = os.path.join(folder, fname)
            if os.path.exists(path):
                b, m = load_template(path)
                if b is not None:
                    templates.append((cv2.UMat(b), cv2.UMat(m), evt_type, h_x, h_y))
                    
                    # Generar versión pequeña para el Escaneo Global Ultrarápido
                    b_half = cv2.resize(b, (0,0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
                    m_half = cv2.resize(m, (0,0), fx=0.5, fy=0.5, interpolation=cv2.INTER_NEAREST)
                    templates_half.append((cv2.UMat(b_half), cv2.UMat(m_half), evt_type, h_x/2.0, h_y/2.0))
    
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
    
    # Contador anti-spam (debounce)
    frames_since_last_click = 0
    COOLDOWN_FRAMES = 8 # ~260ms a 30 FPS
    
    # ------------------ TRACKING INERCIAL ------------------
    prev_x, prev_y = -1, -1
    velocities = []
    
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps([]))
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
    
    # Procesar 30 frames por segundo para una estela perfectamente fluida (el estándar de oro)
    skip_frames = max(1, int(fps / 30))
    
    last_loc = None
    SEARCH_PADDING = 150 # Cuántos píxeles buscar alrededor del último punto conocido
    last_best_template_idx = 0 # Sticky Template Index
    
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
        # Solo comparamos con el cursor que estaba activo en el frame anterior
        t_bgr, t_mask, t_type, h_x, h_y = active_templates[last_best_template_idx]
        res = cv2.matchTemplate(search_frame_umat, t_bgr, cv2.TM_CCORR_NORMED, mask=t_mask)
        res_cpu = res.get() if hasattr(res, 'get') else res
        _, best_val, _, best_loc = cv2.minMaxLoc(res_cpu)
        best_type = t_type
        best_hotspot = (h_x, h_y)
        
        # --- FASE 2: CLASIFICACIÓN (Solo si el cursor cambió de forma o perdimos calidad) ---
        # Si la similitud cae por debajo de nuestro umbral de "clic válido" (0.85),
        # estamos obligados a buscar en toda la librería de cursores.
        if best_val < 0.88:
            best_val = 0
            for i, (t_bgr, t_mask, t_type, h_x, h_y) in enumerate(active_templates):
                if i == last_best_template_idx:
                    continue # Ya lo probamos
                    
                res = cv2.matchTemplate(search_frame_umat, t_bgr, cv2.TM_CCORR_NORMED, mask=t_mask)
                res_cpu = res.get() if hasattr(res, 'get') else res
                _, max_val, _, max_loc = cv2.minMaxLoc(res_cpu)
                
                if max_val > best_val:
                    best_val = max_val
                    best_loc = max_loc
                    best_type = t_type
                    best_hotspot = (h_x, h_y)
                    last_best_template_idx = i # Memorizar el nuevo cursor
                
                # Optimización matemática: Si hallamos una coincidencia altísima (95%)
                if best_val > 0.95:
                    break
                
        if is_global_search:
            # Restaurar la coordenada encontrada a la escala de video nativo 1080p/1440p
            best_loc = (int(best_loc[0] * 2), int(best_loc[1] * 2))
            best_hotspot = (int(best_hotspot[0] * 2), int(best_hotspot[1] * 2))
        
        # Umbral estricto para evitar falsos positivos
        if best_val > 0.85:
            # Reajustar coordenadas si estábamos usando un recorte pequeño
            real_x = float(best_loc[0]) + roi_offset_x
            real_y = float(best_loc[1]) + roi_offset_y
            
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
                frames_since_last_click += 1
                
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
                if (bright_pixels > 30 or is_brake or asset_is_click) and frames_since_last_click >= COOLDOWN_FRAMES:
                    # Determinar si fue clic normal o ataque
                    green_cyan_pixels = cv2.countNonZero(cv2.bitwise_or(mask_green, mask_cyan))
                    red_pixels = cv2.countNonZero(mask_red)
                    
                    if red_pixels > green_cyan_pixels or best_type == "attack":
                        evt_to_register = "left_click" # Ataque
                    else:
                        evt_to_register = "right_click" # Movimiento
                        
                    frames_since_last_click = 0
            
            frames_since_last_click += 1
            
            # Si el tracker visual detectó el sprite de espada, forzamos que al menos diga attack
            if evt_to_register == "move" and best_type != "move":
                evt_to_register = best_type
            
            # Guardamos la ubicación exitosa para el predictivo
            last_loc = (int(real_x), int(real_y))
            
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
        else:
            # Si no encontramos el ratón (o bajó la confianza), perdimos el rastro.
            # En el siguiente fotograma forzaremos una búsqueda Global en toda la pantalla.
            last_loc = None
            
        # Emitir progreso
        if frame_count % (skip_frames * 20) == 0:
            if total_frames > 0:
                progress = (frame_count / total_frames) * 100
                sys.stderr.write(f"Analizando VOD: {time_sec/60:.1f} min ({progress:.1f}%)\n")
                sys.stderr.flush()

    sys.stderr.write("Analisis finalizado, exportando JSON...\n")
    sys.stderr.flush()
    cap.release()
    print(json.dumps(events))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyzer.py <video_path>")
        sys.exit(1)
    
    # Desactivar logs de opencv y tensorflow/ort si los hubiera en el backend de c++
    os.environ['OPENCV_LOG_LEVEL'] = 'OFF'
    
    analyze(sys.argv[1])
