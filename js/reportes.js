/**
 * reportes.js
 * ----------------------------------------------------------------------------
 * Lógica de la página de reportes (reportes.html).
 *   - Calcula el rango de fechas según el periodo elegido (hoy, esta semana, mes...).
 *   - Pide a la capa de datos el reporte con los filtros (BD.obtenerReporte), que
 *     hace los totales con SQL (SUM, GROUP BY).
 *   - Dibuja totales, la gráfica de horas por día, el desglose por proyecto y
 *     por miembro, y la tabla de detalle.
 *   - Exporta el detalle a un archivo CSV que se abre en Excel.
 *   - Lee filtros de la URL: reportes.html?proyecto=3 o ?cliente=1 (enlaces desde Proyectos).
 */

const $ = (id) => document.getElementById(id);
let ultimoReporte = null; // se guarda para exportarlo a CSV sin volver a consultar
let verEquipo = false;    // ¿el rol ve las horas de todos? (administrador y consulta)

document.addEventListener('DOMContentLoaded', async () => {
  if (!Sesion.activa) return;
  verEquipo = Sesion.puede('tiempo.ver_todos');

  try {
    await cargarAjustes();
    await llenarFiltros();
    leerFiltrosDeURL();
    aplicarPeriodo();
    registrarEventos();
    await generarReporte();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
});

/* ------------------------------- Filtros ------------------------------- */

let modulosFiltro = []; // todos los módulos (también archivados: sus horas siguen en los reportes)

async function llenarFiltros() {
  const [proyectos, clientes, modulos] = await Promise.all([
    BD.listarProyectos({ archivados: true }), BD.listarClientes(), BD.listarModulos(null, { archivados: true })
  ]);
  modulosFiltro = modulos;
  llenarSelectProyectos($('f-proyecto'), proyectos);
  llenarFiltroModulos();
  llenarSelect($('f-cliente'), Object.fromEntries(clientes.map((c) => [c.id, c.nombre])));
  if (verEquipo) {
    const miembros = await BD.listarMiembros();
    llenarSelect($('f-usuario'), Object.fromEntries(miembros.map((m) => [m.id, m.nombre])));
  }
}

/**
 * Opciones del filtro de módulo: si hay un proyecto elegido, solo sus módulos;
 * si no, todos agrupados por proyecto. Conserva la selección si sigue siendo válida.
 */
function llenarFiltroModulos() {
  const select = $('f-modulo');
  const anterior = select.value;
  const proyecto = $('f-proyecto').value;
  select.length = 2; // deja "Todos" y "Sin módulo"
  let visibles = modulosFiltro;                                        // "Todos los proyectos": todos los módulos
  if (proyecto === 'ninguno') visibles = [];                           // "Sin proyecto": no hay módulos
  else if (proyecto) visibles = modulosFiltro.filter((m) => String(m.proyecto_id) === proyecto);
  const grupos = new Map();
  visibles.forEach((m) => {
    if (!grupos.has(m.proyecto_nombre)) grupos.set(m.proyecto_nombre, []);
    grupos.get(m.proyecto_nombre).push(m);
  });
  grupos.forEach((lista, nombreProyecto) => {
    const grupo = document.createElement('optgroup');
    grupo.label = nombreProyecto;
    lista.forEach((m) => grupo.appendChild(new Option(m.nombre + (m.archivado ? ' (archivado)' : ''), m.id)));
    select.appendChild(grupo);
  });
  select.value = [...select.options].some((o) => o.value === anterior) ? anterior : '';
}

function leerFiltrosDeURL() {
  const proyecto = obtenerParametroURL('proyecto');
  const modulo = obtenerParametroURL('modulo');
  const cliente = obtenerParametroURL('cliente');
  const usuario = obtenerParametroURL('usuario');
  if (proyecto) { $('f-proyecto').value = proyecto; llenarFiltroModulos(); }
  if (modulo) $('f-modulo').value = modulo;
  // Fechas (al regresar del reporte PDF): periodo personalizado
  const desde = obtenerParametroURL('desde');
  const hasta = obtenerParametroURL('hasta');
  if (desde && hasta) {
    $('f-periodo').value = 'personalizado';
    $('f-desde').value = desde;
    $('f-hasta').value = hasta;
  }
  const facturable = obtenerParametroURL('facturable');
  if (facturable) $('f-facturable').value = facturable;
  if (cliente) $('f-cliente').value = cliente;
  if (usuario && $('f-usuario')) $('f-usuario').value = usuario;
}

/** Calcula desde/hasta según el periodo elegido y los escribe en los campos de fecha */
function aplicarPeriodo() {
  const { sumarDias, inicioSemana, fechaISO } = BD.fechas;
  const hoy = new Date();
  const rangos = {
    hoy: () => [BD.hoy(), BD.hoy()],
    semana: () => [inicioSemana(), BD.hoy()],
    semana_pasada: () => {
      const lunes = sumarDias(-7, new Date(`${inicioSemana()}T00:00:00`));
      return [lunes, sumarDias(6, new Date(`${lunes}T00:00:00`))];
    },
    mes: () => [fechaISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), BD.hoy()],
    mes_pasado: () => [fechaISO(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)), fechaISO(new Date(hoy.getFullYear(), hoy.getMonth(), 0))],
    ultimos30: () => [sumarDias(-29), BD.hoy()]
  };
  const periodo = $('f-periodo').value;
  if (rangos[periodo]) [$('f-desde').value, $('f-hasta').value] = rangos[periodo]();
}

