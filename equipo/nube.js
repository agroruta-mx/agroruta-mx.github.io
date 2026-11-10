/* AgroRuta Equipo · conexión con Supabase: sesión, datos en vivo, fotos y notificaciones */
(function () {
  const C = window.AR_CONFIG || {};
  const sb = (window.supabase && C.url) ? window.supabase.createClient(C.url, C.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
  const AR = window.AR = { sb, user: null, ok: !!sb, abrir: null };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) { } },
    clear(pre) { try { Object.keys(localStorage).filter(k => k.startsWith(pre)).forEach(k => localStorage.removeItem(k)) } catch (e) { } }
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- abrir una orden desde una notificación (#orden=AR-1110-XYZ) ---- */
  const leerHash = () => { const m = location.hash.match(/^#orden=(.+)$/); if (!m) return false; AR.abrir = decodeURIComponent(m[1]); history.replaceState(null, '', location.pathname + location.search + '#tecnico'); return true };
  leerHash();
  addEventListener('hashchange', () => { if (leerHash()) document.dispatchEvent(new Event('ar-abrir')) });

  /* ---- service worker (app instalable + notificaciones) ---- */
  AR.swReady = ('serviceWorker' in navigator) ? navigator.serviceWorker.register('sw.js', { scope: './' }).then(() => navigator.serviceWorker.ready).catch(() => null) : Promise.resolve(null);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {}; if (d.tipo !== 'abrir') return;
    const mm = String(d.url || '').match(/#orden=(.+)$/);
    if (mm) { AR.abrir = decodeURIComponent(mm[1]); document.dispatchEvent(new Event('ar-abrir')) }
  });

  if (!sb) return;

  /* ---- datos: imita la API db (collection/doc/onSnapshot/set/update/delete) ---- */
  const snap = (rows, fromCache) => ({ docs: rows.map(r => ({ id: r.id, data: () => r.data || {} })), size: rows.length, metadata: { fromCache: !!fromCache } });
  function watch(table, filter, load) {
    let t = null; const kick = () => { clearTimeout(t); t = setTimeout(load, 300) };
    const opts = { event: '*', schema: 'public', table }; if (filter) opts.filter = filter;
    const ch = sb.channel('ar-' + table + '-' + Math.random().toString(36).slice(2)).on('postgres_changes', opts, kick).subscribe(st => { if (st === 'SUBSCRIBED') kick() });
    const vis = () => { if (document.visibilityState === 'visible') kick() };
    document.addEventListener('visibilitychange', vis); addEventListener('online', kick);
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load() }, 60000);
    return () => { clearTimeout(t); clearInterval(iv); document.removeEventListener('visibilitychange', vis); removeEventListener('online', kick); try { sb.removeChannel(ch) } catch (e) { } };
  }
  function docRef(table, id) {
    return {
      id,
      async set(d) { const { error } = await sb.from(table).upsert({ id, data: d, updated_at: new Date().toISOString() }); if (error) throw error },
      async update(p) { const { error } = await sb.rpc('merge_data', { t: table, rid: id, patch: p }); if (error) throw error },
      async delete() { const { error } = await sb.from(table).delete().eq('id', id); if (error) throw error },
      onSnapshot(cb, err) {
        const key = 'ar_c_' + table + '_' + id, c = LS.get(key, null);
        if (c) cb({ exists: true, id, data: () => c, metadata: { fromCache: true } });
        const load = async () => {
          let data, error;
          try { ({ data, error } = await sb.from(table).select('id,data').eq('id', id).maybeSingle()) } catch (x) { error = x }
          if (error) { err && err(error); return }
          LS.set(key, data ? data.data : null);
          cb({ exists: !!data, id, data: () => data ? data.data : undefined, metadata: { fromCache: false } });
        };
        load(); return watch(table, 'id=eq.' + id, load);
      }
    };
  }
  function collection(table) {
    let ord = null, lim = 500;
    const q = {
      orderBy(f, dir) { ord = { f, dir: dir || 'asc' }; return q },
      limit(n) { lim = n; return q },
      doc(id) { return docRef(table, id) },
      onSnapshot(cb, err) {
        const key = 'ar_c_' + table, c = LS.get(key, null); let last = null;
        if (c) cb(snap(c, true));
        const load = async () => {
          let data, error;
          try { ({ data, error } = await sb.from(table).select('id,data').order('created_at', { ascending: false }).limit(lim)) } catch (x) { error = x }
          if (error) { last = null; err && err(error); return }
          let rows = data || [];
          if (ord) { const s = ord.dir === 'desc' ? -1 : 1; rows = rows.slice().sort((a, b) => { const x = (a.data || {})[ord.f] ?? '', y = (b.data || {})[ord.f] ?? ''; return x < y ? -s : x > y ? s : 0 }) }
          const sig = JSON.stringify(rows); if (sig === last) return; last = sig;
          LS.set(key, rows); cb(snap(rows, false));
        };
        load(); return watch(table, null, load);
      }
    };
    return q;
  }
  const db = { collection, doc(path) { const [t, id] = path.split('/'); return docRef(t, id) } };
  AR.db = db;

  /* ---- sesión ---- */
  async function esEquipo() { try { const { data, error } = await sb.rpc('es_equipo'); if (error) return null; return data === true } catch (e) { return null } }
  function loginScreen(msg) {
    return new Promise(res => {
      document.getElementById('login')?.remove();
      const d = document.createElement('div'); d.id = 'login';
      d.innerHTML = `<form class="lg" autocomplete="on">
        <div class="brand" style="color:var(--fg)"><i>AR</i>AgroRuta<span class="tag">Equipo</span></div>
        <h2>Entrar</h2>
        <p class="muted">Usa el correo y la contraseña que les dio Hernán.</p>
        <label class="f">Correo<input type="email" name="email" id="lg-e" autocomplete="username" inputmode="email" required></label>
        <label class="f">Contraseña<input type="password" name="password" id="lg-p" autocomplete="current-password" required></label>
        <p class="err" id="lg-err" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>
        <button class="btn primary block" type="submit" id="lg-go">Entrar</button>
        <p class="muted small">La sesión se queda abierta en este aparato. Para salir: Ajustes → Cerrar sesión.</p></form>`;
      document.body.appendChild(d);
      const f = d.querySelector('form'), er = d.querySelector('#lg-err'), go = d.querySelector('#lg-go');
      setTimeout(() => d.querySelector('#lg-e').focus(), 50);
      f.onsubmit = async e => {
        e.preventDefault(); er.hidden = true; go.disabled = true; go.textContent = 'Entrando…';
        try {
          const { data, error } = await sb.auth.signInWithPassword({ email: d.querySelector('#lg-e').value.trim(), password: d.querySelector('#lg-p').value });
          if (error) throw error;
          const ok = await esEquipo();
          if (ok === false) { await sb.auth.signOut(); throw new Error('equipo') }
          d.remove(); res(data.session);
        } catch (x) {
          const t = String(x && x.message || '');
          er.textContent = t === 'equipo' ? 'Este correo no está dado de alta en el equipo. Hay que agregarlo en Supabase (tabla "equipo").'
            : /invalid/i.test(t) ? 'Correo o contraseña incorrectos.' : /fetch|network/i.test(t) ? 'Sin conexión. Revisa tu señal e intenta otra vez.' : 'No se pudo entrar: ' + t;
          er.hidden = false; go.disabled = false; go.textContent = 'Entrar';
        }
      };
    });
  }
  async function ready() {
    let { data: { session } } = await sb.auth.getSession(), msg = '';
    if (session) { const ok = await esEquipo(); if (ok === false) { await sb.auth.signOut(); session = null; msg = 'Este correo no está dado de alta en el equipo.' } }
    if (!session) session = await loginScreen(msg);
    AR.user = session.user;
    document.dispatchEvent(new Event('ar-login'));
    AR.push.refrescar();
    AR.push.estado().then(s => { AR.notifEstado = s; if (location.hash === '' || location.hash === '#tecnico') document.dispatchEvent(new Event('ar-estado')) }).catch(() => { });
    return db;
  }
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && AR.user) location.reload() });
  AR.logout = async () => { try { await AR.push.apagar(true) } catch (e) { } LS.clear('ar_c_'); AR.user = null; await sb.auth.signOut(); location.reload() };
  AR.email = () => (AR.user && AR.user.email) || '';
  window.claude = {
    use: async k => {
      if (k === 'db') return await (AR._ready || (AR._ready = ready()));
      if (k === 'user') return { can: async () => true };
      return null;
    }
  };

  /* ---- notificaciones ---- */
  const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)) };
  const swR = () => Promise.race([AR.swReady, new Promise(r => setTimeout(() => r(null), 4000))]);
  AR.push = {
    ios: () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    instalada: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    soporte: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    async estado() {
      if (!this.soporte()) return this.ios() && !this.instalada() ? 'ios-instalar' : 'no';
      if (Notification.permission === 'denied') return 'bloqueado';
      const r = await swR(); if (!r) return 'no';
      const s = await r.pushManager.getSubscription(); return s && Notification.permission === 'granted' ? 'activo' : 'apagado';
    },
    async guardar(s) { const j = s.toJSON(); const { error } = await sb.from('push_subs').upsert({ endpoint: j.endpoint, sub: j, user_id: AR.user && AR.user.id }); if (error) throw error },
    async activar() {
      const p = await Notification.requestPermission(); if (p !== 'granted') throw new Error('permiso');
      const r = await swR(); if (!r) throw new Error('sw');
      let s = await r.pushManager.getSubscription();
      if (!s) s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(C.vapid) });
      await this.guardar(s); return true;
    },
    async apagar(silencio) {
      const r = await swR(); if (!r) return; const s = await r.pushManager.getSubscription(); if (!s) return;
      try { await sb.from('push_subs').delete().eq('endpoint', s.endpoint) } catch (e) { if (!silencio) throw e }
      await s.unsubscribe();
    },
    async refrescar() { try { if (!this.soporte() || Notification.permission !== 'granted') return; const r = await swR(); const s = r && await r.pushManager.getSubscription(); if (s) await this.guardar(s) } catch (e) { } },
    async prueba() { const { data, error } = await sb.functions.invoke('notificar', { body: { tipo: 'prueba' } }); if (error) throw error; return data }
  };

  /* ---- fotos (bucket privado "fotos") ---- */
  const urlCache = {};
  AR.fotos = {
    async comprimir(file, max = 1600, q = 0.72) {
      let img;
      try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }) }
      catch (e) { img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file) }) }
      const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('foto')), 'image/jpeg', q));
    },
    async subir(carpeta, file, tipo) {
      const blob = await this.comprimir(file);
      const path = `${carpeta}/${Date.now()}-${tipo}.jpg`;
      const { error } = await sb.storage.from('fotos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error; return path;
    },
    async urls(paths) {
      const now = Date.now(), need = paths.filter(p => !urlCache[p] || urlCache[p].exp < now);
      if (need.length) {
        const { data, error } = await sb.storage.from('fotos').createSignedUrls(need, 3600);
        if (!error) (data || []).forEach(d => { if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, exp: now + 3300e3 } });
      }
      return Object.fromEntries(paths.map(p => [p, urlCache[p] ? urlCache[p].url : '']));
    },
    async archivo(path, nombre) { const { data, error } = await sb.storage.from('fotos').download(path); if (error) throw error; return new File([data], nombre || path.split('/').pop(), { type: 'image/jpeg' }) },
    async borrar(path) { const { error } = await sb.storage.from('fotos').remove([path]); if (error) throw error; delete urlCache[path] }
  };
})();
