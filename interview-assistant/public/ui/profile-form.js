import { h, lines } from './dom.js';

const MAX_ROLES = 12;

const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);

/** Profile editor. `onSave(profile)` returns a promise; its error message is shown next to the button. */
export function createProfileForm({ onSave }) {
  const f = {
    name: h('input', { id: 'pf-name', type: 'text', maxLength: 300 }),
    headline: h('input', { id: 'pf-headline', type: 'text', maxLength: 300, placeholder: 'Full Stack Lead' }),
    summary: h('textarea', { id: 'pf-summary', rows: 4, maxLength: 2000, placeholder: 'Quién eres en 2–3 frases' }),
    skills: h('textarea', { id: 'pf-skills', rows: 4, placeholder: 'Una habilidad por línea' }),
    notes: h('textarea', { id: 'pf-notes', rows: 3, maxLength: 4000, placeholder: 'Lo que quieres recordar o resaltar en la entrevista' }),
  };
  const roles = h('div', { id: 'pf-roles' });
  const addRoleBtn = h('button', { id: 'pf-add-role', class: 'btn small', type: 'button' }, 'Añadir rol');
  const saveBtn = h('button', { id: 'profile-save', class: 'btn primary', type: 'button' }, 'Guardar perfil');
  const message = h('p', { id: 'pf-message', class: 'meta', role: 'status' });
  let loaded = null;

  function addRole(role = {}) {
    const inputs = {
      role: h('input', { type: 'text', class: 'r-role', maxLength: 300, value: role.role ?? '' }),
      company: h('input', { type: 'text', class: 'r-company', maxLength: 300, value: role.company ?? '' }),
      period: h('input', { type: 'text', class: 'r-period', maxLength: 300, value: role.period ?? '', placeholder: '2022 – 2024' }),
      highlights: h('textarea', { class: 'r-highlights', rows: 3, placeholder: 'Un logro por línea', value: (role.highlights ?? []).join('\n') }),
    };
    const row = h('fieldset', { class: 'role' },
      field('Rol', inputs.role), field('Empresa', inputs.company), field('Periodo', inputs.period), field('Logros', inputs.highlights),
      h('button', { class: 'btn ghost small', type: 'button', onClick: () => { row.remove(); addRoleBtn.disabled = false; } }, 'Quitar rol'));
    row.inputs = inputs;
    roles.append(row);
    addRoleBtn.disabled = roles.children.length >= MAX_ROLES;
  }

  function populate(profile) {
    f.name.value = profile.name;
    f.headline.value = profile.headline;
    f.summary.value = profile.summary;
    f.skills.value = profile.skills.join('\n');
    f.notes.value = profile.notes;
    roles.replaceChildren();
    profile.experience.forEach(addRole);
    addRoleBtn.disabled = profile.experience.length >= MAX_ROLES;
  }

  function read() {
    return {
      name: f.name.value, headline: f.headline.value, summary: f.summary.value, skills: lines(f.skills.value), notes: f.notes.value,
      experience: [...roles.children].map(({ inputs }) => ({
        role: inputs.role.value, company: inputs.company.value, period: inputs.period.value, highlights: lines(inputs.highlights.value),
      })),
    };
  }

  addRoleBtn.addEventListener('click', () => addRole());
  saveBtn.addEventListener('click', async () => {
    message.className = 'meta';
    message.textContent = 'Guardando…';
    try {
      await onSave(read());
      message.textContent = 'Guardado ✓';
    } catch (err) {
      message.className = 'error-text';
      message.textContent = err.message;
    }
  });

  const el = h('form', { id: 'profile-form', class: 'form', onSubmit: (e) => e.preventDefault() },
    field('Nombre', f.name), field('Titular', f.headline), field('Resumen', f.summary), field('Habilidades', f.skills),
    h('h3', {}, 'Experiencia reciente'), roles, addRoleBtn, field('Notas', f.notes),
    h('div', { class: 'row' }, saveBtn, message));

  return {
    el,
    /** Fills the form when a new profile arrives (first load or after saving), never on unrelated updates. */
    render(state) {
      if (state.profile && state.profile !== loaded) {
        loaded = state.profile;
        populate(state.profile);
      }
    },
  };
}
