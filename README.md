# IslaDock

**Un dock en forma de isla para GNOME Shell.**
Creado y diseñado por **Frank Molina**.

En reposo, IslaDock es una cápsula pequeña en el borde inferior de la pantalla que
avisa qué apps están abiertas, qué suena y cuánto falta. Al acercar el mouse se
convierte en el dock completo.

## Funciones

- **Isla que se expande**: puntos de color por cada app abierta, respiración suave en reposo.
- **Música** (MPRIS): barras que se mueven mientras suena; carátula y controles al abrir la isla.
- **Notificaciones flotantes**: cada notificación aparece sola arriba en el centro, con el aspecto de la isla, y se va sola. También el aviso «Descarga lista».
- **No molestar** con un clic largo sobre la isla.
- **Gestos**: rueda = volumen, Shift + rueda = cambiar canción, clic central = pausa,
  arrastrar hacia arriba = aplicaciones.
- **Búsqueda rápida** (Ctrl + Espacio): apps, archivos recientes y cuentas.
- **Temporizador y Pomodoro** (clic derecho sobre la isla), con pausa y detener en la misma isla.
- **Grabación de pantalla**: mientras grabas, una cápsula roja con el tiempo y el botón para detenerla.
- **Portapapeles** (Super + V): historial de lo copiado (texto, enlaces, colores e imágenes), con búsqueda y fijados.
- **Vista previa de ventanas** al dejar el mouse sobre una app (se puede apagar).
- **Progreso de tareas** de las apps que lo publican.
- **Pila de descargas**: tus últimos archivos en cascada diagonal, en cuadrícula o en una lista minimalista.
- **Carpetas de Archivos**: clic en Archivos y tienes a mano Descargas, Documentos, Imágenes, Música, Vídeos y las que añadas.
- **Botón de aplicaciones** (cuatro puntos) para verlas todas; los botones de acento en tres estilos (Cristal tintado, Marcador lateral, Hoja); la isla se queda visible en el cajón de aplicaciones.
- **Fondo desenfocado en el cajón**: tu fondo de pantalla, desenfocado, detrás de las aplicaciones y de Actividades.
- **Panel Ajustes**: red, Bluetooth, modo de energía, luz nocturna, estilo oscuro, volumen, captura, bloquear, cerrar sesión, reiniciar y apagar.
- **Cafeína**: la pantalla no se apaga ni el equipo se suspende (en el panel Ajustes).
- **Mayúsculas**: para teclados sin luz de Bloq Mayús, un pequeño ⇪ en la isla mientras están activas.
- **Reloj de escritorio**: hora y fecha sobre el fondo de pantalla en cuatro estilos (Línea viva, Lateral acento, Semana fluida, Arco del día), arriba, al centro o abajo (Preferencias → Escritorio).
- **Sin barra superior** (opcional, encendido por defecto): todo queda en la isla y el panel Ajustes.
- **Lo que se perdía sin la barra**: batería, avisos de micrófono, cámara, ubicación y pantalla compartida, idioma del teclado, espacios de trabajo, y un calendario con recordatorios (Super + M).
- **Reloj lateral**: escondido en el borde de la pantalla; al llevar el mouse sale la hora en cuatro estilos (Editorial, Isla con semana, Línea del día, Horizonte), también sobre ventanas maximizadas.
- **Dock**: un punto por ventana abierta, número de mensajes sin leer, acción al hacer clic en la app activa (minimizar, pasar de ventana o miniaturas), Super + 1…9, elegir el monitor.
- **Sonido**: elegir la salida (parlantes, audífonos, HDMI…) y silenciar el micrófono en el panel Ajustes; con varios reproductores, clic derecho en la música para elegir cuál.
- **Calma**: con batería o en modo Ahorro se apagan los efectos costosos; respeta «Reducir animaciones» de GNOME.
- **Copia de la configuración**: exportar e importar todos los ajustes.
- **Idiomas**: español e inglés (`po/`; para añadir uno, copia `po/en.po` y ejecuta `python3 po/traducir.py mo`).
- **Pieles**: Clásica, Clásica oscura y Aurora.
- Tus propios íconos: elige tema o pon archivos en `~/.icons/isla-dock`.

## Requisitos

GNOME Shell 48, 49 y 50.

## Instalar

Desde [extensions.gnome.org](https://extensions.gnome.org) (cuando esté publicada), o a mano:

    git clone https://github.com/FrankM03-code/IslaDock.git
    cd IslaDock
    ./install.sh

Después reinicia GNOME y actívala con `gnome-extensions enable isla-dock@frankm`.
Los ajustes están en *Extensiones → IslaDock → Configuración*.

## Apoya a IslaDock

Si IslaDock te es útil, puedes apoyar su desarrollo con una donación voluntaria:
[Donar con PayPal](https://paypal.me/frankmolina29). También está el botón en Preferencias → Acerca de.

## Licencia

GNU General Public License 2.0 o posterior. Consulta el archivo `LICENSE`.

© 2026 Frank Molina
