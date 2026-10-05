#!/usr/bin/env python3
# ══════════════════════════════════════════════════════════════════
#  AXONTECH · AUTO-VERSION BUILD SCRIPT
# ══════════════════════════════════════════════════════════════════
#  Uso:  python3 build.py
#
#  Qué hace:
#  1. Calcula un hash SHA-256 combinado de los archivos críticos:
#     app.js, app.css, index.html, admin.html, sw.js
#  2. Compara con el hash guardado en version.json.
#     - Si son IGUALES → no hay cambios, no hace nada. Mensaje "Sin cambios".
#     - Si son DIFERENTES → hay cambios, incrementa la versión automáticamente
#       y actualiza TODOS los archivos sincronizados.
#  3. Archivos que actualiza automáticamente cuando hay cambios:
#     - version.json          (nueva versión, nuevo hash, fecha, changelog)
#     - sw.js                  (APP_VERSION y CACHE)
#     - app.js                 (const APP_VERSION)
#     - index.html             (?v=NUEVA en app.css y app.js)
#     - admin.html             (?v=NUEVA en app.css y app.js)
#
#  El admin solo tiene que:
#     1. Hacer sus cambios en cualquier archivo del proyecto
#     2. Ejecutar:  python3 build.py
#     3. Subir TODA la carpeta AXONTECH-main al servidor
#
#  Los usuarios existentes verán el banner verde "Nueva versión disponible"
#  automáticamente en unos 5 minutos (gracias al polling de checkVersion()).
# ══════════════════════════════════════════════════════════════════

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# Carpeta raíz del proyecto (donde está este script)
ROOT = Path(__file__).parent.resolve()

# Archivos críticos cuyo cambio dispara una nueva versión
# catalogo.html se añadió en v62: sw.js lo cachea igual que index.html y
# admin.html (está en su lista STATIC), pero no estaba aquí. Al no contar para
# el hash, tocarlo no subía la versión, la clave de caché no cambiaba y el
# service worker seguía sirviendo la copia vieja: cualquier arreglo del catálogo
# se quedaba sin llegar a los teléfonos. Si un archivo lo cachea el SW, tiene
# que estar en esta lista.
CRITICAL_FILES = ['app.js', 'app.css', 'index.html', 'admin.html', 'sw.js']
# Ojo: tasa.json NO va aquí. Lo reescribe un trabajo programado varias veces al
# día y meterlo en la lista publicaría una versión nueva cada vez, obligando a
# todos los teléfonos a rebajar la app entera por un número que cambió.

# Archivo que guarda la versión y el hash
VERSION_FILE = ROOT / 'version.json'

# ── Etiqueta pública (v62) ────────────────────────────────────────────────────
# El número interno (APP_VERSION) es el contador de publicaciones y NO se puede
# reiniciar: checkVersion() da por buena una actualización solo si el número
# remoto es MAYOR que el local, y el service worker no se activa solo —espera a
# que el usuario pulse "Recargar ahora" en el aviso—. Si se reiniciara a 1, los
# teléfonos con un número mayor no volverían a ver el aviso y se quedarían
# clavados hasta que la numeración recuperase el terreno perdido.
# Así que el contador sigue subiendo por dentro y aparte se calcula una etiqueta
# bonita para enseñar: la publicación PUBLIC_BASE es la 1.0, y a partir de ahí
# 1.1, 1.2 … 1.9, 2.0, 2.1 … Sube diez veces más despacio y siempre se lee bien.
PUBLIC_BASE = 64


def public_label(version):
    """Etiqueta pública ('v1.0') para un número de publicación interno."""
    offset = max(0, int(version) - PUBLIC_BASE)
    return f'v{1 + offset // 10}.{offset % 10}'