function registrarEventos() {
  $('f-periodo').addEventListener('change', () => { aplicarPeriodo(); generarReporte(); });
  // Al cambiar una fecha a mano el periodo pasa a "Personalizado"
  ['f-desde', 'f-hasta'].forEach((id) => $(id).addEventListener('change', () => {
    $('f-periodo').value = 'personalizado';
    generarReporte();
  }));
  // Al cambiar de proyecto se recargan los módulos del filtro
  $('f-proyecto').addEventListener('change', () => { llenarFiltroModulos(); generarReporte(); });
  ['f-usuario', 'f-cliente', 'f-modulo', 'f-facturable'].forEach((id) => $(id)?.addEventListener('change', generarReporte));
  $('btn-csv').addEventListener('click', exportarCSV);
  $('btn-pdf').addEventListener('click', exportarPDF);
  $('form-filtros').addEventListener('submit', (e) => e.preventDefault());
}

/** Valida el rango de fechas (desde <= hasta) */
function validarFiltros() {
  const desde = $('f-desde').value;
  const hasta = $('f-hasta').value;
  let mensaje = '';
  if (!desde || !hasta) mensaje = 'Indica las dos fechas del periodo.';
  else if (desde > hasta) mensaje = 'La fecha "Desde" no puede ser posterior a "Hasta".';
  $('error-filtros').textContent = mensaje;
  $('error-filtros').classList.toggle('d-none', !mensaje);
  ['f-desde', 'f-hasta'].forEach((id) => $(id).classList.toggle('is-invalid', Boolean(mensaje)));
  return !mensaje;
}

function filtrosActuales() {
  return {
    desde: $('f-desde').value,
    hasta: $('f-hasta').value,
    usuario: $('f-usuario')?.value || '',
    cliente: $('f-cliente').value,
    proyecto: $('f-proyecto').value,
    modulo: $('f-modulo').value,
    facturable: $('f-facturable').value
  };
}

/* ------------------------------- Reporte ------------------------------- */

