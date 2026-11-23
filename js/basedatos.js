/**
 * basedatos.js
 * ----------------------------------------------------------------------------
 * CAPA DE DATOS: conexión entre las páginas y la base de datos SQLite.
 *
 * ¿Cómo funciona SQLite sin servidor?
 *   Se usa la librería sql.js (vendor/sqljs/sql-asm.js), que es el motor
 *   SQLite original compilado a JavaScript. Así el navegador ejecuta SQL real
 *   (CREATE TABLE, INSERT, SELECT, UPDATE, DELETE) abriendo las páginas con
 *   doble clic (file://), sin instalar nada.
 *
 * ¿Dónde se guardan los datos?
 *   sql.js trabaja en memoria. Después de cada cambio, el archivo completo de la
 *   base (los bytes de un .db de SQLite) se guarda en el localStorage del
 *   navegador. Al abrir cualquier página se vuelve a cargar desde ahí.
 *   Con "Descargar .db" / "Importar .db" (página Equipo, solo administrador) se respalda.
 *
 * Tablas (relacionadas con llaves foráneas):
 *   configuracion -> ajustes del espacio de trabajo (empresa, moneda, tarifa general)
 *   usuarios      -> cuentas de acceso con rol, contraseña cifrada y TARIFA POR HORA
 *   clientes      -> empresas a las que se les cobra el trabajo
 *   proyectos     -> en qué se trabaja: cliente, color, tarifa, facturable, presupuesto
 *   modulos       -> partes de un proyecto (ej. "Glosa", "Balance") para saber el tiempo por módulo
 *   registros     -> ENTRADAS DE TIEMPO: quién, en qué proyecto y módulo, de qué hora a qué hora,
 *                    si es facturable y a qué tarifa. Si "fin" está vacío (NULL) el
 *                    cronómetro sigue corriendo.
 *
 * ¿Cómo se calcula el dinero? (igual que en Clockify)
 *   tarifa de la entrada = tarifa del proyecto  (si el proyecto tiene una)
 *                        ó tarifa del miembro   (si es mayor que 0)
 *                        ó tarifa general       (configuración)
 *   importe = horas × tarifa   (solo si la entrada es facturable)
 *   La tarifa se COPIA en la entrada al guardarla: si después cambia la tarifa,
 *   lo ya trabajado conserva el precio con el que se registró.
 *
 * Permisos: cada operación que modifica datos llama primero a exigir('permiso'),
 * que consulta la matriz de roles definida en js/sesion.js.
 *
 * Todas las páginas usan el objeto global "BD". Sus funciones son async y, si
 * algo falla, lanzan un Error con:
 *   error.message -> mensaje general
 *   error.errores -> { campo: 'mensaje' } para marcar campos del formulario
 *
 * El código está dentro de una función autoejecutable (IIFE) para que sus
 * variables internas no choquen con las de las páginas; solo se expone BD.
 */
