# AXONTECH · Auto-versionado

## Cómo publicar cambios

**Sube los archivos y ya está.** Desde v67 la versión se genera sola.

GitHub ejecuta `build.py` por ti cada vez que subes uno de los archivos que el
service worker cachea (`app.js`, `app.css`, `index.html`, `admin.html`, `sw.js`
o `catalogo.html`), da igual cómo lo subas: por la web de GitHub, por git o
desde el móvil. Unos 30 segundos después aparece un commit `build: vX.Y` con la
versión ya actualizada, y los usuarios ven el aviso de "Nueva versión
disponible".

Está en `.github/workflows/auto-version.yml`. Para ver si funcionó: pestaña
**Actions** del repositorio en GitHub.

### Por qué esto importa tanto

Antes había que acordarse de ejecutar `python3 build.py` a mano antes de subir.
Si se olvidaba, el archivo nuevo llegaba al servidor pero **la clave de caché no
cambiaba**, así que el service worker seguía sirviendo la copia vieja desde el
teléfono: el cambio no lo veía nadie. Eso tuvo la app rota durante semanas, con
las correcciones publicadas pero sin llegar a ejecutarse.

### Ejecutarlo a mano (opcional)

Sigue funcionando, por si quieres ver el número antes de subir:

```bash
python3 build.py
```

Es inofensivo hacerlo aunque el workflow vaya a ejecutarlo también: si no hay
cambios reales, no toca nada.

### Si añades un archivo nuevo que cachee el service worker

Tiene que estar en **dos** sitios o no se versionará:
1. `CRITICAL_FILES` en `build.py`
2. La lista `paths` de `.github/workflows/auto-version.yml`

(Le pasó a `catalogo.html`: lo cacheaba `sw.js` pero no estaba en la lista, así
que sus arreglos no llegaban a los teléfonos.)

## ¿Cómo funciona?

1. `build.py` calcula un hash SHA-256 combinado de los archivos críticos.
2. Compara con el hash guardado en `version.json`.
3. **Si son iguales** → no hay cambios reales, no hace nada.
4. **Si son diferentes** → incrementa la versión automáticamente y actualiza:
   - `version.json` (nueva versión, nuevo hash, fecha)
   - `sw.js` (`APP_VERSION` y `CACHE`)
   - `app.js` (`APP_VERSION` y `_LOCAL_BUILD_HASH`)
   - `index.html` (`?v=N` en CSS y JS)
   - `admin.html` (`?v=N` en CSS y JS)

## ¿Cómo se enteran los usuarios?

- La app consulta `version.json` cada 5 minutos automáticamente.
- Si la versión remota es mayor que la local, aparece un banner verde: **"🔄 Nueva versión disponible"** con dos botones:
  - **Recargar ahora** → descarga la nueva versión sin caché
  - **Más tarde** → pospone el aviso
- El usuario también puede tocar el badge `v3` (arriba a la izquierda) para verificar manualmente.

## Archivos críticos (su cambio dispara nueva versión)

- `app.js`
- `app.css`
- `index.html`
- `admin.html`
- `sw.js`

## Forzar una nueva versión (sin cambios reales)

Si por algún motivo necesitas forzar que todos los usuarios recarguen (por ejemplo, para limpiar la caché del navegador):

```bash
rm version.json
python3 build.py
```

Esto empezará una nueva versión desde 1.