async function generarReporte() {
  if (!validarFiltros()) return;
  const filtros = filtrosActuales();
  try {
    ultimoReporte = await BD.obtenerReporte(filtros);
    const { totales, porDia, porProyecto, porModulo, porUsuario, detalle } = ultimoReporte;

    $('texto-periodo').textContent = `${formatearDia(filtros.desde)} – ${formatearDia(filtros.hasta)}` +
      (verEquipo ? '' : ' · solo tus horas');

    $('kpi-total').textContent = formatearDuracion(totales.segundos);
    $('kpi-facturable').textContent = formatearDuracion(totales.segundos_facturables);
    $('kpi-porcentaje').textContent = totales.segundos ? `(${Math.round(totales.segundos_facturables * 100 / totales.segundos)}%)` : '';
    $('kpi-importe').textContent = formatearMoneda(totales.importe);
    $('kpi-entradas').textContent = formatearNumero(totales.entradas);

    dibujarGrafica(porDia, filtros.desde, filtros.hasta);
    dibujarProyectos(porProyecto, totales.segundos);
    dibujarModulos(porModulo);
    if (verEquipo) dibujarMiembros(porUsuario);
    dibujarDetalle(detalle);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
}

/**
 * Gráfica de barras: una barra por día del periodo (los días sin horas quedan en 0).
 * Se dibuja con <div> y CSS (sin librerías). La altura de cada barra es el
 * porcentaje respecto al día con más horas. Al pasar el mouse se muestra el detalle.
 */
function dibujarGrafica(porDia, desde, hasta) {
  const grafica = $('grafica');
  const segundosPorFecha = new Map(porDia.map((d) => [d.fecha, d]));

  // Lista de todos los días del rango (máximo 92 para que las barras no queden demasiado delgadas)
  const dias = [];
  for (let f = new Date(`${desde}T00:00:00`); BD.fechas.fechaISO(f) <= hasta && dias.length < 92; f.setDate(f.getDate() + 1)) {
    dias.push(BD.fechas.fechaISO(f));
  }

  const maximo = Math.max(...dias.map((d) => segundosPorFecha.get(d)?.segundos || 0), 0);
  if (maximo === 0) {
    grafica.innerHTML = '<p class="text-body-secondary text-center w-100 align-self-center mb-0">No hay horas registradas en este periodo.</p>';
    return;
  }

  // Escala del eje: múltiplo de 2 horas por encima del máximo
  const horasEje = Math.max(2, Math.ceil(maximo / 3600 / 2) * 2);
  const cadaCuanto = Math.ceil(dias.length / 12); // etiquetas del eje X sin encimarse

  grafica.innerHTML = `
    <div class="grafica-eje" aria-hidden="true">
      <span>${horasEje} h</span><span>${horasEje / 2} h</span><span>0 h</span>
    </div>
    <div class="grafica-area">
      ${dias.map((dia, i) => {
        const d = segundosPorFecha.get(dia);
        const segundos = d?.segundos || 0;
        const alto = (segundos / 3600 / horasEje) * 100;
        const etiqueta = i % cadaCuanto === 0 ? new Date(`${dia}T00:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '';
        return `
          <div class="grafica-columna" data-dia="${dia}" data-segundos="${segundos}" data-importe="${d?.importe || 0}" tabindex="0"
               aria-label="${formatearDia(dia)}: ${formatearDuracion(segundos)}">
            <div class="grafica-barra" style="height:${alto}%"></div>
            <span class="grafica-etiqueta">${etiqueta}</span>
          </div>`;
      }).join('')}
    </div>`;

  // Tooltip al pasar el mouse o enfocar con el teclado (delegación de eventos)
  const tooltip = $('tooltip-grafica');
  const mostrar = (col) => {
    tooltip.innerHTML = `<strong>${formatearDia(col.dataset.dia)}</strong><br>
      <span class="font-monospace">${formatearDuracion(col.dataset.segundos)}</span> · ${formatearMoneda(Number(col.dataset.importe))}`;
    tooltip.classList.remove('d-none');
    const caja = col.getBoundingClientRect();
    const padre = grafica.parentElement.getBoundingClientRect();
    const x = Math.min(Math.max(caja.left - padre.left + caja.width / 2, 80), padre.width - 80);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${Math.max(caja.top - padre.top + caja.height * (1 - Number(col.dataset.segundos) / 3600 / horasEje) - 8, 0)}px`;
  };
  grafica.onmouseover = (e) => { const col = e.target.closest('.grafica-columna'); if (col) mostrar(col); };
  grafica.onfocusin = (e) => { const col = e.target.closest('.grafica-columna'); if (col) mostrar(col); };
  grafica.onmouseleave = () => tooltip.classList.add('d-none');
  grafica.onfocusout = () => tooltip.classList.add('d-none');
}

/** Desglose por proyecto: nombre, barra de porcentaje, tiempo e importe */
function dibujarProyectos(porProyecto, totalSegundos) {
  const lista = $('lista-proyectos');
  if (porProyecto.length === 0) {
    lista.innerHTML = '<li class="list-group-item text-body-secondary text-center py-4">Sin datos en este periodo.</li>';
    return;
  }
  lista.innerHTML = porProyecto.map((p) => {
    const porcentaje = totalSegundos ? (p.segundos * 100) / totalSegundos : 0;
    const color = p.proyecto_color || '#8c8c8c';
    return `
      <li class="list-group-item">
        <div class="d-flex justify-content-between align-items-center gap-2 mb-1">
          <span class="text-truncate">${etiquetaProyecto(p)}</span>
          <span class="text-nowrap small">
            <strong class="font-monospace">${formatearDuracion(p.segundos)}</strong>
            <span class="text-body-secondary ms-2">${formatearMoneda(p.importe)}</span>
          </span>
        </div>
        <div class="d-flex align-items-center gap-2">
          <div class="progress flex-grow-1" style="height: 0.5rem" role="progressbar" aria-valuenow="${Math.round(porcentaje)}" aria-valuemin="0" aria-valuemax="100"
               aria-label="${escaparHTML(p.proyecto_nombre || 'Sin proyecto')}">
            <div class="progress-bar" style="width:${porcentaje}%; background-color:${escaparHTML(color)}"></div>
          </div>
          <span class="small text-body-secondary text-end" style="width: 3rem">${formatearNumero(porcentaje, 1)}%</span>
        </div>
      </li>`;
  }).join('');
}

