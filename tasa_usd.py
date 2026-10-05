#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AXONTECH · Lector de la tasa informal del dólar

Esto NO se ejecuta en el teléfono: lo lanza GitHub Actions cada pocas horas
(.github/workflows/tasa-usd.yml) y deja el resultado en `tasa.json`, al lado de
`version.json`. La app se lo baja de su propia dirección.

¿Por qué dar este rodeo en vez de que el móvil consulte la web de tasas?
Porque el navegador solo deja LEER otra web si esa web lo autoriza (CORS), y una
tienda o un periódico normalmente no lo hacen: la petición se corta en el propio
teléfono. Aquí corremos en un servidor de GitHub, donde esa restricción no
existe, no hay bloqueos de país y la clave —si se usa— vive en los secretos del
repositorio y no dentro de una página pública.

Se prueban varias fuentes en orden y se deja escrito en el registro qué contestó
cada una. Si ninguna sirve, NO se escribe nada: la app sigue enseñando el último
valor bueno con su fecha, que es mejor que un dato inventado.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

# Rango de cordura. La tasa informal cubana se mueve en cientos de CUP; si algo
# devuelve 0.0091 (la conversión al revés) o 99999, es que hemos leído mal.
# 17/08/2026: la banda era 20-5000 y por ahí se coló un 116 —el precio de un
# artículo de la tienda— que se publicó como si fuera la tasa. Un rango tan
# ancho no filtra nada. Se puede ajustar sin tocar código con las variables
# TASA_MIN / TASA_MAX del repositorio.
TASA_MIN = float(os.environ.get('TASA_MIN') or 250)
TASA_MAX = float(os.environ.get('TASA_MAX') or 2500)

# ── El freno de verdad: el anclaje al último valor conocido ──────────────────
# Ninguna regla sobre el formato de la página va a cubrir todos los casos: hoy
# es un precio junto a "USD", mañana será otra cosa. Lo que SÍ se sabe siempre
# es que una tasa real no salta de 665 a 116 de un día para otro. Así que se
# compara con lo último publicado y se rechaza lo que se aleje demasiado.
# La banda se ensancha con la antigüedad del ancla (si llevamos días sin poder
# leer, el mercado ha tenido tiempo de moverse) y se ignora si el ancla es muy
# vieja. TASA_FORZAR=1 la salta del todo, que es como se reancla a mano tras un
# movimiento de verdad.
BANDA_BASE = 0.25          # 25 % de salto permitido con el ancla recién puesta
BANDA_POR_DIA = 0.08       # se ensancha un 8 % por cada día de antigüedad
BANDA_TOPE = 0.60
ANCLA_CADUCA_DIAS = 30

SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tasa.json')
TIMEOUT = 25
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0 Safari/537.36')

# Las claves donde estas webs suelen meter el número, en orden de preferencia:
# la mediana es la cifra que elToque publica como tasa del día.
# Ojo con lo que se mete aquí: 'price' estaba en la lista y es justo la clave que
# usa una tienda para el precio de un artículo. Si un día la API deja de traer
# 'median', caeríamos en 'price' sin enterarnos — el mismo error que en el HTML,
# pero en JSON.
CLAVES_VALOR = ('median', 'mediana', 'tasa', 'rate', 'value', 'avg', 'close', 'last')
CONTENEDORES = ('tasas', 'rates', 'x_rates', 'data', 'result', 'results', 'items',
                'props', 'pageProps', 'initialState', 'dehydratedState', 'queries', 'state')

