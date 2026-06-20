import cv2
import numpy as np
import sys
import json
import os

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
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cursors_dir = os.path.join(base_dir, "assets", "cursors")
    
    # Cargar las diferentes variantes de cursor
    hand_bgr, hand_mask = load_template(os.path.join(cursors_dir, "hand1.png"))
    attack_bgr, attack_mask = load_template(os.path.join(cursors_dir, "singletarget.png"))
    attack_enemy_bgr, attack_enemy_mask = load_template(os.path.join(cursors_dir, "singletargetenemy.png"))
    
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps([]))
        return
        
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0: fps = 30.0
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sys.stderr.write(f"Iniciando analisis... Total frames: {total_frames}\n")
    sys.stderr.flush()
    
    # Asumimos resoluciones similares, o podemos escalar la imagen
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    events = []
    frame_count = 0
    
    # Procesar 5 frames por segundo (suficiente para una estela fluida, el doble de rapido)
    skip_frames = max(1, int(fps / 5))
    
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
        
        best_val = 0
        best_loc = (0, 0)
        best_type = "move"
        
        # Método 1: Cursor normal (movimiento)
        if hand_bgr is not None:
            res = cv2.matchTemplate(frame, hand_bgr, cv2.TM_CCORR_NORMED, mask=hand_mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)
            if max_val > best_val:
                best_val = max_val
                best_loc = max_loc
                best_type = "move"
                
        # Método 2: Cursor ataque
        if attack_bgr is not None:
            res = cv2.matchTemplate(frame, attack_bgr, cv2.TM_CCORR_NORMED, mask=attack_mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)
            if max_val > best_val:
                best_val = max_val
                best_loc = max_loc
                best_type = "right_click"
                
        # Método 3: Cursor ataque a enemigo (rojo)
        if attack_enemy_bgr is not None:
            res = cv2.matchTemplate(frame, attack_enemy_bgr, cv2.TM_CCORR_NORMED, mask=attack_enemy_mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)
            if max_val > best_val:
                best_val = max_val
                best_loc = max_loc
                best_type = "attack"
        
        # Umbral estricto para evitar falsos positivos en el ruido del mapa
        if best_val > 0.85:
            # Los cursores en LoL apuntan con la punta superior izquierda, o el centro dependiendo del cursor
            # El template matching devuelve la esquina superior izquierda del recorte.
            # Como recortamos los bordes, best_loc está bastante cerca del "hotspot".
            events.append({
                "t": time_sec,
                "x": float(best_loc[0]),
                "y": float(best_loc[1]),
                "evt": best_type
            })
            
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