const BD = (() => {
  /* ======================================================================
     Configuración y catálogos
     ====================================================================== */

  // Nombre con el que se guarda la base de datos en localStorage
  // (v2: usuarios iniciales admin y daniel; una clave nueva evita reutilizar datos de versiones anteriores)
  const CLAVE_ALMACENAMIENTO = 'controlTiempo.bd.v2';

  const ROLES = ['administrador', 'colaborador', 'consulta'];
  const MONEDAS = ['MXN', 'USD', 'EUR'];

  // Colores sugeridos para los proyectos (paleta categórica validada para daltonismo)
  const COLORES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

  const MAX_SEGUNDOS = 24 * 3600; // una entrada no puede durar más de 24 horas

  /* ------------------------------ Tablas ------------------------------ */

  // Ajustes generales en formato clave = valor
  const SQL_CREAR_CONFIGURACION = `
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );`;

  // Usuarios. La contraseña NUNCA se guarda tal cual: solo su hash SHA-256 con una sal aleatoria.
  const SQL_CREAR_USUARIOS = `
    CREATE TABLE IF NOT EXISTS usuarios (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario        TEXT    NOT NULL UNIQUE,
      nombre         TEXT    NOT NULL,
      rol            TEXT    NOT NULL CHECK (rol IN ('administrador', 'colaborador', 'consulta')),
      tarifa_hora    REAL    NOT NULL DEFAULT 0 CHECK (tarifa_hora >= 0),   -- precio de su hora
      password_hash  TEXT    NOT NULL,
      sal            TEXT    NOT NULL,
      activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
      fecha_creacion TEXT    NOT NULL,
      ultimo_acceso  TEXT
    );`;

  const SQL_CREAR_CLIENTES = `
    CREATE TABLE IF NOT EXISTS clientes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      contacto       TEXT    NOT NULL DEFAULT '',
      correo         TEXT    NOT NULL DEFAULT '',
      fecha_creacion TEXT    NOT NULL
    );`;

  // Proyectos. Si se elimina el cliente, el proyecto queda "sin cliente" (ON DELETE SET NULL).
  // tarifa_hora NULL = el proyecto no tiene precio propio: se usa el del miembro o el general.
  const SQL_CREAR_PROYECTOS = `
    CREATE TABLE IF NOT EXISTS proyectos (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      cliente_id        INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      color             TEXT    NOT NULL DEFAULT '#2a78d6',
      facturable        INTEGER NOT NULL DEFAULT 1 CHECK (facturable IN (0, 1)),
      tarifa_hora       REAL    CHECK (tarifa_hora IS NULL OR tarifa_hora >= 0),
      presupuesto_horas REAL    CHECK (presupuesto_horas IS NULL OR presupuesto_horas > 0),
      archivado         INTEGER NOT NULL DEFAULT 0 CHECK (archivado IN (0, 1)),
      fecha_creacion    TEXT    NOT NULL
    );`;

  /*
   * Registros (entradas de tiempo).
   * - usuario_id ON DELETE RESTRICT: no se puede borrar a un usuario con horas registradas
   *   (se pierde la facturación); se debe desactivar.
   * - proyecto_id ON DELETE RESTRICT: igual con los proyectos; se archivan.
   * - fin NULL = cronómetro corriendo. El índice único parcial garantiza que cada
   *   usuario tenga como máximo UN cronómetro corriendo.
   */
  /*
   * Módulos: cada proyecto se puede dividir en módulos (partes del trabajo).
   * - Pertenecen a un proyecto: si el proyecto se elimina, sus módulos también (CASCADE).
   * - El nombre no se repite dentro del mismo proyecto (UNIQUE proyecto + nombre).
   */
  const SQL_CREAR_MODULOS = `
    CREATE TABLE IF NOT EXISTS modulos (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      proyecto_id       INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
      nombre            TEXT    NOT NULL,
      presupuesto_horas REAL    CHECK (presupuesto_horas IS NULL OR presupuesto_horas > 0),
      archivado         INTEGER NOT NULL DEFAULT 0 CHECK (archivado IN (0, 1)),
      fecha_creacion    TEXT    NOT NULL,
      UNIQUE (proyecto_id, nombre COLLATE NOCASE)
    );`;

  const SQL_CREAR_REGISTROS = `
    CREATE TABLE IF NOT EXISTS registros (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
      proyecto_id    INTEGER REFERENCES proyectos(id) ON DELETE RESTRICT,
      modulo_id      INTEGER REFERENCES modulos(id) ON DELETE SET NULL,   -- opcional
      descripcion    TEXT    NOT NULL DEFAULT '',
      inicio         TEXT    NOT NULL,                 -- "AAAA-MM-DD HH:MM:SS" hora local
      fin            TEXT,                             -- NULL mientras corre el cronómetro
      duracion       INTEGER CHECK (duracion IS NULL OR duracion > 0),  -- segundos
      facturable     INTEGER NOT NULL DEFAULT 1 CHECK (facturable IN (0, 1)),
      tarifa         REAL    NOT NULL DEFAULT 0 CHECK (tarifa >= 0),    -- precio por hora aplicado
      fecha_creacion TEXT    NOT NULL,
      CHECK (fin IS NULL OR fin > inicio)
    );`;

  const SQL_INDICES = [
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_un_cronometro_por_usuario ON registros(usuario_id) WHERE fin IS NULL',
    'CREATE INDEX IF NOT EXISTS ix_registros_inicio ON registros(inicio)',
    'CREATE INDEX IF NOT EXISTS ix_registros_proyecto ON registros(proyecto_id)',
    'CREATE INDEX IF NOT EXISTS ix_registros_modulo ON registros(modulo_id)'
  ];

  // Importe de una entrada en dinero (se reutiliza en varias consultas)
  const SQL_IMPORTE = 'CASE WHEN r.facturable = 1 THEN r.duracion * r.tarifa / 3600.0 ELSE 0 END';

  // Consulta base de una entrada con el nombre del usuario, proyecto, color y cliente (JOIN)
  const SELECT_REGISTRO = `
    SELECT r.*,
           ${SQL_IMPORTE}  AS importe,
           u.nombre        AS usuario_nombre,
           p.nombre        AS proyecto_nombre,
           p.color         AS proyecto_color,
           m.nombre        AS modulo_nombre,
           c.nombre        AS cliente_nombre
      FROM registros r
      JOIN usuarios u       ON u.id = r.usuario_id
      LEFT JOIN proyectos p ON p.id = r.proyecto_id
      LEFT JOIN modulos m   ON m.id = r.modulo_id
      LEFT JOIN clientes c  ON c.id = p.cliente_id`;

  /* --------------------------- Datos de ejemplo --------------------------- */

  const CONFIG_INICIAL = { empresa: 'Mi Empresa S.A. de C.V.', moneda: 'MXN', tarifa_general: '300' };

  // [usuario, nombre, rol, contraseña, tarifa por hora]. Cambiar las contraseñas en uso real.
  const USUARIOS_EJEMPLO = [
    ['admin', 'Administrador General', 'administrador', 'admin123', 500],
    ['daniel', 'Daniel Valladolid', 'colaborador', 'daniel123', 380]
  ];

  // [nombre, contacto, correo]
  const CLIENTES_EJEMPLO = [
    ['Grupo Industrial del Norte', 'Lic. Marta Garza', 'compras@gindnorte.com.mx'],
    ['Clínica Santa Fe', 'Dr. Jorge Medina', 'administracion@clinicasantafe.mx']
  ];

  // [nombre, cliente, color, facturable, tarifa (null = la del miembro), presupuesto horas]
  const PROYECTOS_EJEMPLO = [
    ['Sitio web corporativo', 'Grupo Industrial del Norte', COLORES[0], 1, 450, 60],
    ['Soporte mensual TI', 'Clínica Santa Fe', COLORES[1], 1, 350, 40],
    ['App de citas', 'Clínica Santa Fe', COLORES[2], 1, null, 80],
    ['Capacitación interna', null, COLORES[3], 0, null, null],
    ['Administración', null, COLORES[4], 0, null, null]
  ];

  // Módulos de ejemplo de cada proyecto
  const MODULOS_EJEMPLO = {
    'Sitio web corporativo': ['Diseño', 'Desarrollo', 'Juntas con el cliente'],
    'App de citas': ['Registro de pacientes', 'Calendario', 'Notificaciones', 'Pruebas'],
    'Soporte mensual TI': ['Servidores', 'Atención a usuarios']
  };

  // Módulo de cada entrada de ejemplo (por su descripción). Las que no aparecen quedan sin módulo.
  const MODULO_DE_EJEMPLO = {
    'Reunión de arranque con el cliente': 'Juntas con el cliente',
    'Diseño de la página de inicio': 'Diseño',
    'Maquetación responsiva con Bootstrap': 'Desarrollo',
    'Revisión de avance con el cliente': 'Juntas con el cliente',
    'Formulario de contacto': 'Desarrollo',
    'Optimización de imágenes': 'Diseño',
    'Ajustes solicitados por el cliente': 'Desarrollo',
    'Pantallas de registro de pacientes': 'Registro de pacientes',
    'Base de datos de citas': 'Calendario',
    'Calendario de disponibilidad': 'Calendario',
    'Notificaciones por correo': 'Notificaciones',
    'Pruebas con usuarios': 'Pruebas',
    'Mantenimiento de servidores': 'Servidores',
    'Ticket #1024: impresora de recepción': 'Atención a usuarios',
    'Respaldo semanal de la información': 'Servidores',
    'Configuración de equipos nuevos': 'Atención a usuarios',
    'Ticket #1031: correo no sincroniza': 'Atención a usuarios',
    'Revisión de antivirus': 'Servidores'
  };

  /*
   * Entradas de ejemplo: [usuario, días (0 = hoy, -1 = ayer...), hora de inicio, minutos, proyecto, descripción]
   * Para HOY la hora es un número: "empezó hace N minutos", así nunca quedan en el futuro.
   */
  const REGISTROS_EJEMPLO = [
    ['daniel', -9, '09:00', 120, 'Sitio web corporativo', 'Reunión de arranque con el cliente'],
    ['daniel', -9, '11:30', 150, 'Sitio web corporativo', 'Diseño de la página de inicio'],
    ['admin', -9, '10:00', 90, 'Soporte mensual TI', 'Mantenimiento de servidores'],
    ['daniel', -8, '09:15', 210, 'App de citas', 'Pantallas de registro de pacientes'],
    ['admin', -8, '09:00', 60, 'Soporte mensual TI', 'Ticket #1024: impresora de recepción'],
    ['admin', -8, '13:00', 120, 'Capacitación interna', 'Curso de seguridad informática'],
    ['admin', -8, '17:00', 45, 'Administración', 'Revisión de facturas de proveedores'],
    ['daniel', -7, '10:00', 180, 'Sitio web corporativo', 'Maquetación responsiva con Bootstrap'],
    ['admin', -7, '09:30', 240, 'App de citas', 'Base de datos de citas'],
    ['daniel', -6, '09:00', 60, 'Administración', 'Junta semanal del equipo'],
    ['daniel', -6, '10:30', 200, 'App de citas', 'Calendario de disponibilidad'],
    ['admin', -6, '11:00', 75, 'Soporte mensual TI', 'Respaldo semanal de la información'],
    ['admin', -5, '09:00', 90, 'Sitio web corporativo', 'Revisión de avance con el cliente'],
    ['admin', -3, '09:00', 180, 'App de citas', 'Notificaciones por correo'],
    ['daniel', -3, '09:30', 240, 'Sitio web corporativo', 'Formulario de contacto'],
    ['daniel', -2, '09:00', 90, 'Capacitación interna', 'Taller de Excel'],
    ['admin', -2, '10:00', 120, 'Soporte mensual TI', 'Configuración de equipos nuevos'],
    ['admin', -2, '16:00', 60, 'Administración', 'Planeación del próximo trimestre'],
    ['daniel', -1, '09:00', 180, 'App de citas', 'Pruebas con usuarios'],
    ['admin', -1, '09:30', 150, 'Sitio web corporativo', 'Optimización de imágenes'],
    ['admin', -1, '14:00', 45, 'Soporte mensual TI', 'Ticket #1031: correo no sincroniza'],
    ['daniel', 0, 150, 75, 'Sitio web corporativo', 'Ajustes solicitados por el cliente'],
    ['admin', 0, 120, 60, 'Soporte mensual TI', 'Revisión de antivirus']
  ];

  // Variables internas
  let SQL = null;             // módulo sql.js ya inicializado
  let promesaConexion = null; // la base se abre una sola vez por página

  /* ======================================================================
     Conexión y persistencia
     ====================================================================== */

  /** Devuelve la conexión (la abre la primera vez). Patrón "singleton". */
  function conectar() {
    if (!promesaConexion) promesaConexion = abrir();
    return promesaConexion;
  }

  async function abrir() {
    if (typeof initSqlJs !== 'function') {
      throw new Error('No se cargó SQLite. Verifica que exista vendor/sqljs/sql-asm.js.');
    }
    SQL = await initSqlJs();

    // Si ya hay una base guardada en el navegador se abre; si no, se crea vacía
    const bytesGuardados = leerDelNavegador();
    const db = bytesGuardados ? new SQL.Database(bytesGuardados) : new SQL.Database();

    await prepararEsquema(db);
    return db;
  }

  /**
   * Activa las llaves foráneas, crea las tablas que falten e inserta datos de
   * ejemplo en las tablas vacías. Es async porque cifrar contraseñas es asíncrono.
   */
  async function prepararEsquema(db) {
    db.run('PRAGMA foreign_keys = ON'); // SQLite las trae apagadas por defecto
    let huboCambios = false;
    [SQL_CREAR_CONFIGURACION, SQL_CREAR_USUARIOS, SQL_CREAR_CLIENTES, SQL_CREAR_PROYECTOS, SQL_CREAR_MODULOS, SQL_CREAR_REGISTROS]
      .forEach((sql) => db.run(sql));

    /*
     * MIGRACIÓN: las bases creadas antes de existir los módulos no tienen la
     * columna registros.modulo_id. Se agrega sin tocar los datos existentes
     * (las entradas quedan "sin módulo" hasta que se les asigne uno).
     */
    const columnas = consultar(db, 'PRAGMA table_info(registros)').map((c) => c.name);
    if (!columnas.includes('modulo_id')) {
      db.run('ALTER TABLE registros ADD COLUMN modulo_id INTEGER REFERENCES modulos(id) ON DELETE SET NULL');
      huboCambios = true;
    }
    SQL_INDICES.forEach((sql) => db.run(sql));

    // Ajustes que falten (INSERT OR IGNORE no reemplaza los existentes)
    for (const [clave, valor] of Object.entries(CONFIG_INICIAL)) {
      db.run('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)', [clave, valor]);
      if (db.getRowsModified() > 0) huboCambios = true;
    }

    // Usuarios iniciales (solo si la tabla está vacía)
    if (contar(db, 'usuarios') === 0) {
      for (const [usuario, nombre, rol, password, tarifa] of USUARIOS_EJEMPLO) {
        const sal = crypto.randomUUID();
        db.run(
          `INSERT INTO usuarios (usuario, nombre, rol, tarifa_hora, password_hash, sal, fecha_creacion)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [usuario, nombre, rol, tarifa, await calcularHash(password, sal), sal, fechaHora(new Date())]
        );
      }
      huboCambios = true;
    }

    // Clientes, proyectos y horas de ejemplo (solo si todavía no hay proyectos)
    if (contar(db, 'proyectos') === 0 && contar(db, 'registros') === 0) {
      insertarEjemplos(db);
      huboCambios = true;
    }

    if (huboCambios) guardarEnNavegador(db);
  }

  function contar(db, tabla) {
    return consultar(db, `SELECT COUNT(*) AS n FROM ${tabla}`)[0].n;
  }

  /** Inserta clientes, proyectos y entradas de tiempo de ejemplo */
  function insertarEjemplos(db) {
    const ahora = fechaHora(new Date());

    for (const [nombre, contacto, correo] of CLIENTES_EJEMPLO) {
      db.run('INSERT INTO clientes (nombre, contacto, correo, fecha_creacion) VALUES (?, ?, ?, ?)', [nombre, contacto, correo, ahora]);
    }
    for (const [nombre, cliente, color, facturable, tarifa, presupuesto] of PROYECTOS_EJEMPLO) {
      const clienteId = cliente ? consultar(db, 'SELECT id FROM clientes WHERE nombre = ?', [cliente])[0]?.id ?? null : null;
      db.run(
        `INSERT INTO proyectos (nombre, cliente_id, color, facturable, tarifa_hora, presupuesto_horas, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [nombre, clienteId, color, facturable, tarifa, presupuesto, ahora]
      );
      const proyectoId = ultimoId(db);
      (MODULOS_EJEMPLO[nombre] || []).forEach((modulo) => {
        db.run('INSERT INTO modulos (proyecto_id, nombre, fecha_creacion) VALUES (?, ?, ?)', [proyectoId, modulo, ahora]);
      });
    }

    for (const [usuario, dias, hora, minutos, proyecto, descripcion] of REGISTROS_EJEMPLO) {
      const u = consultar(db, 'SELECT id FROM usuarios WHERE usuario = ?', [usuario])[0];
      const p = consultar(db, 'SELECT id, facturable FROM proyectos WHERE nombre = ?', [proyecto])[0];
      if (!u || !p) continue; // si el usuario fue eliminado, se omite

      let inicio;
      if (typeof hora === 'number') {
        inicio = new Date(Date.now() - hora * 60000);           // hoy: hace N minutos
      } else {
        inicio = new Date(`${sumarDias(dias)}T${hora}:00`);
      }
      const fin = new Date(inicio.getTime() + minutos * 60000);
      const m = consultar(db, 'SELECT id FROM modulos WHERE proyecto_id = ? AND nombre = ?', [p.id, MODULO_DE_EJEMPLO[descripcion] ?? ''])[0];
      db.run(
        `INSERT INTO registros (usuario_id, proyecto_id, modulo_id, descripcion, inicio, fin, duracion, facturable, tarifa, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u.id, p.id, m ? m.id : null, descripcion, fechaHora(inicio), fechaHora(fin), minutos * 60, p.facturable,
         tarifaPara(db, p.id, u.id), ahora]
      );
    }
  }

  /** Guarda la base completa en localStorage (bytes del .db convertidos a Base64) */
  function guardarEnNavegador(db) {
    try {
      localStorage.setItem(CLAVE_ALMACENAMIENTO, bytesABase64(db.export()));
    } catch (error) {
      console.warn('No se pudo guardar en localStorage:', error);
      throw new Error('No se pudieron guardar los cambios en el navegador (almacenamiento lleno o bloqueado).');
    } finally {
      // db.export() apaga las llaves foráneas en sql.js: se vuelven a encender
      db.run('PRAGMA foreign_keys = ON');
    }
  }

  /** Lee los bytes de la base guardada, o null si no hay ninguna */
  function leerDelNavegador() {
    try {
      const texto = localStorage.getItem(CLAVE_ALMACENAMIENTO);
      return texto ? base64ABytes(texto) : null;
    } catch {
      return null; // almacenamiento bloqueado: se trabaja solo en memoria
    }
  }

  /* ======================================================================
     Utilidades internas
     ====================================================================== */

  /**
   * Ejecuta un SELECT y devuelve un arreglo de objetos { columna: valor }.
   * Los valores van en "parametros" y se colocan en los "?" del SQL
   * (consultas preparadas = protección contra inyección SQL).
   */
  function consultar(db, sql, parametros = []) {
    const sentencia = db.prepare(sql);
    sentencia.bind(parametros);
    const filas = [];
    while (sentencia.step()) filas.push(sentencia.getAsObject());
    sentencia.free();
    return filas;
  }

  const ultimoId = (db) => consultar(db, 'SELECT last_insert_rowid() AS id')[0].id;
  const dos = (n) => String(n).padStart(2, '0');

  /** Date -> "AAAA-MM-DD" en hora local */
  function fechaISO(f) {
    return `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
  }

  /** Date -> "AAAA-MM-DD HH:MM:SS" en hora local (formato con el que se guardan inicio y fin) */
  function fechaHora(f) {
    return `${fechaISO(f)} ${dos(f.getHours())}:${dos(f.getMinutes())}:${dos(f.getSeconds())}`;
  }

  /** "AAAA-MM-DD HH:MM:SS" -> Date */
  function aFecha(texto) {
    return new Date(String(texto).replace(' ', 'T'));
  }

  /** Fecha de hoy +/- n días como "AAAA-MM-DD" */
  function sumarDias(n, base = new Date()) {
    const f = new Date(base);
    f.setDate(f.getDate() + n);
    return fechaISO(f);
  }

  /** Lunes de la semana de una fecha (la semana empieza en lunes) */
  function inicioSemana(base = new Date()) {
    const f = new Date(base);
    const dia = (f.getDay() + 6) % 7; // lunes = 0 ... domingo = 6
    f.setDate(f.getDate() - dia);
    return fechaISO(f);
  }

  /** Crea un Error con mensaje general y errores por campo */
  function crearError(mensaje, errores = {}) {
    const error = new Error(mensaje);
    error.errores = errores;
    return error;
  }

  /** Convierte a número; vacío ('' / null / undefined) = NaN (inválido) */
  function aNumero(valor) {
    if (valor === '' || valor === null || valor === undefined) return NaN;
    return Number(valor);
  }

  /** Valor opcional: vacío -> null; si no, número */
  function opcional(valor) {
    return valor === '' || valor === null || valor === undefined ? null : Number(valor);
  }

  /** Valida que un id sea entero positivo */
  function validarId(id) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) throw crearError('El id no es válido.');
    return numero;
  }

  /** ¿Es una fecha real con formato AAAA-MM-DD? */
  function esFechaValida(texto) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
    const f = new Date(`${texto}T00:00:00`);
    return !Number.isNaN(f.getTime()) && fechaISO(f) === texto;
  }

  const esHoraValida = (texto) => /^([01]\d|2[0-3]):[0-5]\d$/.test(texto);

  // Conversión Uint8Array <-> Base64 (por bloques, para no saturar la pila)
  function bytesABase64(bytes) {
    let binario = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binario += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binario);
  }

  function base64ABytes(texto) {
    const binario = atob(texto);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
  }

  /**
   * Hash SHA-256 de (sal + contraseña) en hexadecimal.
   * - Un hash es una "huella" de un solo sentido: no se puede obtener la contraseña
   *   a partir de él. Para verificar se vuelve a calcular y se compara.
   * - La sal (texto aleatorio por usuario) hace que dos contraseñas iguales tengan hashes distintos.
   */
  async function calcularHash(password, sal) {
    const bytes = new TextEncoder().encode(`${sal}:${password}`);
    const huella = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(huella)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* -------------------------- Permisos -------------------------- */

  /**
   * Segunda línea de defensa de los permisos: aunque un botón esté oculto, si
   * alguien llama a la función desde la consola del navegador, aquí se bloquea.
   * La matriz de permisos vive en js/sesion.js (objeto Sesion).
   */
  function exigir(permiso) {
    if (typeof Sesion === 'undefined' || !Sesion.puede(permiso)) {
      throw crearError('No tienes permiso para realizar esta acción.');
    }
  }

  const yo = () => Sesion.actual()?.id ?? 0;

  /** Regla de propiedad: cada quien modifica solo sus entradas; el administrador, todas */
  function exigirPropiedad(registro) {
    if (Sesion.puede('tiempo.editar_todos')) return;
    if (registro.usuario_id !== yo()) throw crearError('Solo puedes modificar tus propias entradas de tiempo.');
  }

  /* -------------------------- Configuración -------------------------- */

  function leerConfiguracion(db) {
    const config = { ...CONFIG_INICIAL };
    consultar(db, 'SELECT clave, valor FROM configuracion').forEach((f) => { config[f.clave] = f.valor; });
    config.tarifa_general = Number(config.tarifa_general) || 0;
    return config;
  }

  /**
   * Tarifa por hora que corresponde a una entrada (jerarquía tipo Clockify):
   * proyecto > miembro > general.
   */
  function tarifaPara(db, proyectoId, usuarioId) {
    if (proyectoId) {
      const p = consultar(db, 'SELECT tarifa_hora FROM proyectos WHERE id = ?', [proyectoId])[0];
      if (p && p.tarifa_hora !== null) return p.tarifa_hora;
    }
    const u = consultar(db, 'SELECT tarifa_hora FROM usuarios WHERE id = ?', [usuarioId])[0];
    if (u && u.tarifa_hora > 0) return u.tarifa_hora;
    return leerConfiguracion(db).tarifa_general;
  }

  /* -------------------------- Registros de tiempo -------------------------- */

  function buscarRegistro(db, id) {
    return consultar(db, `${SELECT_REGISTRO} WHERE r.id = ?`, [id])[0];
  }

  function cronometroDe(db, usuarioId) {
    return consultar(db, `${SELECT_REGISTRO} WHERE r.usuario_id = ? AND r.fin IS NULL`, [usuarioId])[0] || null;
  }

  /**
   * Valida descripción, proyecto y facturable (comunes al cronómetro y al registro manual).
   * proyectoActual: al editar se permite conservar un proyecto que ya fue archivado.
   */
  function validarDatosBase(db, datos, proyectoActual = null, moduloActual = null) {
    const errores = {};
    const descripcion = String(datos.descripcion ?? '').trim();
    if (descripcion.length > 200) errores.descripcion = 'La descripción no puede superar 200 caracteres.';

    const proyecto_id = opcional(datos.proyecto_id);
    if (proyecto_id !== null) {
      const p = Number.isInteger(proyecto_id) ? consultar(db, 'SELECT id, archivado FROM proyectos WHERE id = ?', [proyecto_id])[0] : null;
      if (!p) errores.proyecto_id = 'Selecciona un proyecto válido.';
      else if (p.archivado === 1 && p.id !== proyectoActual) errores.proyecto_id = 'Ese proyecto está archivado.';
    }

    // El módulo es opcional, pero si se indica debe pertenecer al proyecto elegido
    const modulo_id = opcional(datos.modulo_id);
    if (modulo_id !== null) {
      const m = Number.isInteger(modulo_id) ? consultar(db, 'SELECT id, proyecto_id, archivado FROM modulos WHERE id = ?', [modulo_id])[0] : null;
      if (!m || m.proyecto_id !== proyecto_id) errores.modulo_id = 'Selecciona un módulo del proyecto elegido.';
      else if (m.archivado === 1 && m.id !== moduloActual) errores.modulo_id = 'Ese módulo está archivado.';
    }
    return { errores, valores: { descripcion, proyecto_id, modulo_id, facturable: datos.facturable ? 1 : 0 } };
  }

  /**
   * Valida una entrada manual: fecha + hora de inicio + hora de fin.
   * Si la hora de fin es menor que la de inicio se entiende que terminó al día siguiente
   * (por ejemplo, de 22:00 a 01:00), como en Clockify.
   */
  function validarEntradaManual(db, datos, proyectoActual = null, moduloActual = null) {
    const { errores, valores } = validarDatosBase(db, datos, proyectoActual, moduloActual);
    const fecha = String(datos.fecha ?? '').trim();
    const horaInicio = String(datos.hora_inicio ?? '').trim();
    const horaFin = String(datos.hora_fin ?? '').trim();

    if (!esFechaValida(fecha)) errores.fecha = 'Indica una fecha válida.';
    if (!esHoraValida(horaInicio)) errores.hora_inicio = 'Hora de inicio no válida (HH:MM).';
    if (!esHoraValida(horaFin)) errores.hora_fin = 'Hora de fin no válida (HH:MM).';

    let inicio = null;
    let fin = null;
    if (!errores.fecha && !errores.hora_inicio && !errores.hora_fin) {
      if (horaInicio === horaFin) {
        errores.hora_fin = 'La hora de fin debe ser distinta a la de inicio.';
      } else {
        inicio = new Date(`${fecha}T${horaInicio}:00`);
        fin = new Date(`${fecha}T${horaFin}:00`);
        if (fin <= inicio) fin.setDate(fin.getDate() + 1); // terminó al día siguiente
        if (inicio > new Date()) errores.hora_inicio = 'No se puede registrar tiempo en el futuro.';
      }
    }

    if (Object.keys(errores).length > 0) throw crearError('Revisa los datos de la entrada.', errores);
    const duracion = Math.round((fin - inicio) / 1000);
    return { ...valores, inicio: fechaHora(inicio), fin: fechaHora(fin), duracion };
  }

  /** Arma el WHERE de los reportes y listados a partir de los filtros */
  function construirFiltros(filtros = {}) {
    const condiciones = ['r.fin IS NOT NULL']; // las entradas en curso no cuentan hasta detenerse
    const parametros = [];

    // Quien no puede ver a todo el equipo, solo ve sus propias entradas (aunque pida otras)
    if (!Sesion.puede('tiempo.ver_todos')) {
      condiciones.push('r.usuario_id = ?');
      parametros.push(yo());
    } else if (filtros.usuario) {
      condiciones.push('r.usuario_id = ?');
      parametros.push(Number(filtros.usuario));
    }

    if (filtros.desde) { condiciones.push('date(r.inicio) >= ?'); parametros.push(filtros.desde); }
    if (filtros.hasta) { condiciones.push('date(r.inicio) <= ?'); parametros.push(filtros.hasta); }
    if (filtros.proyecto === 'ninguno') {
      condiciones.push('r.proyecto_id IS NULL');
    } else if (filtros.proyecto) {
      condiciones.push('r.proyecto_id = ?');
      parametros.push(Number(filtros.proyecto));
    }
    if (filtros.modulo === 'ninguno') {
      condiciones.push('r.modulo_id IS NULL');
    } else if (filtros.modulo) {
      condiciones.push('r.modulo_id = ?');
      parametros.push(Number(filtros.modulo));
    }
    if (filtros.cliente) { condiciones.push('p.cliente_id = ?'); parametros.push(Number(filtros.cliente)); }
    if (filtros.facturable === '1' || filtros.facturable === '0') {
      condiciones.push('r.facturable = ?');
      parametros.push(Number(filtros.facturable));
    }
    const q = String(filtros.q ?? '').trim();
    if (q) {
      condiciones.push('(r.descripcion LIKE ? OR p.nombre LIKE ? OR c.nombre LIKE ? OR m.nombre LIKE ?)');
      parametros.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    return { where: `WHERE ${condiciones.join(' AND ')}`, parametros };
  }

  /* -------------------------- Clientes y proyectos -------------------------- */

  function validarCliente(datos = {}) {
    const errores = {};
    const c = {
      nombre: String(datos.nombre ?? '').trim(),
      contacto: String(datos.contacto ?? '').trim(),
      correo: String(datos.correo ?? '').trim().toLowerCase()
    };
    if (c.nombre.length < 2 || c.nombre.length > 80) errores.nombre = 'El nombre debe tener entre 2 y 80 caracteres.';
    if (c.contacto.length > 80) errores.contacto = 'Máximo 80 caracteres.';
    if (c.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.correo)) errores.correo = 'Escribe un correo válido (ej. nombre@empresa.com).';
    if (Object.keys(errores).length > 0) throw crearError('Revisa los datos del cliente.', errores);
    return c;
  }

  function validarProyecto(db, datos = {}) {
    const errores = {};
    const p = {
      nombre: String(datos.nombre ?? '').trim(),
      cliente_id: opcional(datos.cliente_id),
      color: String(datos.color ?? '').trim().toLowerCase(),
      facturable: datos.facturable ? 1 : 0,
      tarifa_hora: opcional(datos.tarifa_hora),
      presupuesto_horas: opcional(datos.presupuesto_horas)
    };
    if (p.nombre.length < 2 || p.nombre.length > 80) errores.nombre = 'El nombre debe tener entre 2 y 80 caracteres.';
    if (p.cliente_id !== null && !consultar(db, 'SELECT id FROM clientes WHERE id = ?', [p.cliente_id]).length) {
      errores.cliente_id = 'Selecciona un cliente válido.';
    }
    if (!/^#[0-9a-f]{6}$/.test(p.color)) errores.color = 'Elige un color.';
    if (p.tarifa_hora !== null && (Number.isNaN(p.tarifa_hora) || p.tarifa_hora < 0 || p.tarifa_hora > 100000)) {
      errores.tarifa_hora = 'La tarifa debe ser un número entre 0 y 100,000 (o déjala vacía).';
    }
    if (p.presupuesto_horas !== null && (Number.isNaN(p.presupuesto_horas) || p.presupuesto_horas <= 0 || p.presupuesto_horas > 100000)) {
      errores.presupuesto_horas = 'El presupuesto debe ser mayor que 0 horas (o déjalo vacío).';
    }
    if (Object.keys(errores).length > 0) throw crearError('Revisa los datos del proyecto.', errores);
    return p;
  }

  /** Valida los datos de un módulo: proyecto existente, nombre de 2 a 80 y presupuesto opcional > 0 */
  function validarModulo(db, datos = {}) {
    const errores = {};
    const m = {
      proyecto_id: opcional(datos.proyecto_id),
      nombre: String(datos.nombre ?? '').trim(),
      presupuesto_horas: opcional(datos.presupuesto_horas)
    };
    if (!Number.isInteger(m.proyecto_id) || !consultar(db, 'SELECT id FROM proyectos WHERE id = ?', [m.proyecto_id]).length) {
      errores.proyecto_id = 'Selecciona un proyecto válido.';
    }
    if (m.nombre.length < 2 || m.nombre.length > 80) errores.nombre = 'El nombre del módulo debe tener entre 2 y 80 caracteres.';
    if (m.presupuesto_horas !== null && (Number.isNaN(m.presupuesto_horas) || m.presupuesto_horas <= 0 || m.presupuesto_horas > 100000)) {
      errores.presupuesto_horas = 'El presupuesto debe ser mayor que 0 horas (o déjalo vacío).';
    }
    if (Object.keys(errores).length > 0) throw crearError('Revisa los datos del módulo.', errores);
    return m;
  }

  /** El nombre de un módulo no se repite dentro del mismo proyecto (sin importar mayúsculas) */
  function exigirModuloUnico(db, proyectoId, nombre, idExcluir = 0) {
    if (consultar(db, 'SELECT id FROM modulos WHERE proyecto_id = ? AND nombre = ? COLLATE NOCASE AND id <> ?',
      [proyectoId, nombre, idExcluir]).length) {
      throw crearError('Ese módulo ya existe en el proyecto.', { nombre: `Ya existe el módulo "${nombre}" en este proyecto.` });
    }
  }

  /** Lanza un error "nombre repetido" si otro registro de la tabla ya usa ese nombre */
  function exigirNombreUnico(db, tabla, nombre, idExcluir = 0) {
    if (consultar(db, `SELECT id FROM ${tabla} WHERE nombre = ? COLLATE NOCASE AND id <> ?`, [nombre, idExcluir]).length) {
      throw crearError('Ese nombre ya existe.', { nombre: `Ya existe "${nombre}".` });
    }
  }

  // Proyecto con totales: horas registradas e importe (subconsultas)
  const SELECT_PROYECTO = `
    SELECT p.*, c.nombre AS cliente_nombre,
           (SELECT COALESCE(SUM(r.duracion), 0) FROM registros r WHERE r.proyecto_id = p.id AND r.fin IS NOT NULL) AS segundos,
           (SELECT COALESCE(SUM(${SQL_IMPORTE}), 0) FROM registros r WHERE r.proyecto_id = p.id AND r.fin IS NOT NULL) AS importe,
           (SELECT COUNT(*) FROM registros r WHERE r.proyecto_id = p.id) AS entradas,
           (SELECT COUNT(*) FROM modulos mo WHERE mo.proyecto_id = p.id AND mo.archivado = 0) AS modulos
      FROM proyectos p
      LEFT JOIN clientes c ON c.id = p.cliente_id`;

  /* -------------------------- Usuarios -------------------------- */

  /** Valida y normaliza los datos de un usuario. esNuevo = true exige contraseña */
  function validarUsuario(datos = {}, esNuevo = true) {
    const errores = {};
    const u = {
      usuario: String(datos.usuario ?? '').trim().toLowerCase(),
      nombre: String(datos.nombre ?? '').trim(),
      rol: String(datos.rol ?? '').trim(),
      tarifa_hora: datos.tarifa_hora === '' || datos.tarifa_hora === undefined ? 0 : Number(datos.tarifa_hora),
      password: String(datos.password ?? '')
    };

    if (!/^[a-z0-9._]{3,20}$/.test(u.usuario)) {
      errores.usuario = 'El usuario debe tener de 3 a 20 caracteres (letras, números, punto o guion bajo).';
    }
    if (u.nombre.length < 3 || u.nombre.length > 80) errores.nombre = 'El nombre debe tener entre 3 y 80 caracteres.';
    if (!ROLES.includes(u.rol)) errores.rol = 'Selecciona un rol válido.';
    if (Number.isNaN(u.tarifa_hora) || u.tarifa_hora < 0 || u.tarifa_hora > 100000) {
      errores.tarifa_hora = 'La tarifa debe ser un número entre 0 y 100,000.';
    }
    // Al editar, la contraseña vacía significa "no cambiarla"
    if ((esNuevo || u.password) && u.password.length < 6) errores.password = 'La contraseña debe tener al menos 6 caracteres.';

    if (Object.keys(errores).length > 0) throw crearError('Revisa los datos del usuario.', errores);
    return u;
  }

  /** Columnas públicas de un usuario (nunca se devuelven el hash ni la sal) */
  const COLUMNAS_USUARIO = 'id, usuario, nombre, rol, tarifa_hora, activo, fecha_creacion, ultimo_acceso';

  /** Cuántos administradores activos hay, sin contar al usuario idExcluir */
  function otrosAdminsActivos(db, idExcluir) {
    const [{ n }] = consultar(db,
      "SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'administrador' AND activo = 1 AND id <> ?", [idExcluir]);
    return n;
  }

  /* ======================================================================
     Funciones públicas (las que usan las páginas)
     ====================================================================== */
  return {
    /* ---------------------------- Generales ---------------------------- */

    /** Listas de valores válidos para los <select> */
    obtenerCatalogos() {
      return { roles: [...ROLES], monedas: [...MONEDAS], colores: [...COLORES] };
    },

    /** Fecha de hoy "AAAA-MM-DD" */
    hoy() {
      return sumarDias(0);
    },

    /** Utilidades de fechas compartidas con las páginas */
    fechas: { fechaISO, fechaHora, aFecha, sumarDias, inicioSemana },

    /** Ajustes del espacio de trabajo { empresa, moneda, tarifa_general } */
    async obtenerConfiguracion() {
      return leerConfiguracion(await conectar());
    },

    /** Guarda los ajustes (solo administrador) */
    async guardarConfiguracion(datos = {}) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const errores = {};
      const empresa = String(datos.empresa ?? '').trim();
      const moneda = String(datos.moneda ?? '');
      const tarifa = aNumero(datos.tarifa_general);
      if (empresa.length < 2 || empresa.length > 80) errores.empresa = 'Escribe el nombre de la empresa (2 a 80 caracteres).';
      if (!MONEDAS.includes(moneda)) errores.moneda = 'Selecciona una moneda.';
      if (Number.isNaN(tarifa) || tarifa < 0 || tarifa > 100000) errores.tarifa_general = 'La tarifa debe ser un número entre 0 y 100,000.';
      if (Object.keys(errores).length > 0) throw crearError('Revisa los ajustes.', errores);

      const guardar = 'INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor';
      db.run(guardar, ['empresa', empresa]);
      db.run(guardar, ['moneda', moneda]);
      db.run(guardar, ['tarifa_general', String(tarifa)]);
      guardarEnNavegador(db);
      return leerConfiguracion(db);
    },

    /* =================== CRONÓMETRO (como el botón INICIAR de Clockify) =================== */

    /** Entrada en curso del usuario actual, o null si no hay cronómetro corriendo */
    async obtenerCronometro() {
      const db = await conectar();
      return cronometroDe(db, yo());
    },

    /**
     * CREATE: inicia el cronómetro. Si ya había uno corriendo, primero se detiene
     * (solo puede haber un cronómetro por persona).
     */
    async iniciarCronometro(datos = {}) {
      exigir('tiempo.registrar');
      const db = await conectar();
      const { errores, valores } = validarDatosBase(db, datos);
      if (Object.keys(errores).length > 0) throw crearError('Revisa los datos.', errores);

      const corriendo = cronometroDe(db, yo());
      if (corriendo) detenerInterno(db, corriendo);

      const ahora = fechaHora(new Date());
      db.run(
        `INSERT INTO registros (usuario_id, proyecto_id, modulo_id, descripcion, inicio, facturable, tarifa, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [yo(), valores.proyecto_id, valores.modulo_id, valores.descripcion, ahora, valores.facturable,
         tarifaPara(db, valores.proyecto_id, yo()), ahora]
      );
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return buscarRegistro(db, id);
    },

    /** UPDATE: cambia descripción, proyecto o facturable mientras el cronómetro corre */
    async actualizarCronometro(datos = {}) {
      exigir('tiempo.registrar');
      const db = await conectar();
      const corriendo = cronometroDe(db, yo());
      if (!corriendo) throw crearError('No hay un cronómetro corriendo.');
      const { errores, valores } = validarDatosBase(db, datos, corriendo.proyecto_id, corriendo.modulo_id);
      if (Object.keys(errores).length > 0) throw crearError('Revisa los datos.', errores);

      db.run('UPDATE registros SET descripcion = ?, proyecto_id = ?, modulo_id = ?, facturable = ?, tarifa = ? WHERE id = ?',
        [valores.descripcion, valores.proyecto_id, valores.modulo_id, valores.facturable,
         tarifaPara(db, valores.proyecto_id, yo()), corriendo.id]);
      guardarEnNavegador(db);
      return buscarRegistro(db, corriendo.id);
    },

    /** UPDATE: detiene el cronómetro; la entrada queda guardada con su duración */
    async detenerCronometro() {
      exigir('tiempo.registrar');
      const db = await conectar();
      const corriendo = cronometroDe(db, yo());
      if (!corriendo) throw crearError('No hay un cronómetro corriendo.');
      detenerInterno(db, corriendo);
      guardarEnNavegador(db);
      return buscarRegistro(db, corriendo.id);
    },

    /** DELETE: descarta el cronómetro en curso sin guardar el tiempo */
    async descartarCronometro() {
      exigir('tiempo.registrar');
      const db = await conectar();
      const corriendo = cronometroDe(db, yo());
      if (!corriendo) return;
      db.run('DELETE FROM registros WHERE id = ?', [corriendo.id]);
      guardarEnNavegador(db);
    },

    /** Inicia un cronómetro nuevo con la misma descripción y proyecto de una entrada (botón ▶) */
    async continuarRegistro(id) {
      const db = await conectar();
      const original = buscarRegistro(db, validarId(id));
      if (!original) throw crearError('Entrada no encontrada.');
      exigirPropiedad(original);
      const proyectoVigente = original.proyecto_id &&
        consultar(db, 'SELECT archivado FROM proyectos WHERE id = ?', [original.proyecto_id])[0]?.archivado === 0;
      const moduloVigente = proyectoVigente && original.modulo_id &&
        consultar(db, 'SELECT archivado FROM modulos WHERE id = ?', [original.modulo_id])[0]?.archivado === 0;
      return this.iniciarCronometro({
        descripcion: original.descripcion,
        proyecto_id: proyectoVigente ? original.proyecto_id : '',
        modulo_id: moduloVigente ? original.modulo_id : '',
        facturable: original.facturable === 1
      });
    },

    /* ======================= ENTRADAS DE TIEMPO (CRUD) ======================= */

    /** CREATE: entrada manual (fecha, hora de inicio y fin) */
    async crearRegistro(datos) {
      exigir('tiempo.registrar');
      const db = await conectar();
      const e = validarEntradaManual(db, datos);
      db.run(
        `INSERT INTO registros (usuario_id, proyecto_id, modulo_id, descripcion, inicio, fin, duracion, facturable, tarifa, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [yo(), e.proyecto_id, e.modulo_id, e.descripcion, e.inicio, e.fin, e.duracion, e.facturable,
         tarifaPara(db, e.proyecto_id, yo()), fechaHora(new Date())]
      );
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return buscarRegistro(db, id);
    },

    /** READ: una entrada por id (solo las propias, salvo quien puede ver todo) */
    async obtenerRegistro(id) {
      const db = await conectar();
      const r = buscarRegistro(db, validarId(id));
      if (!r || (!Sesion.puede('tiempo.ver_todos') && r.usuario_id !== yo())) throw crearError('Entrada no encontrada.');
      return r;
    },

    /**
     * READ: entradas terminadas con filtros { usuario, proyecto, cliente, desde, hasta, facturable, q }
     * y un límite opcional. Más recientes primero.
     */
    async listarRegistros(filtros = {}, limite = 0) {
      const db = await conectar();
      const { where, parametros } = construirFiltros(filtros);
      let sql = `${SELECT_REGISTRO} ${where} ORDER BY r.inicio DESC, r.id DESC`;
      if (limite > 0) { sql += ' LIMIT ?'; parametros.push(Number(limite)); }
      return consultar(db, sql, parametros);
    },

    /** UPDATE: corrige una entrada terminada. Si cambia el proyecto se recalcula la tarifa. */
    async actualizarRegistro(id, datos) {
      exigir('tiempo.registrar');
      const db = await conectar();
      const actual = buscarRegistro(db, validarId(id));
      if (!actual) throw crearError('Entrada no encontrada.');
      exigirPropiedad(actual);
      if (!actual.fin) throw crearError('Detén el cronómetro antes de editar esta entrada.');

      const e = validarEntradaManual(db, datos, actual.proyecto_id, actual.modulo_id);
      const tarifa = e.proyecto_id === actual.proyecto_id ? actual.tarifa : tarifaPara(db, e.proyecto_id, actual.usuario_id);
      db.run(
        `UPDATE registros SET descripcion = ?, proyecto_id = ?, modulo_id = ?, facturable = ?, inicio = ?, fin = ?, duracion = ?, tarifa = ?
          WHERE id = ?`,
        [e.descripcion, e.proyecto_id, e.modulo_id, e.facturable, e.inicio, e.fin, e.duracion, tarifa, actual.id]
      );
      guardarEnNavegador(db);
      return buscarRegistro(db, actual.id);
    },

    /** DELETE: elimina una entrada (la propia, o cualquiera si es administrador) */
    async eliminarRegistro(id) {
      exigir('tiempo.registrar');
      const db = await conectar();
      const actual = buscarRegistro(db, validarId(id));
      if (!actual) throw crearError('Entrada no encontrada.');
      exigirPropiedad(actual);
      db.run('DELETE FROM registros WHERE id = ?', [actual.id]);
      guardarEnNavegador(db);
      return { id: actual.id };
    },

    /* ============================ Reportes ============================ */

    /** Totales del usuario actual para la cabecera del rastreador: hoy y esta semana */
    async resumenPersonal() {
      const db = await conectar();
      const [fila] = consultar(db, `
        SELECT COALESCE(SUM(CASE WHEN date(r.inicio) = ? THEN r.duracion END), 0)                      AS hoy,
               COALESCE(SUM(r.duracion), 0)                                                          AS semana,
               COALESCE(SUM(CASE WHEN r.facturable = 1 THEN r.duracion END), 0)                      AS semana_facturable,
               COALESCE(SUM(${SQL_IMPORTE}), 0)                                                      AS importe_semana
          FROM registros r
         WHERE r.usuario_id = ? AND r.fin IS NOT NULL AND date(r.inicio) >= ?`,
        [sumarDias(0), yo(), inicioSemana()]);
      return fila;
    },

    /**
     * Reporte completo con los filtros indicados (página Reportes):
     *   totales     -> segundos, segundos facturables, importe y número de entradas
     *   porDia      -> segundos por día (para la gráfica)
     *   porProyecto -> horas e importe por proyecto
     *   porUsuario  -> horas e importe por miembro del equipo
     *   detalle     -> todas las entradas
     */
    async obtenerReporte(filtros = {}) {
      const db = await conectar();
      const { where, parametros } = construirFiltros(filtros);
      const desde = `FROM registros r
        JOIN usuarios u       ON u.id = r.usuario_id
        LEFT JOIN proyectos p ON p.id = r.proyecto_id
        LEFT JOIN modulos m   ON m.id = r.modulo_id
        LEFT JOIN clientes c  ON c.id = p.cliente_id
        ${where}`;

      const [totales] = consultar(db, `
        SELECT COUNT(*)                                                         AS entradas,
               COALESCE(SUM(r.duracion), 0)                                     AS segundos,
               COALESCE(SUM(CASE WHEN r.facturable = 1 THEN r.duracion END), 0) AS segundos_facturables,
               COALESCE(SUM(${SQL_IMPORTE}), 0)                                 AS importe
        ${desde}`, parametros);

      const porDia = consultar(db, `
        SELECT date(r.inicio) AS fecha, SUM(r.duracion) AS segundos, SUM(${SQL_IMPORTE}) AS importe
        ${desde} GROUP BY date(r.inicio) ORDER BY fecha`, parametros);

      const porProyecto = consultar(db, `
        SELECT r.proyecto_id, p.nombre AS proyecto_nombre, p.color AS proyecto_color, c.nombre AS cliente_nombre,
               SUM(r.duracion) AS segundos, SUM(${SQL_IMPORTE}) AS importe
        ${desde} GROUP BY r.proyecto_id ORDER BY segundos DESC`, parametros);

      const porUsuario = consultar(db, `
        SELECT r.usuario_id, u.nombre AS usuario_nombre,
               SUM(r.duracion) AS segundos,
               SUM(CASE WHEN r.facturable = 1 THEN r.duracion ELSE 0 END) AS segundos_facturables,
               SUM(${SQL_IMPORTE}) AS importe
        ${desde} GROUP BY r.usuario_id ORDER BY segundos DESC`, parametros);

      // Horas por módulo dentro de cada proyecto (las entradas sin módulo se agrupan como "Sin módulo")
      const porModulo = consultar(db, `
        SELECT r.proyecto_id, p.nombre AS proyecto_nombre, p.color AS proyecto_color,
               r.modulo_id, m.nombre AS modulo_nombre, m.presupuesto_horas,
               COUNT(*) AS entradas, SUM(r.duracion) AS segundos, SUM(${SQL_IMPORTE}) AS importe
        ${desde} GROUP BY r.proyecto_id, r.modulo_id
        ORDER BY p.nombre IS NULL, p.nombre COLLATE NOCASE, segundos DESC`, parametros);

      const detalle = consultar(db, `${SELECT_REGISTRO} ${where} ORDER BY r.inicio DESC, r.id DESC`, parametros);

      return { totales, porDia, porProyecto, porModulo, porUsuario, detalle };
    },

    /* ======================= CLIENTES (CRUD) ======================= */

    /** READ: clientes con número de proyectos, horas e importe */
    async listarClientes() {
      const db = await conectar();
      return consultar(db, `
        SELECT c.*,
               (SELECT COUNT(*) FROM proyectos p WHERE p.cliente_id = c.id) AS proyectos,
               (SELECT COALESCE(SUM(r.duracion), 0) FROM registros r JOIN proyectos p ON p.id = r.proyecto_id
                 WHERE p.cliente_id = c.id AND r.fin IS NOT NULL) AS segundos,
               (SELECT COALESCE(SUM(${SQL_IMPORTE}), 0) FROM registros r JOIN proyectos p ON p.id = r.proyecto_id
                 WHERE p.cliente_id = c.id AND r.fin IS NOT NULL) AS importe
          FROM clientes c
         ORDER BY c.nombre COLLATE NOCASE`);
    },

    async obtenerCliente(id) {
      const db = await conectar();
      const c = consultar(db, 'SELECT * FROM clientes WHERE id = ?', [validarId(id)])[0];
      if (!c) throw crearError('Cliente no encontrado.');
      return c;
    },

    async crearCliente(datos) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const c = validarCliente(datos);
      exigirNombreUnico(db, 'clientes', c.nombre);
      db.run('INSERT INTO clientes (nombre, contacto, correo, fecha_creacion) VALUES (?, ?, ?, ?)',
        [c.nombre, c.contacto, c.correo, fechaHora(new Date())]);
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return { id, ...c };
    },

    async actualizarCliente(id, datos) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const c = validarCliente(datos);
      exigirNombreUnico(db, 'clientes', c.nombre, idValido);
      db.run('UPDATE clientes SET nombre = ?, contacto = ?, correo = ? WHERE id = ?', [c.nombre, c.contacto, c.correo, idValido]);
      if (db.getRowsModified() === 0) throw crearError('Cliente no encontrado.');
      guardarEnNavegador(db);
      return { id: idValido, ...c };
    },

    /** DELETE: elimina el cliente; sus proyectos quedan "sin cliente" (ON DELETE SET NULL) */
    async eliminarCliente(id) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      db.run('DELETE FROM clientes WHERE id = ?', [validarId(id)]);
      if (db.getRowsModified() === 0) throw crearError('Cliente no encontrado.');
      guardarEnNavegador(db);
    },

    /* ======================= PROYECTOS (CRUD) ======================= */

    /** READ: proyectos con cliente, horas, importe y presupuesto. { archivados: true } incluye los archivados */
    async listarProyectos(opciones = {}) {
      const db = await conectar();
      const where = opciones.archivados ? '' : 'WHERE p.archivado = 0';
      return consultar(db, `${SELECT_PROYECTO} ${where} ORDER BY p.archivado, c.nombre IS NULL, c.nombre COLLATE NOCASE, p.nombre COLLATE NOCASE`);
    },

    async obtenerProyecto(id) {
      const db = await conectar();
      const p = consultar(db, `${SELECT_PROYECTO} WHERE p.id = ?`, [validarId(id)])[0];
      if (!p) throw crearError('Proyecto no encontrado.');
      return p;
    },

    async crearProyecto(datos) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const p = validarProyecto(db, datos);
      exigirNombreUnico(db, 'proyectos', p.nombre);
      db.run(
        `INSERT INTO proyectos (nombre, cliente_id, color, facturable, tarifa_hora, presupuesto_horas, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.nombre, p.cliente_id, p.color, p.facturable, p.tarifa_hora, p.presupuesto_horas, fechaHora(new Date())]
      );
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return this.obtenerProyecto(id);
    },

    /** UPDATE: la nueva tarifa se aplica a las entradas que se registren de aquí en adelante */
    async actualizarProyecto(id, datos) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const p = validarProyecto(db, datos);
      exigirNombreUnico(db, 'proyectos', p.nombre, idValido);
      db.run(
        `UPDATE proyectos SET nombre = ?, cliente_id = ?, color = ?, facturable = ?, tarifa_hora = ?, presupuesto_horas = ?
          WHERE id = ?`,
        [p.nombre, p.cliente_id, p.color, p.facturable, p.tarifa_hora, p.presupuesto_horas, idValido]
      );
      if (db.getRowsModified() === 0) throw crearError('Proyecto no encontrado.');
      guardarEnNavegador(db);
      return this.obtenerProyecto(idValido);
    },

    /** UPDATE: archiva (deja de aparecer para registrar tiempo) o reactiva un proyecto */
    async archivarProyecto(id, archivar = true) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      db.run('UPDATE proyectos SET archivado = ? WHERE id = ?', [archivar ? 1 : 0, validarId(id)]);
      if (db.getRowsModified() === 0) throw crearError('Proyecto no encontrado.');
      guardarEnNavegador(db);
    },

    /** DELETE: solo si el proyecto no tiene horas registradas (si tiene, se debe archivar) */
    async eliminarProyecto(id) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const [{ n }] = consultar(db, 'SELECT COUNT(*) AS n FROM registros WHERE proyecto_id = ?', [idValido]);
      if (n > 0) throw crearError(`El proyecto tiene ${n} entrada(s) de tiempo. Archívalo para conservar el historial.`);
      db.run('DELETE FROM proyectos WHERE id = ?', [idValido]);
      if (db.getRowsModified() === 0) throw crearError('Proyecto no encontrado.');
      guardarEnNavegador(db);
    },

    /* ======================= MÓDULOS DE UN PROYECTO (CRUD) ======================= */

    /**
     * READ: módulos con sus horas registradas, importe y número de entradas.
     * proyectoId opcional (sin él, todos). { archivados: true } incluye los archivados.
     */
    async listarModulos(proyectoId = null, opciones = {}) {
      const db = await conectar();
      const condiciones = [];
      const parametros = [];
      if (proyectoId) { condiciones.push('mo.proyecto_id = ?'); parametros.push(Number(proyectoId)); }
      if (!opciones.archivados) condiciones.push('mo.archivado = 0');
      const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
      return consultar(db, `
        SELECT mo.*, p.nombre AS proyecto_nombre, p.color AS proyecto_color,
               (SELECT COALESCE(SUM(r.duracion), 0) FROM registros r WHERE r.modulo_id = mo.id AND r.fin IS NOT NULL) AS segundos,
               (SELECT COALESCE(SUM(${SQL_IMPORTE}), 0) FROM registros r WHERE r.modulo_id = mo.id AND r.fin IS NOT NULL) AS importe,
               (SELECT COUNT(*) FROM registros r WHERE r.modulo_id = mo.id) AS entradas
          FROM modulos mo
          JOIN proyectos p ON p.id = mo.proyecto_id
          ${where}
         ORDER BY p.nombre COLLATE NOCASE, mo.archivado, mo.nombre COLLATE NOCASE`, parametros);
    },

    /** Horas del proyecto que todavía no tienen módulo (para mostrarlas junto a los módulos) */
    async horasSinModulo(proyectoId) {
      const db = await conectar();
      return consultar(db, `
        SELECT COUNT(*) AS entradas, COALESCE(SUM(r.duracion), 0) AS segundos, COALESCE(SUM(${SQL_IMPORTE}), 0) AS importe
          FROM registros r WHERE r.proyecto_id = ? AND r.modulo_id IS NULL AND r.fin IS NOT NULL`, [validarId(proyectoId)])[0];
    },

    /** CREATE: agrega un módulo a un proyecto (nombre único dentro del proyecto) */
    async crearModulo(datos = {}) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const m = validarModulo(db, datos);
      exigirModuloUnico(db, m.proyecto_id, m.nombre);
      db.run('INSERT INTO modulos (proyecto_id, nombre, presupuesto_horas, fecha_creacion) VALUES (?, ?, ?, ?)',
        [m.proyecto_id, m.nombre, m.presupuesto_horas, fechaHora(new Date())]);
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return consultar(db, 'SELECT * FROM modulos WHERE id = ?', [id])[0];
    },

    /** UPDATE: cambia nombre y presupuesto (el proyecto de un módulo no cambia) */
    async actualizarModulo(id, datos = {}) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      const actual = consultar(db, 'SELECT * FROM modulos WHERE id = ?', [validarId(id)])[0];
      if (!actual) throw crearError('Módulo no encontrado.');
      const m = validarModulo(db, { ...datos, proyecto_id: actual.proyecto_id });
      exigirModuloUnico(db, actual.proyecto_id, m.nombre, actual.id);
      db.run('UPDATE modulos SET nombre = ?, presupuesto_horas = ? WHERE id = ?', [m.nombre, m.presupuesto_horas, actual.id]);
      guardarEnNavegador(db);
      return consultar(db, 'SELECT * FROM modulos WHERE id = ?', [actual.id])[0];
    },

    /** UPDATE: archiva (ya no se ofrece al registrar tiempo) o reactiva un módulo */
    async archivarModulo(id, archivar = true) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      db.run('UPDATE modulos SET archivado = ? WHERE id = ?', [archivar ? 1 : 0, validarId(id)]);
      if (db.getRowsModified() === 0) throw crearError('Módulo no encontrado.');
      guardarEnNavegador(db);
    },

    /** DELETE: elimina el módulo; sus entradas se conservan "sin módulo" (ON DELETE SET NULL) */
    async eliminarModulo(id) {
      exigir('proyectos.gestionar');
      const db = await conectar();
      db.run('DELETE FROM modulos WHERE id = ?', [validarId(id)]);
      if (db.getRowsModified() === 0) throw crearError('Módulo no encontrado.');
      guardarEnNavegador(db);
    },

    /* ---------------------- Respaldo del archivo .db ---------------------- */

    /** Descarga la base de datos como archivo tiempos.db */
    async exportarArchivo() {
      exigir('bd.respaldo');
      const db = await conectar();
      const blob = new Blob([db.export()], { type: 'application/x-sqlite3' });
      db.run('PRAGMA foreign_keys = ON');
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(blob);
      enlace.download = 'tiempos.db';
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
    },

    /** Reemplaza la base actual por un archivo .db (verifica que sea de este sistema) */
    async importarArchivo(archivo) {
      exigir('bd.respaldo');
      await conectar(); // asegura que sql.js esté inicializado
      const bytes = new Uint8Array(await archivo.arrayBuffer());

      let nueva;
      try {
        nueva = new SQL.Database(bytes);
        consultar(nueva, 'SELECT id, usuario_id, proyecto_id, inicio, fin, duracion, tarifa FROM registros LIMIT 1');
        consultar(nueva, 'SELECT id, nombre, color FROM proyectos LIMIT 1');
      } catch {
        nueva?.close();
        throw crearError('El archivo no es una base de datos válida de Control de Tiempo.');
      }

      await prepararEsquema(nueva); // crea las tablas que falten
      guardarEnNavegador(nueva);
      (await promesaConexion).close();
      promesaConexion = Promise.resolve(nueva);
    },

    /** Borra entradas, módulos, proyectos y clientes y carga los de ejemplo. Usuarios y ajustes se conservan. */
    async restablecer() {
      exigir('bd.respaldo');
      const db = await conectar();
      db.run('DELETE FROM registros');
      db.run('DELETE FROM modulos');
      db.run('DELETE FROM proyectos');
      db.run('DELETE FROM clientes');
      db.run("DELETE FROM sqlite_sequence WHERE name IN ('registros', 'modulos', 'proyectos', 'clientes')");
      insertarEjemplos(db);
      guardarEnNavegador(db);
    },

    /* ======================= Usuarios y acceso ======================= */

    /**
     * Verifica usuario y contraseña (inicio de sesión).
     * Mismo mensaje si falla el usuario o la contraseña, para no dar pistas.
     */
    async autenticar(usuario, password) {
      const db = await conectar();
      const nombreUsuario = String(usuario ?? '').trim().toLowerCase();
      const fila = consultar(db, 'SELECT * FROM usuarios WHERE usuario = ?', [nombreUsuario])[0];

      if (!fila || (await calcularHash(String(password ?? ''), fila.sal)) !== fila.password_hash) {
        throw crearError('Usuario o contraseña incorrectos.');
      }
      if (fila.activo !== 1) throw crearError('Tu usuario está desactivado. Contacta al administrador.');

      db.run('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?', [fechaHora(new Date()), fila.id]);
      guardarEnNavegador(db);
      return consultar(db, `SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`, [fila.id])[0];
    },

    /** Devuelve el usuario si sigue existiendo y activo (o null). Se usa al abrir cada página. */
    async validarSesion(id) {
      const db = await conectar();
      const fila = consultar(db, `SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`, [Number(id)])[0];
      return fila && fila.activo === 1 ? fila : null;
    },

    /** Miembros que registran tiempo (para el filtro de Reportes) */
    async listarMiembros() {
      const db = await conectar();
      return consultar(db, "SELECT id, nombre FROM usuarios WHERE rol <> 'consulta' OR id IN (SELECT usuario_id FROM registros) ORDER BY nombre COLLATE NOCASE");
    },

    /** Lista los usuarios con sus horas del mes y si tienen cronómetro corriendo (solo administrador) */
    async listarUsuarios() {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const inicioMes = `${sumarDias(0).slice(0, 7)}-01`;
      return consultar(db, `
        SELECT u.id, u.usuario, u.nombre, u.rol, u.tarifa_hora, u.activo, u.fecha_creacion, u.ultimo_acceso,
               (SELECT COALESCE(SUM(r.duracion), 0) FROM registros r
                 WHERE r.usuario_id = u.id AND r.fin IS NOT NULL AND date(r.inicio) >= ?) AS segundos_mes,
               (SELECT COUNT(*) FROM registros r WHERE r.usuario_id = u.id AND r.fin IS NULL) AS corriendo
          FROM usuarios u
         ORDER BY u.rol, u.nombre COLLATE NOCASE`, [inicioMes]);
    },

    /** Obtiene un usuario por id (solo administrador) */
    async obtenerUsuario(id) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const fila = consultar(db, `SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`, [validarId(id)])[0];
      if (!fila) throw crearError('Usuario no encontrado.');
      return fila;
    },

    /** Crea un usuario con su contraseña cifrada (solo administrador) */
    async crearUsuario(datos) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const u = validarUsuario(datos, true);

      if (consultar(db, 'SELECT id FROM usuarios WHERE usuario = ?', [u.usuario]).length) {
        throw crearError('Ese nombre de usuario ya existe.', { usuario: `El usuario "${u.usuario}" ya está registrado.` });
      }

      const sal = crypto.randomUUID();
      db.run(
        `INSERT INTO usuarios (usuario, nombre, rol, tarifa_hora, password_hash, sal, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [u.usuario, u.nombre, u.rol, u.tarifa_hora, await calcularHash(u.password, sal), sal, fechaHora(new Date())]
      );
      const id = ultimoId(db);
      guardarEnNavegador(db);
      return consultar(db, `SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`, [id])[0];
    },

    /**
     * Actualiza nombre, usuario, rol, tarifa y (opcionalmente) contraseña (solo administrador).
     * Regla de negocio: siempre debe quedar al menos un administrador activo.
     */
    async actualizarUsuario(id, datos) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const actual = consultar(db, 'SELECT * FROM usuarios WHERE id = ?', [idValido])[0];
      if (!actual) throw crearError('Usuario no encontrado.');

      const u = validarUsuario(datos, false);
      if (consultar(db, 'SELECT id FROM usuarios WHERE usuario = ? AND id <> ?', [u.usuario, idValido]).length) {
        throw crearError('Ese nombre de usuario ya existe.', { usuario: `El usuario "${u.usuario}" ya está registrado.` });
      }
      if (actual.rol === 'administrador' && u.rol !== 'administrador' && otrosAdminsActivos(db, idValido) === 0) {
        throw crearError('Debe existir al menos un administrador activo.', { rol: 'No puedes quitar el rol al único administrador.' });
      }

      db.run('UPDATE usuarios SET usuario = ?, nombre = ?, rol = ?, tarifa_hora = ? WHERE id = ?',
        [u.usuario, u.nombre, u.rol, u.tarifa_hora, idValido]);

      // Solo si se escribió una contraseña nueva se recalcula el hash (con sal nueva)
      if (u.password) {
        const sal = crypto.randomUUID();
        db.run('UPDATE usuarios SET password_hash = ?, sal = ? WHERE id = ?', [await calcularHash(u.password, sal), sal, idValido]);
      }

      guardarEnNavegador(db);
      return consultar(db, `SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`, [idValido])[0];
    },

    /** Activa o desactiva un usuario (solo administrador). Un usuario desactivado no puede entrar. */
    async cambiarEstadoUsuario(id, activo) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const actual = consultar(db, 'SELECT * FROM usuarios WHERE id = ?', [idValido])[0];
      if (!actual) throw crearError('Usuario no encontrado.');
      if (idValido === yo() && !activo) throw crearError('No puedes desactivar tu propio usuario.');
      if (!activo && actual.rol === 'administrador' && otrosAdminsActivos(db, idValido) === 0) {
        throw crearError('Debe existir al menos un administrador activo.');
      }

      db.run('UPDATE usuarios SET activo = ? WHERE id = ?', [activo ? 1 : 0, idValido]);
      // Si se desactiva, su cronómetro en curso se detiene para no acumular horas
      if (!activo) {
        const corriendo = cronometroDe(db, idValido);
        if (corriendo) detenerInterno(db, corriendo);
      }
      guardarEnNavegador(db);
    },

    /**
     * Elimina un usuario (solo administrador). Si tiene horas registradas no se permite
     * (llave foránea ON DELETE RESTRICT): se debe desactivar para conservar la facturación.
     */
    async eliminarUsuario(id) {
      exigir('usuarios.gestionar');
      const db = await conectar();
      const idValido = validarId(id);
      const actual = consultar(db, 'SELECT * FROM usuarios WHERE id = ?', [idValido])[0];
      if (!actual) throw crearError('Usuario no encontrado.');
      if (idValido === yo()) throw crearError('No puedes eliminar tu propio usuario.');
      if (actual.rol === 'administrador' && otrosAdminsActivos(db, idValido) === 0) {
        throw crearError('Debe existir al menos un administrador activo.');
      }
      const [{ n }] = consultar(db, 'SELECT COUNT(*) AS n FROM registros WHERE usuario_id = ?', [idValido]);
      if (n > 0) throw crearError(`${actual.nombre} tiene ${n} entrada(s) de tiempo. Desactívalo para conservar el historial.`);

      db.run('DELETE FROM usuarios WHERE id = ?', [idValido]);
      guardarEnNavegador(db);
    }
  };

  /** Detiene una entrada en curso: fin = ahora, duración en segundos (máximo 24 h) */
  function detenerInterno(db, registro) {
    const inicio = aFecha(registro.inicio);
    let fin = new Date();
    if (fin - inicio > MAX_SEGUNDOS * 1000) fin = new Date(inicio.getTime() + MAX_SEGUNDOS * 1000);
    if (fin - inicio < 1000) fin = new Date(inicio.getTime() + 1000); // mínimo 1 segundo
    const duracion = Math.round((fin - inicio) / 1000);
    db.run('UPDATE registros SET fin = ?, duracion = ? WHERE id = ?', [fechaHora(fin), duracion, registro.id]);
  }
})();