# ── Por qué ya no se lee la web de una tienda ────────────────────────────────
# 17/08/2026, sacado del registro de Actions de ese día:
#
#     · tiendamax.org: HTTP 200, 144547 bytes
#       · candidato 116.0 (junto a "USD"): …💱 USD -- MN … WhatsApp 116…
#     ✅ Tasa encontrada: 116.0
#
# Fíjate en lo que hay junto a USD: dos guiones. La tienda pinta su tasa con
# JavaScript en el navegador, así que en el HTML que descarga un servidor el
# número NO EXISTE todavía — solo está el hueco "--". El 116 que se llevó el
# lector era el precio de un artículo que venía más adelante en la página.
#
# O sea: tiendamax nunca falló. Devolvía 200 perfectamente. Lo que no tenía era
# el dato. Y como los dos espejos JSON contestaban 401 (ver abajo), la tienda
# era la ÚNICA fuente que quedaba en pie, y publicaba un precio como si fuera la
# tasa cada 3 horas. Por eso "fallaba tanto": no era mala suerte, era la única
# que respondía y la única incapaz de responder bien.
#
# Una página así no se arregla con mejores expresiones regulares. Se quita.
# Lo que sí se puede leer sin navegador es lo que el servidor manda ya escrito:
# el JSON que Next.js deja incrustado en la página (__NEXT_DATA__) o los datos
# estructurados. De eso se encarga extraer_de_html_incrustado().
RE_NEXT_DATA = re.compile(
    r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S | re.I)
RE_JSON_ISLA = re.compile(
    r'<script[^>]+type="application/(?:ld\+)?json"[^>]*>(.*?)</script>', re.S | re.I)


def log(msg):
    print(msg, flush=True)


