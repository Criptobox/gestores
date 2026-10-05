# AXONTECH · Base de datos en Google Sheets

Esta versión de la app guarda TODOS los datos (vales, gestores, catálogo,
configuración…) en **una hoja de cálculo de Google** atendida por un
**Google Apps Script** (`Code.gs`, en la raíz de este repo). Ya no hace
falta Supabase: no hay plan de pago, no hay límite de descargas (el 5 GB
de egress que se agotó en agosto), y puedes ver y tocar los datos
directamente en la hoja.

La app sigue hablando el mismo idioma de siempre internamente, así que
**no cambia nada en la forma de usarla**: mismos vales, mismos botones,
misma sincronización entre teléfonos.

---

## 1 · Crear la base (3 minutos)

1. Entra en <https://script.google.com> con tu cuenta de Google y pulsa
   **Nuevo proyecto**.
2. Borra lo que venga y pega **todo el contenido de `Code.gs`**.
3. Guarda (icono del disquete o Ctrl+S) y nómbralo, p. ej. `AXONTECH DB`.
4. En la barra superior elige la función **`setup`** y pulsa **Ejecutar**.
   - La primera vez Google pedirá permisos: **Revisar permisos →
     elige tu cuenta → Avanzado → Ir a AXONTECH DB (no seguro) → Permitir**.
     Es tu propio script dándose permiso sobre tu propio Drive.
   - Al terminar, el registro muestra el enlace de la hoja. Se ha creado
     **"AXONTECH DB"** en tu Drive con las pestañas:
     `gestores`, `mensajeros`, `productos`, `categorias`, `vales`,
     `meta`, `backups`, `stock_ops`, `vale_contador`, `_cambios`.

## 2 · Publicar la API

1. En el mismo script: **Implementar → Nueva implementación**.
2. Pulsa el engranaje de "Selecciona el tipo" → **Aplicación web**.
3. Configura EXACTAMENTE así:
   - **Descripción**: la que quieras.
   - **Ejecutar como**: `Yo` (tu cuenta).
   - **Quién tiene acceso**: `Cualquier persona`.
4. **Implementar** → copia la **URL de la app web** (termina en `/exec`).

> Prueba rápida: pega esa URL en el navegador. Debe contestar algo como
> `{"ok":true,"servicio":"AXONTECH · Base de datos en Google Sheets",…}`.

## 3 · Conectar la app

Elige UNA de estas dos (la a es la recomendada para el negocio entero):

**a) En el código (todos los teléfonos a la vez).**
Abre `app.js`, busca al principio la línea `const GS_DB_URL = '';` y pega
tu URL entre las comillas. Publica la app como siempre — todos los
teléfonos la cogen al actualizarse.

```js
const GS_DB_URL = 'https://script.google.com/macros/s/AKfyc…/exec';
```

**b) Por enlace (teléfono a teléfono).**
Abre en cada teléfono **una sola vez**:

```
https://TU-PAGINA/?gs=https://script.google.com/macros/s/AKfyc…/exec
```

La URL se queda guardada y el parámetro se limpia solo de la barra.
También se puede poner por la consola del navegador:
`localStorage.setItem('axon_gs_url', '…/exec')`.

Si pusiste un `API_TOKEN` en Code.gs, mándalo también:
`?gs=URL|EL_TOKEN` (o rellena `GS_DB_TOKEN` en app.js).

## 4 · Cargar tus datos (empezar de cero)

La hoja nueva nace vacía. Hay dos formas de llenarla:

**a) Desde la propia app (recomendado).** Entra en `admin.html`, crea
gestores, categorías y productos desde el panel, y la app escribe todo
en la hoja con sus reglas (avisos, stock, claves…).

**b) Pegando filas a mano en la hoja.** Cada pestaña de datos lleva tres
columnas (`id | data (JSON) | updated_at`): pega el `id` (un número que
no exista, p. ej. la fecha en ms), el JSON completo del registro en `data`
y deja `updated_at` vacío. La app lo ve en el siguiente sondeo.
Si importas vales con número, ejecuta una vez `sembrarContadorVales`
desde el editor para dejar el contador por encima del número más alto.

> El repositorio trae además una semilla genérica (`data.json`) con 3
> productos de ejemplo: se siembra sola en un teléfono la primera vez que
> abre sin conexión a la base. Puedes adaptarla a tu gusto o dejarla
> vacía (`{"gestores":[],"mensajeros":[],"productos":[],"categorias":[]}`).

### 4b · Ponerle cara a tu negocio (apartado 🎨 Diseño)

En `admin.html` hay una pestaña **🎨 Diseño** donde se cambia la
identidad del programa sin tocar código — así cada copia de este repo
se adapta a un negocio distinto:

- **Nombre de la tienda** y su lema: aparecen en la cabecera, el splash
  de carga, el título de la pestaña, el favicon y al instalar la app.
- **Logo**: sube una imagen (se recorta y se optimiza sola, queda en
  unos KB) o escribe un emoji. Sin logo se usan las iniciales.
- **Paleta de colores**: 10 paletas listas + color personalizado; se
  derivan solos los tonos claros, oscuros y del modo noche.

