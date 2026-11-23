/**
 * proyectos.js
 * ----------------------------------------------------------------------------
 * Lógica de proyectos.html: CRUD de PROYECTOS y CLIENTES.
 *   - READ:   tablas con tiempo registrado, importe y avance del presupuesto.
 *   - CREATE / UPDATE: formularios en ventanas modales (solo administrador).
 *   - UPDATE: archivar / reactivar proyectos.
 *   - DELETE: eliminar con confirmación.
 *       * Un proyecto con horas registradas NO se puede eliminar (se archiva).
 *       * Al eliminar un cliente, sus proyectos quedan "sin cliente".
 *   - Búsqueda en vivo y filtro "Mostrar archivados".
 */

const $ = (id) => document.getElementById(id);
const NOMBRES_COLORES = ['Azul', 'Naranja', 'Aqua', 'Amarillo', 'Rosa', 'Verde', 'Violeta', 'Rojo'];

let proyectos = [];
let clientes = [];
let editandoProyecto = null; // id del proyecto en edición (null = nuevo)
let editandoCliente = null;
let accionConfirmar = null;  // función que se ejecuta al confirmar la eliminación
let modalProyecto, modalCliente, modalConfirmar, modalModulos;
let proyectoModulos = null;  // proyecto cuyos módulos se están viendo
let modulosProyecto = [];    // módulos de ese proyecto
let editandoModulo = null;   // id del módulo en edición (null = agregar)
const puedeGestionar = () => Sesion.puede('proyectos.gestionar');

