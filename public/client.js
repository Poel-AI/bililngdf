(function () {
    const params = new URLSearchParams(location.search);
    const jobId = params.get('job');
    if (!jobId || !/^[a-f0-9]{16}$/.test(jobId)) return;
    window.__PORTAL_JOB_ID = jobId;
    const prefix = '/api/jobs/' + jobId;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        let url = input;
        if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('/api/jobs/') && !input.startsWith('/api/auth/')) {
            url = prefix + input;
        }
        return origFetch(url, init).then((res) => {
            if (res.status === 401 && !String(url).includes('/api/auth/')) {
                location.href = '/login';
            }
            return res;
        });
    };
    const OrigES = window.EventSource;
    window.EventSource = function (url, opts) {
        if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('/api/jobs/')) {
            url = prefix + url;
        }
        return new OrigES(url, opts);
    };
})();

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

/** true when this build is insurance-verification only (no billing). */
let insuranceOnlyMode = false;

function applyAppMode(s) {
    insuranceOnlyMode = !!(s && (s.insuranceOnly === true || s.appMode === 'insurance'));
    document.body.classList.toggle('app-mode-insurance', insuranceOnlyMode);
    document.body.classList.toggle('app-mode-billing', !insuranceOnlyMode);
    const title = (s && s.appDisplayName) || (insuranceOnlyMode ? 'Diet Fantasy Insurance' : 'Diet Fantasy Billing');
    document.title = title;
    const brandTitle = document.getElementById('brand-title');
    if (brandTitle) brandTitle.textContent = title;
    const tagline = document.getElementById('brand-tagline');
    if (tagline) {
        tagline.textContent = insuranceOnlyMode
            ? 'Load your client list, then verify insurance. Activity and progress appear below.'
            : 'Load your client list, then run billing. Activity and progress appear below.';
    }
    const resumeBtn = document.getElementById('btn-resume-session');
    if (resumeBtn) {
        resumeBtn.textContent = insuranceOnlyMode ? 'Resume check' : 'Resume billing';
    }
    const insuranceBtn = document.getElementById('btn-check-insurance');
    if (insuranceBtn) {
        insuranceBtn.classList.toggle('btn-primary', insuranceOnlyMode);
        insuranceBtn.classList.toggle('btn-secondary', !insuranceOnlyMode);
    }
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
    add(req.mealInvoice);
    add(req.produceInvoice);
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

function parseClientIdFromProofUrl(raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    let resolved = t;
    if (!/^https?:\/\//i.test(t)) {
        const base = API_BASE_URL.replace(/\/$/, '');
        resolved = t.startsWith('/') ? `${base}${t}` : `${base}/${t}`;
    }
    if (!/client-invoice-pdf/i.test(resolved)) return '';
    try {
        return new URL(resolved).searchParams.get('clientId') || '';
    } catch {
        return '';
    }
}

function resolveClientIdForReq(req) {
    const urls = collectProofUrls(req);
    const fromProof = parseClientIdFromProofUrl(urls[0] || '');
    if (fromProof) return fromProof;
    if (req.clientId != null && String(req.clientId).trim() !== '') return String(req.clientId).trim();
    return '';
}

function billingWeekEndIsoFromStart(start) {
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) return '';
    const [y, m, d] = String(start).split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d));
    end.setUTCDate(end.getUTCDate() + 6);
    return end.toISOString().slice(0, 10);
}

function syncBillEndDateFromStart() {
    const endEl = document.getElementById('bill-end-date');
    if (!endEl) return;
    endEl.value = billingWeekEndIsoFromStart(getBillDate());
}

function syncCustomEndDateDefaults() {
    const endEl = document.getElementById('bill-end-date');
    if (!endEl) return;
    if (!endEl.value) {
        endEl.value = billingWeekEndIsoFromStart(getBillDate());
    }
}

function getBillEndDate() {
    const el = document.getElementById('bill-end-date');
    return (el && el.value) ? el.value.trim() : '';
}

function isCustomInvoicesOn() {
    const btn = document.getElementById('btn-custom-invoice');
    return btn ? btn.classList.contains('btn-toggle--on') : false;
}

function getCustomInvoiceParamsFromForm() {
    const from = getBillDate();
    const to = getBillEndDate() || billingWeekEndIsoFromStart(from);
    const itemName = (document.getElementById('ci-item-name')?.value || '').trim();
    const quantity = (document.getElementById('ci-quantity')?.value || '').trim();
    const unitPrice = (document.getElementById('ci-unit-price')?.value || '').trim();
    return { from, to, itemName, quantity, unitPrice };
}