def _num(v):
    """Devuelve el número si está dentro del rango razonable, o None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        v = v.strip().replace(',', '.')
        if not re.fullmatch(r'-?\d+(\.\d+)?', v):
            return None
        v = float(v)
    if isinstance(v, (int, float)) and TASA_MIN <= float(v) <= TASA_MAX:
        return float(v)
    return None


def _valor_de_moneda(o):
    if not isinstance(o, dict):
        return None
    for k in CLAVES_VALOR:
        n = _num(o.get(k))
        if n:
            return n
    return None


# v130: el euro. elToque lo publica en la misma respuesta que el dólar, con la
# clave ECU (su nombre para el euro); otras fuentes lo llaman EUR.
ALIAS_MONEDA = {
    'USD': ('USD', 'usd', 'Usd'),
    'EUR': ('ECU', 'EUR', 'ecu', 'eur', 'Ecu', 'Eur'),
}


def extraer_de_json(j, prof=0, moneda='USD'):
    """Busca el valor del USD (o de `moneda`) sin dar por hecho una estructura exacta.

    Estas webs cambian de formato sin avisar. Casar una forma concreta
    significaría romperse en silencio el día del cambio; buscar por las claves
    donde suele venir y validar el rango, no.
    """
    if j is None or prof > 6:
        return None
    alias = ALIAS_MONEDA.get(moneda, (moneda,))
    if isinstance(j, list):
        # El dato más reciente suele ir al final.
        for item in reversed(j):
            v = extraer_de_json(item, prof + 1, moneda)
            if v:
                return v
        return None
    if not isinstance(j, dict):
        return None
    cur = str(j.get('currency') or j.get('cur') or j.get('moneda') or '').upper()
    if cur in {a.upper() for a in alias}:
        v = _valor_de_moneda(j)
        if v:
            return v
    for k in alias:
        if k in j:
            n = _num(j[k])
            if n:
                return n
            if isinstance(j[k], dict):
                # Ya sabemos que este objeto ES el del dólar: el número que lleve
                # dentro vale aunque no vuelva a etiquetarse como USD.
                v = _valor_de_moneda(j[k]) or extraer_de_json(j[k], prof + 1, moneda)
                if v:
                    return v
    for k in CONTENEDORES:
        if j.get(k) is not None:
            v = extraer_de_json(j[k], prof + 1, moneda)
            if v:
                return v
    return None


def extraer_de_html_incrustado(html):
    """Lee el JSON que la página trae dentro, no el texto que pinta.

    Muchas webs modernas (Next.js y parecidas) mandan sus datos ya escritos en
    un <script> —__NEXT_DATA__, JSON-LD— y el navegador los usa después para
    pintar. Ese JSON sí llega a un servidor, y viene etiquetado: se sabe que un
    número es la tasa del dólar porque está bajo la clave del dólar, no porque
    esté "cerca de la palabra USD" en la pantalla. Es la diferencia entre leer
    el dato y adivinarlo mirando por la ventana.
    """
    bloques = RE_NEXT_DATA.findall(html) + RE_JSON_ISLA.findall(html)
    if not bloques:
        log('      · la página no trae datos incrustados (los pinta con JavaScript)')
        return None
    log(f'      · {len(bloques)} bloque(s) de datos incrustados en la página')
    for bruto in bloques:
        try:
            v = extraer_de_json(json.loads(bruto.strip()))
        except Exception:
            continue
        if v:
            return v
    log('      · los datos incrustados no traen la tasa del USD')
    return None


def extraer_de_html_texto(html):
    """Último recurso: números en rango cerca de las palabras del dólar.

    Esto es EXACTAMENTE lo que publicó el 116, así que vuelve con una correa:
    quien llame a esto marca el valor como débil, y un valor débil solo se
    publica si el ancla lo respalda (ver main). Antes no había ancla y por eso
    un precio cualquiera pasaba por tasa; ahora, para colarse, un número tendría
    que estar además a menos de un 25 % de la última tasa buena — que ya no es
    un número cualquiera, es prácticamente la tasa.
    """
    texto = re.sub(r'<script\b.*?</script>|<style\b.*?</style>', ' ', html,
                   flags=re.S | re.I)
    texto = re.sub(r'<[^>]+>', ' ', texto)
    texto = re.sub(r'&nbsp;?', ' ', texto)
    texto = re.sub(r'\s+', ' ', texto)

    candidatos = []
    for m in re.finditer(r'\bUSD\b|\bd[oó]lar(?:es)?\b', texto, flags=re.I):
        marca = m.group(0).upper()
        ventana = texto[max(0, m.start() - 90): m.end() + 90]
        for num in re.finditer(r'\b(\d{2,4}(?:[.,]\d{1,2})?)\b', ventana):
            n = _num(num.group(1))
            if n:
                candidatos.append((marca, n, ventana.strip()))
    if not candidatos:
        log('      · tampoco hay números de tasa en el texto de la página')
        return None
    for marca, n, ctx in candidatos[:4]:
        log(f'      · candidato débil {n} (junto a "{marca}"): …{ctx[:120]}…')
    return candidatos[0][1]


def pedir(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        cuerpo = r.read().decode('utf-8', 'replace')
        return r.status, cuerpo


def leer_ancla():
    """Lee el último valor conocido y su timestamp de tasa.json."""
    try:
        with open(SALIDA, 'r', encoding='utf-8') as f:
            datos = json.load(f)
        valor = datos.get('valor')
        ts = datos.get('ts', 0)
        # Solo usamos el ancla si es un número válido y tiene timestamp.
        if isinstance(valor, (int, float)) and valor > 0 and ts > 0:
            return valor, ts
    except Exception:
        pass
    return None, None


def calcular_banda(valor_ancla, ts_ancla):
    """Calcula el rango aceptable relativo al ancla usando band-clamping.

    - Empieza con BANDA_BASE (25 % de movimiento)
    - Se ensancha BANDA_POR_DIA (8 %) por cada día de antigüedad
    - Topa en BANDA_TOPE (60 % máximo)
    - Si el ancla es más vieja que ANCLA_CADUCA_DIAS, retorna None (ancla inútil)
    """
    ahora_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    dias_transcurridos = (ahora_ts - ts_ancla) / (1000 * 60 * 60 * 24)

    if dias_transcurridos > ANCLA_CADUCA_DIAS:
        log(f'      · ancla expirada ({dias_transcurridos:.1f} días): se ignora')
        return None

    # Banda = base + (8% por día), tope en 60%
    banda = BANDA_BASE + (dias_transcurridos * BANDA_POR_DIA)
    banda = min(banda, BANDA_TOPE)

    margen = valor_ancla * banda
    minimo = valor_ancla - margen
    maximo = valor_ancla + margen

    return minimo, maximo, banda


def validar_con_ancla(valor, valor_ancla, ts_ancla):
    """Valida un valor contra el ancla.

    Retorna True si:
    - No hay ancla válida (primera vez o expirada)
    - El valor está dentro de la banda permitida
    - TASA_FORZAR=1 (permite override manual)
    """
    if valor_ancla is None:
        log('      · sin ancla anterior: valor aceptado')
        return True

    if os.environ.get('TASA_FORZAR') == '1':
        log('      · TASA_FORZAR=1: banda saltada')
        return True

    banda_resultado = calcular_banda(valor_ancla, ts_ancla)
    if banda_resultado is None:
        log('      · ancla expirada, valor aceptado')
        return True

    minimo, maximo, banda_pct = banda_resultado

    if minimo <= valor <= maximo:
        pct_cambio = abs(valor - valor_ancla) / valor_ancla * 100
        log(f'      · dentro de banda ({banda_pct*100:.0f}%, cambio {pct_cambio:.1f}%): aceptado')
        return True

    pct_cambio = abs(valor - valor_ancla) / valor_ancla * 100
    log(f'      ✗ FUERA de banda ({banda_pct*100:.0f}%, cambio {pct_cambio:.1f}%): rechazado')
    log(f'        ancla={valor_ancla}, nuevo={valor}, rango=[{minimo:.0f}, {maximo:.0f}]')
    return False


# Los espejos públicos contestaron 401 todo el 17/08. Un 401 en una API abierta
# suele significar "no vienes de mi web": comprueban Referer/Origin para que solo
# la use su propia página. Se mandan, por si es eso; si de verdad han cerrado la
# API, el 401 seguirá y quedará escrito en el registro.
CABECERAS_NAVEGADOR = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Referer': 'https://cambiocuba.money/',
    'Origin': 'https://cambiocuba.money',
}

# Para las páginas web: un 403 suele venir de un portero (Cloudflare) que mira si
# la petición se parece a la de un navegador de verdad. Con las cabeceras
# completas a veces pasa. Si aun así devuelve 403, es que bloquea por IP —los
# servidores de GitHub están en listas de centros de datos— y no hay cabecera que
# lo arregle.
CABECERAS_PAGINA = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
}


def fuentes():
    hoy = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    lista = []
    clave = os.environ.get('ELTOQUE_API_KEY', '').strip()
    if clave:
        lista.append((
            'elToque (API oficial)',
            f'https://tasas.eltoque.com/v1/trmi?date_from={hoy}%2000:00:01&date_to={hoy}%2023:59:01',
            {'Authorization': 'Bearer ' + clave},
            'json',
        ))
    else:
        # Esto no es un detalle menor: sin clave, la fuente BUENA ni se intenta y
        # todo el peso recae en espejos que pueden cerrarse cualquier día — que es
        # exactamente lo que pasó. La clave se pide gratis en eltoque.com y se
        # guarda en Settings → Secrets → Actions como ELTOQUE_API_KEY.
        log('· Sin ELTOQUE_API_KEY: se salta la fuente oficial y quedamos a merced de los espejos.')
    lista.append(('elToque (espejo cambiocuba)',
                  'https://api.cambiocuba.money/api/v1/x-rates-by-date-range-history?trmi=true&cur=USD&period=1',
                  CABECERAS_NAVEGADOR, 'json'))
    lista.append(('elToque (espejo cambiocuba)',
                  'https://api.cambiocuba.money/api/v1/x-rates', CABECERAS_NAVEGADOR, 'json'))
    # La web de elToque publica sus tasas y, al estar hecha con Next.js, manda el
    # dato ya escrito dentro de la página. No hace falta clave ni navegador.
    lista.append(('elToque (web)',
                  'https://eltoque.com/tasas-de-cambio-de-moneda-en-cuba-hoy',
                  CABECERAS_PAGINA, 'auto'))
    lista.append(('elToque (web, www)',
                  'https://www.eltoque.com/tasas-de-cambio-de-moneda-en-cuba-hoy',
                  CABECERAS_PAGINA, 'auto'))
    # elveedor.com estuvo aquí unas horas. Responde 200, sí, pero es un dominio
    # EN VENTA: la página solo dice "Price $1,888 USD - Buy Now". El lector sacó
    # de ahí un 888 y lo habría publicado como tasa — el 116 otra vez, con otro
    # disfraz. Esta vez lo paró el ancla (888 está a un 33 % de 665, fuera de la
    # banda del 26 %), y por eso quedó registrado en vez de acabar en la app.
    # Es la prueba de que el ancla no sobra: las páginas que se caen se notan,
    # las que contestan basura no.
    extra = os.environ.get('TASA_URL_EXTRA', '').strip()
    if extra:
        lista.append(('fuente propia', extra, CABECERAS_PAGINA, 'auto'))
    # Solo para el modo diagnóstico: lista de direcciones separadas por comas que
    # se quieren probar sin tocar el código. Así se puede buscar una fuente nueva
    # desde el botón de Actions en vez de a ciegas.
    for i, u in enumerate(
            [x.strip() for x in os.environ.get('TASA_URLS_PRUEBA', '').split(',') if x.strip()]):
        lista.append((f'prueba {i + 1}', u, CABECERAS_PAGINA, 'auto'))
    # tiendamax.org estuvo aquí como última reserva y fue justo quien publicó el
    # 116. Ver la nota larga arriba: su tasa la pinta el navegador, así que en el
    # HTML solo hay "USD --" y cualquier número que se saque de ahí es otra cosa.
    return lista


def main():
    log('AXONTECH · buscando la tasa del dólar')
    # TASA_DIAG=1 prueba TODAS las fuentes y no escribe nada. Sirve para ver de
    # un vistazo, desde el botón manual de Actions, cuáles siguen vivas — en vez
    # de enterarse solo de la primera que contesta.
    diagnostico = os.environ.get('TASA_DIAG') == '1'
    if diagnostico:
        log('· MODO DIAGNÓSTICO: se prueban todas las fuentes y no se escribe tasa.json')
        ancla, ts_ancla = leer_ancla()
        log(f'· ancla actual: {ancla}')
        vivas = 0
        for nombre, url, headers, tipo in fuentes():
            log(f'· {nombre}: {url}')
            try:
                estado, cuerpo = pedir(url, headers)
            except urllib.error.HTTPError as e:
                log(f'    ✗ HTTP {e.code}')
                continue
            except Exception as e:
                log(f'    ✗ {type(e).__name__}: {e}')
                continue
            log(f'    → HTTP {estado}, {len(cuerpo)} bytes')
            valor = None
            if tipo in ('json', 'auto'):
                try:
                    valor = extraer_de_json(json.loads(cuerpo))
                except Exception:
                    pass
            debil = False
            if valor is None and tipo in ('html', 'auto'):
                valor = extraer_de_html_incrustado(cuerpo)
            if valor is None and tipo in ('html', 'auto'):
                valor = extraer_de_html_texto(cuerpo)
                debil = valor is not None
            if valor:
                vivas += 1
                dentro = validar_con_ancla(valor, ancla, ts_ancla)
                etiqueta = 'del texto (débil)' if debil else 'de datos (fiable)'
                log(f'    ✅ leería {valor} {etiqueta} · {"pasa" if dentro else "la rechaza"} el ancla')
            else:
                log('    ✗ respondió, pero no trae la tasa')
        log(f'· Resumen: {vivas} fuente(s) utilizable(s).')
        return 0

    for nombre, url, headers, tipo in fuentes():
        log(f'· {nombre}: {url}')
        try:
            estado, cuerpo = pedir(url, headers)
        except urllib.error.HTTPError as e:
            log(f'    ✗ HTTP {e.code}')
            continue
        except Exception as e:
            log(f'    ✗ {type(e).__name__}: {e}')
            continue
        log(f'    → HTTP {estado}, {len(cuerpo)} bytes')

        valor = None
        parseado = None
        if tipo in ('json', 'auto'):
            try:
                parseado = json.loads(cuerpo)
                valor = extraer_de_json(parseado)
            except Exception as e:
                if tipo == 'json':
                    log(f'    ✗ no es JSON válido: {e}')
                    log(f'      primeros 200 caracteres: {cuerpo[:200]!r}')
        debil = False
        if valor is None and tipo in ('html', 'auto'):
            valor = extraer_de_html_incrustado(cuerpo)
        if valor is None and tipo in ('html', 'auto'):
            # Raspar el texto es lo que produjo el 116. Se permite, pero marcado:
            # abajo se exige que el ancla lo respalde.
            valor = extraer_de_html_texto(cuerpo)
            debil = valor is not None

        if valor:
            valor_redondeado = round(valor, 2)
            # Validar contra el ancla antes de escribir
            valor_ancla, ts_ancla = leer_ancla()
            if debil and valor_ancla is None:
                # Sin ancla no hay con qué contrastar, y un número sacado del
                # texto sin contrastar es justo el 116 otra vez. Se descarta: es
                # preferible quedarse con la tasa vieja y su fecha en naranja.
                log('    ✗ valor del texto sin ancla que lo respalde — no se publica')
                continue
            if debil and os.environ.get('TASA_FORZAR') == '1':
                # Forzar sirve para reanclar a mano con una fuente FIABLE, no
                # para bendecir un número raspado de una página cualquiera.
                log('    ✗ TASA_FORZAR no se aplica a valores del texto — no se publica')
                continue
            if not validar_con_ancla(valor_redondeado, valor_ancla, ts_ancla):
                log(f'    ✗ valor rechazado por band-clamping (ancla={valor_ancla})')
                continue

            datos = {
                'valor': valor_redondeado,
                'fuente': nombre + (' · leído del texto' if debil else ''),
                'ts': int(datetime.now(timezone.utc).timestamp() * 1000),
                'actualizado': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
            }
            # v130: el euro, si la misma respuesta lo trae. Solo de datos (JSON),
            # nunca raspado del texto, y con una cordura propia: un euro vale
            # algo más que un dólar, no la mitad ni el triple.
            eur = extraer_de_json(parseado, moneda='EUR') if parseado is not None else None
            if eur and valor_redondeado * 0.85 <= eur <= valor_redondeado * 1.6:
                datos['eur'] = round(eur, 2)
                datos['eurTs'] = datos['ts']
                log(f'    ✅ euro: {datos["eur"]} CUP por 1 EUR')
            else:
                # Sin euro nuevo se conserva el anterior con SU fecha: la app
                # enseña cuándo es, en vez de quedarse sin nada.
                try:
                    with open(SALIDA, encoding='utf-8') as f:
                        viejo = json.load(f)
                    if viejo.get('eur'):
                        datos['eur'] = viejo['eur']
                        datos['eurTs'] = viejo.get('eurTs') or viejo.get('ts')
                except Exception:
                    pass
                log(f'    · euro: no vino en esta respuesta ({eur!r})')
            with open(SALIDA, 'w', encoding='utf-8') as f:
                json.dump(datos, f, ensure_ascii=False, indent=2)
                f.write('\n')
            log(f'✅ Tasa encontrada: {datos["valor"]} CUP por 1 USD ({nombre})')
            return 0
        log('    ✗ respondió, pero no se pudo leer la tasa')

    # Sin dato bueno no se toca el archivo: la app seguirá enseñando el último
    # valor conocido con su fecha en naranja, que avisa de que está viejo.
    log('⚠ Ninguna fuente dio un valor válido. No se toca tasa.json.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