document.addEventListener('DOMContentLoaded', async () => {
  if (!Sesion.activa) return;

  modalProyecto = new bootstrap.Modal($('modal-proyecto'));
  modalCliente = new bootstrap.Modal($('modal-cliente'));
  modalConfirmar = new bootstrap.Modal($('modal-confirmar'));
  modalModulos = new bootstrap.Modal($('modal-modulos'));
  registrarEventosModulos();

  dibujarMuestrasColor();
  registrarEventos();
  // Abrir directamente la pestaña de clientes con proyectos.html#clientes
  if (window.location.hash === '#clientes') bootstrap.Tab.getOrCreateInstance($('tab-clientes')).show();

  try {
    await cargarAjustes();
    await cargarDatos();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
});

/* ------------------------------ Carga ------------------------------ */

async function cargarDatos() {
  [proyectos, clientes] = await Promise.all([BD.listarProyectos({ archivados: true }), BD.listarClientes()]);
  const activos = proyectos.filter((p) => !p.archivado).length;
  $('contador').textContent = `${activos} proyecto(s) activo(s) · ${clientes.length} cliente(s)`;

  // Select de clientes del formulario de proyecto
  const select = $('p-cliente');
  select.length = 1; // deja solo "Sin cliente"
  llenarSelect(select, Object.fromEntries(clientes.map((c) => [c.id, c.nombre])));

  dibujarProyectos();
  dibujarClientes();
}

/* ------------------------------ Proyectos ------------------------------ */

/** Dibuja la tabla aplicando la búsqueda y el filtro de archivados */
function dibujarProyectos() {
  const texto = $('buscar').value.trim().toLowerCase();
  const verArchivados = $('ver-archivados').checked;
  const visibles = proyectos.filter((p) =>
    (verArchivados || !p.archivado) &&
    (!texto || p.nombre.toLowerCase().includes(texto) || (p.cliente_nombre || '').toLowerCase().includes(texto)));

  if (visibles.length === 0) {
    $('tabla-proyectos').innerHTML = '<tr><td colspan="6" class="text-center text-body-secondary py-5">No hay proyectos que coincidan.</td></tr>';
    return;
  }

  $('tabla-proyectos').innerHTML = visibles.map((p) => {
    const tarifa = p.tarifa_hora === null
      ? '<span class="text-body-secondary small">Por miembro</span>'
      : `${formatearMoneda(p.tarifa_hora)}<span class="text-body-secondary small">/h</span>`;
    return `
      <tr data-id="${p.id}" class="${p.archivado ? 'text-body-secondary' : ''}">
        <td>
          <div>${etiquetaProyecto({ proyecto_nombre: p.nombre, proyecto_color: p.color, cliente_nombre: p.cliente_nombre })}
            ${p.archivado ? '<span class="badge text-bg-secondary ms-1"><i class="bi bi-archive"></i> Archivado</span>' : ''}</div>
          <div class="small text-body-secondary">${p.facturable ? '<i class="bi bi-currency-dollar text-success"></i> Facturable' : 'No facturable'}
            · <i class="bi bi-diagram-3"></i> ${p.modulos} módulo(s)</div>
        </td>
        <td class="d-none d-md-table-cell text-nowrap">${tarifa}</td>
        <td class="text-end font-monospace">${formatearDuracion(p.segundos)}</td>
        <td class="text-end d-none d-sm-table-cell text-nowrap">${formatearMoneda(p.importe)}</td>
        <td class="d-none d-lg-table-cell">${barraPresupuesto(p)}</td>
        <td class="text-end text-nowrap">
          <button type="button" class="btn btn-sm btn-light" data-accion="modulos" title="Módulos" aria-label="Módulos"><i class="bi bi-diagram-3"></i></button>
          <a class="btn btn-sm btn-light" href="reportes.html?proyecto=${p.id}" title="Ver reporte" aria-label="Ver reporte"><i class="bi bi-bar-chart"></i></a>
          ${puedeGestionar() ? `
          <button type="button" class="btn btn-sm btn-light" data-accion="editar" title="Editar" aria-label="Editar"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-light" data-accion="archivar" title="${p.archivado ? 'Reactivar' : 'Archivar'}" aria-label="${p.archivado ? 'Reactivar' : 'Archivar'}">
            <i class="bi ${p.archivado ? 'bi-box-arrow-up' : 'bi-archive'}"></i></button>
          <button type="button" class="btn btn-sm btn-light text-danger" data-accion="eliminar" title="Eliminar" aria-label="Eliminar"><i class="bi bi-trash"></i></button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

/** Barra de avance del presupuesto: verde < 80%, amarilla 80–100%, roja si se excede */
function barraPresupuesto(p) {
  if (!p.presupuesto_horas) return '<span class="text-body-secondary small">Sin presupuesto</span>';
  const horas = p.segundos / 3600;
  const porcentaje = (horas * 100) / p.presupuesto_horas;
  const color = porcentaje > 100 ? 'bg-danger' : porcentaje >= 80 ? 'bg-warning' : 'bg-success';
  const aviso = porcentaje > 100 ? ' <i class="bi bi-exclamation-triangle-fill text-danger" title="Presupuesto excedido"></i>' : '';
  return `
    <div class="small mb-1">${formatearNumero(horas, 1)} / ${formatearNumero(p.presupuesto_horas, 1)} h · ${Math.round(porcentaje)}%${aviso}</div>
    <div class="progress" style="height: 0.4rem" role="progressbar" aria-valuenow="${Math.round(porcentaje)}" aria-valuemin="0" aria-valuemax="100" aria-label="Presupuesto usado">
      <div class="progress-bar ${color}" style="width:${Math.min(porcentaje, 100)}%"></div>
    </div>`;
}

/** Muestras de color del formulario (botones). La última es un selector libre. */
function dibujarMuestrasColor() {
  const colores = BD.obtenerCatalogos().colores;
  $('muestras-color').innerHTML = colores.map((c, i) => `
    <button type="button" class="muestra-color" style="--color-proyecto:${c}" data-color="${c}"
            title="${NOMBRES_COLORES[i]}" aria-label="${NOMBRES_COLORES[i]}" aria-pressed="false"></button>`).join('') +
    `<label class="small text-body-secondary d-flex align-items-center gap-1 ms-1">
       <input type="color" id="color-libre" class="form-control form-control-color p-0" value="#2a78d6" title="Otro color"> Otro
     </label>`;
}

function elegirColor(color) {
  $('p-color').value = color;
  document.querySelectorAll('.muestra-color').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
  $('color-libre').value = color;
}

function abrirProyecto(p = null) {
  editandoProyecto = p ? p.id : null;
  $('form-proyecto').reset();
  limpiarErrores('p');
  $('titulo-modal-proyecto').textContent = p ? 'Editar proyecto' : 'Nuevo proyecto';
  // Un color distinto para cada proyecto nuevo (siguiente de la paleta, en orden fijo)
  const colores = BD.obtenerCatalogos().colores;
  elegirColor(p ? p.color : colores[proyectos.length % colores.length]);
  if (p) {
    $('p-nombre').value = p.nombre;
    $('p-cliente').value = p.cliente_id ?? '';
    $('p-tarifa').value = p.tarifa_hora ?? '';
    $('p-presupuesto').value = p.presupuesto_horas ?? '';
    $('p-facturable').checked = p.facturable === 1;
  }
  modalProyecto.show();
}

async function guardarProyecto(evento) {
  evento.preventDefault();
  const datos = {
    nombre: $('p-nombre').value,
    cliente_id: $('p-cliente').value,
    color: $('p-color').value,
    tarifa_hora: $('p-tarifa').value,
    presupuesto_horas: $('p-presupuesto').value,
    facturable: $('p-facturable').checked
  };

  // Validación en el navegador (la capa de datos vuelve a validar)
  const errores = {};
  if (datos.nombre.trim().length < 2) errores.nombre = 'Escribe el nombre del proyecto (mínimo 2 caracteres).';
  if (datos.tarifa_hora !== '' && Number(datos.tarifa_hora) < 0) errores.tarifa_hora = 'La tarifa no puede ser negativa.';
  if (datos.presupuesto_horas !== '' && Number(datos.presupuesto_horas) <= 0) errores.presupuesto_horas = 'Debe ser mayor que 0.';
  const camposProyecto = { nombre: 'p-nombre', cliente_id: 'p-cliente', tarifa_hora: 'p-tarifa', presupuesto_horas: 'p-presupuesto', color: 'p-color' };
  marcarErrores(camposProyecto, errores);
  if (Object.keys(errores).length) return;

  const boton = $('btn-guardar-proyecto');
  boton.disabled = true;
  try {
    if (editandoProyecto) await BD.actualizarProyecto(editandoProyecto, datos);
    else await BD.crearProyecto(datos);
    modalProyecto.hide();
    mostrarAlerta(`Proyecto "${datos.nombre.trim()}" guardado.`);
    await cargarDatos();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcarErrores(camposProyecto, error.errores || {});
  } finally {
    boton.disabled = false;
  }
}

/* ------------------------------ Módulos ------------------------------ */
/*
 * Cada proyecto se divide en módulos (ej. "Glosa", "Balance"). Aquí se ven las
 * horas, el importe y el presupuesto de cada módulo, y el administrador los
 * agrega, edita, archiva o elimina. Al eliminar un módulo sus entradas se
 * conservan "sin módulo".
 */

async function abrirModulos(p) {
  proyectoModulos = p;
  $('titulo-modal-modulos').innerHTML = `<i class="bi bi-diagram-3 text-primary"></i> Módulos de ${escaparHTML(p.nombre)}`;
  $('enlace-reporte-modulos').href = `reportes.html?proyecto=${p.id}`;
  limpiarFormularioModulo();
  await cargarModulos();
  modalModulos.show();
}

async function cargarModulos() {
  try {
    const [lista, sinModulo] = await Promise.all([
      BD.listarModulos(proyectoModulos.id, { archivados: true }), BD.horasSinModulo(proyectoModulos.id)
    ]);
    modulosProyecto = lista;
    const total = lista.reduce((s, m) => s + m.segundos, 0) + sinModulo.segundos;
    $('resumen-modulos').innerHTML = `Total del proyecto: <strong class="font-monospace">${formatearDuracion(total)}</strong>` +
      ` · Sin módulo: <strong class="font-monospace">${formatearDuracion(sinModulo.segundos)}</strong> (${sinModulo.entradas} entrada(s))`;
    dibujarTablaModulos(total);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
}

let totalModulos = 0; // segundos totales del proyecto (para los porcentajes)

function dibujarTablaModulos(totalProyecto = totalModulos) {
  totalModulos = totalProyecto;
  if (modulosProyecto.length === 0) {
    $('tabla-modulos').innerHTML = `<tr><td colspan="5" class="text-center text-body-secondary py-4">
      Este proyecto aún no tiene módulos.${puedeGestionar() ? ' Agrega el primero con el formulario de arriba.' : ''}</td></tr>`;
    return;
  }
  $('tabla-modulos').innerHTML = modulosProyecto.map((m) => {
    const porcentaje = totalProyecto ? Math.round((m.segundos * 100) / totalProyecto) : 0;
    return `
      <tr data-id="${m.id}" class="${m.archivado ? 'text-body-secondary' : ''}">
        <td>
          <span class="fw-medium">${escaparHTML(m.nombre)}</span>
          ${m.archivado ? '<span class="badge text-bg-secondary ms-1"><i class="bi bi-archive"></i> Archivado</span>' : ''}
          <div class="small text-body-secondary">${m.entradas} entrada(s) · ${porcentaje}% del proyecto</div>
        </td>
        <td class="text-end font-monospace">${formatearDuracion(m.segundos)}</td>
        <td class="text-end d-none d-sm-table-cell text-nowrap">${formatearMoneda(m.importe)}</td>
        <td class="d-none d-md-table-cell">${barraPresupuesto({ segundos: m.segundos, presupuesto_horas: m.presupuesto_horas })}</td>
        <td class="text-end text-nowrap">
          <a class="btn btn-sm btn-light" href="reportes.html?proyecto=${m.proyecto_id}&modulo=${m.id}" title="Ver reporte" aria-label="Ver reporte"><i class="bi bi-bar-chart"></i></a>
          ${puedeGestionar() ? `
          <button type="button" class="btn btn-sm btn-light" data-accion="editar" title="Editar" aria-label="Editar"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-light" data-accion="archivar" title="${m.archivado ? 'Reactivar' : 'Archivar'}" aria-label="${m.archivado ? 'Reactivar' : 'Archivar'}">
            <i class="bi ${m.archivado ? 'bi-box-arrow-up' : 'bi-archive'}"></i></button>
          <button type="button" class="btn btn-sm btn-light text-danger" data-accion="eliminar" title="Eliminar" aria-label="Eliminar"><i class="bi bi-trash"></i></button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

function limpiarFormularioModulo() {
  editandoModulo = null;
  if (!$('form-modulo')) return; // sin permiso, el formulario no existe
  $('form-modulo').reset();
  limpiarErrores('m');
  $('btn-guardar-modulo').innerHTML = '<i class="bi bi-plus-lg"></i> Agregar';
  $('btn-cancelar-modulo').classList.add('d-none');
}

async function guardarModulo(evento) {
  evento.preventDefault();
  const datos = { proyecto_id: proyectoModulos.id, nombre: $('m-nombre').value, presupuesto_horas: $('m-presupuesto').value };
  const campos = { nombre: 'm-nombre', presupuesto_horas: 'm-presupuesto' };

  const errores = {};
  if (datos.nombre.trim().length < 2) errores.nombre = 'Escribe el nombre del módulo (mínimo 2 caracteres).';
  if (datos.presupuesto_horas !== '' && Number(datos.presupuesto_horas) <= 0) errores.presupuesto_horas = 'Debe ser mayor que 0.';
  marcarErrores(campos, errores);
  if (Object.keys(errores).length) return;

  try {
    if (editandoModulo) await BD.actualizarModulo(editandoModulo, datos);
    else await BD.crearModulo(datos);
    mostrarAlerta(`Módulo "${datos.nombre.trim()}" guardado.`);
    limpiarFormularioModulo();
    await Promise.all([cargarModulos(), cargarDatos()]);
    $('m-nombre').focus();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcarErrores(campos, error.errores || {});
  }
}

function registrarEventosModulos() {
  $('form-modulo')?.addEventListener('submit', guardarModulo);
  $('btn-cancelar-modulo')?.addEventListener('click', limpiarFormularioModulo);

  // Delegación de eventos en la tabla de módulos
  $('tabla-modulos').addEventListener('click', async (e) => {
    const boton = e.target.closest('button[data-accion]');
    if (!boton) return;
    const m = modulosProyecto.find((x) => x.id === Number(boton.closest('tr').dataset.id));
    try {
      if (boton.dataset.accion === 'editar') {
        editandoModulo = m.id;
        limpiarErrores('m');
        $('m-nombre').value = m.nombre;
        $('m-presupuesto').value = m.presupuesto_horas ?? '';
        $('btn-guardar-modulo').innerHTML = '<i class="bi bi-floppy"></i> Guardar';
        $('btn-cancelar-modulo').classList.remove('d-none');
        $('m-nombre').focus();
      }
      if (boton.dataset.accion === 'archivar') {
        await BD.archivarModulo(m.id, !m.archivado);
        mostrarAlerta(m.archivado ? `"${m.nombre}" se reactivó.` : `"${m.nombre}" se archivó: ya no aparece al registrar tiempo.`, 'info');
        await Promise.all([cargarModulos(), cargarDatos()]);
      }
      if (boton.dataset.accion === 'eliminar') {
        // Confirmación en dos clics (dentro de un modal no se abre otro modal)
        if (boton.dataset.confirmar !== '1') {
          boton.dataset.confirmar = '1';
          boton.classList.replace('btn-light', 'btn-danger');
          boton.classList.remove('text-danger');
          boton.innerHTML = '¿Eliminar?';
          setTimeout(() => { if (boton.isConnected) dibujarTablaModulos(); }, 4000);
          return;
        }
        await BD.eliminarModulo(m.id);
        mostrarAlerta(`Se eliminó el módulo "${m.nombre}". Sus ${m.entradas} entrada(s) quedan sin módulo.`);
        await Promise.all([cargarModulos(), cargarDatos()]);
      }
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
    }
  });
}

/* ------------------------------ Clientes ------------------------------ */

function dibujarClientes() {
  if (clientes.length === 0) {
    $('tabla-clientes').innerHTML = '<tr><td colspan="6" class="text-center text-body-secondary py-5">Aún no hay clientes.</td></tr>';
    return;
  }
  $('tabla-clientes').innerHTML = clientes.map((c) => `
    <tr data-id="${c.id}">
      <td class="fw-medium"><i class="bi bi-building text-body-secondary"></i> ${escaparHTML(c.nombre)}</td>
      <td class="d-none d-md-table-cell small">
        ${escaparHTML(c.contacto) || '<span class="text-body-secondary">—</span>'}
        ${c.correo ? `<div><a href="mailto:${escaparHTML(c.correo)}">${escaparHTML(c.correo)}</a></div>` : ''}
      </td>
      <td class="text-center">${c.proyectos}</td>
      <td class="text-end font-monospace">${formatearDuracion(c.segundos)}</td>
      <td class="text-end d-none d-sm-table-cell text-nowrap">${formatearMoneda(c.importe)}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-light" href="reportes.html?cliente=${c.id}" title="Ver reporte" aria-label="Ver reporte"><i class="bi bi-bar-chart"></i></a>
        ${puedeGestionar() ? `
        <button type="button" class="btn btn-sm btn-light" data-accion="editar" title="Editar" aria-label="Editar"><i class="bi bi-pencil"></i></button>
        <button type="button" class="btn btn-sm btn-light text-danger" data-accion="eliminar" title="Eliminar" aria-label="Eliminar"><i class="bi bi-trash"></i></button>` : ''}
      </td>
    </tr>`).join('');
}

function abrirCliente(c = null) {
  editandoCliente = c ? c.id : null;
  $('form-cliente').reset();
  limpiarErrores('c');
  $('titulo-modal-cliente').textContent = c ? 'Editar cliente' : 'Nuevo cliente';
  if (c) {
    $('c-nombre').value = c.nombre;
    $('c-contacto').value = c.contacto;
    $('c-correo').value = c.correo;
  }
  modalCliente.show();
}

async function guardarCliente(evento) {
  evento.preventDefault();
  const datos = { nombre: $('c-nombre').value, contacto: $('c-contacto').value, correo: $('c-correo').value };
  const campos = { nombre: 'c-nombre', contacto: 'c-contacto', correo: 'c-correo' };

  const errores = {};
  if (datos.nombre.trim().length < 2) errores.nombre = 'Escribe el nombre del cliente (mínimo 2 caracteres).';
  if (datos.correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(datos.correo.trim())) errores.correo = 'Escribe un correo válido.';
  marcarErrores(campos, errores);
  if (Object.keys(errores).length) return;

  const boton = $('btn-guardar-cliente');
  boton.disabled = true;
  try {
    if (editandoCliente) await BD.actualizarCliente(editandoCliente, datos);
    else await BD.crearCliente(datos);
    modalCliente.hide();
    mostrarAlerta(`Cliente "${datos.nombre.trim()}" guardado.`);
    await cargarDatos();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcarErrores(campos, error.errores || {});
  } finally {
    boton.disabled = false;
  }
}

/* ------------------------------ Eventos ------------------------------ */

function registrarEventos() {
  $('btn-nuevo-proyecto')?.addEventListener('click', () => abrirProyecto());
  $('btn-nuevo-cliente')?.addEventListener('click', () => abrirCliente());
  $('form-proyecto').addEventListener('submit', guardarProyecto);
  $('form-cliente').addEventListener('submit', guardarCliente);
  $('buscar').addEventListener('input', dibujarProyectos);
  $('ver-archivados').addEventListener('change', dibujarProyectos);
  $('btn-confirmar').addEventListener('click', async () => {
    if (!accionConfirmar) return;
    try {
      await accionConfirmar();
      modalConfirmar.hide();
      await cargarDatos();
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
      modalConfirmar.hide();
    } finally {
      accionConfirmar = null;
    }
  });

  $('muestras-color').addEventListener('click', (e) => {
    const boton = e.target.closest('.muestra-color');
    if (boton) elegirColor(boton.dataset.color);
  });
  $('muestras-color').addEventListener('input', (e) => {
    if (e.target.id === 'color-libre') elegirColor(e.target.value.toLowerCase());
  });

  // Delegación de eventos en la tabla de proyectos
  $('tabla-proyectos').addEventListener('click', async (e) => {
    const boton = e.target.closest('button[data-accion]');
    if (!boton) return;
    const p = proyectos.find((x) => x.id === Number(boton.closest('tr').dataset.id));
    if (boton.dataset.accion === 'modulos') abrirModulos(p);
    if (boton.dataset.accion === 'editar') abrirProyecto(p);
    if (boton.dataset.accion === 'archivar') {
      try {
        await BD.archivarProyecto(p.id, !p.archivado);
        mostrarAlerta(p.archivado ? `"${p.nombre}" se reactivó.` : `"${p.nombre}" se archivó: ya no aparece al registrar tiempo.`, 'info');
        await cargarDatos();
      } catch (error) {
        mostrarAlerta(error.message, 'danger');
      }
    }
    if (boton.dataset.accion === 'eliminar') {
      confirmar(`¿Eliminar el proyecto <strong>${escaparHTML(p.nombre)}</strong>?` +
        (p.entradas > 0 ? `<p class="small text-danger mb-0 mt-2">Tiene ${p.entradas} entrada(s) de tiempo: no se podrá eliminar. Mejor archívalo.</p>` : ''),
      async () => { await BD.eliminarProyecto(p.id); mostrarAlerta(`Se eliminó "${p.nombre}".`); });
    }
  });

  // Delegación de eventos en la tabla de clientes
  $('tabla-clientes').addEventListener('click', (e) => {
    const boton = e.target.closest('button[data-accion]');
    if (!boton) return;
    const c = clientes.find((x) => x.id === Number(boton.closest('tr').dataset.id));
    if (boton.dataset.accion === 'editar') abrirCliente(c);
    if (boton.dataset.accion === 'eliminar') {
      confirmar(`¿Eliminar el cliente <strong>${escaparHTML(c.nombre)}</strong>?` +
        (c.proyectos > 0 ? `<p class="small text-body-secondary mb-0 mt-2">Sus ${c.proyectos} proyecto(s) se conservan como <strong>sin cliente</strong>.</p>` : ''),
      async () => { await BD.eliminarCliente(c.id); mostrarAlerta(`Se eliminó "${c.nombre}".`); });
    }
  });
}

/** Abre el modal de confirmación con un texto (HTML ya escapado) y la acción a ejecutar */
function confirmar(html, accion) {
  $('texto-confirmar').innerHTML = html;
  accionConfirmar = accion;
  modalConfirmar.show();
}

/* ------------------------------ Errores ------------------------------ */

function marcarErrores(campos, errores) {
  for (const [campo, id] of Object.entries(campos)) {
    const mensaje = errores[campo] || '';
    $(id).classList.toggle('is-invalid', Boolean(mensaje));
    const contenedor = $(`error-${id}`);
    if (contenedor) contenedor.textContent = mensaje;
  }
}

function limpiarErrores(prefijo) {
  document.querySelectorAll(`[id^="${prefijo}-"]`).forEach((el) => el.classList.remove('is-invalid'));
  document.querySelectorAll(`[id^="error-${prefijo}-"]`).forEach((el) => { el.textContent = ''; });
}