function validateBillEndDateFields() {
    const start = getBillDate();
    const end = getBillEndDate();
    if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 'Set list end date (YYYY-MM-DD)';
    if (start && end && end < start) return 'List end date must be on or after billing week start';
    return null;
}

function validateCustomInvoiceGlobalFields(params) {
    if (!isCustomInvoicesOn()) return null;
    const endErr = validateBillEndDateFields();
    if (endErr) return endErr;
    if (!params) return 'Custom invoice fields missing';
    const missing = [];
    if (!params.from || !/^\d{4}-\d{2}-\d{2}$/.test(params.from)) missing.push('from');
    if (!params.to || !/^\d{4}-\d{2}-\d{2}$/.test(params.to)) missing.push('to');
    if (!params.itemName) missing.push('item name');
    if (!params.quantity) missing.push('quantity');
    if (!params.unitPrice) missing.push('unit price');
    if (missing.length) return `Fill custom invoice ${missing.join(', ')}`;
    return null;
}

function setCustomInvoiceFieldsVisible(show) {
    const toolbar = document.querySelector('section.toolbar');
    if (toolbar) toolbar.classList.toggle('custom-invoice-mode', !!show);
}

function updateCustomInvoiceButtonUI(on) {
    const btn = document.getElementById('btn-custom-invoice');
    if (!btn) return;
    if (on) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Custom invoice: On';
        btn.setAttribute('aria-pressed', 'true');
        setCustomInvoiceFieldsVisible(true);
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Custom invoice: Off';
        btn.setAttribute('aria-pressed', 'false');
        setCustomInvoiceFieldsVisible(false);
    }
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
        'btn-skip-produce',
        'btn-skip-food',
        'btn-bill-invoices-endpoint',
        'btn-save-settings',
        'btn-open-source-files',
        'check-only-dates-input',
        'date-clamp-mode',
        'btn-custom-invoice',
        'bill-end-date',
        'ci-item-name',
        'ci-quantity',
        'ci-unit-price'
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

function updateSkipProduceButtonUI(on) {
    const btn = document.getElementById('btn-skip-produce');
    if (!btn) return;
    if (on) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Skip produce: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Skip produce: Off';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function updateSkipFoodButtonUI(on) {
    const btn = document.getElementById('btn-skip-food');
    if (!btn) return;
    if (on) {
        btn.classList.add('btn-toggle--on');
        btn.textContent = 'Skip food: On';
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('btn-toggle--on');
        btn.textContent = 'Skip food: Off';
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

async function persistSkipProduceToggle(on) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipProduce: on })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(on ? 'Skip produce enabled (saved to .env)' : 'Skip produce disabled (saved to .env)', 'success');
    } catch (e) {
        log(`Save failed: ${e.message}`, 'error');
    }
}

async function persistSkipFoodToggle(on) {
    try {
        const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipFood: on })
        });
        const d = await r.json();
        if (!r.ok) {
            log(d.error || `Save failed (${r.status})`, 'error');
            return;
        }
        log(on ? 'Skip food enabled (saved to .env)' : 'Skip food disabled (saved to .env)', 'success');
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
        applyAppMode(s);
        const num = document.getElementById('setting-concurrent-browsers');
        if (num) {
            if (s.minConcurrent != null) num.min = String(s.minConcurrent);
            if (s.maxConcurrent != null) num.max = String(s.maxConcurrent);
            num.value = String(s.concurrentBrowsers);
        }
        updateShowBrowserButtonUI(!s.headless);
        updateUploadAttestationsButtonUI(s.uploadAttestations !== false);
        updateSkipProduceButtonUI(s.skipProduce === true);
        updateSkipFoodButtonUI(s.skipFood === true);
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
        if (s.portalMode) applyPortalChrome(s);
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

async function exportInsuranceExcel() {
    try {
        const r = await fetch('/api/export-insurance.xlsx');
        if (!r.ok) {
            let msg = `Insurance export failed (${r.status})`;
            try {
                const err = await r.json();
                if (err.error) msg = err.error;
            } catch (_) { /* not JSON */ }
            log(msg, 'error');
            return;
        }
        const blob = await r.blob();
        const disp = r.headers.get('Content-Disposition') || '';
        let name = 'insurance-verify.xlsx';
        const m = /filename="([^"]+)"/.exec(disp);
        if (m) name = m[1];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        log(`Downloaded ${name}`, 'success');
    } catch (e) {
        log(`Insurance export failed: ${e.message}`, 'error');
    }
}

