# Videos — Panel de edición

Sitio estático en GitHub Pages: panel de flujo de edición + revisión de cortes por proyecto.

**Live:** https://carromecanico2-jpg.github.io/Videos/

## Estructura

```
/
  index.html                 # Panel (dashboard)
  css/dashboard.css
  js/dashboard.js
  data/projects.json         # Fuente de verdad de proyectos y estados
  revision/<slug>/           # Revisión de audio de cada proyecto
    index.html
    audio.mp3
    css/ styles
    js/  app + wavesurfer
    data/proposals.json, peaks.json
```

## Actualizar proyectos

Edita `data/projects.json` y haz push a `main`. Campos útiles:

- `projects[].title`, `subtitle`, `status`
- `projects[].pipeline[].status`: `pendiente` | `en_progreso` | `esperando_aprobacion` | `aprobado`
- `projects[].media.cleanedAudio` / `videoPreview`: ruta relativa al archivo (o `null` → muestra “pendiente”)
- `projects[].review.counts` y `link` para el paso de cortes
- `style`: resumen de ritmo / LUFS / SFX / resolución

Para un proyecto nuevo: copia un bloque en `projects`, crea `revision/<slug>/` con audio + propuestas, y enlázalo.

## Revisión Mary Cooper

- URL: https://carromecanico2-jpg.github.io/Videos/revision/mary-cooper/
- localStorage: `mary-cooper-audio-review-v2` (sin cambios)
