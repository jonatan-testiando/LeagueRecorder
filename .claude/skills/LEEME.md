# Skills de este proyecto

Instaladas el 2026-10-20 para el rediseño (`docs/rediseno-2026-10/README.md`). Antes de copiarlas se leyeron enteras.

| Carpeta | Origen | Cambios locales |
|---|---|---|
| `impeccable/` | github.com/pbakaus/impeccable v4.7.0 (e7d0f58), `plugin/skills/impeccable` | **Sin `scripts/`**: el lanzador descarga y ejecuta un binario en `~/.impeccable/bin` y manda telemetría. Sin hooks ni agentes. Al principio de SKILL.md hay una nota que manda entrar por «Launcher unavailable» y fija tus reglas. Licencia en `LICENSE.impeccable` (Apache 2.0) |
| `emil-design-eng/`, `animate/`, `animation-performance/`, `review-animations/`, `improve-animations/`, `find-animation-opportunities/`, `break-ui/` | github.com/emilkowalski/skills (2d22863) | Nota «Ajuste local» en las de movimiento (sin rebote: `bounce: 0`; contraste 10-11:1; EN/ES). En `emil-design-eng` se añadió «Use when…» a la descripción. Licencia MIT en `emil-design-eng/LICENSE.emilkowalski` |

Para actualizar: volver a clonar los repos y repetir la revisión. No uses `npx impeccable install` ni `npx skills add`: instalan a nivel de usuario y, en el caso de Impeccable, también los hooks y el binario.