def normalize_content(content, fname):
    """Normaliza el contenido antes de hashear para que los bumps de versión
    automáticos NO cuenten como cambios reales. Reemplaza todos los indicadores
    de versión por un placeholder constante."""
    if isinstance(content, bytes):
        text = content.decode('utf-8', errors='replace')
    else:
        text = content
    # Reemplazar APP_VERSION = N  (en app.js como entero, en sw.js como string)
    text = re.sub(r'APP_VERSION\s*=\s*[\d\'"]+', 'APP_VERSION = X', text)
    # Reemplazar CACHE = 'axontech-vN'
    text = re.sub(r"CACHE\s*=\s*'axontech-v\d+'", "CACHE = 'axontech-vX'", text)
    # Reemplazar ?v=N en referencias a CSS/JS
    text = re.sub(r'\./app(?:\.min)?\.(css|js)\?v=\d+', r'./app.\1?v=X', text)
    # Reemplazar el texto del badge >vN< y >vN.M<
    text = re.sub(r'>v\d+(?:\.\d+)?<', '>vX<', text)
    # Reemplazar la etiqueta pública inyectada en app.js. Sin esto, cada cambio
    # de etiqueta contaría como cambio real y la siguiente ejecución subiría la
    # versión otra vez, que a su vez cambiaría la etiqueta: un bump en cadena
    # sin que nadie hubiera tocado el código. Es el mismo motivo por el que ya
    # se normalizan APP_VERSION y _LOCAL_BUILD_HASH.
    text = re.sub(r"_PUBLIC_VERSION_STR\s*=\s*'(?:[^'\\]|\\.)*'", "_PUBLIC_VERSION_STR = 'X'", text)
    text = re.sub(r'_PUBLIC_VERSION_STR\s*=\s*null', "_PUBLIC_VERSION_STR = 'X'", text)
    # Reemplazar _LOCAL_BUILD_HASH = 'cualquier-cosa' (para que el hash inyectado
    # por build.py no cuente como cambio en la próxima ejecución).
    text = re.sub(r"_LOCAL_BUILD_HASH\s*=\s*'(?:[^'\\]|\\.)*'", "_LOCAL_BUILD_HASH = 'X'", text)
    text = re.sub(r'_LOCAL_BUILD_HASH\s*=\s*null', "_LOCAL_BUILD_HASH = 'X'", text)
    # Reemplazar la versión en version.json (por si se incluye)
    text = re.sub(r'"version"\s*:\s*\d+', '"version": X', text)
    text = re.sub(r'"versionStr"\s*:\s*"v\d+(?:\.\d+)?"', '"versionStr": "vX"', text)
    text = re.sub(r'"build"\s*:\s*\d+', '"build": X', text)
    text = re.sub(r'"hash"\s*:\s*"(?:[^"\\]|\\.)*"', '"hash": "X"', text)
    text = re.sub(r'"hashFull"\s*:\s*"(?:[^"\\]|\\.)*"', '"hashFull": "X"', text)
    text = re.sub(r'"releasedAt"\s*:\s*"[^"]*"', '"releasedAt": "X"', text)
    return text.encode('utf-8')


def compute_hash():
    """Calcula un hash SHA-256 combinado de todos los archivos críticos,
    normalizando el contenido para ignorar bumps de versión automáticos."""
    h = hashlib.sha256()
    for fname in CRITICAL_FILES:
        p = ROOT / fname
        if not p.exists():
            print(f'  ⚠️  ADVERTENCIA: {fname} no existe, se omite del hash')
            continue
        raw = p.read_bytes()
        normalized = normalize_content(raw, fname)
        # Incluir el nombre del archivo en el hash para que renombrar también cuente
        h.update(fname.encode('utf-8'))
        h.update(b'\x00')
        h.update(normalized)
        h.update(b'\x00')
    return h.hexdigest()[:16]  # 16 chars = 64 bits, suficiente


def read_current_version():
    """Lee la versión actual de version.json. Devuelve (version, hash) o (None, None)."""
    if not VERSION_FILE.exists():
        return None, None
    try:
        data = json.loads(VERSION_FILE.read_text(encoding='utf-8'))
        return data.get('version'), data.get('hash')
    except Exception as e:
        print(f'  ⚠️  version.json corrupto: {e}')
        return None, None


