/**
 * rastreador.js
 * ----------------------------------------------------------------------------
 * Lógica del rastreador de tiempo (index.html), inspirado en Clockify.
 *
 *  MODO CRONÓMETRO
 *    1. Escribe "¿En qué estás trabajando?", elige proyecto y si es facturable ($).
 *    2. INICIAR  -> BD.iniciarCronometro() guarda una entrada SIN hora de fin.
 *    3. El reloj cuenta cada segundo (setInterval). Como la hora de inicio está en
 *       la base de datos, el cronómetro sigue corriendo aunque cambies de página
 *       o cierres el navegador.
 *    4. DETENER  -> BD.detenerCronometro() pone la hora de fin y la duración.
 *    Mientras corre, cambiar la descripción/proyecto/$ actualiza la entrada en curso.
 *
 *  MODO MANUAL
 *    Se indica hora de inicio, hora de fin y fecha -> AGREGAR -> BD.crearRegistro().
 *
 *  LISTA DE ENTRADAS
 *    Agrupadas por día con el total de cada día. Botones: ▶ continuar (inicia un
 *    cronómetro con los mismos datos), editar (modal) y eliminar (modal de confirmación).
 */

/* ------------------------- Estado de la página ------------------------- */
const CLAVE_MODO = 'controlTiempo.modo'; // recuerda el último modo usado (cronómetro / manual)

let proyectos = [];          // proyectos activos (para los <select>)
let modulos = [];            // módulos activos de todos los proyectos (se filtran por proyecto)
let corriendo = null;        // entrada en curso o null
let intervaloReloj = null;   // id del setInterval del reloj
let modo = 'cronometro';     // 'cronometro' | 'manual'
let limite = 40;             // cuántas entradas se muestran ("Cargar más" suma 40)
let entradaEditando = null;  // entrada abierta en el modal de edición
let entradaAEliminar = null;
let modalEntrada = null;
let modalEliminar = null;
const tituloOriginal = document.title;

// Elementos que se usan seguido
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', iniciarPagina);

async function iniciarPagina() {
  if (!Sesion.activa) return; // sin sesión: sesion.js ya está redirigiendo

  modalEntrada = new bootstrap.Modal($('modal-entrada'));
  modalEliminar = new bootstrap.Modal($('modal-eliminar'));
  const usuario = Sesion.actual();
  const puedeRegistrar = Sesion.puede('tiempo.registrar');

  try {
    const config = await cargarAjustes();
    $('saludo').textContent = puedeRegistrar
      ? `Hola, ${usuario.nombre.split(' ')[0]}. ${formatearDia(BD.hoy())} · ${config.empresa}`
      : `Actividad reciente del equipo de ${config.empresa}.`;

    [proyectos, modulos] = await Promise.all([BD.listarProyectos(), BD.listarModulos()]);
    llenarSelectProyectos($('e-proyecto'), proyectos);

    if (puedeRegistrar) {
      llenarSelectProyectos($('proyecto'), proyectos);
      registrarEventosBarra();
      try { modo = localStorage.getItem(CLAVE_MODO) === 'manual' ? 'manual' : 'cronometro'; } catch { /* sin almacenamiento */ }
      corriendo = await BD.obtenerCronometro();
      if (corriendo) modo = 'cronometro'; // si hay uno corriendo, se muestra
      pintarBarra();
      await cargarResumen();
    } else {
      $('titulo-entradas').textContent = 'Actividad reciente del equipo';
    }

    registrarEventosLista();
    await cargarEntradas();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    $('lista-dias').innerHTML = '<p class="text-danger text-center py-4">No se pudieron cargar los datos.</p>';
  }
}

/* ============================ Barra del cronómetro ============================ */

