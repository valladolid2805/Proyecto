/**
 * login.js
 * ----------------------------------------------------------------------------
 * Lógica de la pantalla de inicio de sesión (login.html).
 *   - Valida que se escriban usuario y contraseña.
 *   - Verifica las credenciales contra la tabla "usuarios" (Sesion.iniciar -> BD.autenticar).
 *   - Si son correctas abre la sesión y envía al inicio; si no, muestra el error.
 *   - Botón para mostrar/ocultar la contraseña y botones de usuarios de prueba.
 */

const formLogin = document.getElementById('form-login');
const campoUsuario = document.getElementById('usuario');
const campoPassword = document.getElementById('password');
const alertaError = document.getElementById('error-login');
const botonEntrar = document.getElementById('btn-entrar');

document.addEventListener('DOMContentLoaded', () => {
  // Si ya hay una sesión abierta, no tiene caso volver a iniciar: ir al inicio
  if (Sesion.actual()) {
    window.location.replace('index.html');
    return;
  }

  formLogin.addEventListener('submit', entrar);
  document.getElementById('btn-ver-password').addEventListener('click', alternarPassword);

  // Botones de usuarios de prueba: llenan el formulario con sus datos
  document.querySelectorAll('.btn-demo').forEach((boton) => {
    boton.addEventListener('click', () => {
      campoUsuario.value = boton.dataset.usuario;
      campoPassword.value = boton.dataset.password;
      limpiarErrores();
      botonEntrar.focus();
    });
  });

  // Al escribir se quita el error anterior
  [campoUsuario, campoPassword].forEach((campo) => campo.addEventListener('input', limpiarErrores));
});

/** Envía el formulario: valida, verifica credenciales y abre la sesión */
async function entrar(evento) {
  evento.preventDefault(); // evitar que la página se recargue
  limpiarErrores();

  // Validación: ambos campos son obligatorios
  let valido = true;
  [campoUsuario, campoPassword].forEach((campo) => {
    const vacio = campo.value.trim() === '';
    campo.classList.toggle('is-invalid', vacio);
    if (vacio) valido = false;
  });
  if (!valido) {
    formLogin.querySelector('.is-invalid').focus();
    return;
  }

  // Indicador de carga y evitar doble clic
  botonEntrar.disabled = true;
  botonEntrar.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Verificando...';

  try {
    const usuario = await Sesion.iniciar(campoUsuario.value, campoPassword.value);
    guardarMensajeFlash(`¡Bienvenido(a), ${usuario.nombre}!`);
    window.location.href = 'index.html';
  } catch (error) {
    // Mostrar el error, borrar la contraseña y regresar el cursor a ese campo
    alertaError.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> ${escaparHTML(error.message)}`;
    alertaError.classList.remove('d-none');
    campoPassword.value = '';
    campoPassword.classList.add('is-invalid');
    campoPassword.focus();

    botonEntrar.disabled = false;
    botonEntrar.innerHTML = '<i class="bi bi-box-arrow-in-right"></i> Entrar';
  }
}

/** Cambia el campo de contraseña entre "password" (oculto) y "text" (visible) */
function alternarPassword() {
  const visible = campoPassword.type === 'text';
  campoPassword.type = visible ? 'password' : 'text';
  this.innerHTML = `<i class="bi ${visible ? 'bi-eye' : 'bi-eye-slash'}"></i>`;
  this.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
}

/** Oculta el mensaje de error y quita los bordes rojos */
function limpiarErrores() {
  alertaError.classList.add('d-none');
  [campoUsuario, campoPassword].forEach((campo) => campo.classList.remove('is-invalid'));
}
