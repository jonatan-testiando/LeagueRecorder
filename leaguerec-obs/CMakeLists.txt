cmake_minimum_required(VERSION 3.28)
project(leaguerec-obs LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
find_package(LibObs REQUIRED)

add_executable(leaguerec-obs src/main.cpp src/recorder.cpp)
target_link_libraries(leaguerec-obs PRIVATE LibObs::libobs)

if(MSVC)
  target_compile_options(leaguerec-obs PRIVATE /W3 /permissive-)
  target_compile_definitions(leaguerec-obs PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
