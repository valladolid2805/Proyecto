/**
 * reporte-pdf.js
 * ----------------------------------------------------------------------------
 * Arma el "Reporte de actividades" en la hoja membretada (reporte-pdf.html).
 *   1. Lee los filtros de la URL (los manda el botón "Exportar PDF" de Reportes).
 *   2. Pide los datos a BD.obtenerReporte() (la misma consulta de la página Reportes).
 *   3. Escribe: título, periodo, resumen, tiempo por proyecto y módulo, y el
 *      detalle de actividades en orden cronológico.
 *   4. Abre el cuadro de impresión: ahí se elige "Guardar como PDF".
 * La firma y el nombre ya están en el HTML, siempre al final del reporte.
 */

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  if (!Sesion.activa) return;

  $('btn-imprimir').addEventListener('click', () => window.print());
  // "Regresar" vuelve a Reportes con los mismos filtros
  $('btn-regresar').href = 'reportes.html' + window.location.search;

  try {
    await cargarAjustes();
    const filtros = leerFiltros();
    const reporte = await BD.obtenerReporte(filtros);
    $('contenido-reporte').innerHTML = await armarReporte(filtros, reporte);
    // Fecha debajo del nombre en la firma
    document.querySelectorAll('.fecha-firma').forEach((p) => {
      p.textContent = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    });

    // Se espera a que carguen la tipografía y las imágenes antes de imprimir
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    if (obtenerParametroURL('imprimir') !== '0') window.print();
  } catch (error) {
    $('contenido-reporte').innerHTML = `<p class="text-danger">No se pudo generar el reporte: ${escaparHTML(error.message)}</p>`;
  }
});

/** Filtros desde la URL. Si no vienen fechas, se usa el mes actual. */
function leerFiltros() {
  const p = (n) => obtenerParametroURL(n) || '';
  return {
    desde: p('desde') || `${BD.hoy().slice(0, 7)}-01`,
    hasta: p('hasta') || BD.hoy(),
    usuario: p('usuario'),
    cliente: p('cliente'),
    proyecto: p('proyecto'),
    modulo: p('modulo'),
    facturable: p('facturable')
  };
}

/** Texto de los filtros aplicados (ej. "Proyecto: Grupo Oleo Lab · Módulo: Glosa") */
async function describirFiltros(f, reporte) {
  const partes = [];
  const fila = reporte.detalle[0]; // los nombres se toman de los propios datos
  if (f.proyecto === 'ninguno') partes.push('Proyecto: sin proyecto');
  else if (f.proyecto && fila) partes.push(`Proyecto: ${fila.proyecto_nombre}`);
  if (f.modulo === 'ninguno') partes.push('Módulo: sin módulo');
  else if (f.modulo && fila) partes.push(`Módulo: ${fila.modulo_nombre}`);
  if (f.cliente && fila) partes.push(`Cliente: ${fila.cliente_nombre}`);
  if (f.usuario && fila) partes.push(`Miembro: ${fila.usuario_nombre}`);
  if (f.facturable === '1') partes.push('Solo facturable');
  if (f.facturable === '0') partes.push('Solo no facturable');
  return partes.length ? partes.join(' · ') : 'Todos los proyectos y módulos';
}

