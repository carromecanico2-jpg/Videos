# Videos — Panel de edición

Sitio estático en GitHub Pages con sidebar, proyectos y revisión de cortes.

**Live:** https://carromecanico2-jpg.github.io/Videos/

## Rutas (hash)
- `#/` — inicio (lista de proyectos)
- `#/p/<slug>` — vista de un proyecto
- `#/settings` — cómo empezar + guía de estilo
- `/revision/<slug>/` — revisión de audio (Mary Cooper)

## Datos
- `data/projects.json` — proyectos oficiales (fuente de verdad)
- `data/style.json` — resumen de estilo / howto (Settings)
- Borradores locales: `localStorage` key `zepfilms-edit-panel-drafts-v1`

## Actualizar un proyecto
Edita `data/projects.json` y push a `main`. Estados: `pendiente` | `en_progreso` | `esperando_aprobacion` | `aprobado`.