Todo se guarda en la pestaña `meta` de la hoja (fila `marca`) y baja al
resto de teléfonos con el sondeo normal, como cualquier otro dato. El
catálogo público toma el estilo nuevo la próxima vez que se publique
desde ⚙️ Config. «↩ Restaurar original» devuelve el AXONTECH de fábrica.

### 4c · Avisos, solo lectura y respaldos (v209)

**🔔 Avisos de vales nuevos** — En Admin → Config hay un botón para
apagarlos o encenderlos. El permiso del navegador se pide al entrar como
admin; si lo aceptas, cada vale nuevo suena, vibra y dispara una
notificación aunque la app esté en segundo plano (mientras siga abierta).
Para avisar con la app COMPLETAMENTE cerrada haría falta un servicio de
push (Firebase/FCM) con su propia cuenta — decisión deliberada para no
amarrar la plantilla a ningún servicio externo.

**👤 Acceso solo lectura** — En Config crea una segunda contraseña. Con
ella aparece un acceso «Entrar solo lectura» en la pantalla de contraseña:
los dueños ven todos los paneles, pero la app bloquea cualquier guardado
(escrituras a la nube rechazadas de raíz + botones de acción ocultos).
La contraseña queda hasheada en ese teléfono; se puede quitar desde Config.

**☁️ Respaldo de seguridad** — En Config → ☁️:
- *Respaldar ahora* copia toda la hoja a un archivo aparte en tu Drive
  («AXONTECH respaldo …»). Se conservan los últimos 8.
- *Activar semanal* instala un disparador en tu cuenta de Google (lunes
  6:00) — se autoriza una vez y corre solo. Google avisa que el trigger
  ejecuta el script: es normal, es tu propio script.
- Restaurar = abrir el respaldo en Drive y copiar las pestañas a la hoja
  viva (misma estructura) o pegar su ID en SPREADSHEET_ID.

## 5 · La hoja por dentro

Cada pestaña de datos tiene tres columnas:

| id | data (JSON) | updated_at |
|----|-------------|------------|
| 9001 | `{"cliente":"Luis","total":1200,"status":"confirmed",…}` | 2026-10-03T14:22:05.181Z |

- **La columna `data` es la verdad.** Todo lo que la app sabe de ese
  registro está ahí dentro, en JSON. No borres ni muevas las cabeceras.
- `meta` guarda documentos sueltos por nombre: `config`, `notifs`,
  `tasa`, `estafa`, `duenos`, `mermas`, `claves_admin`…
- `stock_ops` y `vale_contador` son internas (idempotencia de stock y
  números de vale). No hace falta mirarlas.
- `_cambios` es el "semáforo" del sondeo: la app pregunta ahí (una
  lectura minúscula) si algo cambió antes de bajarse tablas enteras.

### Editar a mano

- **Añadir filas** (un producto nuevo, un gestor): se puede. Pega el `id`
  (un número que no exista, p. ej. la fecha en ms), el JSON completo en
  `data` y deja `updated_at` vacío o ponle la hora. La app lo ve en el
  siguiente sondeo.
- **Cambiar una fila vieja**: también se puede, pero puede tardar hasta
  el barrido periódico en llegar a los teléfonos. Para cambios normales
  usa la propia app (admin), que lo propaga en segundos y mantiene las
  reglas (campos del admin, fusión de avisos, stock…).
- Si un JSON queda roto, la fila se ignora hasta arreglarlo — no rompe
  la app ni los demás datos.

## 6 · Límites y notas

- **Tamaño por fila**: una celda de Sheets aguanta ~50.000 caracteres.
  Un vale ronda 1,5 KB; el único sitio donde conviene vigilar es algún
  documento de `meta` que crezca mucho (mermas, avisos) — la app los
  recorta sola, pero si un día viera "Fila demasiado grande", es eso.
- **Velocidad**: la primera carga tras conectar puede tardar unos
  segundos más que con Supabase. El día a día va bien: el sondeo es
  barato y las escrituras son pequeñas.
- **Cuentas**: el script corre como TU cuenta; los teléfonos NO necesitan
  cuenta de Google ni permisos sobre la hoja (por eso el acceso de la
  implementación es "Cualquier persona"). La URL del script es la puerta;
  si quieres una cerradura más, pon `API_TOKEN` en Code.gs y el mismo
  token en la app.
- **Copia de seguridad**: File → Make a copy de la hoja, cuando quieras.
  La app además sigue guardando sus respaldos como siempre.
- **Cuotas de Google** (cuenta gratuita): sobradísimas para un negocio
  de este tamaño; el sondeo lento cuando nadie toca nada ayuda a que así
  siga siendo.

## 7 · Si quieres desmontarlo

Todo el cambio vive en `app.js` (el bloque "GOOGLE SHEETS DATA LAYER"),
`Code.gs` y las versiones de caché. Basta con desconectar la URL de la
base (`?gs=clear` en cada teléfono, o vaciar `GS_DB_URL`) para que la app
siga funcionando en local con los datos que ya tenía; la hoja queda
ahí, legible, por si hay que re-exportar nada.