function registrarEventosBarra() {
  $('form-cronometro').addEventListener('submit', accionPrincipal);
  $('btn-descartar').addEventListener('click', descartar);
  $('modo-cronometro').addEventListener('click', () => cambiarModo('cronometro'));
  $('modo-manual').addEventListener('click', () => cambiarModo('manual'));

  // Botón $: activa / desactiva "facturable"
  $('btn-facturable').addEventListener('click', () => {
    ponerFacturable($('btn-facturable').getAttribute('aria-pressed') !== 'true');
    if (corriendo) guardarCambiosCronometro();
  });

  // Al elegir proyecto: se pinta su color y se toma su valor de "facturable" (como Clockify)
  // y se cargan sus módulos en el segundo <select>
  $('proyecto').addEventListener('change', () => {
    const opcion = $('proyecto').selectedOptions[0];
    ponerFacturable(opcion.value ? opcion.dataset.facturable === '1' : false);
    llenarSelectModulos($('modulo'), modulos, $('proyecto').value);
    pintarPuntoProyecto();
    if (corriendo) guardarCambiosCronometro();
  });

  // Cambiar el módulo con el cronómetro corriendo actualiza la entrada en curso
  $('modulo').addEventListener('change', () => {
    $('error-modulo').classList.add('d-none');
    if (corriendo) guardarCambiosCronometro();
  });

  // Mientras corre, al terminar de escribir la descripción se guarda en la entrada en curso
  $('descripcion').addEventListener('change', () => { if (corriendo) guardarCambiosCronometro(); });
  $('descripcion').addEventListener('input', () => $('descripcion').classList.remove('is-invalid'));

  // En modo manual, la duración se muestra en el reloj mientras se escriben las horas
  ['hora-inicio', 'hora-fin'].forEach((id) => $(id).addEventListener('input', mostrarDuracionManual));
}

/** Dibuja la barra según el modo y si hay un cronómetro corriendo */
function pintarBarra() {
  const manual = modo === 'manual';
  $('campos-manual').classList.toggle('d-none', !manual);
  $('modo-cronometro').classList.toggle('active', !manual);
  $('modo-manual').classList.toggle('active', manual);
  $('modo-manual').disabled = Boolean(corriendo); // no se cambia de modo con el cronómetro corriendo
  $('barra-cronometro').classList.toggle('barra-corriendo', Boolean(corriendo));

  const boton = $('btn-principal');
  boton.classList.remove('btn-primary', 'btn-danger');
  $('btn-descartar').classList.toggle('d-none', !corriendo);

  if (corriendo) {
    // Llenar la barra con los datos de la entrada en curso
    $('descripcion').value = corriendo.descripcion;
    $('proyecto').value = corriendo.proyecto_id ?? '';
    llenarSelectModulos($('modulo'), modulos, $('proyecto').value,
      corriendo.modulo_id ? { id: corriendo.modulo_id, nombre: corriendo.modulo_nombre, proyecto_id: corriendo.proyecto_id } : null);
    $('modulo').value = corriendo.modulo_id ?? '';
    ponerFacturable(corriendo.facturable === 1);
    boton.textContent = 'DETENER';
    boton.classList.add('btn-danger');
    iniciarReloj();
  } else {
    detenerReloj();
    boton.textContent = manual ? 'AGREGAR' : 'INICIAR';
    boton.classList.add('btn-primary');
    if (manual) {
      if (!$('fecha').value) $('fecha').value = BD.hoy();
      mostrarDuracionManual();
    } else {
      $('reloj').textContent = '0:00:00';
    }
    // Conserva el módulo elegido si sigue siendo del proyecto actual
    const moduloElegido = $('modulo').value;
    llenarSelectModulos($('modulo'), modulos, $('proyecto').value);
    if ([...$('modulo').options].some((o) => o.value === moduloElegido)) $('modulo').value = moduloElegido;
  }
  pintarPuntoProyecto();
}

function cambiarModo(nuevo) {
  modo = nuevo;
  try { localStorage.setItem(CLAVE_MODO, nuevo); } catch { /* sin almacenamiento */ }
  $('error-manual').classList.add('d-none');
  pintarBarra();
}

function ponerFacturable(activo) {
  const boton = $('btn-facturable');
  boton.setAttribute('aria-pressed', String(activo));
  boton.classList.toggle('active', activo);
  boton.title = activo ? 'Facturable' : 'No facturable';
}

