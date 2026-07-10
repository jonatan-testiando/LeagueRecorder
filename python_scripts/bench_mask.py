import cv2
import numpy as np
import time

def benchmark():
    print("OpenCL enabled:", cv2.ocl.useOpenCL())
    
    # Create dummy images
    search_img = np.random.randint(0, 255, (1080, 1920, 3), dtype=np.uint8)
    template = np.random.randint(0, 255, (30, 30, 3), dtype=np.uint8)
    mask = np.random.randint(0, 255, (30, 30), dtype=np.uint8)
    
    # Global search (resized)
    search_half = cv2.resize(search_img, (0,0), fx=0.5, fy=0.5)
    template_half = cv2.resize(template, (0,0), fx=0.5, fy=0.5)
    mask_half = cv2.resize(mask, (0,0), fx=0.5, fy=0.5)
    
    # UMat
    s_umat = cv2.UMat(search_half)
    t_umat = cv2.UMat(template_half)
    m_umat = cv2.UMat(mask_half)
    
    print("Testing unmasked...")
    start = time.time()
    for _ in range(50):
        cv2.matchTemplate(s_umat, t_umat, cv2.TM_CCORR_NORMED)
    end = time.time()
    print(f"Unmasked time: {end - start:.4f}s")
    
    print("Testing masked...")
    start = time.time()
    for _ in range(50):
        cv2.matchTemplate(s_umat, t_umat, cv2.TM_CCORR_NORMED, mask=m_umat)
    end = time.time()
    print(f"Masked time: {end - start:.4f}s")

if __name__ == '__main__':
    benchmark()
