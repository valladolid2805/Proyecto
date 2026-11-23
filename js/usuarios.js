/**
 * usuarios.js
 * ----------------------------------------------------------------------------
 * Lógica de la página Equipo (usuarios.html). Solo Administrador.
 *   - READ:   lista los usuarios con su tarifa, horas del mes y cronómetro en curso.
 *   - CREATE / UPDATE: formulario en ventana modal (rol, tarifa por hora; la
 *     contraseña es opcional al editar).
 *   - UPDATE: activar / desactivar usuarios.
 *   - DELETE: eliminar usuarios con confirmación.
 *   - Ajustes del espacio de trabajo (empresa, moneda, tarifa general).
 *   - Respaldo de la base de datos: descargar, importar y restablecer.
 *   - Dibuja la matriz "Permisos por rol" a partir de Sesion.PERMISOS.
 *
 * Reglas que hace cumplir la capa de datos (js/basedatos.js):
 *   - El nombre de usuario no se puede repetir.
 *   - Nadie puede desactivarse o eliminarse a sí mismo.
 *   - Siempre debe quedar al menos un administrador activo.
 *   - Quien tiene horas registradas no se elimina: se desactiva.
 */

const tablaUsuarios = document.getElementById('tabla-usuarios');
const formUsuario = document.getElementById('form-usuario');
let modalUsuario = null;
let modalEliminarUsuario = null;
let idEditando = null;       // id del usuario que se edita (null = se está creando)
let usuarioAEliminar = null; // usuario elegido para eliminar

// Campos del formulario: nombre lógico -> id del input en el HTML
const CAMPOS = { nombre: 'u-nombre', usuario: 'u-usuario', rol: 'u-rol', tarifa_hora: 'u-tarifa', password: 'u-password', confirmar: 'u-confirmar' };

