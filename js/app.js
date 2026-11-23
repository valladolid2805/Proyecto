/**
 * app.js
 * ----------------------------------------------------------------------------
 * Utilidades compartidas por TODAS las páginas:
 *   - Formato de fechas, horas, duraciones (segundos -> "1:30:00") y dinero.
 *   - Etiqueta de proyecto con su color (● Proyecto · Cliente).
 *   - Protección contra XSS al insertar texto en el HTML.
 *   - Notificaciones emergentes (toasts de Bootstrap).
 *   - Mensajes "flash" que sobreviven a un cambio de página.
 *   - Marcar el enlace activo del menú y el año del pie de página.
 */

/* ------------------------------- Ajustes ------------------------------- */

// Moneda del espacio de trabajo. Cada página llama a cargarAjustes() al iniciar.
let monedaSistema = 'MXN';

/** Lee los ajustes (empresa, moneda, tarifa general) de la base de datos */
async function cargarAjustes() {
  const config = await BD.obtenerConfiguracion();
  monedaSistema = config.moneda;
  return config;
}

/* ------------------------------- Formatos ------------------------------- */

/** 1234.5 -> "1,234.5" */
function formatearNumero(valor, decimales = 0) {
  return new Intl.NumberFormat('es-MX', { minimumFractionDigits: decimales, maximumFractionDigits: decimales }).format(valor || 0);
}

/** 1500 -> "$1,500.00" (en la moneda configurada: MXN, USD o EUR) */
function formatearMoneda(valor) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: monedaSistema }).format(valor || 0);
}

/**
 * Segundos -> "H:MM:SS", el formato de Clockify.
 * 5400 -> "1:30:00" | 75 -> "0:01:15" | 0 -> "0:00:00"
 */