async function importRemainingFromExcel(file) {
    if (!file) return;
    if (billingRunning) {
        log('Cannot import while billing is running.', 'error');
        return;
    }
    try {
        log(`Uploading ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)…`, 'info');
        const r = await fetch('/api/import-queue-from-excel', {
            method: 'POST',
            headers: {
                'Content-Type':
                    file.type ||
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'X-Only-Remaining': 'true',
            },
            body: file,
        });
        const raw = await r.text();
        let d = {};
        try {
            d = raw ? JSON.parse(raw) : {};
        } catch (_) {
            d = {};
        }
        if (!r.ok) {
            const sizeKb = Math.max(1, Math.round(file.size / 1024));
            const msg =
                d.error ||
                (r.status === 413
                    ? `Excel file is too large (${sizeKb} KB). Server limit is 25 MB.`
                    : raw && raw.trim()
                      ? raw.trim().slice(0, 200)
                      : `Import failed (${r.status})`);
            log(msg, 'error');
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

function postJson(url, body) {
    const send = (payload) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (r.status === 409 && data.code === 'SAME_ACCOUNT' && !payload.confirmSameAccount) {
            const proceed = window.confirm(
                (data.error || 'Another running job is already using this UniteUs login.') +
                '\n\nStart this job anyway? The two runs can kick each other off UniteUs.'
            );
            if (!proceed) {
                const err = new Error('Not started.');
                err.silent = true;
                throw err;
            }
            return send(Object.assign({}, payload, { confirmSameAccount: true }));
        }
        if (!r.ok || data.error) {
            throw new Error(data.error || data.message || ('HTTP ' + r.status));
        }
        return data;
    });
    return send(body);
}

function resumeBillingSession() {
    log('Resuming saved billing session…', 'info');
    const account = getSelectedAccount();
    const attBtn = document.getElementById('btn-upload-attestations');
    const uploadAttestations = attBtn ? attBtn.classList.contains('btn-toggle--on') : true;
    const checkBtn = document.getElementById('btn-check-only');
    const checkOnlyMode = checkBtn ? checkBtn.classList.contains('btn-toggle--on') : false;
    const skipProduceBtn = document.getElementById('btn-skip-produce');
    const skipProduce = skipProduceBtn ? skipProduceBtn.classList.contains('btn-toggle--on') : false;
    const skipFoodBtn = document.getElementById('btn-skip-food');
    const skipFood = skipFoodBtn ? skipFoodBtn.classList.contains('btn-toggle--on') : false;
    const payload = {
        source: 'resume',
        apiKey: '',
        account,
        uploadAttestations,
        checkOnlyMode,
        skipProduce,
        skipFood,
        customInvoices: isCustomInvoicesOn(),
        customInvoiceParams: isCustomInvoicesOn() ? getCustomInvoiceParamsFromForm() : undefined
    };
    postJson('/process-billing', payload)
        .then((d) => {
            log(d.message || 'Resume started.', 'success');
        })
        .catch((e) => {
            if (!e.silent) log(`Resume failed: ${e.message}`, 'error');
        });
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

function formatCheckOnlyInvoicesCell(req) {
    const v = req.checkOnlyInvoiceAmounts != null ? String(req.checkOnlyInvoiceAmounts).trim() : '';
    if (v) return v;
    const list = Array.isArray(req.checkOnlyInvoices) ? req.checkOnlyInvoices : [];
    if (list.length === 0) return '—';
    return list.map((inv) => inv.amount || '—').join(', ');
}

function formatInsuranceResultsCellHtml(req) {
    const list = Array.isArray(req.insuranceResults) ? req.insuranceResults : [];
    if (list.length === 0) {
        if (req.status === 'processing' && /verifying insurance/i.test(String(req.message || ''))) {
            return '<span class="td-muted">Checking…</span>';
        }
        return '<span class="td-muted">—</span>';
    }
    return list
        .map((r) => {
            const st = String(r.status || '').toUpperCase();
            let cls = 'ins-badge';
            if (st === 'GREEN') cls += ' ins-badge--green';
            else if (st === 'RED') cls += ' ins-badge--red';
            else cls += ' ins-badge--err';
            const title = escapeHtmlAttr(
                `${r.plan || '?'}: ${st}${r.detail ? ` — ${r.detail}` : ''}`
            );
            const label = escapeHtml(`${r.plan || '?'}: ${st}`);
            return `<span class="${cls}" title="${title}">${label}</span>`;
        })
        .join(' ');
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
        req.clientType,
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
        Array.isArray(req.checkOnlyInvoices)
            ? req.checkOnlyInvoices.map((i) => i.status).join(' ')
            : '',
        Array.isArray(req.insuranceResults)
            ? req.insuranceResults.map((i) => `${i.plan} ${i.status} ${i.detail}`).join(' ')
            : '',
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

        if (field === 'insuranceResults') {
            const sa = Array.isArray(a.insuranceResults)
                ? a.insuranceResults.map((r) => `${r.plan}:${r.status}`).join(' ')
                : '';
            const sb = Array.isArray(b.insuranceResults)
                ? b.insuranceResults.map((r) => `${r.plan}:${r.status}`).join(' ')
                : '';
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
    if (v === 'brooklyn') return 'brooklyn';
    if (v === 'yonkers') return 'yonkers';
    return 'regular';
}

function billAccountLabel(account) {
    if (account === 'brooklyn') return 'Brooklyn';
    if (account === 'yonkers') return 'Yonkers';
    return 'Diet Fantasy (Main)';
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
    const endErr = validateBillEndDateFields();
    if (endErr) {
        log(endErr, 'error');
        return;
    }
    const endDate = getBillEndDate();
    const rangeLabel = `${date} → ${endDate}`;
    log(`Fetching ${label} client list for ${rangeLabel}…`, 'info');

    requestsSnapshotBeforeDownload = lastRequests.slice();
    queueDownloadLoading = true;
    lastRequests = [];
    queueAnchorVisibleIndex = -1;
    renderQueue();
    updateStats([]);
    updateSelectAllCheckbox();

    const payload = { date, account, endDate };

    fetch('/fetch-all-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
    if (insuranceOnlyMode) {
        log('Billing is disabled in this app. Use Check insurance.', 'warning');
        return;
    }
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
    const skipProduceBtn = document.getElementById('btn-skip-produce');
    const skipProduce = skipProduceBtn ? skipProduceBtn.classList.contains('btn-toggle--on') : false;
    const skipFoodBtn = document.getElementById('btn-skip-food');
    const skipFood = skipFoodBtn ? skipFoodBtn.classList.contains('btn-toggle--on') : false;
    const clampSel = document.getElementById('date-clamp-mode');
    const dateClampMode =
        clampSel && clampSel.value === 'client_created' ? 'client_created' : 'auth';
    const account = getSelectedAccount();
    const customInvoices = isCustomInvoicesOn();
    const customInvoiceParams = customInvoices ? getCustomInvoiceParamsFromForm() : null;
    if (customInvoices) {
        const fieldErr = validateCustomInvoiceGlobalFields(customInvoiceParams);
        if (fieldErr) {
            log(fieldErr, 'error');
            return;
        }
        const selected = lastRequests.filter((r) => selectedIds.has(requestIdForReq(r)));
        for (const r of selected) {
            const clientId = resolveClientIdForReq(r);
            if (!clientId) {
                log(`${r.name || 'Client'}: could not parse clientId from API proof link.`, 'error');
                return;
            }
        }
    }
    const body = {
        source: 'queue',
        apiKey: '',
        account,
        uploadAttestations,
        checkOnlyMode,
        submitInvoice,
        skipProduce,
        skipFood,
        dateClampMode,
        customInvoices,
        customInvoiceParams: customInvoices ? customInvoiceParams : undefined
    };
    if (checkOnlyMode && multiDateOn && datesStr) {
        body.checkOnlyDebugDates = datesStr;
    }
    body.selectedIds = ids;

    postJson('/process-billing', body)
        .then(d => {
            log(d.message || 'Run started.', 'success');
        })
        .catch(e => {
            if (!e.silent) log(`Error: ${e.message}`, 'error');
        });
}

/** Same selected queue, but open facesheet profile and Verify Insurance (no billing). */
function runInsuranceCheck() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
        log('No clients selected. Check the clients you want to verify.', 'warning');
        return;
    }
    const selected = lastRequests.filter((r) => selectedIds.has(requestIdForReq(r)));
    if (selected.length === 0) {
        log('No selected clients to check.', 'warning');
        return;
    }
    const missingUrl = selected.filter((r) => !r.url || !String(r.url).includes('/contact/'));
    if (missingUrl.length > 0) {
        log(
            `${missingUrl.length} selected client(s) missing a Unite /contact/… link (e.g. ${missingUrl[0].name || 'client'}).`,
            'warning'
        );
    }
    log(`Starting insurance check for ${selected.length} selected client(s)...`, 'info');

    postJson('/process-insurance', {
        account: getSelectedAccount(),
        apiKey: '',
        selectedIds: ids,
    })
        .then((d) => {
            log(d.message || 'Insurance check started.', 'success');
        })
        .catch((e) => {
            if (!e.silent) log(`Error: ${e.message}`, 'error');
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
        [35, 42, 28, 55, 48, 38, 32, 28, 40, 36, 50, 48],
        [40, 55, 32, 48, 62, 44, 36, 34, 42, 40, 45, 50],
        [32, 48, 30, 52, 55, 40, 30, 36, 38, 38, 55, 48],
        [45, 38, 34, 58, 50, 42, 34, 32, 44, 42, 48, 52],
        [38, 52, 28, 45, 58, 36, 38, 30, 40, 36, 52, 46],
        [42, 44, 32, 50, 52, 40, 32, 36, 42, 40, 46, 50],
        [36, 50, 30, 46, 54, 38, 36, 34, 40, 38, 50, 44],
        [44, 40, 28, 54, 48, 42, 30, 32, 42, 44, 48, 52],
        [40, 46, 34, 48, 56, 40, 34, 36, 44, 40, 52, 48],
        [38, 54, 32, 52, 50, 44, 32, 28, 38, 36, 46, 50]
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
            <td>${skeletonBar(w[10])}</td>
            <td>${skeletonBar(w[11] || w[10])}</td>
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
            <td class="col-client-type">${escapeHtml(req.clientType != null && String(req.clientType).trim() !== '' ? String(req.clientType) : '—')}</td>
            <td>${escapeHtml(req.start ? `${req.start} → ${req.end}` : req.date || '—')}</td>
            <td class="col-created">${formatCreatedCell(req)}</td>
            <td class="col-links">${uniteCaseLinkCell(req)}</td>
            <td class="col-links billing-only">${proofLinksCell(req)}</td>
            <td><span class="status-badge ${statusClass}">${escapeHtml(req.status || 'pending')}</span></td>
            <td class="td-muted col-invoice-cost billing-only">${escapeHtml(formatCheckOnlyInvoicesCell(req))}</td>
            <td class="col-insurance">${formatInsuranceResultsCellHtml(req)}</td>
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
    const skipProduceBtn = document.getElementById('btn-skip-produce');
    const skipFoodBtn = document.getElementById('btn-skip-food');
    const exportBtn = document.getElementById('btn-export-excel');
    const exportInsuranceBtn = document.getElementById('btn-export-insurance-excel');
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
    const customInvoicesBtn = document.getElementById('btn-custom-invoice');
    if (customInvoicesBtn) {
        customInvoicesBtn.addEventListener('click', () => {
            if (settingsUiLocked) return;
            const next = !customInvoicesBtn.classList.contains('btn-toggle--on');
            updateCustomInvoiceButtonUI(next);
        });
    }
    const billDateEl = document.getElementById('bill-date');
    if (billDateEl) {
        billDateEl.addEventListener('change', () => {
            syncBillEndDateFromStart();
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
    if (skipProduceBtn) {
        skipProduceBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !skipProduceBtn.classList.contains('btn-toggle--on');
            updateSkipProduceButtonUI(next);
            await persistSkipProduceToggle(next);
        });
    }
    if (skipFoodBtn) {
        skipFoodBtn.addEventListener('click', async () => {
            if (settingsUiLocked) return;
            const next = !skipFoodBtn.classList.contains('btn-toggle--on');
            updateSkipFoodButtonUI(next);
            await persistSkipFoodToggle(next);
        });
    }
    if (exportBtn) exportBtn.addEventListener('click', () => exportExcel());
    if (exportInsuranceBtn) exportInsuranceBtn.addEventListener('click', () => exportInsuranceExcel());
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
syncCustomEndDateDefaults();
updateCustomInvoiceButtonUI(false);
document.getElementById('btn-load-session')?.addEventListener('click', loadBillingSession);
document.getElementById('btn-resume-session')?.addEventListener('click', resumeBillingSession);
document.getElementById('btn-dismiss-session')?.addEventListener('click', dismissBillingSession);

function applyPortalChrome() {
    const bar = document.getElementById('portal-bar');
    const live = document.getElementById('live-panel');
    if (bar) bar.hidden = false;
    if (live) live.hidden = false;
    const showBrowser = document.getElementById('btn-show-browser');
    if (showBrowser) showBrowser.hidden = true;
    const openFiles = document.getElementById('btn-open-source-files');
    if (openFiles) openFiles.hidden = true;
    const nameEl = document.getElementById('portal-job-name');
    if (nameEl) nameEl.textContent = 'This job';
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
        const user = d && d.user;
        const el = document.getElementById('portal-user');
        if (el && user) el.textContent = user.email || '';
        const usersLink = document.getElementById('portal-users-link');
        if (usersLink && user && user.role === 'admin') usersLink.hidden = false;
    }).catch(() => {});
    const stopBtn = document.getElementById('portal-stop');
    if (stopBtn && !stopBtn.dataset.bound) {
        stopBtn.dataset.bound = '1';
        stopBtn.addEventListener('click', () => {
            if (!window.confirm('Stop this job and close its browsers?')) return;
            const id = window.__PORTAL_JOB_ID;
            fetch('/api/jobs/' + id + '/stop', { method: 'POST' }).then(async (r) => {
                const data = await r.json().catch(() => ({}));
                if (!r.ok) log(data.error || 'Stop failed', 'error');
                else log('Stop requested.', 'warning');
            }).catch((e) => log(e.message, 'error'));
        });
    }
    const logoutBtn = document.getElementById('portal-logout');
    if (logoutBtn && !logoutBtn.dataset.bound) {
        logoutBtn.dataset.bound = '1';
        logoutBtn.addEventListener('click', () => {
            fetch('/api/auth/logout', { method: 'POST' }).finally(() => { location.href = '/login'; });
        });
    }
    startLiveView();
}

function imageFraction(img, clientX, clientY) {
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth || rect.width;
    const nh = img.naturalHeight || rect.height;
    if (!nw || !nh) return null;
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const ox = rect.left + (rect.width - dw) / 2;
    const oy = rect.top + (rect.height - dh) / 2;
    const x = (clientX - ox) / dw;
    const y = (clientY - oy) / dh;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
}

function startLiveView() {
    if (!window.__PORTAL_JOB_ID || window.__liveViewStarted) return;
    window.__liveViewStarted = true;
    const grid = document.getElementById('live-grid');
    const stageWrap = document.getElementById('live-stage-wrap');
    const stage = document.getElementById('live-stage');
    const stageImg = document.getElementById('live-stage-img');
    if (!grid || !stageImg) return;
    const thumbs = new Map();
    let focus = '0';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/api/jobs/' + window.__PORTAL_JOB_ID + '/live');

    function send(msg) {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function ensureThumb(slotId) {
        let img = thumbs.get(slotId);
        if (img) return img;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'live-thumb';
        btn.dataset.slot = slotId;
        btn.innerHTML = '<span class="live-thumb__label">Slot ' + slotId + '</span>';
        img = document.createElement('img');
        img.alt = 'Slot ' + slotId;
        img.draggable = false;
        btn.appendChild(img);
        btn.addEventListener('click', () => {
            focus = slotId;
            send({ type: 'focus', slotId });
            stageWrap.hidden = false;
            stage.focus();
            for (const el of grid.querySelectorAll('.live-thumb')) {
                el.classList.toggle('live-thumb--focus', el.dataset.slot === slotId);
            }
        });
        grid.appendChild(btn);
        thumbs.set(slotId, img);
        if (thumbs.size === 1) btn.click();
        return img;
    }

    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || msg.type !== 'frame' || !msg.data) return;
        const url = 'data:image/jpeg;base64,' + msg.data;
        const thumb = ensureThumb(String(msg.slotId));
        thumb.src = url;
        if (String(msg.slotId) === focus) stageImg.src = url;
    };

    function pointerFraction(event) {
        return imageFraction(stageImg, event.clientX, event.clientY);
    }

    stageImg.addEventListener('click', (event) => {
        const pos = pointerFraction(event);
        if (!pos) return;
        stage.focus();
        send({ type: 'input', kind: 'click', slotId: focus, x: pos.x, y: pos.y });
    });
    stageImg.addEventListener('wheel', (event) => {
        const pos = pointerFraction(event);
        if (!pos) return;
        event.preventDefault();
        send({ type: 'input', kind: 'wheel', slotId: focus, x: pos.x, y: pos.y, deltaY: event.deltaY });
    }, { passive: false });
    stage.addEventListener('keydown', (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        if (event.key.length === 1) {
            send({ type: 'input', kind: 'type', slotId: focus, text: event.key });
        } else {
            send({ type: 'input', kind: 'key', slotId: focus, key: event.key === ' ' ? 'Space' : event.key });
        }
    });
}