document.addEventListener('DOMContentLoaded', async () => {
  if (!Sesion.activa) return; // sin sesión o sin permiso: sesion.js ya está redirigiendo

  modalUsuario = new bootstrap.Modal(document.getElementById('modal-usuario'));
  modalEliminarUsuario = new bootstrap.Modal(document.getElementById('modal-eliminar-usuario'));

  dibujarPermisos();
  registrarEventos();
  registrarEventosRespaldo();
  try {
    await cargarFormularioAjustes();
    await cargarUsuarios();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
});

/* ------------------------------ Ajustes ------------------------------ */

const CAMPOS_AJUSTES = { empresa: 'a-empresa', moneda: 'a-moneda', tarifa_general: 'a-tarifa' };

async function cargarFormularioAjustes() {
  const config = await cargarAjustes();
  document.getElementById('a-empresa').value = config.empresa;
  document.getElementById('a-moneda').value = config.moneda;
  document.getElementById('a-tarifa').value = config.tarifa_general;
}

async function guardarAjustes(evento) {
  evento.preventDefault();
  const datos = {
    empresa: document.getElementById('a-empresa').value,
    moneda: document.getElementById('a-moneda').value,
    tarifa_general: document.getElementById('a-tarifa').value
  };
  const errores = {};
  if (datos.empresa.trim().length < 2) errores.empresa = 'Escribe el nombre de la empresa.';
  if (datos.tarifa_general === '' || Number(datos.tarifa_general) < 0) errores.tarifa_general = 'Indica una tarifa de 0 o más.';
  marcarErroresEn(CAMPOS_AJUSTES, errores);
  if (Object.keys(errores).length) return;

  try {
    await BD.guardarConfiguracion(datos);
    await cargarFormularioAjustes();
    await cargarUsuarios(); // las tarifas se muestran en la nueva moneda
    mostrarAlerta('Ajustes guardados.');
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcarErroresEn(CAMPOS_AJUSTES, error.errores || {});
  }
}

function marcarErroresEn(campos, errores) {
  for (const [campo, id] of Object.entries(campos)) {
    const mensaje = errores[campo] || '';
    document.getElementById(id).classList.toggle('is-invalid', Boolean(mensaje));
    document.getElementById(`error-${id}`).textContent = mensaje;
  }
}

/* --------------------------- Respaldo de la BD --------------------------- */

function registrarEventosRespaldo() {
  const selectorArchivo = document.getElementById('archivo-importar');
  const modalRestablecer = new bootstrap.Modal(document.getElementById('modal-restablecer'));

  // Descargar el archivo tiempos.db
  document.getElementById('btn-exportar').addEventListener('click', async () => {
    try {
      await BD.exportarArchivo();
      mostrarAlerta('Se descargó el archivo tiempos.db.');
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
    }
  });

  // El botón "Importar" abre el selector de archivos oculto
  document.getElementById('btn-importar').addEventListener('click', () => selectorArchivo.click());
  selectorArchivo.addEventListener('change', async () => {
    const archivo = selectorArchivo.files[0];
    if (!archivo) return;
    try {
      await BD.importarArchivo(archivo);
      mostrarAlerta(`Se importó "${archivo.name}" correctamente.`);
      await cargarFormularioAjustes();
      await cargarUsuarios();
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
    } finally {
      selectorArchivo.value = ''; // permite volver a elegir el mismo archivo
    }
  });

  // Restablecer pide confirmación con una ventana modal
  document.getElementById('btn-restablecer').addEventListener('click', () => modalRestablecer.show());
  document.getElementById('btn-confirmar-restablecer').addEventListener('click', async () => {
    try {
      await BD.restablecer();
      modalRestablecer.hide();
      mostrarAlerta('Se cargaron de nuevo los proyectos y horas de ejemplo.');
      await cargarUsuarios();
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
    }
  });
}

/* ------------------------------ Carga y tabla ------------------------------ */

/** Consulta los usuarios en la base de datos y dibuja la tabla */
async function cargarUsuarios() {
  try {
    const usuarios = await BD.listarUsuarios();
    dibujarTabla(usuarios);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    tablaUsuarios.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">No se pudieron cargar los usuarios.</td></tr>';
  }
}

/** Genera una fila <tr> por usuario */
function dibujarTabla(usuarios) {
  const yo = Sesion.actual();
  const activos = usuarios.filter((u) => u.activo === 1).length;
  document.getElementById('contador-usuarios').textContent =
    `${usuarios.length} usuario(s) registrados · ${activos} activo(s)`;

  tablaUsuarios.innerHTML = usuarios.map((u) => {
    const esYo = u.id === yo.id; // al usuario actual no se le permite desactivarse ni eliminarse
    const estado = u.activo === 1
      ? '<span class="badge text-bg-success"><i class="bi bi-check-circle"></i> Activo</span>'
      : '<span class="badge text-bg-light border"><i class="bi bi-slash-circle"></i> Inactivo</span>';

    return `
      <tr data-id="${u.id}" class="${u.activo === 1 ? '' : 'text-body-secondary'}">
        <td>
          <div class="fw-semibold">${escaparHTML(u.nombre)} ${esYo ? '<span class="badge text-bg-info">Tú</span>' : ''}
            ${u.corriendo ? '<span class="badge text-bg-danger" title="Tiene el cronómetro corriendo"><i class="bi bi-record-circle"></i> Trabajando</span>' : ''}</div>
          <div class="small text-body-secondary"><i class="bi bi-person"></i> ${escaparHTML(u.usuario)}</div>
        </td>
        <td>${Sesion.badgeRol(u.rol)}</td>
        <td class="d-none d-md-table-cell">${estado}</td>
        <td class="text-end text-nowrap">${u.tarifa_hora > 0 ? formatearMoneda(u.tarifa_hora) : '<span class="text-body-secondary small">General</span>'}</td>
        <td class="d-none d-md-table-cell text-end">
          <a class="font-monospace" href="reportes.html?usuario=${u.id}" title="Ver reporte">${formatearDuracion(u.segundos_mes)}</a>
        </td>
        <td class="d-none d-lg-table-cell small">${u.ultimo_acceso ? formatearFecha(u.ultimo_acceso) : 'Nunca'}</td>
        <td class="text-end text-nowrap">
          <button type="button" class="btn btn-sm btn-outline-primary" data-accion="editar" title="Editar" aria-label="Editar">
            <i class="bi bi-pencil"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-${u.activo === 1 ? 'warning' : 'success'}" data-accion="estado"
                  title="${u.activo === 1 ? 'Desactivar' : 'Activar'}" aria-label="${u.activo === 1 ? 'Desactivar' : 'Activar'}" ${esYo ? 'disabled' : ''}>
            <i class="bi ${u.activo === 1 ? 'bi-pause-circle' : 'bi-play-circle'}"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-accion="eliminar" title="Eliminar" aria-label="Eliminar"
                  data-nombre="${escaparHTML(u.nombre)}" ${esYo ? 'disabled' : ''}>
            <i class="bi bi-trash"></i>
          </button>
        </td>
      </tr>`;
  }).join('');
}

/** Dibuja la matriz de permisos (filas = acciones, columnas = roles) */
function dibujarPermisos() {
  const acciones = {
    'tiempo.registrar': 'Usar el cronómetro y registrar tiempo (propio)',
    'tiempo.editar_todos': 'Corregir o eliminar el tiempo de otros',
    'reportes.ver': 'Ver reportes',
    'tiempo.ver_todos': 'Ver las horas de todo el equipo',
    'proyectos.ver': 'Ver proyectos y clientes',
    'proyectos.gestionar': 'Crear y editar proyectos, clientes y tarifas',
    'usuarios.gestionar': 'Administrar equipo, tarifas por miembro y ajustes',
    'bd.respaldo': 'Respaldar / importar / restablecer la BD'
  };
  const roles = Object.keys(Sesion.ROLES);

  let html = '<thead><tr><th class="text-start ps-3">Acción</th>' +
    roles.map((r) => `<th>${Sesion.badgeRol(r)}</th>`).join('') + '</tr></thead><tbody>';
  for (const [permiso, texto] of Object.entries(acciones)) {
    html += `<tr><td class="text-start ps-3">${texto}</td>` + roles.map((r) =>
      Sesion.PERMISOS[permiso].includes(r)
        ? '<td><i class="bi bi-check-circle-fill text-success" aria-label="Sí"></i></td>'
        : '<td><i class="bi bi-dash-circle text-body-tertiary" aria-label="No"></i></td>'
    ).join('') + '</tr>';
  }
  document.getElementById('tabla-permisos').innerHTML = html + '</tbody>';
}

/* --------------------------------- Eventos --------------------------------- */

function registrarEventos() {
  document.getElementById('btn-nuevo-usuario').addEventListener('click', () => abrirFormulario(null));
  formUsuario.addEventListener('submit', guardarUsuario);
  document.getElementById('btn-confirmar-eliminar-usuario').addEventListener('click', eliminarUsuario);
  document.getElementById('form-ajustes').addEventListener('submit', guardarAjustes);

  // El usuario siempre en minúsculas
  document.getElementById('u-usuario').addEventListener('input', (e) => {
    e.target.value = e.target.value.toLowerCase();
  });

  // Delegación de eventos: un solo listener atiende los botones de todas las filas
  tablaUsuarios.addEventListener('click', async (evento) => {
    const boton = evento.target.closest('button[data-accion]');
    if (!boton) return;
    const id = Number(boton.closest('tr').dataset.id);

    if (boton.dataset.accion === 'editar') abrirFormulario(id);
    if (boton.dataset.accion === 'estado') alternarEstado(id);
    if (boton.dataset.accion === 'eliminar') {
      usuarioAEliminar = { id, nombre: boton.dataset.nombre };
      document.getElementById('nombre-eliminar-usuario').textContent = usuarioAEliminar.nombre;
      modalEliminarUsuario.show();
    }
  });
}

/* ------------------------------ Formulario ------------------------------ */

/** Abre el modal vacío (crear) o con los datos del usuario (editar) */
async function abrirFormulario(id) {
  idEditando = id;
  formUsuario.reset();
  limpiarErrores();

  const esNuevo = id === null;
  document.getElementById('titulo-modal-usuario').textContent = esNuevo ? 'Nuevo usuario' : 'Editar usuario';
  document.getElementById('marca-password').classList.toggle('d-none', !esNuevo);
  document.getElementById('ayuda-password').textContent = esNuevo
    ? 'Mínimo 6 caracteres.'
    : 'Déjala vacía para conservar la contraseña actual. Mínimo 6 caracteres si la cambias.';

  if (!esNuevo) {
    try {
      const u = await BD.obtenerUsuario(id);
      document.getElementById(CAMPOS.nombre).value = u.nombre;
      document.getElementById(CAMPOS.usuario).value = u.usuario;
      document.getElementById(CAMPOS.rol).value = u.rol;
      document.getElementById(CAMPOS.tarifa_hora).value = u.tarifa_hora || '';
    } catch (error) {
      mostrarAlerta(error.message, 'danger');
      return;
    }
  }
  modalUsuario.show();
}

/** Validación en el navegador (la capa de datos vuelve a validar) */
function validarFormularioUsuario() {
  const valor = (campo) => document.getElementById(CAMPOS[campo]).value;
  const esNuevo = idEditando === null;
  const errores = {};

  if (valor('nombre').trim().length < 3) errores.nombre = 'Escribe el nombre completo (mínimo 3 caracteres).';
  if (!/^[a-z0-9._]{3,20}$/.test(valor('usuario').trim())) errores.usuario = 'De 3 a 20 caracteres: letras, números, punto o guion bajo.';
  if (!valor('rol')) errores.rol = 'Selecciona un rol.';
  if (valor('tarifa_hora') !== '' && Number(valor('tarifa_hora')) < 0) errores.tarifa_hora = 'La tarifa no puede ser negativa.';
  if ((esNuevo || valor('password')) && valor('password').length < 6) errores.password = 'Mínimo 6 caracteres.';
  if (valor('password') !== valor('confirmar')) errores.confirmar = 'Las contraseñas no coinciden.';

  marcarErrores(errores);
  return Object.keys(errores).length === 0;
}

/** Marca en rojo los campos con error y en verde los correctos */
function marcarErrores(errores) {
  for (const [campo, idInput] of Object.entries(CAMPOS)) {
    const input = document.getElementById(idInput);
    const mensaje = errores[campo] || '';
    document.getElementById(`error-${idInput}`).textContent = mensaje;
    input.classList.toggle('is-invalid', Boolean(mensaje));
  }
}

function limpiarErrores() {
  Object.values(CAMPOS).forEach((id) => document.getElementById(id).classList.remove('is-invalid'));
}

/** CREATE o UPDATE del usuario */
async function guardarUsuario(evento) {
  evento.preventDefault();
  if (!validarFormularioUsuario()) {
    formUsuario.querySelector('.is-invalid')?.focus();
    return;
  }

  const datos = {
    nombre: document.getElementById(CAMPOS.nombre).value,
    usuario: document.getElementById(CAMPOS.usuario).value,
    rol: document.getElementById(CAMPOS.rol).value,
    tarifa_hora: document.getElementById(CAMPOS.tarifa_hora).value,
    password: document.getElementById(CAMPOS.password).value
  };

  const boton = document.getElementById('btn-guardar-usuario');
  boton.disabled = true;
  try {
    if (idEditando === null) {
      await BD.crearUsuario(datos);
      mostrarAlerta(`Se creó el usuario "${datos.usuario}".`, 'success');
    } else {
      await BD.actualizarUsuario(idEditando, datos);
      mostrarAlerta(`Se actualizó el usuario "${datos.usuario}".`, 'success');
    }
    modalUsuario.hide();
    await cargarUsuarios();

    // Si el administrador se editó a sí mismo, actualizar la sesión (nombre, usuario o rol)
    if (idEditando === Sesion.actual().id) setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
    marcarErrores(error.errores || {});
  } finally {
    boton.disabled = false;
  }
}

/* ------------------------ Activar / eliminar ------------------------ */

/** Activa un usuario inactivo o desactiva uno activo */
async function alternarEstado(id) {
  try {
    const u = await BD.obtenerUsuario(id);
    const activar = u.activo !== 1;
    await BD.cambiarEstadoUsuario(id, activar);
    mostrarAlerta(`"${u.usuario}" ahora está ${activar ? 'activo' : 'inactivo'}.`, activar ? 'success' : 'warning');
    await cargarUsuarios();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  }
}

/** DELETE del usuario confirmado en el modal */
async function eliminarUsuario() {
  if (!usuarioAEliminar) return;
  try {
    await BD.eliminarUsuario(usuarioAEliminar.id);
    modalEliminarUsuario.hide();
    mostrarAlerta(`Se eliminó a "${usuarioAEliminar.nombre}".`, 'success');
    await cargarUsuarios();
  } catch (error) {
    mostrarAlerta(error.message, 'danger');
  } finally {
    usuarioAEliminar = null;
  }
}