def write_version_json(new_version, new_hash, changelog=None):
    """Escribe version.json con la nueva versión y hash."""
    if changelog is None:
        changelog = [f'Actualización automática · build {new_hash[:8]}']
    data = {
        # 'version' es lo que compara checkVersion(): el contador, siempre al alza.
        'version': new_version,
        # 'versionStr' es solo para enseñar (banner y badge). Que sea la etiqueta
        # pública no afecta a la comparación, que usa 'version'.
        'versionStr': public_label(new_version),
        # Número de publicación, a la vista para soporte: si alguien dice "tengo
        # la v1.3", aquí se ve a qué build corresponde.
        'build': new_version,
        'hash': new_hash,
        'hashFull': new_hash,
        'releasedAt': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'files': CRITICAL_FILES,
        'changelog': changelog
    }
    VERSION_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8'
    )
    print(f'  ✓ version.json actualizado → v{new_version} (hash {new_hash[:8]})')


def update_sw_js(new_version):
    """Actualiza APP_VERSION y CACHE en sw.js."""
    p = ROOT / 'sw.js'
    content = p.read_text(encoding='utf-8')
    content = re.sub(
        r"const APP_VERSION\s*=\s*'\d+';",
        f"const APP_VERSION  = '{new_version}';",
        content
    )
    content = re.sub(
        r"const CACHE\s*=\s*'axontech-v\d+';",
        f"const CACHE = 'axontech-v{new_version}';",
        content
    )
    p.write_text(content, encoding='utf-8')
    print(f'  ✓ sw.js actualizado → APP_VERSION={new_version}, CACHE=axontech-v{new_version}')


def update_app_js(new_version, new_hash):
    """Actualiza const APP_VERSION y _LOCAL_BUILD_HASH en app.js."""
    p = ROOT / 'app.js'
    content = p.read_text(encoding='utf-8')
    content = re.sub(
        r"const APP_VERSION\s*=\s*\d+;",
        f"const APP_VERSION = {new_version};",
        content
    )
    # Inyectar el hash local para que checkVersion() pueda comparar hashes
    # además de números de versión.
    content = re.sub(
        r"let _LOCAL_BUILD_HASH\s*=\s*(null|'[^']*'|\"[^\"]*\");",
        f"let _LOCAL_BUILD_HASH = '{new_hash}';",
        content
    )
    # Etiqueta pública del badge — cosmética, no interviene en la comparación.
    content = re.sub(
        r"let _PUBLIC_VERSION_STR\s*=\s*(null|'[^']*'|\"[^\"]*\");",
        f"let _PUBLIC_VERSION_STR = '{public_label(new_version)}';",
        content
    )
    p.write_text(content, encoding='utf-8')
    print(f'  ✓ app.js actualizado → APP_VERSION={new_version} ({public_label(new_version)}), _LOCAL_BUILD_HASH={new_hash[:8]}')


def update_html_query_version(html_file, new_version):
    """Actualiza ?v=N en las referencias a app.css, app.js y app.min.js."""
    p = ROOT / html_file
    content = p.read_text(encoding='utf-8')
    # Reemplazar ./app.css?v=N, ./app.js?v=N y ./app.min.js?v=N (v211)
    content = re.sub(
        r'\./app\.css\?v=\d+',
        f'./app.css?v={new_version}',
        content
    )
    content = re.sub(
        r'\./app\.min\.js\?v=\d+',
        f'./app.min.js?v={new_version}',
        content
    )
    content = re.sub(
        r'\./app\.js\?v=\d+',
        f'./app.js?v={new_version}',
        content
    )
    # El badge enseña la etiqueta pública, no el contador.
    # El patrón acepta 'v\d+(\.\d+)?' para reconocer tanto el formato viejo (v62)
    # como el nuevo (v1.0); con solo `v\d+` dejaría de casar en cuanto la etiqueta
    # llevara punto y el badge se quedaría congelado en el número antiguo.
    content = re.sub(
        r'(<span[^>]*id="versionBadge"[^>]*>)v\d+(?:\.\d+)?(</span>)',
        rf'\g<1>{public_label(new_version)}\g<2>',
        content
    )
    p.write_text(content, encoding='utf-8')
    print(f'  ✓ {html_file} actualizado → ?v={new_version} en app.css y app.min.js')


