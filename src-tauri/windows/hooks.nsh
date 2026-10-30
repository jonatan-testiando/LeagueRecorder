; Hooks del instalador NSIS (bundle.windows.nsis.installerHooks).
;
; Migración de LeagueRecorder a Wardline (2026-10-30).
;
; El producto se llamaba LeagueRecorder. El instalador busca su instalación
; previa en claves del registro que llevan el nombre del producto, y el
; actualizador lo lanza sin decirle carpeta (/S /R /UPDATE): con el nombre
; nuevo no la encuentra e instala en %LOCALAPPDATA%\Wardline. Sin esto
; quedarían las dos copias, con dos accesos directos y dos entradas en
; «Agregar o quitar programas».
;
; Tras instalar, si hay una instalación de LeagueRecorder en OTRA carpeta, se
; lanza su desinstalador en silencio. En silencio no borra datos: eso solo lo
; hace con la casilla de «borrar datos», que no se marca. Y los datos de la app
; (config, coach, entrenamiento) viven en %APPDATA%\LeagueRecorder y las
; partidas en su carpeta de grabaciones, rutas que ningún desinstalador toca.

!define OLD_PRODUCTNAME "LeagueRecorder"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  Push $R9

  ; La carpeta de la instalación vieja. El instalador de Tauri la guarda entre
  ; comillas ("C:\...\LeagueRecorder").
  ReadRegStr $R8 HKCU "${OLD_UNINSTKEY}" "InstallLocation"
  StrCpy $R9 $R8 1
  ${If} $R9 == '"'
    StrCpy $R8 $R8 "" 1
    StrCpy $R8 $R8 -1
  ${EndIf}

  ; Solo si es otra carpeta: si se instaló Wardline encima de la vieja, su
  ; desinstalador borraría los ficheros que se acaban de copiar (mismo exe,
  ; mismos recursos).
  ${If} $R8 != ""
  ${AndIf} $R8 != $INSTDIR
  ${AndIf} ${FileExists} "$R8\uninstall.exe"
    ; `_?=` lo ejecuta en su sitio y espera a que acabe (sin él se copia a
    ; temporales y ExecWait vuelve enseguida). Borra sus ficheros, sus accesos
    ; directos y su entrada en «Agregar o quitar programas».
    ExecWait '"$R8\uninstall.exe" /S _?=$R8'
    ; Ejecutado en su sitio no puede borrarse a sí mismo.
    Delete "$R8\uninstall.exe"
    ; Lo que la app creó al usarse dentro de sus recursos (cachés de Python) y
    ; el desinstalador no conoce: solo estas carpetas, que son del programa.
    RMDir /r "$R8\python-runtime"
    RMDir /r "$R8\obs-runtime"
    RMDir /r "$R8\python_scripts"
    RMDir /r "$R8\models"
    RMDir /r "$R8\assets"
    RMDir /r "$R8\bin"
    ; Sin /r: si queda algo más dentro, la carpeta se queda.
    RMDir "$R8"
  ${EndIf}

  ; La carpeta de instalación vieja que guardaba el instalador. Su
  ; desinstalador solo la borra cuando borra los datos.
  DeleteRegKey HKCU "${MANUKEY}\${OLD_PRODUCTNAME}"

  Pop $R9
  Pop $R8
!macroend