/**
 * Desglose por módulo: una fila de encabezado por proyecto (con su total) y debajo
 * sus módulos con tiempo, % dentro del proyecto e importe. "Sin módulo" agrupa
 * las entradas que aún no tienen módulo asignado.
 */
function dibujarModulos(porModulo) {
  const tabla = $('tabla-modulos');
  if (porModulo.length === 0) {
    tabla.innerHTML = '<tr><td colspan="5" class="text-center text-body-secondary py-4">Sin datos en este periodo.</td></tr>';
    return;
  }
  // Agrupar por proyecto conservando el orden de la consulta
  const proyectos = new Map();
  porModulo.forEach((f) => {
    const clave = f.proyecto_id ?? 0;
    if (!proyectos.has(clave)) proyectos.set(clave, { nombre: f.proyecto_nombre, color: f.proyecto_color, filas: [], segundos: 0, importe: 0, entradas: 0 });
    const p = proyectos.get(clave);
    p.filas.push(f);
    p.segundos += f.segundos;
    p.importe += f.importe;
    p.entradas += f.entradas;
  });

  let html = '';
  proyectos.forEach((p) => {
    html += `
      <tr class="table-light fila-proyecto">
        <td class="ps-3">${etiquetaProyecto({ proyecto_nombre: p.nombre, proyecto_color: p.color })}</td>
        <td class="text-end d-none d-sm-table-cell">${p.entradas}</td>
        <td class="text-end font-monospace fw-semibold">${formatearDuracion(p.segundos)}</td>
        <td class="d-none d-md-table-cell small text-body-secondary">Total del proyecto</td>
        <td class="text-end pe-3 fw-semibold">${formatearMoneda(p.importe)}</td>
      </tr>`;
    if (!p.nombre) return; // las entradas sin proyecto no tienen módulos
    p.filas.forEach((m) => {
      const porcentaje = p.segundos ? (m.segundos * 100) / p.segundos : 0;
      const presupuesto = m.presupuesto_horas
        ? `<div class="small text-body-secondary">Presupuesto: ${formatearNumero(m.segundos / 3600, 1)} / ${formatearNumero(m.presupuesto_horas, 1)} h</div>` : '';
      html += `
        <tr>
          <td class="ps-4">
            <i class="bi bi-arrow-return-right text-body-tertiary"></i>
            ${m.modulo_id ? escaparHTML(m.modulo_nombre) : '<span class="text-body-secondary fst-italic">Sin módulo</span>'}
            ${presupuesto}
          </td>
          <td class="text-end d-none d-sm-table-cell">${m.entradas}</td>
          <td class="text-end font-monospace">${formatearDuracion(m.segundos)}</td>
          <td class="d-none d-md-table-cell">
            <div class="d-flex align-items-center gap-2">
              <div class="progress flex-grow-1" style="height: 0.45rem" role="progressbar" aria-valuenow="${Math.round(porcentaje)}" aria-valuemin="0" aria-valuemax="100" aria-label="Porcentaje del proyecto">
                <div class="progress-bar" style="width:${porcentaje}%; background-color:${escaparHTML(p.color || '#8c8c8c')}"></div>
              </div>
              <span class="small text-body-secondary text-end" style="width: 3rem">${formatearNumero(porcentaje, 1)}%</span>
            </div>
          </td>
          <td class="text-end pe-3">${formatearMoneda(m.importe)}</td>
        </tr>`;
    });
  });
  tabla.innerHTML = html;
}