def regenerate_app_min(new_version):
    """v211 · Regenera app.min.js a partir de app.js.

    index.html y admin.html ya no cargan app.js: cargan app.min.js, una copia
    minificada (−47% de peso, sin comentarios) que baja y se parsea mucho más
    rápido en el móvil. El fuente SIEMPRE es app.js — este paso solo produce
    su copia de producción, igual que hace cualquier empaquetador.

    Si Node/terser no está disponible en la máquina (o falla), se copia app.js
    tal cual: la app sigue funcionando idéntica, solo pesa más. Nada de esto
    rompe la build nunca.
    """
    import shutil
    import subprocess
    src, dst = ROOT / 'app.js', ROOT / 'app.min.js'
    if not src.exists():
        print('  ⚠️  app.js no existe — no se puede generar app.min.js')
        return
    min_ok = False
    try:
        r = subprocess.run(
            ['npx', '--yes', 'terser', str(src), '-o', str(dst),
             '-c', 'passes=2', '-m'],
            cwd=str(ROOT), capture_output=True, text=True, timeout=300
        )
        min_ok = (r.returncode == 0 and dst.exists()
                  and dst.stat().st_size > 0)
        if not min_ok:
            print('  ⚠️  terser falló — app.min.js será copia directa de app.js')
    except FileNotFoundError:
        print('  · Node/npx no está en esta máquina — app.min.js = copia de app.js')
    except subprocess.TimeoutExpired:
        print('  · terser tardó demasiado — app.min.js = copia de app.js')
    if not min_ok:
        shutil.copyfile(src, dst)
    origen = 'minificado con terser' if min_ok else 'copia sin minificar'
    print(f'  ✓ app.min.js regenerado ({origen}): '
          f'{dst.stat().st_size:,} bytes · ?v={new_version}')


def main():
    print('═══════════════════════════════════════════════════════')
    print('  AXONTECH · AUTO-VERSION BUILD')
    print('═══════════════════════════════════════════════════════')
    print()

    # 1. Calcular hash actual de los archivos críticos
    print('1. Calculando hash de archivos críticos...')
    for f in CRITICAL_FILES:
        p = ROOT / f
        size = p.stat().st_size if p.exists() else 0
        print(f'   · {f:20s} {size:>8,} bytes')
    current_hash = compute_hash()
    print(f'   Hash combinado: {current_hash}')
    print()

    # 2. Leer versión y hash guardados
    print('2. Leyendo versión actual...')
    current_version, saved_hash = read_current_version()
    if current_version is None:
        current_version = 0
        print('   No hay version.json previo. Empezando desde v1.')
    else:
        print(f'   Versión guardada: v{current_version} (hash {saved_hash[:8] if saved_hash else "???"})')
    print()

    # 3. Comparar hashes
    print('3. Comparando hashes...')
    if saved_hash == current_hash and current_version > 0:
        print('   ✅ Sin cambios. Los archivos críticos son idénticos a la última build.')
        print(f'   Versión actual: v{current_version}')
        print()
        print('   Si quieres forzar una nueva versión, borra version.json y vuelve a ejecutar.')
        return 0
    print('   ⚠️  Detectados cambios en los archivos críticos.')
    print()

    # 4. Incrementar versión
    new_version = int(current_version) + 1
    print(f'4. Nueva versión: v{new_version}')
    print()

    # 5. Actualizar todos los archivos sincronizados
    print('5. Actualizando archivos...')
    write_version_json(new_version, current_hash)
    update_sw_js(new_version)
    update_app_js(new_version, current_hash)
    update_html_query_version('index.html', new_version)
    update_html_query_version('admin.html', new_version)
    regenerate_app_min(new_version)   # v211: app.min.js SIEMPRE sale de app.js
    print()

    print('═══════════════════════════════════════════════════════')
    print(f'  ✅ BUILD COMPLETADA · v{new_version}')
    print('═══════════════════════════════════════════════════════')
    print()
    print('  Próximos pasos:')
    print('   1. Sube TODA la carpeta AXONTECH-main/ al servidor')
    print('   2. Los usuarios verán el banner "Nueva versión disponible"')
    print('      automáticamente en ~5 minutos (o al tocar el badge v' + str(new_version) + ')')
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
