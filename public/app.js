// Single-pipeline SPA. Drives the Project Manual flow against the Worker API:
// create → intake → Gate 0 → outline (M0) → run → resolve selections (M-DECIDE)
// → triage coordination (M-COORD) → approve (gate5) → download. No mode chooser
// (one mode: UFGS). The anonymous "sample" path bundles a finish-schedule CSV.

const $ = (s, r = document) => r.querySelector(s);
const el = (t, p = {}, kids = []) => { const n = Object.assign(document.createElement(t), p); for (const k of [].concat(kids)) n.append(k.nodeType ? k : document.createTextNode(k)); return n; };
const toast = (m, ms = 2600) => { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `${res.status} ${path}`);
  return body;
}

const SAMPLE_CSV = `room,substrate,finish,sheen
101-110,gypsum board,paint,eggshell
101-110,ferrous metal (railings),paint,semi-gloss
112,gypsum board,paint,eggshell
`;

let state = { user: null, projectId: null, project: null };

// ---- auth ----
async function refreshAuth() {
  const cfg = await api('/auth/config').catch(() => ({}));
  const me = await api('/auth/me').catch(() => ({ user: null }));
  state.user = me.user;
  const box = $('#authState');
  box.innerHTML = '';
  if (state.user) {
    box.append(el('span', { textContent: `${state.user.name || state.user.email} · ` }));
    box.append(el('button', { className: 'link', textContent: 'Sign out', onclick: async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); } }));
  } else if (cfg.googleConfigured) {
    box.append(el('a', { href: '/auth/google/start', textContent: 'Sign in with Google', className: 'link' }));
  } else if (cfg.devLoginAvailable) {
    box.append(el('button', { className: 'link', textContent: 'Dev sign-in', onclick: async () => {
      const email = prompt('Dev email:', 'demo@local'); if (!email) return;
      await api('/auth/session', { method: 'POST', body: JSON.stringify({ email, name: email.split('@')[0] }) });
      location.reload();
    } }));
  } else {
    box.append(el('span', { className: 'muted', textContent: 'anonymous' }));
  }
}

// ---- home ----
async function showHome() {
  show('home');
  const list = $('#projectList'); list.innerHTML = '';
  if (!state.user) { list.append(el('p', { className: 'muted', textContent: 'Sign in to see saved manuals, or try the sample.' })); return; }
  const { projects } = await api('/projects').catch(() => ({ projects: [] }));
  if (!projects.length) { list.append(el('p', { className: 'muted', textContent: 'No manuals yet.' })); return; }
  for (const p of projects) {
    list.append(el('div', { className: 'card', onclick: () => openProject(p.projectId, p.name) }, [
      el('div', { textContent: p.name || 'Untitled Project Manual' }),
      el('div', { className: 'meta', textContent: `${p.projectId} · ${p.manualStatus || p.status || 'intake'}` }),
    ]));
  }
}

// ---- create ----
async function createProject(name, agency, demo) {
  const { projectId } = await api('/project', { method: 'POST', body: JSON.stringify({ name, agency }) });
  state.projectId = projectId;
  if (demo) {
    const fd = new FormData();
    fd.append('finish-schedule', new Blob([SAMPLE_CSV], { type: 'text/csv' }), 'finish-schedule.csv');
    await api(`/project/${projectId}/inputs`, { method: 'POST', body: fd });
    await api(`/project/${projectId}/parse`, { method: 'POST' });
  }
  openProject(projectId, name);
}

// ---- project flow ----
async function openProject(id, name) {
  state.projectId = id;
  show('project');
  $('#projTitle').textContent = name || 'Project Manual';
  await renderStep();
}

function setSteps(active, done = []) {
  for (const li of document.querySelectorAll('#steps li')) {
    li.classList.toggle('active', li.dataset.step === active);
    li.classList.toggle('done', done.includes(li.dataset.step));
  }
}

async function renderStep() {
  const id = state.projectId;
  const body = $('#stepBody'); body.innerHTML = loading();
  // Determine where we are from server state.
  const ex = await api(`/project/${id}/extracted`).catch(() => ({ data: null, confirmed: false, inputs: [] }));
  if (!ex.data) return stepIntake(ex);
  if (!ex.confirmed) return stepGate0(ex);
  const outline = await api(`/project/${id}/manual/outline`).catch(() => ({ sections: [] }));
  if (!outline.sections || !outline.sections.length) return stepOutline();
  const ms = await api(`/project/${id}/manual/state`).catch(() => ({}));
  return stepRun(ms);
}

function loading() { return '<span class="spin"></span> loading…'; }