function dibujarMiembros(porUsuario) {
  $('tabla-miembros').innerHTML = porUsuario.length === 0
    ? '<tr><td colspan="3" class="text-center text-body-secondary py-4">Sin datos en este periodo.</td></tr>'
    : porUsuario.map((u) => `
      <tr>
        <td class="ps-3"><i class="bi bi-person-circle text-body-secondary"></i> ${escaparHTML(u.usuario_nombre)}</td>
        <td class="text-end font-monospace">${formatearDuracion(u.segundos)}</td>
        <td class="text-end pe-3">${formatearMoneda(u.importe)}</td>
      </tr>`).join('');
}

/** Tabla de detalle (se muestran hasta 200 filas; el CSV incluye todas) */
function dibujarDetalle(detalle) {
  const columnas = verEquipo ? 6 : 5;
  const visibles = detalle.slice(0, 200);
  $('nota-detalle').textContent = detalle.length > 200
    ? `Se muestran 200 de ${detalle.length} entradas (el CSV incluye todas).`
    : `${detalle.length} entrada(s)`;

  $('tabla-detalle').innerHTML = visibles.length === 0
    ? `<tr><td colspan="${columnas}" class="text-center text-body-secondary py-4">No hay entradas con estos filtros.</td></tr>`
    : visibles.map((e) => `
      <tr>
        <td class="text-nowrap small">${formatearDia(e.inicio.slice(0, 10))}</td>
        <td>
          <div class="${e.descripcion ? '' : 'text-body-secondary fst-italic'}">${escaparHTML(e.descripcion || '(sin descripción)')}</div>
          <div class="small">${etiquetaProyecto(e)}</div>
        </td>
        ${verEquipo ? `<td class="d-none d-md-table-cell small">${escaparHTML(e.usuario_nombre)}</td>` : ''}
        <td class="d-none d-sm-table-cell small text-nowrap">${horaDe(e.inicio)} – ${horaDe(e.fin)}</td>
        <td class="text-end font-monospace">${formatearDuracion(e.duracion)}</td>
        <td class="text-end text-nowrap">${e.facturable ? formatearMoneda(e.importe) : '<span class="text-body-tertiary">—</span>'}</td>
      </tr>`).join('');
}

/* ------------------------------- Exportar PDF ------------------------------- */

/**
 * Abre reporte-pdf.html con los mismos filtros en la URL. Esa página arma el
 * reporte en la hoja membretada, con la firma al final, y abre el cuadro de
 * impresión para elegir "Guardar como PDF".
 */
function exportarPDF() {
  if (!validarFiltros()) return;
  const filtros = Object.entries(filtrosActuales()).filter(([, valor]) => valor !== '');
  window.location.href = 'reporte-pdf.html?' + new URLSearchParams(filtros).toString();
}

/* ------------------------------- Exportar CSV ------------------------------- */

/**
 * Genera un archivo CSV con el detalle y lo descarga.
 * - Cada valor va entre comillas (y las comillas internas se duplican) para que
 *   las comas dentro de una descripción no rompan las columnas.
 * - Se agrega el BOM (﻿) para que Excel reconozca los acentos (UTF-8).
 */
function exportarCSV() {
  if (!ultimoReporte || ultimoReporte.detalle.length === 0) {
    mostrarAlerta('No hay entradas para exportar con estos filtros.', 'warning');
    return;
  }
  const comillas = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const encabezado = ['Fecha', 'Inicio', 'Fin', 'Miembro', 'Cliente', 'Proyecto', 'Módulo', 'Descripción',
    'Duración', 'Horas', 'Facturable', `Tarifa (${monedaSistema})`, `Importe (${monedaSistema})`];
  const filas = ultimoReporte.detalle.map((e) => [
    e.inicio.slice(0, 10), horaDe(e.inicio), horaDe(e.fin), e.usuario_nombre, e.cliente_nombre || '',
    e.proyecto_nombre || 'Sin proyecto', e.modulo_nombre || '', e.descripcion, formatearDuracion(e.duracion), horasDecimales(e.duracion),
    e.facturable ? 'Sí' : 'No', e.tarifa.toFixed(2), e.importe.toFixed(2)
  ]);
  const csv = [encabezado, ...filas].map((fila) => fila.map(comillas).join(',')).join('\r\n');

  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  enlace.download = `reporte_${$('f-desde').value}_a_${$('f-hasta').value}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
  mostrarAlerta(`Se exportaron ${filas.length} entradas a CSV.`);
}
