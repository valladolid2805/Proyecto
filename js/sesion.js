/**
 * sesion.js
 * ----------------------------------------------------------------------------
 * INICIO DE SESIÓN, ROLES Y PERMISOS.
 *
 * Responsabilidades:
 *   1. Guardar quién inició sesión (en sessionStorage: se borra al cerrar la pestaña).
 *   2. Definir QUÉ puede hacer cada rol (matriz PERMISOS, en un solo lugar).
 *   3. Proteger cada página:
 *        - sin sesión            -> se envía a login.html
 *        - sin permiso de página -> se envía al inicio con un aviso
 *   4. Quitar de la pantalla los botones/secciones que el rol no puede usar
 *      (elementos HTML con el atributo data-permiso="...").
 *   5. Dibujar en la barra de navegación el menú del usuario con "Cerrar sesión".
 *
 * Se carga en TODAS las páginas después de basedatos.js y app.js, y antes del
 * script propio de cada página. Expone el objeto global "Sesion".
 *
 * IMPORTANTE: como todo el sistema corre en el navegador, este control de acceso
 * organiza el trabajo y evita errores, pero no sustituye la seguridad de un
 * servidor (ver documentación, sección de seguridad).
 */
const Sesion = (() => {
  // Clave con la que se guarda la sesión en sessionStorage
  const CLAVE = 'controlTiempo.sesion';

  /*
   * MATRIZ DE PERMISOS: para cada acción, qué roles la pueden realizar.
   * Cambiar lo que puede hacer un rol = editar esta tabla.
   */
  const PERMISOS = {
    'tiempo.registrar':     ['administrador', 'colaborador'],              // cronómetro y entradas manuales (propias)
    'tiempo.editar_todos':  ['administrador'],                             // corregir/eliminar entradas de otros
    'tiempo.ver_todos':     ['administrador', 'consulta'],                 // reportes de todo el equipo
    'reportes.ver':         ['administrador', 'colaborador', 'consulta'],  // colaborador: solo sus horas
    'proyectos.ver':        ['administrador', 'colaborador', 'consulta'],
    'proyectos.gestionar':  ['administrador'],                             // proyectos, clientes y tarifas
    'usuarios.gestionar':   ['administrador'],                             // equipo, tarifas por miembro y ajustes
    'bd.respaldo':          ['administrador']
  };

  // Texto, color (Bootstrap) e ícono con que se muestra cada rol
  const ROLES = {
    administrador: { nombre: 'Administrador', color: 'danger', icono: 'bi-shield-lock' },
    colaborador:   { nombre: 'Colaborador', color: 'primary', icono: 'bi-person-workspace' },
    consulta:      { nombre: 'Consulta', color: 'secondary', icono: 'bi-eye' }
  };

  /* --------------------------- Datos de la sesión --------------------------- */

  /** Devuelve el usuario con sesión iniciada { id, usuario, nombre, rol } o null */
  function actual() {
    try {
      return JSON.parse(sessionStorage.getItem(CLAVE));
    } catch {
      return null;
    }
  }

  /** Guarda en sessionStorage solo los datos necesarios (nunca la contraseña) */
  function guardar(u) {
    sessionStorage.setItem(CLAVE, JSON.stringify({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol }));
  }

  /** ¿El usuario actual puede realizar la acción indicada? */
  function puede(permiso) {
    const u = actual();
    return Boolean(u && PERMISOS[permiso]?.includes(u.rol));
  }

  /**
   * ¿El usuario actual puede modificar ESTA entrada de tiempo?
   * - Administrador: cualquiera.
   * - Colaborador: solo las suyas.
   * (La capa de datos aplica la misma regla en exigirPropiedad.)
   */
  function puedeModificar(registro) {
    if (!puede('tiempo.registrar')) return false;
    if (puede('tiempo.editar_todos')) return true;
    return registro.usuario_id === actual()?.id;
  }

  /** Verifica usuario y contraseña contra la BD y, si son correctos, abre la sesión */
  async function iniciar(usuario, password) {
    const u = await BD.autenticar(usuario, password);
    guardar(u);
    return u;
  }

  /** Cierra la sesión y regresa a la pantalla de acceso */
  function cerrar() {
    sessionStorage.removeItem(CLAVE);
    window.location.href = 'login.html';
  }

  /** HTML de la insignia de color de un rol */
  function badgeRol(rol) {
    const r = ROLES[rol] || { nombre: rol, color: 'dark', icono: 'bi-person' };
    return `<span class="badge text-bg-${r.color}"><i class="bi ${r.icono}"></i> ${r.nombre}</span>`;
  }

  /* --------------------------- Interfaz por rol --------------------------- */

  /**
   * Quita del DOM los elementos marcados con data-permiso que el rol no puede usar.
   * Ejemplo en HTML:  <a href="usuarios.html" data-permiso="usuarios.gestionar">Equipo</a>
   */
  function aplicarPermisos(raiz = document) {
    raiz.querySelectorAll('[data-permiso]').forEach((el) => {
      if (!puede(el.dataset.permiso)) el.remove();
    });
  }

  /** Agrega a la barra de navegación el menú desplegable del usuario */
  function pintarMenuUsuario() {
    const menu = document.querySelector('.navbar .navbar-nav');
    const u = actual();
    if (!menu || !u) return;

    const li = document.createElement('li');
    li.className = 'nav-item dropdown ms-lg-3';
    li.innerHTML = `
      <a class="nav-link dropdown-toggle" href="#" id="menu-usuario" role="button" data-bs-toggle="dropdown" aria-expanded="false">
        <i class="bi bi-person-circle"></i> ${escaparHTML(u.nombre)}
      </a>
      <ul class="dropdown-menu dropdown-menu-end shadow" aria-labelledby="menu-usuario">
        <li class="px-3 py-2">
          <div class="small text-body-secondary">Sesión iniciada como</div>
          <div class="fw-semibold">${escaparHTML(u.usuario)}</div>
          <div class="mt-1">${badgeRol(u.rol)}</div>
        </li>
        <li><hr class="dropdown-divider"></li>
        <li><a class="dropdown-item" href="reportes.html"><i class="bi bi-bar-chart"></i> Mis reportes</a></li>
        <li>
          <button type="button" class="dropdown-item text-danger" id="btn-cerrar-sesion">
            <i class="bi bi-box-arrow-right"></i> Cerrar sesión
          </button>
        </li>
      </ul>`;
    menu.appendChild(li);
    li.querySelector('#btn-cerrar-sesion').addEventListener('click', cerrar);
  }

  /**
   * Indicador del cronómetro en la barra de navegación (en todas las páginas
   * excepto el rastreador, que ya lo muestra en grande). Si hay un cronómetro
   * corriendo se ve "● 00:12:34" en rojo y al hacer clic se va al rastreador.
   */
  async function pintarCronometroEnMenu() {
    const pagina = window.location.pathname.split('/').pop() || 'index.html';
    const menu = document.querySelector('.navbar .navbar-nav');
    if (pagina === 'index.html' || !menu || !puede('tiempo.registrar')) return;

    const corriendo = await BD.obtenerCronometro();
    if (!corriendo) return;

    const li = document.createElement('li');
    li.className = 'nav-item';
    li.innerHTML = `
      <a class="nav-link" href="index.html" id="cronometro-menu" title="Cronómetro en curso: ${escaparHTML(corriendo.descripcion || 'sin descripción')}">
        <span class="badge text-bg-danger"><i class="bi bi-record-circle"></i> <span class="font-monospace">00:00:00</span></span>
      </a>`;
    menu.insertBefore(li, menu.lastElementChild); // antes del menú del usuario

    const reloj = li.querySelector('.font-monospace');
    const inicio = BD.fechas.aFecha(corriendo.inicio);
    const actualizar = () => { reloj.textContent = formatearDuracion((Date.now() - inicio) / 1000); };
    actualizar();
    setInterval(actualizar, 1000);
  }

  /* ---------------------------- Protección ---------------------------- */

  /**
   * Se ejecuta automáticamente al cargar el script en cada página.
   * Devuelve true si la página puede usarse; false si se está redirigiendo.
   * El permiso que exige una página se declara en su <body data-permiso="...">.
   */
  function proteger() {
    const pagina = window.location.pathname.split('/').pop() || 'index.html';
    if (pagina === 'login.html') return true; // la pantalla de acceso es pública

    const u = actual();
    if (!u) {
      window.location.replace('login.html');
      return false;
    }

    const permisoPagina = document.body.dataset.permiso;
    if (permisoPagina && !puede(permisoPagina)) {
      guardarMensajeFlash('No tienes permiso para entrar a esa página.', 'warning');
      window.location.replace('index.html');
      return false;
    }

    aplicarPermisos();
    pintarMenuUsuario();
    pintarCronometroEnMenu().catch(() => { /* si falla, simplemente no se muestra */ });

    // En segundo plano se confirma contra la base de datos que el usuario siga
    // existiendo y activo, y que su rol no haya cambiado mientras navegaba.
    BD.validarSesion(u.id).then((fila) => {
      if (!fila) {
        sessionStorage.removeItem(CLAVE);
        guardarMensajeFlash('Tu sesión ya no es válida. Inicia sesión de nuevo.', 'warning');
        window.location.replace('login.html');
      } else if (fila.rol !== u.rol || fila.nombre !== u.nombre || fila.usuario !== u.usuario) {
        guardar(fila);
        window.location.reload(); // recargar para aplicar los permisos del rol nuevo
      }
    }).catch(() => { /* si la BD falla, la propia página mostrará el error */ });

    return true;
  }

  const activa = proteger();

  return { actual, puede, puedeModificar, iniciar, cerrar, badgeRol, aplicarPermisos, activa, ROLES, PERMISOS };
})();