function pintarPuntoProyecto() {
  const p = proyectos.find((x) => String(x.id) === $('proyecto').value);
  $('punto-proyecto').style.setProperty('--color-proyecto', p ? p.color : 'transparent');
  $('punto-proyecto').classList.toggle('punto-vacio', !p);
}

/** Datos actuales de la barra */
function datosBarra() {
  return {
    descripcion: $('descripcion').value,
    proyecto_id: $('proyecto').value,
    modulo_id: $('modulo').value,
    facturable: $('btn-facturable').getAttribute('aria-pressed') === 'true'
  };
}

/* ------------------------------- Reloj ------------------------------- */

function iniciarReloj() {
  detenerReloj();
  const inicio = BD.fechas.aFecha(corriendo.inicio);
  const actualizar = () => {
    const texto = formatearDuracion((Date.now() - inicio) / 1000);
    $('reloj').textContent = texto;
    document.title = `${texto} · ${corriendo.proyecto_nombre || 'Sin proyecto'}`; // como Clockify: el tiempo en la pestaña
  };
  actualizar();
  intervaloReloj = setInterval(actualizar, 1000);
}

function detenerReloj() {
  clearInterval(intervaloReloj);
  intervaloReloj = null;
  document.title = tituloOriginal;
}

/** Duración entre las horas del modo manual (si la de fin es menor, termina al día siguiente) */
function mostrarDuracionManual() {
  const [inicio, fin] = [$('hora-inicio').value, $('hora-fin').value];
  $('reloj').textContent = formatearDuracion(segundosEntre(inicio, fin));
}

/** Segundos entre dos horas "HH:MM" (0 si falta alguna) */
function segundosEntre(inicio, fin) {
  if (!inicio || !fin) return 0;
  const aMin = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  let minutos = aMin(fin) - aMin(inicio);
  if (minutos < 0) minutos += 24 * 60;
  return minutos * 60;
}

/* ------------------------------ Acciones ------------------------------ */

/** INICIAR / DETENER / AGREGAR según el modo */
async function accionPrincipal(evento) {
  evento.preventDefault();
  const boton = $('btn-principal');
  boton.disabled = true;
  try {
    if (corriendo) {
      const entrada = await BD.detenerCronometro();
      corriendo = null;
      $('descripcion').value = '';
      mostrarAlerta(`Se registraron ${formatearDuracion(entrada.duracion)}${entrada.proyecto_nombre ? ` en "${entrada.proyecto_nombre}"` : ''}.`);
    } else if (modo === 'manual') {
      if (!validarManual()) return;
      const entrada = await BD.crearRegistro({ ...datosBarra(), fecha: $('fecha').value, hora_inicio: $('hora-inicio').value, hora_fin: $('hora-fin').value });
      $('descripcion').value = '';
      $('hora-inicio').value = '';
      $('hora-fin').value = '';
      mostrarAlerta(`Entrada agregada: ${formatearDuracion(entrada.duracion)}.`);
    } else {
      corriendo = await BD.iniciarCronometro(datosBarra());
      mostrarAlerta('Cronómetro iniciado.', 'info');
    }
    pintarBarra();
    await Promise.all([cargarResumen(), cargarEntradas()]);
  } catch (error) {
    mostrarErrores(error);
  } finally {
    boton.disabled = false;
  }
}

/** Validación del modo manual en el navegador (la capa de datos vuelve a validar) */
function validarManual() {
  const errores = [];
  if (!$('hora-inicio').value) errores.push('Indica la hora de inicio.');
  if (!$('hora-fin').value) errores.push('Indica la hora de fin.');
  if ($('hora-inicio').value && $('hora-inicio').value === $('hora-fin').value) errores.push('La hora de fin debe ser distinta a la de inicio.');
  if (!$('fecha').value) errores.push('Indica la fecha.');
  else if ($('fecha').value > BD.hoy()) errores.push('No se puede registrar tiempo en una fecha futura.');
  if ($('descripcion').value.trim().length > 200) errores.push('La descripción no puede superar 200 caracteres.');

  ['hora-inicio', 'hora-fin', 'fecha'].forEach((id) => $(id).classList.toggle('is-invalid', errores.length > 0 && !$(id).value));
  $('error-manual').textContent = errores.join(' ');
  $('error-manual').classList.toggle('d-none', errores.length === 0);
  return errores.length === 0;
}