function stepIntake(ex) {
  setSteps('intake');
  const body = $('#stepBody'); body.innerHTML = '';
  body.append(el('h3', { textContent: 'Intake — upload project data' }));
  body.append(el('p', { className: 'muted', textContent: 'Upload a finish-schedule CSV/XLSX (and optionally IFC, COBie, program, drawings). The engine selects sections from what it finds.' }));
  const file = el('input', { type: 'file', accept: '.csv,.xlsx,.ifc,.pdf,.docx' });
  body.append(el('label', { textContent: 'Finish schedule' }), file);
  body.append(el('div', { className: 'row' }, [
    el('button', { className: 'primary', textContent: 'Upload & parse', onclick: async () => {
      if (!file.files[0]) return toast('Choose a file first.');
      const fd = new FormData(); fd.append('finish-schedule', file.files[0]);
      await api(`/project/${state.projectId}/inputs`, { method: 'POST', body: fd });
      await api(`/project/${state.projectId}/parse`, { method: 'POST' });
      renderStep();
    } }),
  ]));
}

function stepGate0(ex) {
  setSteps('gate0', ['intake']);
  const body = $('#stepBody'); body.innerHTML = '';
  body.append(el('h3', { textContent: 'Confirm the extracted project data (Gate 0)' }));
  const d = ex.data || {};
  const t = el('table');
  t.append(el('tr', {}, [el('th', { textContent: 'Finishes' }), el('th', { textContent: 'Spaces' }), el('th', { textContent: 'Elements' })]));
  t.append(el('tr', {}, [el('td', { textContent: String((d.finishes || []).length) }), el('td', { textContent: String((d.spaces || []).length) }), el('td', { textContent: String((d.elements || []).length) })]));
  body.append(t);
  if (d.finishes?.length) {
    const ft = el('table'); ft.append(el('tr', {}, [el('th', { textContent: 'Space' }), el('th', { textContent: 'Substrate' }), el('th', { textContent: 'Finish' }), el('th', { textContent: 'Sheen' })]));
    for (const f of d.finishes.slice(0, 20)) ft.append(el('tr', {}, [el('td', { textContent: f.spaceRef || '' }), el('td', { textContent: f.substrate || '' }), el('td', { textContent: f.finish || '' }), el('td', { textContent: f.sheen || '' })]));
    body.append(ft);
  }
  body.append(el('div', { className: 'row' }, [
    el('button', { className: 'primary', textContent: 'Confirm — this is correct', onclick: async () => {
      try { await api(`/project/${state.projectId}/extracted/confirm`, { method: 'POST', body: JSON.stringify({}) }); renderStep(); }
      catch (e) { toast(e.message); }
    } }),
  ]));
}

async function stepOutline() {
  setSteps('outline', ['intake', 'gate0']);
  const body = $('#stepBody'); body.innerHTML = loading();
  const proposed = await api(`/project/${state.projectId}/manual/outline/proposed`).catch(() => ({ sections: [] }));
  body.innerHTML = '';
  body.append(el('h3', { textContent: 'Confirm the section outline (Gate M0)' }));
  body.append(el('p', { className: 'muted', textContent: 'Division 01 is always included; technical sections are matched from your intake. Outline-only sections are shown honestly as reserved (G-MAN).' }));
  const t = el('table'); t.append(el('tr', {}, [el('th', { textContent: 'Section' }), el('th', { textContent: 'Title' }), el('th', { textContent: 'Mode' })]));
  for (const s of proposed.sections || []) t.append(el('tr', {}, [el('td', { className: 'mono', textContent: s.section }), el('td', { textContent: s.title || '' }), el('td', { textContent: s.draftingMode })]));
  body.append(t);
  body.append(el('div', { className: 'row' }, [
    el('button', { className: 'primary', textContent: 'Confirm outline & run the book', onclick: async () => {
      try {
        await api(`/project/${state.projectId}/manual/outline`, { method: 'POST', body: JSON.stringify({ sections: proposed.sections }) });
        await api(`/project/${state.projectId}/manual/run`, { method: 'POST', body: JSON.stringify({}) });
        pollRun();
      } catch (e) { toast(e.message); }
    } }),
  ]));
}

let pollTimer = null;
function pollRun() { clearTimeout(pollTimer); renderStep(); }

async function stepRun(ms) {
  const status = ms.status || ms.manualStatus || 'running';
  const gate = ms.pendingGate?.gateId || ms.gate;
  if (gate === 'M-DECIDE') return stepDecide();
  if (gate === 'M-COORD') return stepCoord();
  if (gate === 'gate5') return stepApprove(ms);
  if (status === 'approved' || status === 'assembled') return stepApprove(ms);

  setSteps('run', ['intake', 'gate0', 'outline']);
  const body = $('#stepBody'); body.innerHTML = '';
  body.append(el('h3', {}, [el('span', { className: 'spin' }), `Running the book — ${status}`]));
  const sections = ms.sections || ms.perSection || [];
  if (sections.length) {
    const t = el('table'); t.append(el('tr', {}, [el('th', { textContent: 'Section' }), el('th', { textContent: 'Status' })]));
    for (const s of sections) t.append(el('tr', {}, [el('td', { className: 'mono', textContent: s.section }), el('td', { textContent: s.status || '' })]));
    body.append(t);
  }
  pollTimer = setTimeout(renderStep, 2500);
}

