import os
import urllib.request
import re

base_urls = [
    "https://raw.communitydragon.org/pbe/game/assets/ux/cursors/",
    "https://raw.communitydragon.org/pbe/game/assets/ux/cursors/upscaled/"
]

output_dir = "assets/cursors"
os.makedirs(output_dir, exist_ok=True)
os.makedirs(os.path.join(output_dir, "upscaled"), exist_ok=True)

for base_url in base_urls:
    print(f"Buscando en {base_url}...")
    try:
        req = urllib.request.Request(base_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            
            # Extract hrefs ending in .png
            matches = re.findall(r'href="([^"]+\.png)"', html)
            
            is_upscaled = "upscaled" in base_url
            target_dir = os.path.join(output_dir, "upscaled") if is_upscaled else output_dir
            
            for file_name in matches:
                file_url = base_url + file_name
                output_path = os.path.join(target_dir, file_name)
                
                print(f"Descargando {file_name}...")
                try:
                    req_file = urllib.request.Request(file_url, headers={'User-Agent': 'Mozilla/5.0'})
                    with urllib.request.urlopen(req_file) as res_file:
                        with open(output_path, 'wb') as f:
                            f.write(res_file.read())
                except Exception as e:
                    print(f"Error descargando {file_name}: {e}")
    except Exception as e:
         print(f"Error accediendo a {base_url}: {e}")

print("¡Descarga de cursores completada!")