/** Muestra el error de la capa de datos en la barra */
function mostrarErrores(error) {
  mostrarAlerta(error.message, 'danger');
  const e = error.errores || {};
  if (e.descripcion) {
    $('descripcion').classList.add('is-invalid');
    $('error-descripcion').textContent = e.descripcion;
  }
  if (e.modulo_id) {
    $('error-modulo').textContent = e.modulo_id;
    $('error-modulo').classList.remove('d-none');
  }
  const manual = [e.fecha, e.hora_inicio, e.hora_fin].filter(Boolean);
  if (manual.length) {
    $('error-manual').textContent = manual.join(' ');
    $('error-manual').classList.remove('d-none');
  }
}

/** Guarda en la entrada en curso los cambios de descripción, proyecto o $ */
async function guardarCambiosCronometro() {
  try {
    corriendo = await BD.actualizarCronometro(datosBarra());
  } catch (error) {
    mostrarErrores(error);
  }
}

/** Descarta el cronómetro en curso sin guardar el tiempo */
async function descartar() {
  try {
    await BD.descartarCronometro();
    corriendo = null;
    $('descripcion').value = '';
    pintarBarra();
    mostrarAlerta('Se descartó el cronómetro.', 'warning');
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
}

/* ============================ Totales ============================ */

async function cargarResumen() {
  const r = await BD.resumenPersonal();
  $('kpi-hoy').textContent = formatearDuracion(r.hoy);
  $('kpi-semana').textContent = formatearDuracion(r.semana);
  $('kpi-facturable').textContent = formatearDuracion(r.semana_facturable);
  $('kpi-importe').textContent = formatearMoneda(r.importe_semana);
}

/* ============================ Lista de entradas ============================ */

function registrarEventosLista() {
  $('btn-mas').addEventListener('click', () => { limite += 40; cargarEntradas(); });
  $('form-entrada').addEventListener('submit', guardarEntrada);
  $('btn-confirmar-eliminar').addEventListener('click', eliminarEntrada);
  ['e-fecha', 'e-inicio', 'e-fin'].forEach((id) => $(id).addEventListener('input', () => {
    $('e-duracion').textContent = formatearDuracion(segundosEntre($('e-inicio').value, $('e-fin').value));
  }));
  $('e-proyecto').addEventListener('change', () => {
    const opcion = $('e-proyecto').selectedOptions[0];
    $('e-facturable').checked = opcion.value ? opcion.dataset.facturable === '1' : false;
    llenarSelectModulos($('e-modulo'), modulos, $('e-proyecto').value);
  });

  // Delegación de eventos: un solo listener para los botones de todas las entradas
  $('lista-dias').addEventListener('click', async (evento) => {
    const boton = evento.target.closest('button[data-accion]');
    if (!boton) return;
    const id = Number(boton.closest('[data-id]').dataset.id);
    try {
      if (boton.dataset.accion === 'continuar') await continuar(id);
      if (boton.dataset.accion === 'editar') abrirEdicion(await BD.obtenerRegistro(id));
      if (boton.dataset.accion === 'eliminar') {
        entradaAEliminar = await BD.obtenerRegistro(id);
        $('texto-eliminar').textContent = `"${entradaAEliminar.descripcion || 'sin descripción'}" (${formatearDuracion(entradaAEliminar.duracion)})`;
        modalEliminar.show();
      }
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
    }
  });
}

/** Consulta las entradas: las propias (quien registra tiempo) o las del equipo (consulta) */
async function cargarEntradas() {
  const filtros = Sesion.puede('tiempo.registrar') ? { usuario: Sesion.actual().id } : {};
  const entradas = await BD.listarRegistros(filtros, limite + 1); // +1 para saber si hay más
  $('btn-mas').classList.toggle('d-none', entradas.length <= limite);
  dibujarEntradas(entradas.slice(0, limite));
}

/** Agrupa las entradas por día y genera una tarjeta por día (manipulación del DOM) */
function dibujarEntradas(entradas) {
  const lista = $('lista-dias');
  if (entradas.length === 0) {
    lista.innerHTML = `
      <div class="card shadow-sm"><div class="card-body text-center py-5 text-body-secondary">
        <i class="bi bi-stopwatch display-5 d-block mb-2"></i>
        Aún no hay entradas. Escribe en qué estás trabajando y presiona <strong>INICIAR</strong>.
      </div></div>`;
    return;
  }

  // Map conserva el orden de inserción: los días quedan del más reciente al más antiguo
  const porDia = new Map();
  entradas.forEach((e) => {
    const dia = e.inicio.slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(e);
  });

  const verUsuario = !Sesion.puede('tiempo.registrar'); // consulta ve de quién es cada entrada
  lista.innerHTML = [...porDia].map(([dia, delDia]) => {
    const total = delDia.reduce((suma, e) => suma + e.duracion, 0);
    return `
      <article class="card shadow-sm mb-3">
        <header class="card-header bg-body-tertiary d-flex justify-content-between align-items-center py-2">
          <span class="fw-semibold">${nombreDia(dia)}</span>
          <span class="small text-body-secondary">Total: <strong class="font-monospace text-body">${formatearDuracion(total)}</strong></span>
        </header>
        <ul class="list-group list-group-flush">
          ${delDia.map((e) => filaEntrada(e, verUsuario)).join('')}
        </ul>
      </article>`;
  }).join('');
}

/** HTML de una entrada: descripción + proyecto | $ | horario | duración | botones */
function filaEntrada(e, verUsuario) {
  const propia = e.usuario_id === Sesion.actual().id;
  const editable = Sesion.puedeModificar(e);
  const facturable = e.facturable
    ? `<span class="text-success" title="Facturable · ${formatearMoneda(e.importe)}"><i class="bi bi-currency-dollar"></i></span>`
    : '<span class="text-body-tertiary" title="No facturable"><i class="bi bi-currency-dollar"></i></span>';

  return `
    <li class="list-group-item entrada" data-id="${e.id}">
      <div class="row g-2 align-items-center">
        <div class="col-12 col-md">
          <div class="${e.descripcion ? '' : 'text-body-secondary fst-italic'}">${escaparHTML(e.descripcion || '(sin descripción)')}</div>
          <div class="small">${etiquetaProyecto(e)}${verUsuario ? ` <span class="text-body-secondary ms-2"><i class="bi bi-person"></i> ${escaparHTML(e.usuario_nombre)}</span>` : ''}</div>
        </div>
        <div class="col-auto">${facturable}</div>
        <div class="col-auto small text-body-secondary text-nowrap">${horaDe(e.inicio)} – ${horaDe(e.fin)}</div>
        <div class="col-auto fw-semibold font-monospace text-end duracion">${formatearDuracion(e.duracion)}</div>
        <div class="col-auto text-nowrap">
          ${propia && editable ? `<button type="button" class="btn btn-sm btn-light" data-accion="continuar" title="Continuar" aria-label="Continuar"><i class="bi bi-play-fill"></i></button>` : ''}
          ${editable ? `<button type="button" class="btn btn-sm btn-light" data-accion="editar" title="Editar" aria-label="Editar"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-light text-danger" data-accion="eliminar" title="Eliminar" aria-label="Eliminar"><i class="bi bi-trash"></i></button>` : ''}
        </div>
      </div>
    </li>`;
}

/** ▶ Continuar: inicia un cronómetro nuevo con la misma descripción y proyecto */
async function continuar(id) {
  corriendo = await BD.continuarRegistro(id);
  modo = 'cronometro';
  pintarBarra();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  mostrarAlerta('Cronómetro iniciado con los datos de la entrada.', 'info');
  await Promise.all([cargarResumen(), cargarEntradas()]);
}

/* ------------------------------ Editar ------------------------------ */

function abrirEdicion(e) {
  entradaEditando = e;
  ['e-descripcion', 'e-proyecto', 'e-modulo', 'e-fecha', 'e-inicio', 'e-fin'].forEach((id) => $(id).classList.remove('is-invalid'));

  // Si el proyecto está archivado no aparece en la lista: se agrega para poder conservarlo
  const select = $('e-proyecto');
  if (e.proyecto_id && !select.querySelector(`option[value="${e.proyecto_id}"]`)) {
    select.add(new Option(`${e.proyecto_nombre} (archivado)`, e.proyecto_id));
  }
  $('e-descripcion').value = e.descripcion;
  select.value = e.proyecto_id ?? '';
  // Módulos del proyecto de la entrada (si su módulo ya está archivado, también aparece)
  llenarSelectModulos($('e-modulo'), modulos, select.value,
    e.modulo_id ? { id: e.modulo_id, nombre: e.modulo_nombre, proyecto_id: e.proyecto_id } : null);
  $('e-modulo').value = e.modulo_id ?? '';
  $('e-facturable').checked = e.facturable === 1;
  $('e-fecha').value = e.inicio.slice(0, 10);
  $('e-inicio').value = horaDe(e.inicio);
  $('e-fin').value = horaDe(e.fin);
  $('e-duracion').textContent = formatearDuracion(e.duracion);
  modalEntrada.show();
}

async function guardarEntrada(evento) {
  evento.preventDefault();
  const campos = { fecha: 'e-fecha', hora_inicio: 'e-inicio', hora_fin: 'e-fin', descripcion: 'e-descripcion', proyecto_id: 'e-proyecto', modulo_id: 'e-modulo' };

  // Validación en el navegador
  const errores = {};
  if (!$('e-fecha').value) errores.fecha = 'Indica la fecha.';
  else if ($('e-fecha').value > BD.hoy()) errores.fecha = 'No puede ser una fecha futura.';
  if (!$('e-inicio').value) errores.hora_inicio = 'Indica la hora de inicio.';
  if (!$('e-fin').value) errores.hora_fin = 'Indica la hora de fin.';
  else if ($('e-fin').value === $('e-inicio').value) errores.hora_fin = 'Debe ser distinta a la de inicio.';

  const marcar = (errs) => Object.entries(campos).forEach(([campo, id]) => {
    $(id).classList.toggle('is-invalid', Boolean(errs[campo]));
    const contenedor = $(`error-${id}`);
    if (contenedor) contenedor.textContent = errs[campo] || '';
  });
  marcar(errores);
  if (Object.keys(errores).length) return;

  const boton = $('btn-guardar-entrada');
  boton.disabled = true;
  try {
    await BD.actualizarRegistro(entradaEditando.id, {
      descripcion: $('e-descripcion').value,
      proyecto_id: $('e-proyecto').value,
      modulo_id: $('e-modulo').value,
      facturable: $('e-facturable').checked,
      fecha: $('e-fecha').value,
      hora_inicio: $('e-inicio').value,
      hora_fin: $('e-fin').value
    });
    modalEntrada.hide();
    mostrarAlerta('Entrada actualizada.');
    await Promise.all([cargarResumen(), cargarEntradas()]);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcar(error.errores || {});
  } finally {
    boton.disabled = false;
  }
}

/* ------------------------------ Eliminar ------------------------------ */

async function eliminarEntrada() {
  if (!entradaAEliminar) return;
  try {
    await BD.eliminarRegistro(entradaAEliminar.id);
    modalEliminar.hide();
    mostrarAlerta('Entrada eliminada.');
    await Promise.all([Sesion.puede('tiempo.registrar') ? cargarResumen() : null, cargarEntradas()]);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  } finally {
    entradaAEliminar = null;
  }
}
