const termEl = document.getElementById('terminal');
const queueBody = document.getElementById('queue-body');
const statusBadge = document.getElementById('connection-status');
const slotsStrip = document.getElementById('slots-strip');

function escapeHtml(s) {
    if (s == null || s === '') return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
}

function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;');
}

/** First case UUID in a Unite URL (`.../cases/open/{uuid}/...`). */
function uniteCaseIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/\/cases\/open\/([0-9a-f-]{36})\b/i);
    return m ? m[1] : null;
}

function requestCreatedRaw(req) {
    return req.createdAt ?? req.created_at ?? req['Created At'] ?? null;
}

function collectProofUrls(req) {
    const out = [];
    const seen = new Set();
    const add = (x) => {
        if (x == null || typeof x !== 'string' || !x.trim()) return;
        const t = x.trim();
        if (seen.has(t)) return;
        seen.add(t);
        out.push(t);
    };
    if (Array.isArray(req.proofURLs)) req.proofURLs.forEach(add);
    add(req.proofURL);
    return out;
}

/** Make queue proof link clickable when API returns a host-relative path (e.g. api/client-invoice-pdf?…). */
function resolveProofHref(u) {
    if (u == null || typeof u !== 'string') return '';
    const t = u.trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t) || t.startsWith('data:')) return normalizeCustomerApiUrl(t);
    const base = API_BASE_URL.replace(/\/$/, '');
    return t.startsWith('/') ? `${base}${t}` : `${base}/${t}`;
}

function formatCreatedCell(req) {
    const raw = requestCreatedRaw(req);
    if (raw == null || String(raw).trim() === '') {
        return '<span class="td-muted">—</span>';
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
        return `<span class="td-muted">${escapeHtml(String(raw))}</span>`;
    }
    const title = escapeHtmlAttr(d.toISOString());
    const shown = escapeHtml(
        d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    );
    return `<span class="col-created" title="${title}">${shown}</span>`;
}

function uniteCaseLinkCell(req) {
    const u = req.url;
    if (!u || typeof u !== 'string' || !u.trim()) {
        return '<span class="td-muted">—</span>';
    }
    const trimmed = u.trim();
    const caseId = uniteCaseIdFromUrl(trimmed);
    const label = caseId ? `${caseId.slice(0, 8)}…` : 'Open case';
    return `<a class="queue-link" href="${escapeHtmlAttr(trimmed)}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr(trimmed)}">${escapeHtml(label)}</a>`;
}

