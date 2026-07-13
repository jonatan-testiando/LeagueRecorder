# FindLibObs.cmake — localiza libobs a partir de un árbol de OBS compilado desde fuente.
#
# Entradas (cache, con defaults relativos a este repo):
#   OBS_SOURCE_DIR  Raíz del código de OBS (contiene libobs/obs.h)
#   OBS_BUILD_DIR   Directorio de build de OBS (contiene libobs/.../obs.lib y obsconfig.h)
#
# Salidas:
#   LibObs_FOUND
#   LibObs::libobs  (target importado con includes + lib)

if(NOT DEFINED OBS_SOURCE_DIR)
  set(OBS_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../../third_party/obs-studio"
      CACHE PATH "Raíz del código fuente de OBS")
endif()
if(NOT DEFINED OBS_BUILD_DIR)
  set(OBS_BUILD_DIR "${OBS_SOURCE_DIR}/build_x64"
      CACHE PATH "Directorio de build de OBS")
endif()

get_filename_component(OBS_SOURCE_DIR "${OBS_SOURCE_DIR}" ABSOLUTE)
get_filename_component(OBS_BUILD_DIR  "${OBS_BUILD_DIR}"  ABSOLUTE)

# Header principal (en el árbol de fuentes).
find_path(LibObs_INCLUDE_DIR
  NAMES obs.h
  PATHS "${OBS_SOURCE_DIR}/libobs"
  NO_DEFAULT_PATH)

# obsconfig.h se genera en el árbol de build; su ubicación varía entre versiones.
find_path(LibObs_CONFIG_INCLUDE_DIR
  NAMES obsconfig.h
  PATHS
    "${OBS_BUILD_DIR}/config"
    "${OBS_BUILD_DIR}/libobs"
    "${OBS_BUILD_DIR}/config/obs"
  NO_DEFAULT_PATH)

# obs.lib (import library) generada por el build RelWithDebInfo.
find_library(LibObs_LIBRARY
  NAMES obs
  PATHS
    "${OBS_BUILD_DIR}/libobs/RelWithDebInfo"
    "${OBS_BUILD_DIR}/libobs"
    "${OBS_BUILD_DIR}/rundir/RelWithDebInfo/bin/64bit"
  NO_DEFAULT_PATH)

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(LibObs
  REQUIRED_VARS LibObs_LIBRARY LibObs_INCLUDE_DIR LibObs_CONFIG_INCLUDE_DIR
  FAIL_MESSAGE "No se encontró libobs. Compila OBS con scripts/build-obs.ps1, o pasa -DOBS_SOURCE_DIR/-DOBS_BUILD_DIR.")

if(LibObs_FOUND AND NOT TARGET LibObs::libobs)
  add_library(LibObs::libobs UNKNOWN IMPORTED)
  set_target_properties(LibObs::libobs PROPERTIES
    IMPORTED_LOCATION "${LibObs_LIBRARY}"
    INTERFACE_INCLUDE_DIRECTORIES "${LibObs_INCLUDE_DIR};${LibObs_CONFIG_INCLUDE_DIR}")
endif()