/** HTML completo del reporte */
async function armarReporte(f, r) {
  const config = await cargarAjustes();
  const usuario = Sesion.actual();
  const t = r.totales;
  const porcentaje = t.segundos ? Math.round((t.segundos_facturables * 100) / t.segundos) : 0;

  let html = `
    <h1 class="titulo-reporte">REPORTE DE ACTIVIDADES</h1>
    <p class="subtitulo-reporte">Del ${formatearDia(f.desde)} al ${formatearDia(f.hasta)}</p>
    <div class="datos-reporte">
      <div><strong>${escaparHTML(config.empresa)}</strong></div>
      <div>${escaparHTML(await describirFiltros(f, r))}${Sesion.puede('tiempo.ver_todos') ? '' : ` · Horas de ${escaparHTML(usuario.nombre)}`}</div>
      <div>Emitido el ${formatearFecha(BD.fechas.fechaHora(new Date()))} por ${escaparHTML(usuario.nombre)}</div>
    </div>

    <h2 class="seccion-reporte">Resumen</h2>
    <div class="resumen-reporte">
      <div><span>Tiempo total</span><strong>${formatearDuracion(t.segundos)}</strong></div>
      <div><span>Facturable (${porcentaje}%)</span><strong>${formatearDuracion(t.segundos_facturables)}</strong></div>
      <div><span>Importe</span><strong>${formatearMoneda(t.importe)}</strong></div>
      <div><span>Actividades</span><strong>${t.entradas}</strong></div>
    </div>`;

  // Firma (HTML de la plantilla en reporte-pdf.html)
  const firma = $('plantilla-firma').innerHTML;

  if (t.entradas === 0) {
    return html + '<p class="mt-4">No hay actividades registradas con estos filtros en el periodo.</p>' + firma;
  }

  // Tiempo por proyecto y módulo
  html += `
    <h2 class="seccion-reporte">Tiempo por proyecto y módulo</h2>
    <table class="tabla-reporte">
      <thead><tr><th>Proyecto / módulo</th><th class="num">Actividades</th><th class="num">Tiempo</th><th class="num">%</th><th class="num">Importe</th></tr></thead>
      <tbody>${filasModulos(r.porModulo)}</tbody>
    </table>`;

  // Detalle cronológico (del más antiguo al más reciente)
  const detalle = [...r.detalle].reverse();
  // La columna "Miembro" solo se muestra si en el reporte hay horas de más de una persona
  const verMiembro = new Set(detalle.map((e) => e.usuario_id)).size > 1;
  const fechaCorta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`; // 2026-10-22 -> 22/10/2026
  html += `
    <h2 class="seccion-reporte">Detalle de actividades</h2>
    <table class="tabla-reporte tabla-detalle">
      <colgroup>
        <col style="width:0.8in"><col>${verMiembro ? '<col style="width:1in">' : ''}<col style="width:0.95in"><col style="width:0.7in"><col style="width:0.8in">
      </colgroup>
      <thead><tr><th>Fecha</th><th>Actividad</th>${verMiembro ? '<th>Miembro</th>' : ''}<th>Horario</th><th class="num">Duración</th><th class="num">Importe</th></tr></thead>
      <tbody>
        ${detalle.map((e) => `
          <tr>
            <td style="white-space:nowrap">${fechaCorta(e.inicio)}</td>
            <td>
              ${escaparHTML(e.descripcion || '(sin descripción)')}
              <div class="detalle-proyecto">${escaparHTML(e.proyecto_nombre || 'Sin proyecto')}${e.modulo_nombre ? ' › ' + escaparHTML(e.modulo_nombre) : ''}</div>
            </td>
            ${verMiembro ? `<td>${escaparHTML(e.usuario_nombre)}</td>` : ''}
            <td style="white-space:nowrap">${horaDe(e.inicio)} – ${horaDe(e.fin)}</td>
            <td class="num">${formatearDuracion(e.duracion)}</td>
            <td class="num">${e.facturable ? formatearMoneda(e.importe) : '—'}</td>
          </tr>`).join('')}
        <!-- Último renglón: total + firma juntos (un renglón no se parte entre hojas) -->
        <tr class="fila-cierre">
          <td colspan="${verMiembro ? 6 : 5}">
            <div class="total-cierre">
              <span>Total</span>
              <span class="num">${formatearDuracion(t.segundos)}</span>
              <span class="num">${formatearMoneda(t.importe)}</span>
            </div>
            ${firma}
          </td>
        </tr>
      </tbody>
    </table>`;
  return html;
}

/** Filas de "Tiempo por proyecto y módulo": total de cada proyecto y sus módulos debajo */
function filasModulos(porModulo) {
  const proyectos = new Map();
  porModulo.forEach((f) => {
    const clave = f.proyecto_id ?? 0;
    if (!proyectos.has(clave)) proyectos.set(clave, { nombre: f.proyecto_nombre || 'Sin proyecto', filas: [], segundos: 0, importe: 0, entradas: 0 });
    const p = proyectos.get(clave);
    p.filas.push(f);
    p.segundos += f.segundos;
    p.importe += f.importe;
    p.entradas += f.entradas;
  });

  let html = '';
  proyectos.forEach((p) => {
    html += `<tr class="fila-total"><td>${escaparHTML(p.nombre)}</td><td class="num">${p.entradas}</td>
      <td class="num">${formatearDuracion(p.segundos)}</td><td class="num">100%</td><td class="num">${formatearMoneda(p.importe)}</td></tr>`;
    if (p.nombre === 'Sin proyecto') return;
    p.filas.forEach((m) => {
      const pct = p.segundos ? Math.round((m.segundos * 100) / p.segundos) : 0;
      html += `<tr><td style="padding-left:1.2rem">${m.modulo_id ? escaparHTML(m.modulo_nombre) : '<em>Sin módulo</em>'}</td>
        <td class="num">${m.entradas}</td><td class="num">${formatearDuracion(m.segundos)}</td><td class="num">${pct}%</td>
        <td class="num">${formatearMoneda(m.importe)}</td></tr>`;
    });
  });
  return html;
}