function proofLinksCell(req) {
    const urls = collectProofUrls(req);
    if (!urls.length) return '<span class="td-muted">—</span>';
    const parts = urls.map((u, i) => {
        const href = resolveProofHref(u);
        const isHttp = /^https?:\/\//i.test(href);
        const label = isHttp ? `Proof ${i + 1}` : href.startsWith('data:') ? 'Generated proof' : `Proof ${i + 1}`;
        return `<a class="queue-link" href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    });
    return `<span class="col-links">${parts.join('<span class="queue-link-sep"> · </span>')}</span>`;
}

let settingsUiLocked = false;

function setSettingsFormDisabled(locked) {
    settingsUiLocked = !!locked;
    const ids = [
        'setting-concurrent-browsers',
        'btn-show-browser',
        'btn-check-only',
        'btn-check-only-multi-debug',
        'btn-submit-invoice',
        'btn-upload-attestations',
        'btn-bill-invoices-endpoint',
        'btn-save-settings',
        'btn-open-source-files',
        'check-only-dates-input',
        'date-clamp-mode'
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = locked;
    });
}

function updateUploadAttestationsButtonUI(uploadOn) {
    const btn = document.getElementById('btn-upload-attestations');
    if (!btn) return;
    if (uploadOn) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Upload proofs: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Upload proofs: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

async function persistUploadAttestationsToggle(uploadOn) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadAttestations: uploadOn })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(uploadOn ? 'Proof upload enabled (saved to .env)' : 'Proof upload disabled (saved to .env)', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

function updateShowBrowserButtonUI(showBrowserVisible) {
    const btn = document.getElementById('btn-show-browser');
    if (!btn) return;
    if (showBrowserVisible) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Show browser: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Show browser: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function updateCheckOnlyButtonUI(checkOnlyOn) {
    const btn = document.getElementById('btn-check-only');
    if (!btn) return;
    if (checkOnlyOn) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Check-only: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Check-only: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function updateCheckOnlyMultiDateDebugUI(multiOn) {
    const btn = document.getElementById('btn-check-only-multi-debug');
    if (!btn) return;
    if (multiOn) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Multi-date check: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Multi-date check: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function updateSubmitInvoiceButtonUI(submitOn) {
    const btn = document.getElementById('btn-submit-invoice');
    if (!btn) return;
    if (submitOn) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Submit invoice: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Submit invoice: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function updateBillFromInvoicesButtonUI(on) {
    const btn = document.getElementById('btn-bill-invoices-endpoint');
    if (!btn) return;
    if (on) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Invoice as proof: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Invoice as proof: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function syncCheckOnlyDatesRowVisibility() {
    const row = document.getElementById('check-only-dates-row');
    if (!row) return;
    const checkOn = document.getElementById('btn-check-only')?.classList.contains('btn-toggle--on');
    const multiOn = document.getElementById('btn-check-only-multi-debug')?.classList.contains('btn-toggle--on');
    row.hidden = !(checkOn && multiOn);
}

async function persistCheckOnlyToggle(checkOnlyOn) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkOnlyMode: checkOnlyOn })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(checkOnlyOn ? 'Check-only mode enabled (saved to .env)' : 'Check-only mode disabled (saved to .env)', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistCheckOnlyMultiDateDebug(multiOn, datesStr) {
    try {
        const payload = { checkOnlyMultiDateDebug: multiOn };
        if (datesStr != null) payload.checkOnlyDebugDates = String(datesStr);
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(multiOn ? 'Multi-date check-only enabled (saved to .env)' : 'Multi-date check-only disabled (saved to .env)', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistSubmitInvoiceToggle(submitOn) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ submitInvoice: submitOn })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(
            submitOn ? 'Submit invoice enabled (saved to .env)' : 'Submit invoice disabled — test mode: click Continue bar in browser, no Post (saved to .env)',
            'success'
        );
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistBillFromInvoicesToggle(on) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ billFromInvoices: on })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(
            on
                ? 'Invoice as proof: queue from /api/bill/invoices; PDF proof on run (saved to .env)'
                : 'Invoice as proof off: queue from /api/bill (saved to .env)',
            'success'
        );
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistDateClampMode(value) {
    try {
        const v = value === 'client_created' ? 'client_created' : 'auth';
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dateClampMode: v })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(
            v === 'client_created'
                ? 'Date clamping: Client created mode (saved to .env)'
                : 'Date clamping: Auth window mode (saved to .env)',
            'success'
        );
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistCheckOnlyDebugDatesOnly(datesStr) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkOnlyDebugDates: String(datesStr ?? '') })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log('Check-only date list saved to .env', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistHeadlessFromShowBrowserButton() {
    const numEl = document.getElementById('setting-concurrent-browsers');
    const btn = document.getElementById('btn-show-browser');
    const concurrentBrowsers = parseInt(numEl && numEl.value, 10);
    const showOn = btn && btn.classList.contains('btn-toggle--on');
    const headless = !showOn;
    if (!Number.isFinite(concurrentBrowsers)) {
        log('Invalid browser slots value', 'error');
        return;
    }
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrentBrowsers, headless })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(showOn ? 'Browser window will show on next run (HEADLESS=false)' : 'Headless mode saved (HEADLESS=true)', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function loadSettings() {
    try {
        const r = await fetch('/api/settings');
        const s = await r.json();
        if (!r.ok) {
            log(`Settings load failed: ${s.error || r.status}`, 'error');
            return;
        }
        const num = document.getElementById('setting-concurrent-browsers');
        if (num) {
            if (s.minConcurrent != null) num.min = String(s.minConcurrent);
            if (s.maxConcurrent != null) num.max = String(s.maxConcurrent);
            num.value = String(s.concurrentBrowsers);
        }
        updateShowBrowserButtonUI(!s.headless);
        updateUploadAttestationsButtonUI(s.uploadAttestations !== false);
        updateCheckOnlyButtonUI(s.checkOnlyMode === true);
        updateCheckOnlyMultiDateDebugUI(s.checkOnlyMultiDateDebug === true);
        updateSubmitInvoiceButtonUI(s.submitInvoice !== false);
        updateBillFromInvoicesButtonUI(s.billFromInvoices !== false);
        const clampSel = document.getElementById('date-clamp-mode');
        if (clampSel) {
            const v = s.dateClampMode === 'client_created' ? 'client_created' : 'auth';
            clampSel.value = v;
        }
        const datesIn = document.getElementById('check-only-dates-input');
        if (datesIn) {
            datesIn.value = s.checkOnlyDebugDates != null ? String(s.checkOnlyDebugDates) : '';
        }
        syncCheckOnlyDatesRowVisibility();
        setSettingsFormDisabled(s.isRunning);
        const c = Math.max(0, parseInt(s.concurrentBrowsers, 10) || 0);
        if (c > 0) renderSlotBoxes(c);
    } catch (e) {
        log(`Settings load failed: ${e.message}`, 'error');
    }
}

async function saveSettings() {
    const numEl = document.getElementById('setting-concurrent-browsers');
    const btn = document.getElementById('btn-show-browser');
    const concurrentBrowsers = parseInt(numEl && numEl.value, 10);
    const headless = btn ? !btn.classList.contains('btn-toggle--on') : true;
    if (!Number.isFinite(concurrentBrowsers)) {
        log('Invalid browser slots value', 'error');
        return;
    }
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrentBrowsers, headless })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log('Settings saved to .env', 'success');
        renderSlotBoxes(d.concurrentBrowsers);
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function openEnvFolder() {
    try {
        const r = await fetch('/api/open-env-folder', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || 'Could not open folder', 'error');
            return;
        }
        log('Opened source files folder', 'success');
    } catch (e) {
        log(`Open folder failed: ${e.message}`, 'error');
    }
}

async function exportExcel() {
    try {
        const r = await fetch('/api/export-queue.xlsx');
        if (!r.ok) {
            let msg = `Export failed (${r.status})`;
            try {
                const err = await r.json();
                if (err.error) msg = err.error;
            } catch (_) { /* not JSON */ }
            log(msg, 'error');
            return;
        }
        const blob = await r.blob();
        const disp = r.headers.get('Content-Disposition') || '';
        let name = 'billing-queue.xlsx';
        const m = /filename="([^"]+)"/.exec(disp);
        if (m) name = m[1];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        log(`Downloaded ${name}`, 'success');
    } catch (e) {
        log(`Export failed: ${e.message}`, 'error');
    }
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== 'string') {
                reject(new Error('Could not read file'));
                return;
            }
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        };
        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}

async function importRemainingFromExcel(file) {
    if (!file) return;
    if (billingRunning) {
        log('Cannot import while billing is running.', 'error');
        return;
    }
    try {
        log(`Reading ${file.name}…`, 'info');
        const fileBase64 = await readFileAsBase64(file);
        const r = await fetch('/api/import-queue-from-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileBase64, onlyRemaining: true }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
            log(d.error || `Import failed (${r.status})`, 'error');
            if (Array.isArray(d.missing) && d.missing.length) {
                log(`Unmatched rows: ${d.missing.slice(0, 5).join(', ')}${d.missing.length > 5 ? '…' : ''}`, 'warning');
            }
            return;
        }
        requests = Array.isArray(d.queue) ? d.queue : requests;
        lastRequests = requests;
        selectedIds = new Set((d.selectedIds || []).map(String));
        if (selectedIds.size === 0 && Array.isArray(requests)) {
            requests.forEach((req) => selectedIds.add(requestIdForReq(req)));
        }
        renderQueue();
        updateSelectAllCheckbox();
        refreshSessionBanner();
        const counts = d.statusCounts
            ? Object.entries(d.statusCounts).map(([k, n]) => `${k}: ${n}`).join(', ')
            : '';
        log(
            d.message ||
                `Imported ${d.imported} client(s) from Excel${counts ? ` (${counts})` : ''}. Click Run billing for a clean run.`,
            'success'
        );
        if (Array.isArray(d.missing) && d.missing.length) {
            log(`${d.missing.length} Excel row(s) could not be matched and were skipped.`, 'warning');
        }
    } catch (e) {
        log(`Import failed: ${e.message}`, 'error');
    }
}

// Connect to SSE
const evtSource = new EventSource('/events');

let badgeTripleClicks = 0;
let badgeTripleTimer = null;
const BADGE_TRIPLE_WINDOW_MS = 700;

function toggleAdvancedSettingsBar() {
    const bar = document.getElementById('settings-bar');
    if (!bar) return;
    const hide = !bar.classList.contains('settings-bar--hidden');
    if (hide) {
        bar.classList.add('settings-bar--hidden');
        log('Advanced settings hidden. Triple-click Connected to show again.', 'info');
    } else {
        bar.classList.remove('settings-bar--hidden');
        log('Advanced settings shown. Triple-click Connected to hide.', 'info');
    }
}

function initConnectionBadgeTripleClick() {
    if (!statusBadge) return;
    statusBadge.addEventListener('click', () => {
        if (statusBadge.disabled || !statusBadge.classList.contains('badge--connected')) {
            return;
        }
        badgeTripleClicks += 1;
        clearTimeout(badgeTripleTimer);
        badgeTripleTimer = setTimeout(() => {
            badgeTripleClicks = 0;
        }, BADGE_TRIPLE_WINDOW_MS);
        if (badgeTripleClicks >= 3) {
            badgeTripleClicks = 0;
            clearTimeout(badgeTripleTimer);
            toggleAdvancedSettingsBar();
        }
    });
}

evtSource.onopen = () => {
    statusBadge.textContent = 'Connected';
    statusBadge.className = 'badge-status badge--connected';
    statusBadge.disabled = false;
    log('Connected to server.');
    refreshSessionBanner();
};

evtSource.onerror = () => {
    statusBadge.textContent = 'Disconnected';
    statusBadge.className = 'badge-status badge--disconnected';
    statusBadge.disabled = true;
};

// Handle Log Events
evtSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    log(data.message, data.type);
});

// Slot status: { slotIndex, slotLabel, clientName, stage }
let slotStates = [];

function stageToClass(stage) {
    if (!stage) return 'slot-stage--idle';
    const s = String(stage).trim().toLowerCase();
    if (s === 'idle') return 'slot-stage--idle';
    if (s === 'success') return 'slot-stage--success';
    if (s === 'skipped') return 'slot-stage--skipped';
    if (s === 'failed') return 'slot-stage--failed';
    if (s === 'billing' || s.includes('billing')) return 'slot-stage--billing';
    if (s === 'starting' || s === 'navigating' || s === 'login') return 'slot-stage--progress';
    return 'slot-stage--progress';
}

function renderSlotBoxes(count) {
    slotsStrip.innerHTML = '';
    slotStates = Array.from({ length: count }, () => ({ clientName: '', stage: 'Idle' }));
    for (let i = 0; i < count; i++) {
        const box = document.createElement('div');
        box.className = 'slot-box';
        box.setAttribute('data-slot-index', i);
        box.innerHTML = `
            <div class="slot-title">Slot ${i}</div>
            <div class="slot-client">—</div>
            <span class="slot-stage slot-stage--idle">Idle</span>
        `;
        slotsStrip.appendChild(box);
    }
}

function updateSlotStatus(slotIndex, clientName, stage) {
    if (slotIndex < 0 || slotIndex >= slotStates.length) return;
    slotStates[slotIndex] = { clientName: clientName || '', stage: stage || 'Idle' };
    const box = slotsStrip.querySelector(`[data-slot-index="${slotIndex}"]`);
    if (!box) return;
    const clientEl = box.querySelector('.slot-client');
    const stageEl = box.querySelector('.slot-stage');
    if (clientEl) clientEl.textContent = clientName || '—';
    if (stageEl) {
        stageEl.textContent = stage || 'Idle';
        stageEl.className = 'slot-stage ' + stageToClass(stage);
    }
}

evtSource.addEventListener('slotCount', (e) => {
    const data = JSON.parse(e.data);
    const count = Math.max(0, parseInt(data.count, 10) || 0);
    renderSlotBoxes(count);
});

evtSource.addEventListener('automationState', (e) => {
    const data = JSON.parse(e.data);
    billingRunning = !!data.isRunning;
    setSettingsFormDisabled(data.isRunning);
    const banner = document.getElementById('session-resume-banner');
    if (banner && data.isRunning) banner.style.display = 'none';
    if (!data.isRunning) refreshSessionBanner();
});

async function refreshSessionBanner() {
    const banner = document.getElementById('session-resume-banner');
    const textEl = document.getElementById('session-resume-text');
    if (!banner || !textEl) return;
    if (billingRunning) {
        banner.style.display = 'none';
        return;
    }
    try {
        const r = await fetch('/api/billing-session');
        const d = r.ok ? await r.json() : {};
        if (d.running) {
            banner.style.display = 'none';
            return;
        }
        const s = d && d.session;
        if (!s || !s.remaining) {
            banner.style.display = 'none';
            return;
        }
        const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : 'unknown time';
        textEl.textContent = `Saved billing session (not running): ${s.done} done, ${s.remaining} remaining (${s.total} total). Last saved ${updated}.`;
        banner.style.display = '';
    } catch (_) {
        banner.style.display = 'none';
    }
}

function applySelectionFromSession(ids) {
    selectedIds = new Set((ids || []).map(String));
    applyUnselectedPendingAsSkipped();
    renderQueue();
    updateSelectAllCheckbox();
    updateStats(lastRequests);
}

function loadBillingSession() {
    log('Loading saved billing session…', 'info');
    fetch('/load-billing-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
            if (!ok || d.error) throw new Error(d.error || 'Load failed');
            if (Array.isArray(d.selectedIds)) applySelectionFromSession(d.selectedIds);
            log(d.message || `Loaded session (${d.count || 0} clients).`, 'success');
            refreshSessionBanner();
        })
        .catch((e) => log(`Load session failed: ${e.message}`, 'error'));
}

function resumeBillingSession() {
    log('Resuming saved billing session…', 'info');
    const account = getSelectedAccount();
    const attBtn = document.getElementById('btn-upload-attestations');
    const uploadAttestations = attBtn ? attBtn.classList.contains('btn-toggle--on') : true;
    const checkBtn = document.getElementById('btn-check-only');
    const checkOnlyMode = checkBtn ? checkBtn.classList.contains('btn-toggle--on') : false;
    fetch('/process-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'resume', apiKey: '', account, uploadAttestations, checkOnlyMode }),
    })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
            if (!ok || d.error) throw new Error(d.error || 'Resume failed');
            log(d.message || 'Resume started.', 'success');
        })
        .catch((e) => log(`Resume failed: ${e.message}`, 'error'));
}

function dismissBillingSession() {
    fetch('/clear-billing-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            log(d.message || 'Saved session dismissed.', 'info');
            refreshSessionBanner();
        })
        .catch((e) => log(`Dismiss session failed: ${e.message}`, 'error'));
}

evtSource.addEventListener('slotStatus', (e) => {
    const data = JSON.parse(e.data);
    updateSlotStatus(data.slotIndex, data.clientName, data.stage);
});

let lastRequests = [];
/** True while billing automation is running (hides stale session banner). */
let billingRunning = false;
/** While true, table shows placeholder rows (client list download in flight). */
let queueDownloadLoading = false;
/** Snapshot before a download; restored if the request fails (no SSE update). */
let requestsSnapshotBeforeDownload = [];
const QUEUE_SKELETON_ROW_COUNT = 10;
let sortDir = {}; // track direction for each field
let selectedIds = new Set(); // which clients are selected to run (stable id per request)
let queueStatusFilter = 'all';
/** Substring filter for client queue (name, ids, dates, etc.) */
let queueClientSearch = '';
/** Index in getFilteredQueue() for shift-click range selection; -1 = none */
let queueAnchorVisibleIndex = -1;

function requestIdForReq(req) {
    const i = lastRequests.indexOf(req);
    if (i < 0) {
        return req.id != null ? String(req.id) : (req.orderID != null ? String(req.orderID) : 'unknown');
    }
    return requestId(req, i);
}

function findReqById(id) {
    return lastRequests.find((r) => requestIdForReq(r) === id);
}

/** Unchecked rows are excluded from the run — mark still-pending ones as skipped for stats/UI. */
function syncStatusWithSelection(req, selected) {
    if (!req) return;
    if (selected) {
        if (req.status === 'skipped' && req.message === 'Not selected') {
            req.status = 'pending';
            req.message = '';
        }
    } else if (!req.status || req.status === 'pending') {
        req.status = 'skipped';
        req.message = 'Not selected';
    }
}

function setRowSelected(id, selected, req) {
    if (selected) selectedIds.add(id);
    else selectedIds.delete(id);
    syncStatusWithSelection(req || findReqById(id), selected);
}

function applyUnselectedPendingAsSkipped() {
    if (!Array.isArray(lastRequests)) return;
    lastRequests.forEach((req) => {
        if (!selectedIds.has(requestIdForReq(req))) syncStatusWithSelection(req, false);
    });
}

function normalizedRowStatus(req) {
    return String(req.status || 'pending').toLowerCase();
}

function rowSearchHaystack(req) {
    const parts = [
        req.name,
        req.id,
        req.orderID,
        req.clientId,
        req.date,
        req.start,
        req.end,
        req.endDate,
        req.createdAt,
        req.created_at,
        req['Created At'],
        req.url,
        collectProofUrls(req).join(' '),
        uniteCaseIdFromUrl(req.url),
        req.status,
        req.checkOnlyInvoiceAmounts,
        req.message,
        Array.isArray(req.orderNumbers) ? req.orderNumbers.join(' ') : ''
    ];
    return parts
        .filter((p) => p != null && String(p).trim() !== '')
        .map((p) => String(p).toLowerCase())
        .join(' ');
}

function getFilteredQueue() {
    let list = queueStatusFilter === 'all'
        ? lastRequests.slice()
        : lastRequests.filter((r) => normalizedRowStatus(r) === queueStatusFilter);
    const q = queueClientSearch.trim().toLowerCase();
    if (q) {
        list = list.filter((r) => rowSearchHaystack(r).includes(q));
    }
    return list;
}

// Drag-to-select over checkboxes
let dragSelectActive = false;
let dragSelectValue = false; // true = selecting, false = deselecting
let dragSelectLastRow = null;

// Handle Queue Updates (Full Refresh) — keep selection by id
evtSource.addEventListener('queue', (e) => {
    const next = JSON.parse(e.data);
    lastRequests = next;
    queueDownloadLoading = false;
    queueAnchorVisibleIndex = -1;
    renderQueue();
    updateStats(lastRequests);
    updateSelectAllCheckbox();
});

function sortQueue(field) {
    if (!lastRequests.length) return;
    queueAnchorVisibleIndex = -1;

    // Toggle direction
    sortDir[field] = sortDir[field] === 'asc' ? 'desc' : 'asc';
    const dir = sortDir[field] === 'asc' ? 1 : -1;

    lastRequests.sort((a, b) => {
        if (field === 'created') {
            const ta = new Date(requestCreatedRaw(a) || 0).getTime();
            const tb = new Date(requestCreatedRaw(b) || 0).getTime();
            const na = Number.isNaN(ta) ? 0 : ta;
            const nb = Number.isNaN(tb) ? 0 : tb;
            if (na < nb) return -1 * dir;
            if (na > nb) return 1 * dir;
            return 0;
        }

        if (field === 'proofs') {
            const ua = collectProofUrls(a);
            const ub = collectProofUrls(b);
            const na = ua.length;
            const nb = ub.length;
            if (na !== nb) return na < nb ? -1 * dir : 1 * dir;
            const sa = (ua[0] || '').toLowerCase();
            const sb = (ub[0] || '').toLowerCase();
            if (sa < sb) return -1 * dir;
            if (sa > sb) return 1 * dir;
            return 0;
        }

        let valA =
            field === 'start'
                ? (a.start || a.date || '')
                : field === 'url'
                  ? (a.url || '')
                  : (a[field] || '');
        let valB =
            field === 'start'
                ? (b.start || b.date || '')
                : field === 'url'
                  ? (b.url || '')
                  : (b[field] || '');

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
    });

    renderQueue();
}

/** Always customer host; Brooklyn vs Main is only ?account= on the API request. */
const API_BASE_URL = 'https://customer.thedietfantasy.com';

/** Rewrite legacy Diet Fantasy hosts in API-returned URLs (brooklyn/monsey → customer). */
function normalizeCustomerApiUrl(urlStr) {
    if (urlStr == null || typeof urlStr !== 'string') return urlStr;
    const t = urlStr.trim();
    if (!t || !/thedietfantasy\.com/i.test(t)) return urlStr;
    return t.replace(/https?:\/\/(?:brooklyn|monsey)\.thedietfantasy\.com/gi, API_BASE_URL);
}

/** Maps Account dropdown to ?account= for /api/bill and /api/bill/invoices (Main = regular). */
function billAccountFromServerSelect(sel) {
    const v = (sel && sel.value) || 'main';
    return v === 'brooklyn' ? 'brooklyn' : 'regular';
}

function billAccountLabel(account) {
    return account === 'brooklyn' ? 'Brooklyn' : 'Diet Fantasy (Main)';
}

function getSelectedAccount() {
    const sel = document.getElementById('serverSelect');
    return billAccountFromServerSelect(sel);
}

/** Return YYYY-MM-DD for the last Monday (including today if today is Monday). */
function getLastMondayISO() {
    const d = new Date();
    const day = d.getDay(); // 0 Sun .. 6 Sat
    const daysBack = (day + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
    d.setDate(d.getDate() - daysBack);
    return d.toISOString().slice(0, 10);
}

function initBillDate() {
    const el = document.getElementById('bill-date');
    if (el && !el.value) el.value = getLastMondayISO();
}

function getBillDate() {
    const el = document.getElementById('bill-date');
    return (el && el.value) ? el.value : getLastMondayISO();
}

function downloadAllClients() {
    if (queueDownloadLoading) {
        log('Client list is already loading…', 'info');
        return;
    }
    const date = getBillDate();
    const account = getSelectedAccount();
    const label = billAccountLabel(account);
    log(`Fetching ${label} client list for week starting ${date}…`, 'info');

    requestsSnapshotBeforeDownload = lastRequests.slice();
    queueDownloadLoading = true;
    lastRequests = [];
    queueAnchorVisibleIndex = -1;
    renderQueue();
    updateStats([]);
    updateSelectAllCheckbox();

    fetch('/fetch-all-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, account })
    })
        .then(r => r.json())
        .then(d => {
            if (d.error) {
                log(`Fetch Error: ${d.error}`, 'error');
                if (queueDownloadLoading) {
                    queueDownloadLoading = false;
                    lastRequests = requestsSnapshotBeforeDownload.slice();
                    renderQueue();
                    updateStats(lastRequests);
                    updateSelectAllCheckbox();
                }
            } else {
                log(d.message || `Loaded ${d.count} ${label} clients.`, 'success');
            }
        })
        .catch(e => {
            log(`Fetch Failed: ${e.message}`, 'error');
            if (queueDownloadLoading) {
                queueDownloadLoading = false;
                lastRequests = requestsSnapshotBeforeDownload.slice();
                renderQueue();
                updateStats(lastRequests);
                updateSelectAllCheckbox();
            }
        });
}

function countSelectedNeedsProcessing(requests) {
    return (requests || []).filter((r) => {
        if (!selectedIds.has(requestIdForReq(r))) return false;
        if (!r || r.skip) return false;
        const st = r.status || 'pending';
        return st === 'pending' || st === 'processing' || st === 'failed' || st === 'stopped';
    }).length;
}

function runCurrentQueue() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
        log('No clients selected. Check the clients you want to run.', 'warning');
        return;
    }
    const waiting = countSelectedNeedsProcessing(lastRequests);
    if (waiting === 0) {
        log('No selected clients waiting to process.', 'warning');
        return;
    }
    log(`Starting automation for ${waiting} selected client(s)...`, 'info');

    const attBtn = document.getElementById('btn-upload-attestations');
    const uploadAttestations = attBtn ? attBtn.classList.contains('btn-toggle--on') : true;
    const checkBtn = document.getElementById('btn-check-only');
    const checkOnlyMode = checkBtn ? checkBtn.classList.contains('btn-toggle--on') : false;
    const multiBtn = document.getElementById('btn-check-only-multi-debug');
    const multiDateOn = multiBtn ? multiBtn.classList.contains('btn-toggle--on') : false;
    const datesInput = document.getElementById('check-only-dates-input');
    const datesStr = datesInput && datesInput.value ? datesInput.value.trim() : '';
    const submitBtn = document.getElementById('btn-submit-invoice');
    const submitInvoice = submitBtn ? submitBtn.classList.contains('btn-toggle--on') : true;
    const clampSel = document.getElementById('date-clamp-mode');
    const dateClampMode =
        clampSel && clampSel.value === 'client_created' ? 'client_created' : 'auth';
    const account = getSelectedAccount();
    const body = { source: 'queue', apiKey: '', account, uploadAttestations, checkOnlyMode, submitInvoice, dateClampMode };
    if (checkOnlyMode && multiDateOn && datesStr) {
        body.checkOnlyDebugDates = datesStr;
    }
    body.selectedIds = ids;

    fetch('/process-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(r => {
            if (!r.ok) {
                return r.json().then(data => {
                    throw new Error(data.error || `HTTP ${r.status}`);
                });
            }
            return r.json();
        })
        .then(d => {
            log(d.message || 'Run started.', 'success');
        })
        .catch(e => {
            log(`Error: ${e.message}`, 'error');
        });
}

function log(msg, type = 'info') {
    const div = document.createElement('div');
    div.className = `line ${type}`;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    termEl.appendChild(div);
    termEl.scrollTop = termEl.scrollHeight;
}

function requestId(req, idx) {
    return req.id != null ? String(req.id) : (req.orderID != null ? String(req.orderID) : `row-${idx}`);
}

function updateSelectAllCheckbox() {
    const all = document.getElementById('queue-select-all');
    if (!all) return;
    const visible = getFilteredQueue();
    const n = visible.length;
    if (n === 0) {
        all.checked = false;
        all.indeterminate = false;
        return;
    }
    let selectedVisible = 0;
    for (const req of visible) {
        if (selectedIds.has(requestIdForReq(req))) selectedVisible += 1;
    }
    all.checked = selectedVisible === n;
    all.indeterminate = selectedVisible > 0 && selectedVisible < n;
}

function onSelectAllChange(checked) {
    const visible = getFilteredQueue();
    visible.forEach((req) => setRowSelected(requestIdForReq(req), checked, req));
    renderQueue();
    updateSelectAllCheckbox();
    updateStats(lastRequests);
}

function setupDragSelect() {
    queueBody.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.col-check');
        const row = e.target.closest('tbody tr');
        if (!cell || !row) return;
        const checkbox = row.querySelector('.queue-row-check');
        if (!checkbox) return;
        dragSelectActive = true;
        dragSelectValue = !checkbox.checked;
        dragSelectLastRow = row;
        const id = row.getAttribute('data-row-id');
        if (id) setRowSelected(id, dragSelectValue, findReqById(id));
        renderQueue();
        updateSelectAllCheckbox();
        updateStats(lastRequests);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragSelectActive) return;
        const row = e.target.closest('tbody#queue-body tr');
        if (!row || row.closest('tbody') !== queueBody) return;
        if (row === dragSelectLastRow) return;
        dragSelectLastRow = row;
        const id = row.getAttribute('data-row-id');
        if (id) setRowSelected(id, dragSelectValue, findReqById(id));
        renderQueue();
        updateSelectAllCheckbox();
        updateStats(lastRequests);
    });

    document.addEventListener('mouseup', () => {
        dragSelectActive = false;
        dragSelectLastRow = null;
    });
}

function setupQueueRowInteractions() {
    queueBody.addEventListener('click', (e) => {
        const cell = e.target.closest('.queue-client-cell');
        if (!cell) return;
        const tr = cell.closest('tr');
        if (!tr) return;
        const id = tr.getAttribute('data-row-id');
        if (!id) return;
        const visibleIdx = parseInt(tr.getAttribute('data-visible-index'), 10);
        const visible = getFilteredQueue();

        if (
            e.shiftKey &&
            queueAnchorVisibleIndex >= 0 &&
            Number.isFinite(visibleIdx) &&
            queueAnchorVisibleIndex < visible.length &&
            visibleIdx < visible.length
        ) {
            const from = Math.min(queueAnchorVisibleIndex, visibleIdx);
            const to = Math.max(queueAnchorVisibleIndex, visibleIdx);
            for (let i = from; i <= to; i++) {
                setRowSelected(requestIdForReq(visible[i]), true, visible[i]);
            }
            queueAnchorVisibleIndex = visibleIdx;
        } else {
            const req = findReqById(id);
            const nextSelected = !selectedIds.has(id);
            setRowSelected(id, nextSelected, req);
            queueAnchorVisibleIndex = Number.isFinite(visibleIdx) ? visibleIdx : -1;
        }
        renderQueue();
        updateSelectAllCheckbox();
        updateStats(lastRequests);
    });
    queueBody.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const cell = e.target.closest('.queue-client-cell');
        if (!cell) return;
        e.preventDefault();
        const id = cell.closest('tr') && cell.closest('tr').getAttribute('data-row-id');
        if (!id) return;
        const req = findReqById(id);
        const nextSelected = !selectedIds.has(id);
        setRowSelected(id, nextSelected, req);
        renderQueue();
        updateSelectAllCheckbox();
        updateStats(lastRequests);
    });
}

function skeletonBar(widthPct) {
    return `<span class="skeleton-block" style="width:${widthPct}%"></span>`;
}

function renderQueueSkeleton() {
    queueBody.setAttribute('aria-busy', 'true');
    queueBody.innerHTML = '';
    const allCb = document.getElementById('queue-select-all');
    if (allCb) {
        allCb.checked = false;
        allCb.indeterminate = false;
        allCb.disabled = true;
    }
    const widths = [
        [35, 42, 55, 48, 38, 32, 28, 40, 36, 50],
        [40, 55, 48, 62, 44, 36, 34, 42, 40, 45],
        [32, 48, 52, 55, 40, 30, 36, 38, 38, 55],
        [45, 38, 58, 50, 42, 34, 32, 44, 42, 48],
        [38, 52, 45, 58, 36, 38, 30, 40, 36, 52],
        [42, 44, 50, 52, 40, 32, 36, 42, 40, 46],
        [36, 50, 46, 54, 38, 36, 34, 40, 38, 50],
        [44, 40, 54, 48, 42, 30, 32, 42, 44, 48],
        [40, 46, 48, 56, 40, 34, 36, 44, 40, 52],
        [38, 54, 52, 50, 44, 32, 28, 38, 36, 46]
    ];
    for (let i = 0; i < QUEUE_SKELETON_ROW_COUNT; i++) {
        const w = widths[i % widths.length];
        const tr = document.createElement('tr');
        tr.className = 'queue-row-skeleton';
        tr.setAttribute('aria-hidden', 'true');
        tr.style.setProperty('--sk-row-delay', `${i * 0.06}s`);
        tr.innerHTML = `
            <td class="col-check"><span class="skeleton-block skeleton-block--tiny"></span></td>
            <td>${skeletonBar(w[0])}</td>
            <td>${skeletonBar(w[1])}</td>
            <td>${skeletonBar(w[2])}</td>
            <td>${skeletonBar(w[3])}</td>
            <td>${skeletonBar(w[4])}</td>
            <td>${skeletonBar(w[5])}</td>
            <td>${skeletonBar(w[6])}</td>
            <td>${skeletonBar(w[7])}</td>
            <td>${skeletonBar(w[8])}</td>
            <td>${skeletonBar(w[9])}</td>
        `;
        queueBody.appendChild(tr);
    }
}

function renderQueue() {
    if (queueDownloadLoading) {
        renderQueueSkeleton();
        return;
    }

    queueBody.removeAttribute('aria-busy');
    const visible = getFilteredQueue();
    queueBody.innerHTML = '';
    const allCbHead = document.getElementById('queue-select-all');
    if (allCbHead) allCbHead.disabled = false;

    visible.forEach((req, visibleIdx) => {
        const id = requestIdForReq(req);
        const tr = document.createElement('tr');
        tr.setAttribute('data-row-id', id);
        tr.setAttribute('data-visible-index', String(visibleIdx));

        const globalIdx = lastRequests.indexOf(req);
        const rowNum = globalIdx >= 0 ? globalIdx + 1 : '—';

        let statusClass = 'status-pending';
        if (req.status === 'processing') statusClass = 'status-processing';
        if (req.status === 'success') statusClass = 'status-success';
        if (req.status === 'failed') statusClass = 'status-failed';
        if (req.status === 'skipped') statusClass = 'status-skipped';
        if (req.status === 'warning') statusClass = 'status-warning';

        const checked = selectedIds.has(id) ? ' checked' : '';
        if (selectedIds.has(id)) tr.classList.add('row-selected');
        tr.innerHTML = `
            <td class="col-check"><input type="checkbox" class="queue-row-check"${checked}></td>
            <td>${rowNum} <span class="td-muted">(${escapeHtml(String(req.orderID || req.id || '—'))})</span></td>
            <td class="queue-client-cell" tabindex="0" title="Click to toggle. Shift+click another row to select everyone in between.">${escapeHtml(req.name || '')}</td>
            <td>${escapeHtml(req.start ? `${req.start} → ${req.end}` : req.date || '—')}</td>
            <td class="col-created">${formatCreatedCell(req)}</td>
            <td class="col-links">${uniteCaseLinkCell(req)}</td>
            <td class="col-links">${proofLinksCell(req)}</td>
            <td><span class="status-badge ${statusClass}">${escapeHtml(req.status || 'pending')}</span></td>
            <td class="td-muted col-invoice-cost">${escapeHtml(req.checkOnlyInvoiceAmounts != null && String(req.checkOnlyInvoiceAmounts).trim() !== '' ? req.checkOnlyInvoiceAmounts : '—')}</td>
            <td class="td-muted">${escapeHtml(req.message || '—')}</td>
        `;
        const cb = tr.querySelector('.queue-row-check');
        if (cb) cb.setAttribute('data-id', id);
        queueBody.appendChild(tr);
    });
    queueBody.querySelectorAll('.queue-row-check').forEach((cb) => {
        cb.addEventListener('change', function () {
            const rid = this.getAttribute('data-id');
            setRowSelected(rid, this.checked, findReqById(rid));
            const tr = this.closest('tr');
            tr?.classList.toggle('row-selected', selectedIds.has(rid));
            const v = tr && parseInt(tr.getAttribute('data-visible-index'), 10);
            if (Number.isFinite(v)) queueAnchorVisibleIndex = v;
            renderQueue();
            updateSelectAllCheckbox();
            updateStats(lastRequests);
        });
    });
    const allCb = document.getElementById('queue-select-all');
    if (allCb && !allCb.onSelectAllBound) {
        allCb.onSelectAllBound = true;
        allCb.addEventListener('change', function () {
            onSelectAllChange(this.checked);
        });
    }
}

function updateStats(requests) {
    document.getElementById('stat-total').textContent = requests.length;
    document.getElementById('stat-pending').textContent = requests.filter(r => !r.status || r.status === 'pending').length;
    document.getElementById('stat-success').textContent = requests.filter(r => r.status === 'success').length;
    document.getElementById('stat-failed').textContent = requests.filter(r => r.status === 'failed').length;
}

initBillDate();
setupDragSelect();
setupQueueRowInteractions();

(function initQueueStatusFilter() {
    const sel = document.getElementById('queue-status-filter');
    if (!sel) return;
    sel.addEventListener('change', () => {
        queueStatusFilter = sel.value || 'all';
        queueAnchorVisibleIndex = -1;
        renderQueue();
        updateSelectAllCheckbox();
    });
})();

(function initQueueClientSearch() {
    const input = document.getElementById('queue-client-search');
    if (!input) return;
    input.addEventListener('input', () => {
        queueClientSearch = input.value || '';
        queueAnchorVisibleIndex = -1;
        renderQueue();
        updateSelectAllCheckbox();
    });
})();

(function initSettingsBar() {
    const saveBtn = document.getElementById('btn-save-settings');
    const openBtn = document.getElementById('btn-open-source-files');
    const showBtn = document.getElementById('btn-show-browser');
    const checkBtn = document.getElementById('btn-check-only');
    const multiDebugBtn = document.getElementById('btn-check-only-multi-debug');
    const submitInvoiceBtn = document.getElementById('btn-submit-invoice');
    const billInvoicesBtn = document.getElementById('btn-bill-invoices-endpoint');
    const datesInputEl = document.getElementById('check-only-dates-input');
    const attestBtn = document.getElementById('btn-upload-attestations');
    const exportBtn = document.getElementById('btn-export-excel');
    if (saveBtn) saveBtn.addEventListener('click', () => saveSettings());
    if (openBtn) openBtn.addEventListener('click', () => openEnvFolder());
    if (showBtn) {
        showBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !showBtn.classList.contains('btn-toggle--on');
            updateShowBrowserButtonUI(next);
            await persistHeadlessFromShowBrowserButton();
        });
    }
    if (checkBtn) {
        checkBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !checkBtn.classList.contains('btn-toggle--on');
            updateCheckOnlyButtonUI(next);
            await persistCheckOnlyToggle(next);
            syncCheckOnlyDatesRowVisibility();
        });
    }
    if (multiDebugBtn) {
        multiDebugBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !multiDebugBtn.classList.contains('btn-toggle--on');
            updateCheckOnlyMultiDateDebugUI(next);
            await persistCheckOnlyMultiDateDebug(next, datesInputEl ? datesInputEl.value : '');
            syncCheckOnlyDatesRowVisibility();
        });
    }
    if (submitInvoiceBtn) {
        submitInvoiceBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !submitInvoiceBtn.classList.contains('btn-toggle--on');
            updateSubmitInvoiceButtonUI(next);
            await persistSubmitInvoiceToggle(next);
        });
    }
    if (billInvoicesBtn) {
        billInvoicesBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !billInvoicesBtn.classList.contains('btn-toggle--on');
            updateBillFromInvoicesButtonUI(next);
            await persistBillFromInvoicesToggle(next);
        });
    }
    if (datesInputEl) {
        datesInputEl.addEventListener('change', async () => {
            if (settingsUiLocked) return;
            await persistCheckOnlyDebugDatesOnly(datesInputEl.value);
        });
    }
    if (attestBtn) {
        attestBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !attestBtn.classList.contains('btn-toggle--on');
            updateUploadAttestationsButtonUI(next);
            await persistUploadAttestationsToggle(next);
        });
    }
    if (exportBtn) exportBtn.addEventListener('click', () => exportExcel());
    const importExcelBtn = document.getElementById('btn-import-excel-remaining');
    const importExcelFile = document.getElementById('import-excel-file');
    if (importExcelBtn && importExcelFile) {
        importExcelBtn.addEventListener('click', () => {
            if (settingsUiLocked) return;
            importExcelFile.value = '';
            importExcelFile.click();
        });
        importExcelFile.addEventListener('change', () => {
            const file = importExcelFile.files && importExcelFile.files[0];
            if (file) importRemainingFromExcel(file);
        });
    }
    loadSettings();
})();

(function initDateClampModeSelect() {
    const clampSel = document.getElementById('date-clamp-mode');
    if (!clampSel) return;
    clampSel.addEventListener('change', async () => {
        if (settingsUiLocked) return;
        await persistDateClampMode(clampSel.value);
    });
})();

initConnectionBadgeTripleClick();
document.getElementById('btn-load-session')?.addEventListener('click', loadBillingSession);
document.getElementById('btn-resume-session')?.addEventListener('click', resumeBillingSession);
document.getElementById('btn-dismiss-session')?.addEventListener('click', dismissBillingSession);
