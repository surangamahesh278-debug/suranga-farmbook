/*
 * FarmBook's small, dependency-free Supabase client and IndexedDB outbox.
 * No record is uploaded until a signed-in user reviews and confirms migration.
 */
(() => {
  'use strict';

  const cfg = window.FARMBOOK_SUPABASE_CONFIG || {};
  const DB_NAME = 'suranga-farmbook-sync-v1';
  const DB_VERSION = 2;
  const stores = ['meta', 'records', 'mirror', 'outbox', 'conflicts'];
  const AUTH_REDIRECT_URL = cfg.redirectUrl || 'https://surangamahesh278-debug.github.io/suranga-farmbook/';
  const $ = (id) => document.getElementById(id);
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const keyFor = (entity, id) => `${entity}:${id}`;
  let db, bridge, currentSession = null, currentSnapshot = null, previewSnapshot = null;
  let ready = false, syncBusy = false, syncTimer = 0, authInitBusy = false;
  let lastSnapshot = null, accountScope = '', remoteSnapshot = null, observeChain = Promise.resolve();

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        for (const name of stores) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'key' });
        const outbox = request.transaction.objectStore('outbox');
        if (!outbox.indexNames.contains('createdAt')) outbox.createIndex('createdAt', 'createdAt');
      };
      request.onblocked = () => setStatus('Sync storage upgrade is waiting for another FarmBook tab to close. Close the other tab; this upgrade will continue automatically. Your saved records are unchanged.', 'review');
      request.onsuccess = () => {
        const connection = request.result;
        connection.onversionchange = () => connection.close();
        resolve(connection);
      };
      request.onerror = () => reject(request.error || new Error('Could not open the local sync store.'));
    });
  }

  function idb(storeName, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      try { request = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || request?.error || new Error('Local sync storage failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local sync storage was interrupted.'));
    });
  }
  const get = (store, key) => idb(store, 'readonly', (s) => s.get(key));
  const put = (store, value) => idb(store, 'readwrite', (s) => s.put(value));
  const remove = (store, key) => idb(store, 'readwrite', (s) => s.delete(key));
  const all = (store) => idb(store, 'readonly', (s) => s.getAll());
  const getMeta = async (key, fallback = null) => (await get('meta', key))?.value ?? fallback;
  const setMeta = (key, value) => put('meta', { key, value });
  const randomId = () => crypto.randomUUID();

  function setStatus(message, mode = '') {
    const label = $('cloud-sync-status');
    if (label) { label.textContent = message; label.dataset.mode = mode; }
    const chip = $('connectivity-label');
    if (chip && mode === 'online') chip.textContent = 'Cloud synced';
    else if (chip && mode === 'offline') chip.textContent = 'Offline · changes queued';
  }

  function showAuthNotice(message, mode = 'review') {
    setStatus(message, mode);
    const toast = $('toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 6000);
    }
  }

  function configured() {
    return /^https:\/\//.test(cfg.url || '') && /^sb_publishable_/.test(cfg.publishableKey || '');
  }

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    if (!configured()) throw new Error('Cloud sync is not configured.');
    const headers = { apikey: cfg.publishableKey, 'Content-Type': 'application/json' };
    if (auth && currentSession?.access_token) headers.Authorization = `Bearer ${currentSession.access_token}`;
    const response = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!response.ok) {
      const message = value?.msg || value?.message || value?.error_description || value?.error || `Cloud request failed (${response.status}).`;
      const error = new Error(message); error.status = response.status; error.details = value;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    return value;
  }

  // The app uses its existing configured Auth REST helper instead of adding
  // a CDN/SDK dependency, while matching Supabase's auth.resend interface.
  const supabase = { auth: { resend: ({ type, email, options = {} }) => {
    if (type !== 'signup') throw new Error('Only signup confirmation resend is supported here.');
    const redirectTo = options.emailRedirectTo || AUTH_REDIRECT_URL;
    return api(`/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', auth: false, body: { type, email } });
  } } };

  function normalizeSession(value) {
    if (!value?.access_token || !value?.refresh_token) return null;
    return { access_token: value.access_token, refresh_token: value.refresh_token,
      expires_at: value.expires_at || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600),
      user: value.user || currentSession?.user || null };
  }

  async function saveSession(value) {
    currentSession = normalizeSession(value);
    if (currentSession) await setMeta('auth-session', currentSession);
    else await remove('meta', 'auth-session');
    accountScope = currentSession?.user?.id ? `${cfg.url}:${currentSession.user.id}` : '';
    paintAuth();
  }

  async function ensureSession() {
    if (!currentSession) throw new Error('Sign in to synchronize your FarmBook.');
    if (currentSession.expires_at > Math.floor(Date.now() / 1000) + 90) return currentSession;
    try {
      const refreshed = await api('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', auth: false, body: { refresh_token: currentSession.refresh_token }
      });
      await saveSession(refreshed);
      return currentSession;
    } catch (error) {
      if (error.status === 400 || error.status === 401) await saveSession(null);
      throw error;
    }
  }

  function stateHasRecords(state) {
    return !!(state && ((state.farms || []).length || (state.expenses || []).length || (state.incomes || []).length));
  }

  function rowsFor(state) {
    return [
      ...(state.farms || []).map((payload) => ({ entity: 'cultivation', id: String(payload.id), payload })),
      ...(state.expenses || []).map((payload) => ({ entity: 'expense', id: String(payload.id), payload })),
      ...(state.incomes || []).map((payload) => ({ entity: 'income', id: String(payload.id), payload })),
      { entity: 'settings', id: 'settings', payload: state.settings || {} }
    ];
  }

  function fromRows(rows, base = { farms: [], expenses: [], incomes: [], settings: { owner: 'Suranga', farmInfo: '' } }) {
    const result = { farms: [], expenses: [], incomes: [], settings: base.settings || { owner: 'Suranga', farmInfo: '' } };
    for (const row of rows) {
      if (row.entity === 'cultivation') result.farms.push(copy(row.payload));
      else if (row.entity === 'expense') result.expenses.push(copy(row.payload));
      else if (row.entity === 'income') result.incomes.push(copy(row.payload));
      else if (row.entity === 'settings') result.settings = copy(row.payload);
    }
    return result;
  }

  function eventRowsToMap(events) {
    const map = new Map();
    for (const event of events) {
      const key = keyFor(event.entity_type, event.record_id);
      if (event.is_deleted) map.delete(key);
      else map.set(key, { key, entity: event.entity_type, id: event.record_id,
        payload: event.payload, revision: Number(event.revision), sequence: Number(event.sequence_id) });
    }
    return map;
  }

  async function fetchRemoteSnapshot() {
    await ensureSession();
    let cursor = 0, events = [], pages = 0;
    while (pages++ < 200) {
      const page = await api('/rest/v1/rpc/farmbook_pull_changes', {
        method: 'POST', body: { p_after_sequence: cursor, p_limit: 500 }
      });
      const current = page?.events || [];
      events = events.concat(current);
      const next = Number(page?.cursor || cursor);
      if (!current.length || next <= cursor) break;
      cursor = next;
      if (current.length < 500) break;
    }
    return { events, cursor };
  }

  function countRows(state) {
    return { cultivations: (state.farms || []).length, expenses: (state.expenses || []).length,
      income: (state.incomes || []).length, settings: state.settings ? 1 : 0 };
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showMigrationPreview(local, remote, note = '') {
    previewSnapshot = copy(local);
    remoteSnapshot = copy(remote);
    const box = $('cloud-migration-preview');
    if (!box) return;
    const localCounts = countRows(local), cloudCounts = countRows(remote);
    const localRows = rowsFor(local);
    const remoteMap = eventRowsToMap(remote.events || []);
    const conflicts = localRows.filter((r) => {
      const existing = remoteMap.get(keyFor(r.entity, r.id));
      return existing && JSON.stringify(existing.payload) !== JSON.stringify(r.payload);
    });
    const list = localRows.map((r) => {
      const label = r.entity === 'cultivation' ? `${r.payload.cropOther || r.payload.crop || 'Cultivation'} — ${r.payload.batch || 'Season unspecified'}` :
        r.entity === 'expense' ? `${r.payload.date || ''} · ${r.payload.work || r.payload.description || 'Expense'} · Rs. ${Number(r.payload.total || 0).toFixed(2)}` :
        r.entity === 'income' ? `${r.payload.date || ''} · ${r.payload.description || 'Income'} · Rs. ${Number(r.payload.total || 0).toFixed(2)}` :
        `Owner: ${r.payload.owner || ''}; farm info: ${r.payload.farmInfo || ''}`;
      return `<li><b>${safeText(r.entity)}</b> <code>${safeText(r.id)}</code> — ${safeText(label)}</li>`;
    }).join('');
    const json = JSON.stringify(local, null, 2);
    box.innerHTML = `<div class="cloud-preview-warning"><b>Nothing has been uploaded.</b> Review the exact local snapshot below. Cloud changes will be merged by record ID; records with the same ID but different contents will be held as conflicts.</div>
      ${note ? `<p>${safeText(note)}</p>` : ''}
      <div class="cloud-preview-counts"><b>This device to review:</b> ${localCounts.cultivations} cultivations · ${localCounts.expenses} expenses · ${localCounts.income} income records<br><b>Already in cloud:</b> ${cloudCounts.cultivations} cultivations · ${cloudCounts.expenses} expenses · ${cloudCounts.income} income records<br><b>Same-ID records needing review:</b> ${conflicts.length}</div>
      <details><summary>Review every local record (${localRows.length})</summary><ul class="cloud-preview-list">${list || '<li>No local records in this snapshot.</li>'}</ul></details>
      <details><summary>Review the exact JSON snapshot</summary><pre class="cloud-preview-json"></pre></details>
      <button type="button" class="primary-btn" id="cloud-migration-confirm">Confirm this snapshot and begin sync</button>
      <button type="button" class="secondary-btn" id="cloud-migration-cancel">Cancel review</button>`;
    box.querySelector('.cloud-preview-json').textContent = json;
    box.classList.remove('hidden');
    $('cloud-migration-confirm').addEventListener('click', approveMigration);
    $('cloud-migration-cancel').addEventListener('click', () => { previewSnapshot = null; box.classList.add('hidden'); });
  }

  async function resolveInitialState(remote) {
    const marker = await getMeta(`approved:${accountScope}`, false);
    const local = bridge.getSnapshot();
    const hasCloud = (remote.events || []).length > 0;
    if (marker) {
      await hydrateRemote(remote);
      return true;
    }
    if (!stateHasRecords(local) && hasCloud) {
      await hydrateRemote(remote);
      await setMeta(`approved:${accountScope}`, true);
      return true;
    }
    if (!stateHasRecords(local) && !hasCloud) {
      await setMeta(`approved:${accountScope}`, true);
      setStatus('Signed in · ready for your first sync', 'online');
      return true;
    }
    showMigrationPreview(local, remote, 'This is a one-time review before enabling cloud sync on this device.');
    setStatus('Review local data before syncing', 'review');
    return false;
  }

  async function approveMigration() {
    if (!previewSnapshot || !currentSession) return;
    const confirmButton = $('cloud-migration-confirm');
    if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = 'Preparing safe merge…'; }
    try {
      const preview = previewSnapshot;
      const remote = await fetchRemoteSnapshot();
      if (remoteSnapshot && JSON.stringify(remote.events) !== JSON.stringify(remoteSnapshot.events)) {
        remoteSnapshot = remote;
        showMigrationPreview(preview, remote, 'Cloud records changed since the last preview. Review the refreshed preview before confirming.');
        setStatus('Cloud changed · review the refreshed migration preview', 'review');
        return;
      }
      remoteSnapshot = remote;
      const remoteMap = eventRowsToMap(remote.events || []);
      const localMap = new Map(rowsFor(bridge.getSnapshot()).map((r) => [keyFor(r.entity, r.id), r]));
      const selectedMap = new Map(rowsFor(preview).map((r) => [keyFor(r.entity, r.id), r]));
      const conflicts = [];

      // Backup JSON can be added to the preview without replacing live browser data.
      for (const [key, row] of selectedMap) {
        if (!localMap.has(key)) localMap.set(key, row);
        else if (JSON.stringify(localMap.get(key).payload) !== JSON.stringify(row.payload)) {
          conflicts.push({ key, entity: row.entity, id: row.id, local: localMap.get(key).payload, backup: row.payload, remote: null, revision: 0, reason: 'local_backup' });
        }
      }

      const merged = new Map(localMap);
      for (const [key, cloud] of remoteMap) {
        const local = merged.get(key);
        if (!local) merged.set(key, { entity: cloud.entity, id: cloud.id, payload: cloud.payload });
        else if (JSON.stringify(local.payload) !== JSON.stringify(cloud.payload)) {
          conflicts.push({ key, entity: cloud.entity, id: cloud.id, local: local.payload, remote: cloud.payload, revision: cloud.revision, reason: 'same_id' });
        }
      }

      for (const cloud of remoteMap.values()) await put('mirror', cloud);
      for (const conflict of conflicts) await put('conflicts', { ...conflict, key: conflict.key });
      const current = bridge.getSnapshot();
      const keep = new Map(rowsFor(current).map((r) => [keyFor(r.entity, r.id), r]));
      for (const [key, row] of merged) if (!keep.has(key)) keep.set(key, row);
      const mergedState = fromRows([...keep.values()], current);
      bridge.applySnapshot(mergedState, { fromSync: true });
      lastSnapshot = copy(mergedState);

      const remoteKeys = new Set(remoteMap.keys());
      for (const [key, row] of localMap) {
        if (remoteKeys.has(key) || conflicts.some((c) => c.key === key)) continue;
        await enqueue(row.entity, row.id, row.payload, false, 0);
      }
      await setMeta(`approved:${accountScope}`, true);
      previewSnapshot = null;
      $('cloud-migration-preview')?.classList.add('hidden');
      await paintConflicts();
      setStatus(conflicts.length ? `${conflicts.length} record conflict(s) need your choice` : 'Migration review approved · syncing', conflicts.length ? 'conflict' : 'pending');
      await persistCursor(remote.cursor || 0);
      await syncNow();
    } catch (error) {
      setStatus(`Could not prepare migration: ${error.message}`, 'error');
      if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = 'Confirm this snapshot and begin sync'; }
    }
  }

  async function enqueue(entity, id, payload, deleted, expectedRevision) {
    const pending = (await all('outbox')).filter((op) => op.entity === entity && op.record_id === id).sort((a, b) => a.createdAt - b.createdAt);
    const expected = pending.length ? pending[pending.length - 1].expected_revision + 1 : expectedRevision;
    const op = { key: randomId(), operation_id: randomId(), entity, record_id: id,
      expected_revision: expected, deleted: !!deleted, payload: copy(payload), createdAt: Date.now(), accountScope };
    await put('outbox', op);
    return op;
  }

  async function observeLocalSerial(snapshot, fromSync = false) {
    const next = copy(snapshot);
    await put('records', { key: 'current', value: next, savedAt: Date.now() });
    if (!lastSnapshot) { lastSnapshot = next; return; }
    if (fromSync) { lastSnapshot = next; return; }
    const before = new Map(rowsFor(lastSnapshot).map((r) => [keyFor(r.entity, r.id), r]));
    const after = new Map(rowsFor(next).map((r) => [keyFor(r.entity, r.id), r]));
    lastSnapshot = next;
    const approved = currentSession && await getMeta(`approved:${accountScope}`, false);
    if (!approved) return;
    for (const [key, row] of after) {
      const old = before.get(key);
      if (!old || JSON.stringify(old.payload) !== JSON.stringify(row.payload)) {
        const mirror = await get('mirror', key);
        await enqueue(row.entity, row.id, row.payload, false, mirror?.revision || 0);
      }
    }
    for (const [key, row] of before) if (!after.has(key)) {
      const mirror = await get('mirror', key);
      await enqueue(row.entity, row.id, row.payload, true, mirror?.revision || 0);
    }
    scheduleSync();
  }

  function observeLocal(snapshot, fromSync = false) {
    observeChain = observeChain.then(() => observeLocalSerial(snapshot, fromSync));
    return observeChain;
  }

  function persistCursor(value) { return setMeta(`cursor:${accountScope}`, Number(value) || 0); }

  async function hydrateRemote(remote) {
    const map = eventRowsToMap(remote.events || []);
    const local = bridge.getSnapshot();
    const conflicts = await all('conflicts');
    const blocked = new Set(conflicts.map((c) => c.key));
    const pending = await all('outbox');
    for (const op of pending) blocked.add(keyFor(op.entity, op.record_id));
    const localMap = new Map(rowsFor(local).map((r) => [keyFor(r.entity, r.id), r]));
    for (const [key, remoteRow] of map) {
      await put('mirror', remoteRow);
      if (blocked.has(key)) continue;
      localMap.set(key, { entity: remoteRow.entity, id: remoteRow.id, payload: remoteRow.payload });
    }
    const remoteKeys = new Set(map.keys());
    for (const row of remote.events || []) {
      const key = keyFor(row.entity_type, row.record_id);
      if (row.is_deleted && !blocked.has(key)) localMap.delete(key);
    }
    bridge.applySnapshot(fromRows([...localMap.values()], local), { fromSync: true });
    lastSnapshot = copy(bridge.getSnapshot());
    await persistCursor(remote.cursor || 0);
    setStatus('Cloud data loaded on this device', 'online');
  }

  async function pullChanges() {
    const cursor = Number(await getMeta(`cursor:${accountScope}`, 0));
    const page = await api('/rest/v1/rpc/farmbook_pull_changes', {
      method: 'POST', body: { p_after_sequence: cursor, p_limit: 500 }
    });
    const events = page?.events || [];
    if (!events.length) return 0;
    const ownOps = new Set((await all('outbox')).map((op) => op.operation_id));
    const local = bridge.getSnapshot();
    const rows = new Map(rowsFor(local).map((r) => [keyFor(r.entity, r.id), r]));
    const byKey = new Map();
    for (const event of events) {
      const key = keyFor(event.entity_type, event.record_id);
      const mirror = { key, entity: event.entity_type, id: event.record_id, payload: event.payload,
        revision: Number(event.revision), sequence: Number(event.sequence_id), deleted: !!event.is_deleted };
      await put('mirror', mirror);
      if (ownOps.has(event.operation_id)) {
        const own = (await all('outbox')).find((op) => op.operation_id === event.operation_id);
        if (own) await remove('outbox', own.key);
        continue;
      }
      byKey.set(key, { key, event, mirror });
    }
    const pending = await all('outbox');
    const pendingKeys = new Set(pending.map((op) => keyFor(op.entity, op.record_id)));
    for (const [key, { event, mirror }] of byKey) {
      if (pendingKeys.has(key)) {
        const ops = pending.filter((op) => keyFor(op.entity, op.record_id) === key);
        const localPayload = ops[ops.length - 1]?.payload || rows.get(key)?.payload;
        await put('conflicts', { key, entity: event.entity_type, id: event.record_id,
          local: localPayload, remote: event.payload, revision: Number(event.revision),
          deleted: !!event.is_deleted, reason: 'concurrent_edit' });
      } else if (mirror.deleted) rows.delete(key);
      else rows.set(key, { entity: mirror.entity, id: mirror.id, payload: mirror.payload });
    }
    bridge.applySnapshot(fromRows([...rows.values()], local), { fromSync: true });
    lastSnapshot = copy(bridge.getSnapshot());
    await persistCursor(page.cursor || events[events.length - 1].sequence_id);
    return events.length;
  }

  async function pushChanges() {
    const pending = (await all('outbox')).filter((op) => op.accountScope === accountScope).sort((a, b) => a.createdAt - b.createdAt);
    if (!pending.length) return 0;
    const conflicts = new Set((await all('conflicts')).map((c) => c.key));
    const batch = [];
    for (const op of pending) {
      if (conflicts.has(keyFor(op.entity, op.record_id))) continue;
      if (batch.length >= 100) break;
      batch.push({ operation_id: op.operation_id, entity: op.entity, record_id: op.record_id,
        expected_revision: op.expected_revision, deleted: op.deleted, payload: op.payload });
    }
    if (!batch.length) return 0;
    const result = await api('/rest/v1/rpc/farmbook_apply_batch', { method: 'POST', body: { p_operations: batch } });
    let applied = 0;
    for (const item of result?.results || []) {
      const op = pending.find((p) => p.operation_id === item.operation_id);
      if (!op) continue;
      const key = keyFor(op.entity, op.record_id);
      if (item.status === 'conflict') {
        await put('conflicts', { key, entity: op.entity, id: op.record_id, local: op.payload,
          remote: item.payload, revision: Number(item.revision || 0), deleted: !!item.deleted, reason: 'revision_mismatch' });
        continue;
      }
      if (item.status === 'applied' || item.status === 'already_applied') {
        await remove('outbox', op.key);
        await put('mirror', { key, entity: op.entity, id: op.record_id, payload: op.payload,
          revision: Number(item.revision), sequence: Number(item.sequence_id), deleted: op.deleted });
        applied++;
      }
    }
    return applied;
  }

  async function syncNow() {
    if (syncBusy || !currentSession || !navigator.onLine || !ready) return;
    if (!(await getMeta(`approved:${accountScope}`, false))) return;
    syncBusy = true;
    setStatus('Synchronizing…', 'pending');
    try {
      await ensureSession();
      await reconcileLocalAgainstMirror();
      await pullChanges();
      let loops = 0;
      while (loops++ < 20 && (await pushChanges()) > 0) await pullChanges();
      await paintConflicts();
      const pending = (await all('outbox')).filter((op) => op.accountScope === accountScope).length;
      const conflictCount = (await all('conflicts')).length;
      if (conflictCount) setStatus(`${conflictCount} change conflict(s) need your choice`, 'conflict');
      else if (pending) setStatus(`${pending} change(s) waiting to sync`, 'pending');
      else { setStatus(`Synced just now · ${new Date().toLocaleTimeString()}`, 'online'); await setMeta('last-synced', Date.now()); }
    } catch (error) {
      setStatus(navigator.onLine ? `Sync paused: ${error.message}` : 'Offline · changes are saved on this device', navigator.onLine ? 'error' : 'offline');
    } finally { syncBusy = false; }
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 800);
  }

  async function reconcileLocalAgainstMirror() {
    const local = new Map(rowsFor(bridge.getSnapshot()).map((row) => [keyFor(row.entity, row.id), row]));
    const mirrors = await all('mirror');
    const pending = await all('outbox');
    const pendingKeys = new Set(pending.filter((op) => op.accountScope === accountScope).map((op) => keyFor(op.entity, op.record_id)));
    const conflicts = new Set((await all('conflicts')).map((row) => row.key));
    const remote = new Map(mirrors.map((row) => [row.key, row]));
    for (const [key, row] of local) {
      const mirror = remote.get(key);
      if (pendingKeys.has(key) || conflicts.has(key)) continue;
      if (!mirror || mirror.deleted || JSON.stringify(row.payload) !== JSON.stringify(mirror.payload)) {
        await enqueue(row.entity, row.id, row.payload, false, mirror?.revision || 0);
      }
    }
    for (const [key, mirror] of remote) {
      if (local.has(key) || pendingKeys.has(key) || conflicts.has(key) || mirror.deleted) continue;
      await enqueue(mirror.entity, mirror.id, mirror.payload, true, mirror.revision || 0);
    }
  }

  async function paintConflicts() {
    const box = $('cloud-conflicts');
    if (!box) return;
    const conflicts = await all('conflicts');
    box.innerHTML = conflicts.length ? `<h4>Review changes made on different devices</h4>${conflicts.map((c) => `<article class="cloud-conflict"><b>${safeText(c.entity)} · ${safeText(c.id)}</b><p>This record changed in two places. Choose which version to keep; the other is not discarded until you choose.</p><button type="button" class="secondary-btn" data-conflict="cloud" data-key="${safeText(c.key)}">Keep cloud version</button><button type="button" class="primary-btn" data-conflict="local" data-key="${safeText(c.key)}">Keep this device's version</button></article>`).join('')}` : '';
    box.classList.toggle('hidden', !conflicts.length);
    box.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', () => resolveConflict(b.dataset.key, b.dataset.conflict)));
  }

  async function resolveConflict(key, choice) {
    const conflict = await get('conflicts', key);
    if (!conflict) return;
    const oldPending = (await all('outbox')).filter((op) => keyFor(op.entity, op.record_id) === key);
    for (const op of oldPending) await remove('outbox', op.key);
    const local = bridge.getSnapshot();
    const rows = new Map(rowsFor(local).map((r) => [keyFor(r.entity, r.id), r]));
    if (choice === 'cloud') {
      if (conflict.deleted) rows.delete(key);
      else rows.set(key, { entity: conflict.entity, id: conflict.id, payload: conflict.remote });
      await put('mirror', { key, entity: conflict.entity, id: conflict.id, payload: conflict.remote,
        revision: conflict.revision, deleted: !!conflict.deleted });
      bridge.applySnapshot(fromRows([...rows.values()], local), { fromSync: true });
      lastSnapshot = copy(bridge.getSnapshot());
    } else {
      const chosen = conflict.local;
      await enqueue(conflict.entity, conflict.id, chosen, false, Number(conflict.revision || 0));
    }
    await remove('conflicts', key);
    await paintConflicts();
    await syncNow();
  }

  async function login(email, password, signUp = false) {
    setStatus(signUp ? 'Creating account…' : 'Signing in…', 'pending');
    const path = signUp ? `/auth/v1/signup?redirect_to=${encodeURIComponent(AUTH_REDIRECT_URL)}` : '/auth/v1/token?grant_type=password';
    const result = await api(path, { method: 'POST', auth: false, body: { email, password } });
    const session = normalizeSession(result);
    if (session) {
      await saveSession(session);
      await beginAuthenticatedSession();
    } else if (signUp) setStatus('Check your email to confirm the account, then sign in.', 'review');
    else setStatus('Sign-in did not return a session. Check the email confirmation setting.', 'error');
  }

  function cleanAuthCallbackUrl() {
    // Auth credentials and errors are one-time URL parameters. Remove them
    // before rendering while keeping the current GitHub Pages project path.
    try { history.replaceState(null, '', `${location.origin}${location.pathname}`); } catch { /* URL cleanup is best-effort. */ }
  }

  function authCallbackParams() {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const params = new Map();
    for (const [key, value] of [...query, ...hash]) params.set(key, value);
    return params;
  }

  async function processAuthCallback() {
    const params = authCallbackParams();
    const hasAuthCallback = ['access_token', 'refresh_token', 'code', 'error', 'error_code', 'error_description']
      .some((key) => params.has(key));
    if (!hasAuthCallback) return false;
    cleanAuthCallbackUrl();

    const errorCode = params.get('error_code') || params.get('error');
    if (errorCode) {
      const detail = params.get('error_description') || params.get('msg') || 'The confirmation link could not be verified.';
      showAuthNotice(`Email confirmation failed (${errorCode}): ${detail} Request a fresh confirmation email and open it promptly.`, 'error');
      return true;
    }

    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      const message = params.has('code')
        ? 'The confirmation returned an authorization code that this REST-based sign-in cannot exchange. Request a new confirmation email after the app update.'
        : 'The confirmation link did not include a complete sign-in session. Request a new confirmation email.';
      showAuthNotice(message, 'error');
      return true;
    }

    try {
      const response = await fetch(`${cfg.url.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${accessToken}` }
      });
      const user = await response.json().catch(() => null);
      if (!response.ok || !user?.id) throw new Error(user?.msg || user?.message || 'Supabase could not verify the confirmed account.');
      const expiresIn = Number(params.get('expires_in') || 3600);
      await saveSession({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, user });
      showAuthNotice('Email confirmed. You are signed in; your FarmBook records on this device are unchanged.', 'online');
      return true;
    } catch (error) {
      await saveSession(null);
      showAuthNotice(`Email confirmation was received, but FarmBook could not establish the session: ${error.message}`, 'error');
      return true;
    }
  }

  async function beginAuthenticatedSession() {
    if (authInitBusy) return;
    authInitBusy = true;
    try {
    if (!currentSession?.user?.id) throw new Error('Supabase did not return a signed-in user.');
    await ensureSession();
    const remote = await fetchRemoteSnapshot();
    const approved = await resolveInitialState(remote);
    await paintConflicts();
    if (approved) await syncNow();
    } finally { authInitBusy = false; }
  }

  async function resumeSync() {
    if (!currentSession || !ready) return;
    if (await getMeta(`approved:${accountScope}`, false)) scheduleSync();
    else {
      try { await beginAuthenticatedSession(); }
      catch (error) { setStatus(`Sync setup paused: ${error.message}`, 'error'); }
    }
  }

  async function logout() {
    try { if (currentSession) await api('/auth/v1/logout', { method: 'POST' }); } catch { /* Local sign-out still works offline. */ }
    await saveSession(null);
    setStatus('Signed out · this device’s local data remains available', 'offline');
  }

  async function attach(appBridge) {
    bridge = appBridge;
    if (!configured()) { setStatus('Cloud sync is not configured', 'review'); return; }
    try {
      db = await openDb();
      const rawBackup = bridge.getLegacySnapshot?.() || {};
      if (!(await get('meta', 'legacy-localstorage-backup'))) {
        await put('meta', { key: 'legacy-localstorage-backup', value: { capturedAt: new Date().toISOString(), values: rawBackup } });
      }
      const stored = await get('records', 'current');
      const current = bridge.getSnapshot();
      if (stored?.value && !stateHasRecords(current) && stateHasRecords(stored.value)) {
        bridge.applySnapshot(stored.value, { fromSync: true });
      }
      lastSnapshot = copy(bridge.getSnapshot());
      ready = true;
      const callbackHandled = await processAuthCallback();
      const session = await getMeta('auth-session');
      if (session) {
        currentSession = normalizeSession(session);
        accountScope = currentSession?.user?.id ? `${cfg.url}:${currentSession.user.id}` : '';
        paintAuth();
        try { await beginAuthenticatedSession(); }
        catch (error) { setStatus(`Sign in again to sync: ${error.message}`, 'error'); }
      } else {
        if (!callbackHandled) setStatus(navigator.onLine ? 'Not signed in · records stay on this device' : 'Offline · records stay on this device', 'offline');
        paintAuth();
      }
    } catch (error) {
      setStatus(`Local sync storage unavailable: ${error.message}`, 'error');
    }
  }

  function paintAuth() {
    const signedIn = !!currentSession?.user;
    const form = $('cloud-login-form');
    if (form) form.classList.toggle('hidden', signedIn);
    $('cloud-signed-in')?.classList.toggle('hidden', !signedIn);
    const who = $('cloud-account-label');
    if (who) who.textContent = currentSession?.user?.email || 'Signed in';
  }

  async function previewBackupFile(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.farms) || !Array.isArray(parsed.expenses) || !Array.isArray(parsed.incomes))
        throw new Error('That file is not a Suranga FarmBook JSON backup.');
      const backup = { farms: parsed.farms, expenses: parsed.expenses, incomes: parsed.incomes,
        settings: parsed.settings || bridge.getSnapshot().settings };
      const local = bridge.getSnapshot();
      const localRows = new Map(rowsFor(local).map((r) => [keyFor(r.entity, r.id), r]));
      for (const row of rowsFor(backup)) {
        if (!localRows.has(keyFor(row.entity, row.id))) localRows.set(keyFor(row.entity, row.id), row);
      }
      previewSnapshot = fromRows([...localRows.values()], local);
      const remote = await fetchRemoteSnapshot();
      remoteSnapshot = remote;
      showMigrationPreview(previewSnapshot, remote, `Preview combines the selected backup with current device records by existing record ID. Current device values are retained for IDs that differ.`);
      $('cloud-migration-preview')?.classList.remove('hidden');
      setStatus('Backup preview ready · nothing uploaded or replaced', 'review');
    } catch (error) { setStatus(`Backup preview failed: ${error.message}`, 'error'); }
    finally { $('cloud-migration-file').value = ''; }
  }

  async function startPreview() {
    if (!currentSession) { setStatus('Sign in first to preview cloud migration.', 'review'); return; }
    try {
      const remote = await fetchRemoteSnapshot();
      remoteSnapshot = remote;
      showMigrationPreview(bridge.getSnapshot(), remote, 'Review the exact current device snapshot before any upload.');
      setStatus('Migration preview ready · nothing uploaded', 'review');
    } catch (error) { setStatus(`Could not load migration preview: ${error.message}`, 'error'); }
  }

  function wireUi() {
    $('cloud-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await login($('cloud-email').value.trim(), $('cloud-password').value); }
      catch (error) { setStatus(`Sign-in failed: ${error.message}`, 'error'); }
    });
    $('cloud-create-account')?.addEventListener('click', async () => {
      try { await login($('cloud-email').value.trim(), $('cloud-password').value, true); }
      catch (error) { setStatus(`Account setup failed: ${error.message}`, 'error'); }
    });
    $('cloud-resend-confirmation')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const emailInput = $('cloud-email');
      const email = emailInput.value.trim();
      if (!emailInput.checkValidity()) { emailInput.reportValidity(); return; }
      const cooldownKey = `farmbook-signup-resend-until:${email.toLowerCase()}`;
      const currentUntil = Number(sessionStorage.getItem(cooldownKey) || 0);
      if (currentUntil > Date.now()) {
        setStatus(`Please wait ${Math.ceil((currentUntil - Date.now()) / 1000)} seconds before requesting another confirmation email.`, 'review');
        return;
      }
      const cooldownUntil = Date.now() + 60_000;
      sessionStorage.setItem(cooldownKey, String(cooldownUntil));
      button.disabled = true;
      const originalText = button.textContent;
      const cooldownTimer = setInterval(() => {
        const remaining = Math.max(0, Number(sessionStorage.getItem(cooldownKey) || 0) - Date.now());
        if (remaining <= 0) { clearInterval(cooldownTimer); button.disabled = false; button.textContent = originalText; }
        else button.textContent = `Wait ${Math.ceil(remaining / 1000)}s to resend`;
      }, 1000);
      button.textContent = 'Requesting email…';
      try {
        await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: AUTH_REDIRECT_URL } });
        setStatus('If a signup confirmation is pending for this email, a new message has been requested. Check your inbox and spam folder.', 'review');
      } catch (error) {
        if (error.retryAfterMs > 60_000) sessionStorage.setItem(cooldownKey, String(Date.now() + error.retryAfterMs));
        if (error.status === 429) setStatus(`Supabase is limiting confirmation emails. Please wait before trying again. ${error.message}`, 'error');
        else setStatus(`Could not request a confirmation email: ${error.message}`, 'error');
      }
    });
    $('cloud-sync-now')?.addEventListener('click', syncNow);
    $('cloud-sign-out')?.addEventListener('click', logout);
    $('cloud-preview-migration')?.addEventListener('click', startPreview);
    $('cloud-migration-file')?.addEventListener('change', (e) => previewBackupFile(e.target.files?.[0]));
    window.addEventListener('online', () => { if (currentSession) resumeSync(); else setStatus('Online · sign in to sync', 'review'); });
    window.addEventListener('focus', resumeSync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeSync(); });
    setInterval(() => { if (!document.hidden) resumeSync(); }, 45000);
  }

  window.FarmBookCloudSync = {
    attach,
    onLocalSave(snapshot, options = {}) { if (ready) observeLocal(snapshot, !!options.fromSync).catch((e) => setStatus(`Local queue error: ${e.message}`, 'error')); },
    isConfigured: configured
  };
  wireUi();
})();