async function stepDecide() {
  setSteps('decide', ['intake', 'gate0', 'outline', 'run']);
  const body = $('#stepBody'); body.innerHTML = loading();
  const d = await api(`/project/${state.projectId}/manual/decisions`).catch(() => ({ decisions: [] }));
  const decisions = d.decisions || d.open || [];
  body.innerHTML = '';
  body.append(el('h3', { textContent: `Resolve in-book selections (Gate M-DECIDE) — ${decisions.length} open` }));
  for (const dec of decisions) {
    const wrap = el('div', { className: 'flag' });
    wrap.append(el('div', { className: 'mono', textContent: `${dec.section || ''} · ${dec.selectionId || dec.id}` }));
    if (dec.options?.length) {
      const sel = el('select'); for (const o of dec.options) sel.append(el('option', { value: o, textContent: o }));
      wrap.append(sel);
      wrap.append(el('button', { textContent: 'Resolve', onclick: async () => {
        await api(`/project/${state.projectId}/manual/section/${encodeURIComponent(dec.section)}/resolve`, { method: 'POST', body: JSON.stringify({ selectionId: dec.selectionId || dec.id, value: sel.value }) }).catch((e) => toast(e.message));
        stepDecide();
      } }));
    } else {
      const inp = el('input', { placeholder: 'value' });
      wrap.append(inp, el('button', { textContent: 'Fill', onclick: async () => {
        await api(`/project/${state.projectId}/manual/section/${encodeURIComponent(dec.section)}/resolve`, { method: 'POST', body: JSON.stringify({ selectionId: dec.selectionId || dec.id, value: inp.value }) }).catch((e) => toast(e.message));
        stepDecide();
      } }));
    }
    body.append(wrap);
  }
  body.append(el('div', { className: 'row' }, [el('button', { className: 'primary', textContent: 'Close M-DECIDE', onclick: () => gate('M-DECIDE') })]));
}

async function stepCoord() {
  setSteps('coord', ['intake', 'gate0', 'outline', 'run', 'decide']);
  const body = $('#stepBody'); body.innerHTML = loading();
  const c = await api(`/project/${state.projectId}/manual/coordination`).catch(() => ({ flags: [] }));
  const flags = c.flags || c.coordinationFlags || [];
  body.innerHTML = '';
  body.append(el('h3', { textContent: `Triage cross-section flags (Gate M-COORD) — ${flags.length}` }));
  for (const f of flags) body.append(el('div', { className: 'flag ' + (f.severity === 'high' ? 'bad' : ''), }, [
    el('div', {}, [el('span', { className: 'mono', textContent: f.kind + ' ' }), el('span', { textContent: (f.sections || []).join(', ') })]),
    el('div', { className: 'muted', textContent: f.detail || '' }),
  ]));
  body.append(el('div', { className: 'row' }, [el('button', { className: 'primary', textContent: 'Clear & continue (M-COORD)', onclick: () => gate('M-COORD') })]));
}

async function stepApprove(ms) {
  setSteps('approve', ['intake', 'gate0', 'outline', 'run', 'decide', 'coord']);
  const body = $('#stepBody'); body.innerHTML = '';
  const approved = (ms.status || ms.manualStatus) === 'approved';
  body.append(el('h3', { textContent: approved ? 'Approved for seal' : 'Approve for seal (Gate 5)' }));
  body.append(el('p', { className: 'muted', textContent: 'A licensed architect-of-record reviews and applies the real seal outside this system. This produces an approved-for-seal package only.' }));
  if (!approved) body.append(el('div', { className: 'row' }, [el('button', { className: 'primary', textContent: 'Approve for seal', onclick: () => gate('gate5') })]));
  const dl = el('div', { className: 'dl' });
  for (const k of ['docx', 'pdf', 'seal-package', 'references', 'submittal-register', 'coordination', 'compliance', 'toc'])
    dl.append(el('a', { href: `/project/${state.projectId}/manual/artifact/${k}`, textContent: k, target: '_blank' }));
  body.append(el('h3', { textContent: 'Artifacts' }), dl);
}

async function gate(gateId) {
  try { await api(`/project/${state.projectId}/manual/gate/${gateId}`, { method: 'POST', body: JSON.stringify({}) }); renderStep(); }
  catch (e) { toast(e.message); }
}

// ---- view switching ----
function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== `view-${view}`);
  if (view === 'home') clearTimeout(pollTimer);
}

document.addEventListener('click', (e) => { const n = e.target.closest('[data-nav]'); if (n) { e.preventDefault(); if (n.dataset.nav === 'home') showHome(); } });
$('#btnNew').onclick = () => { const name = prompt('Project name:', 'New Project Manual'); if (name) createProject(name, 'ARMY', false); };
$('#btnDemo').onclick = () => createProject('Sample — Medical Clinic (Painting)', 'ARMY', true);

(async function init() { await refreshAuth(); await showHome(); })();
