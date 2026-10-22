# IslaDock

**Un dock en forma de isla para GNOME Shell.**
Creado y diseñado por **Frank Molina**.

En reposo, IslaDock es una cápsula pequeña en el borde inferior de la pantalla que
avisa qué apps están abiertas, qué suena y cuánto falta. Al acercar el mouse se
convierte en el dock completo.

## Funciones

- **Isla que se expande**: puntos de color por cada app abierta, respiración suave en reposo.
- **Música** (MPRIS): barras que se mueven mientras suena; carátula y controles al abrir la isla.
- **Avisos discretos**: las notificaciones asoman en la isla unos segundos.
- **No molestar** con un clic largo sobre la isla.
- **Gestos**: rueda = volumen, Shift + rueda = cambiar canción, clic central = pausa,
  arrastrar hacia arriba = aplicaciones.
- **Búsqueda rápida** (Ctrl + Espacio): apps, archivos recientes y cuentas.
- **Temporizador y Pomodoro** (clic derecho sobre la isla).
- **Vista previa de ventanas** al dejar el mouse sobre una app (se puede apagar).
- **Progreso de tareas** de las apps que lo publican.
- **Pila de descargas**: tus últimos archivos en cascada diagonal o en cuadrícula.
- **Botón Portal** para ver todas las aplicaciones.
- **Pieles**: Clásica (blanca u oscura), Vidrio oscuro (vidrio ahumado con efecto lupa) y Aurora, con transparencia ajustable.
- Tus propios íconos: elige tema o pon archivos en `~/.icons/isla-dock`.

## Requisitos

GNOME Shell 48.

## Instalar

Desde [extensions.gnome.org](https://extensions.gnome.org) (cuando esté publicada), o a mano:

    git clone https://github.com/FrankM03-code/IslaDock.git
    cd IslaDock
    ./install.sh

Después reinicia GNOME y actívala con `gnome-extensions enable isla-dock@frankm`.
Los ajustes están en *Extensiones → IslaDock → Configuración*.

## Licencia

GNU General Public License 2.0 o posterior. Consulta el archivo `LICENSE`.

© 2026 Frank Molina