function formatearDuracion(segundos) {
  const total = Math.max(0, Math.floor(segundos || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Segundos -> horas con dos decimales: 5400 -> "1.50" (para el CSV y los promedios) */
function horasDecimales(segundos) {
  return ((segundos || 0) / 3600).toFixed(2);
}

/** "2026-11-15 10:30:00" -> "15 nov 2026, 10:30" */
function formatearFecha(textoFecha) {
  if (!textoFecha) return '—';
  const fecha = new Date(textoFecha.replace(' ', 'T'));
  if (Number.isNaN(fecha.getTime())) return textoFecha;
  return fecha.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "2026-11-17" -> "lun, 17 nov 2026" */
function formatearDia(textoFecha) {
  if (!textoFecha) return '—';
  const fecha = new Date(`${textoFecha}T00:00:00`);
  if (Number.isNaN(fecha.getTime())) return textoFecha;
  return fecha.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "2026-11-17" -> "Hoy", "Ayer" o "lun, 17 nov" (encabezados de cada día en el rastreador) */
function nombreDia(textoFecha) {
  if (textoFecha === BD.hoy()) return 'Hoy';
  if (textoFecha === BD.fechas.sumarDias(-1)) return 'Ayer';
  const fecha = new Date(`${textoFecha}T00:00:00`);
  return fecha.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "2026-11-17 09:05:00" -> "09:05" */
function horaDe(textoFechaHora) {
  return String(textoFechaHora || '').slice(11, 16);
}

/**
 * Escapa caracteres especiales de HTML.
 * Se usa SIEMPRE que se inserta texto del usuario con innerHTML, para que
 * si alguien escribe "<script>" como descripción, se muestre como texto y no se
 * ejecute (protección contra ataques XSS).
 */
function escaparHTML(texto) {
  return String(texto ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Lee un parámetro de la URL. Ej: reportes.html?proyecto=3 -> obtenerParametroURL('proyecto') = "3" */
function obtenerParametroURL(nombre) {
  return new URLSearchParams(window.location.search).get(nombre);
}

/* -------------------------- Proyectos -------------------------- */

/**
 * Etiqueta de un proyecto: punto de color + nombre (+ cliente en gris).
 * Recibe un objeto con proyecto_nombre, proyecto_color y cliente_nombre.
 * El nombre siempre se escribe: el color nunca es la única pista.
 */
function etiquetaProyecto(r) {
  if (!r.proyecto_nombre) return '<span class="text-body-secondary"><i class="bi bi-dash-circle"></i> Sin proyecto</span>';
  const modulo = r.modulo_nombre ? ` <span class="etiqueta-modulo"><i class="bi bi-chevron-right"></i> ${escaparHTML(r.modulo_nombre)}</span>` : '';
  const cliente = r.cliente_nombre ? ` <span class="text-body-secondary">· ${escaparHTML(r.cliente_nombre)}</span>` : '';
  return `<span class="punto-proyecto" style="--color-proyecto:${escaparHTML(r.proyecto_color)}"></span>` +
    `<span class="fw-medium">${escaparHTML(r.proyecto_nombre)}</span>${modulo}${cliente}`;
}

/**
 * Llena el <select> de módulos con los del proyecto elegido.
 * Si el proyecto no tiene módulos, el select queda deshabilitado con "Sin módulos".
 * extra: módulo que debe aparecer aunque esté archivado (al editar una entrada antigua).
 */
function llenarSelectModulos(select, modulos, proyectoId, extra = null) {
  const delProyecto = modulos.filter((m) => String(m.proyecto_id) === String(proyectoId));
  if (extra && !delProyecto.some((m) => m.id === extra.id)) delProyecto.push({ ...extra, nombre: `${extra.nombre} (archivado)` });
  select.innerHTML = '';
  select.add(new Option(delProyecto.length ? 'Sin módulo' : 'Sin módulos', ''));
  delProyecto.forEach((m) => select.add(new Option(m.nombre, m.id)));
  select.disabled = delProyecto.length === 0;
}

/**
 * Llena un <select> de proyectos agrupados por cliente (<optgroup>), conservando
 * la primera opción existente (ej. "Sin proyecto" o "Todos").
 */
function llenarSelectProyectos(select, proyectos) {
  const grupos = new Map();
  proyectos.forEach((p) => {
    const cliente = p.cliente_nombre || 'Sin cliente';
    if (!grupos.has(cliente)) grupos.set(cliente, []);
    grupos.get(cliente).push(p);
  });
  grupos.forEach((lista, cliente) => {
    const grupo = document.createElement('optgroup');
    grupo.label = cliente;
    lista.forEach((p) => {
      const opcion = new Option(p.nombre + (p.archivado ? ' (archivado)' : ''), p.id);
      opcion.dataset.facturable = p.facturable;
      grupo.appendChild(opcion);
    });
    select.appendChild(grupo);
  });
}

/** Llena un <select> con opciones { valor: texto } conservando la primera opción (ej. "Todos") */
function llenarSelect(select, opciones) {
  Object.entries(opciones).forEach(([valor, texto]) => select.add(new Option(texto, valor)));
}

/* ---------------------------- Notificaciones ---------------------------- */

/**
 * Muestra una notificación emergente (toast) en la esquina de la pantalla.
 * @param {string} mensaje
 * @param {'success'|'danger'|'warning'|'info'} tipo
 */
function mostrarAlerta(mensaje, tipo = 'success') {
  // Crear el contenedor de toasts la primera vez (manipulación del DOM)
  let contenedor = document.getElementById('contenedor-alertas');
  if (!contenedor) {
    contenedor = document.createElement('div');
    contenedor.id = 'contenedor-alertas';
    // Esquina inferior derecha: así no tapa el menú ni la barra del cronómetro
    contenedor.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    document.body.appendChild(contenedor);
  }

  const iconos = { success: 'bi-check-circle-fill', danger: 'bi-x-circle-fill', warning: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };

  const toast = document.createElement('div');
  toast.className = `toast align-items-center text-bg-${tipo} border-0`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">
        <i class="bi ${iconos[tipo] || iconos.info} me-1"></i> ${escaparHTML(mensaje)}
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>
    </div>`;

  contenedor.appendChild(toast);

  // Bootstrap se encarga de mostrarlo y ocultarlo después de 4 segundos
  const instancia = new bootstrap.Toast(toast, { delay: 4000 });
  instancia.show();

  // Al ocultarse se elimina del DOM para no acumular elementos
  toast.addEventListener('hidden.bs.toast', () => toast.remove());
}

/* ----------------------------- Mensajes flash --------------------------- */
/*
 * Problema: al iniciar sesión redirigimos a otra página, y cualquier alerta
 * mostrada antes de redirigir se pierde.
 * Solución: guardar el mensaje en sessionStorage y mostrarlo al cargar la
 * página siguiente.
 */

function guardarMensajeFlash(mensaje, tipo = 'success') {
  try {
    sessionStorage.setItem('mensajeFlash', JSON.stringify({ mensaje, tipo }));
  } catch {
    /* Si el navegador bloquea el almacenamiento, simplemente no se muestra */
  }
}

function mostrarMensajeFlash() {
  try {
    const guardado = sessionStorage.getItem('mensajeFlash');
    if (!guardado) return;
    sessionStorage.removeItem('mensajeFlash');
    const { mensaje, tipo } = JSON.parse(guardado);
    mostrarAlerta(mensaje, tipo);
  } catch {
    /* Ignorar errores de almacenamiento */
  }
}

/* ------------------------------ Navegación ------------------------------ */

/** Resalta en el menú el enlace de la página actual */
function marcarEnlaceActivo() {
  const pagina = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.navbar .nav-link').forEach((enlace) => {
    const esActivo = enlace.getAttribute('href') === pagina;
    enlace.classList.toggle('active', esActivo);
    if (esActivo) enlace.setAttribute('aria-current', 'page');
  });
}

/* --------------------- Se ejecuta en todas las páginas ------------------- */

document.addEventListener('DOMContentLoaded', () => {
  marcarEnlaceActivo();
  mostrarMensajeFlash();

  const anio = document.getElementById('anio-actual');
  if (anio) anio.textContent = new Date().getFullYear();
});
