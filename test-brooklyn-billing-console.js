/**
 * BROOKLYN BILLING – Console test (Single Date + interaction note)
 * ================================================================
 * Paste this ENTIRE file into the browser console on the UniteUs billing form.
 *
 * Brooklyn flow (different from main):
 *   - Period of Service: "Single Date" (NOT Date Range)
 *   - Service Date field: deliveryDate from API (one date only)
 *   - Note (#interactionNote): "Services provided for the week of … through …"
 *     using API `date` + `endDate` for the week text
 *
 * One-shot:
 *   await brooklynBilling.run({
 *     date: '2026-02-23',
 *     endDate: '2026-03-01',
 *     deliveryDate: '2026-02-26'
 *   })
 *
 * Step-by-step:
 *   await brooklynBilling.selectSingleDateRadio()
 *   await brooklynBilling.setServiceDate('2026-02-26')   // deliveryDate ISO
 *   brooklynBilling.fillInteractionNote('2026-02-23', '2026-03-01')
 *   brooklynBilling.verify()
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sel = {
    singleDateRadioId: 'provided-service-period-of-service-0',
    dateRangeRadioId: 'provided-service-period-of-service-1',
    serviceDateInputId: 'provided-service-date',
    serviceDateYearId: 'provided-service-date-year-input',
    noteTextareaId: 'interactionNote',
    calendarTrigger: 'a[aria-controls="provided-service-date"]',
    dateFieldContainer: '.ui-date-field',
    dropdownClass: 'ui-date-field__dropdown',
    dropdownOpenClass: 'ui-date-field__dropdown--open',
    controls: '.ui-date-field__controls',
    monthSpan: '.ui-date-field__controls div span',
    navPrev: '.ui-date-field__controls a[role="button"]:first-of-type',
    navNext: '.ui-date-field__controls a[role="button"]:last-of-type',
    calendar: '.ui-date-field__dropdown .ui-calendar',
    dayButton:
      '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]',
  };

  const MONTH_NAMES = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];

  const shown = (el) =>
  !!(el && (el.offsetParent !== null || (el.getClientRects?.().length || 0) > 0));

  const byXPath = (xp) => {
    const r = document.evaluate(
      xp,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return r.singleNodeValue || null;
  };

  function getCoords(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return {
      clientX: x,
      clientY: y,
      pageX: x + window.pageXOffset,
      pageY: y + window.pageYOffset,
    };
  }

  async function clickHumanAsync(el, delayMs = 25) {
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    await sleep(50);
    const c = getCoords(el);
    el.focus?.();
    await sleep(30);
    const m = (t, o) =>
      el.dispatchEvent(
        new MouseEvent(t, {
          view: window,
          bubbles: true,
          cancelable: true,
          ...c,
          ...o,
        })
      );
    const p = (t, o) =>
      el.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          pressure: t === 'pointerdown' ? 1 : 0,
          width: 1,
          height: 1,
          ...c,
          bubbles: true,
          cancelable: true,
          ...o,
        })
      );
    m('mousemove', {});
    p('pointermove', {});
    await sleep(delayMs);
    p('pointerdown', { buttons: 1 });
    await sleep(delayMs);
    m('mousedown', { buttons: 1, detail: 1 });
    await sleep(delayMs);
    p('pointerup', { buttons: 0 });
    await sleep(delayMs);
    m('mouseup', { buttons: 0, detail: 1 });
    await sleep(delayMs);
    m('click', { detail: 1 });
  }

  const clickLikeHuman = (el) => {
    if (!el) return;
    const c = getCoords(el);
    const p = (t, o) =>
      el.dispatchEvent(
        new PointerEvent(t, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          ...c,
          ...o,
        })
      );
    const m = (t, o) =>
      el.dispatchEvent(
        new MouseEvent(t, {
          bubbles: true,
          cancelable: true,
          view: window,
          ...c,
          ...o,
        })
      );
    p('pointerdown', { pressure: 1, buttons: 1 });
    m('mousedown', { buttons: 1, detail: 1 });
    p('pointerup', { pressure: 0, buttons: 0 });
    m('mouseup', { buttons: 0, detail: 1 });
    m('click', { detail: 1 });
  };

  const setNativeValue = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  };

  const fire = (el, type) =>
    el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

  const pressKey = (el, key, code, keyCode) => {
    const opts = {
      key,
      code,
      keyCode,
      which: keyCode,
      view: window,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: keyCode }));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  };

  function isoToDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toMDY(isoOrDate) {
    const d = typeof isoOrDate === 'string' ? isoToDate(isoOrDate) : isoOrDate;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }

  function formatNoteDate(iso) {
    const d = isoToDate(iso);
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function buildNoteText(weekStartISO, weekEndISO, orderURLs) {
    let text = `Services provided for the week of ${formatNoteDate(weekStartISO)} through ${formatNoteDate(weekEndISO)}`;
    const urls = (Array.isArray(orderURLs) ? orderURLs : [])
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    if (urls.length > 0) {
      text += '\n\n' + urls.join('\n');
    }
    return text;
  }

  function getServiceDateInput() {
    return document.getElementById(sel.serviceDateInputId);
  }

  function getNoteTextarea() {
    return document.getElementById(sel.noteTextareaId);
  }

  function getDateFieldRoot() {
    const input = getServiceDateInput();
    return input?.closest(sel.dateFieldContainer) || null;
  }

  function isPickerOpen() {
    const root = getDateFieldRoot();
    if (!root) return false;
    if (root.querySelector('.' + sel.dropdownOpenClass.replace(/\s+/g, '.'))) return true;
    const dd = root.querySelector(sel.dropdownClass);
    if (dd && shown(dd)) return true;
    const trigger = root.querySelector(sel.calendarTrigger);
    if (trigger?.getAttribute('aria-expanded') === 'true') return true;
    return false;
  }

  function findSingleDateRadio() {
    return (
      document.getElementById(sel.singleDateRadioId) ||
      document.querySelector(
        'input[name="provided_service.period_of_service"][value="Single Date"]'
      ) ||
      Array.from(
        document.querySelectorAll('input[name="provided_service.period_of_service"]')
      ).find((r) =>
        (r.nextElementSibling?.textContent || r.labels?.[0]?.textContent || '')
          .trim()
          .toLowerCase()
          .includes('single')
      ) ||
      null
    );
  }

  async function selectSingleDateRadio() {
    console.log('[Brooklyn] Selecting "Single Date" radio...');
    const rangeRadio = document.getElementById(sel.dateRangeRadioId);
    if (rangeRadio?.checked) {
      console.log('[Brooklyn] Date Range was selected; switching to Single Date.');
    }
    const radio = findSingleDateRadio();
    if (!radio) {
      console.error('[Brooklyn] Single Date radio not found.');
      return false;
    }
    if (!radio.checked) {
      clickLikeHuman(radio);
      await sleep(400);
      const labelFor = document.querySelector(`label[for="${radio.id}"]`);
      if (labelFor && !radio.checked) clickLikeHuman(labelFor);
      await sleep(300);
    }
  console.log('[Brooklyn] Single Date selected:', radio.checked);
    return radio.checked;
  }

  async function openSingleDatePicker() {
    if (isPickerOpen()) {
      console.log('[Brooklyn] Date picker already open.');
      return true;
    }
    const root = getDateFieldRoot();
    const input = getServiceDateInput();
    const label = document.querySelector(`label[for="${sel.serviceDateInputId}"]`);
    const trigger =
      root?.querySelector(sel.calendarTrigger) ||
      document.querySelector(sel.calendarTrigger);

    const tryOpen = async () => {
      if (trigger && shown(trigger)) {
        console.log('[Brooklyn] Clicking calendar trigger...');
        await clickHumanAsync(trigger, 25);
        for (let i = 0; i < 15; i++) {
          if (isPickerOpen()) return true;
          await sleep(80);
        }
      }
      if (label && shown(label)) {
        console.log('[Brooklyn] Clicking Service Date label...');
        clickLikeHuman(label);
        await sleep(120);
        if (isPickerOpen()) return true;
      }
      if (input && shown(input)) {
        console.log('[Brooklyn] Focusing Service Date input...');
        input.focus();
        await sleep(80);
        pressKey(input, ' ', 'Space', 32);
        await sleep(120);
        if (isPickerOpen()) return true;
        pressKey(input, 'Enter', 'Enter', 13);
        for (let i = 0; i < 10; i++) {
          if (isPickerOpen()) return true;
          await sleep(60);
        }
      }
      return false;
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await tryOpen()) return true;
      await sleep(150 + attempt * 100);
    }
    console.error('[Brooklyn] Could not open single-date picker.');
    return false;
  }

  function monthNameToIdx(name) {
    return MONTH_NAMES.indexOf(String(name || '').trim().toLowerCase());
  }

  function getVisibleMonthYear(root) {
    const dd = root.querySelector(sel.dropdownClass);
    if (!dd) return null;
    const span = dd.querySelector(sel.monthSpan);
    const yearIn =
      document.getElementById(sel.serviceDateYearId) ||
      dd.querySelector('#' + sel.serviceDateYearId);
    const monthIdx = monthNameToIdx(span?.textContent);
    const year = parseInt(yearIn?.value || '0', 10);
    if (monthIdx < 0 || !year) return null;
    return { monthIdx, year };
  }

  async function ensureMonthVisible(targetDate) {
    const root = getDateFieldRoot();
    const dd = root?.querySelector(sel.dropdownClass);
    if (!dd) return false;
    const prev = dd.querySelector(sel.navPrev);
    const next = dd.querySelector(sel.navNext);
    if (!prev || !next) return false;

    const targetAbs = targetDate.getFullYear() * 12 + targetDate.getMonth();
    for (let i = 0; i < 36; i++) {
      const vis = getVisibleMonthYear(root);
      if (!vis) return false;
      const visibleAbs = vis.year * 12 + vis.monthIdx;
      if (visibleAbs === targetAbs) return true;
      if (targetAbs < visibleAbs) await clickHumanAsync(prev, 25);
      else await clickHumanAsync(next, 25);
      await sleep(300);
    }
    return false;
  }

  async function clickDayInCalendar(targetDate) {
    const root = getDateFieldRoot();
    const cal = root?.querySelector(sel.calendar);
    if (!cal) {
      console.error('[Brooklyn] Calendar element not found.');
      return false;
    }
    const want = String(targetDate.getDate());
    const cells = cal.querySelectorAll(sel.dayButton);
    const btn = Array.from(cells).find(
      (b) => (b.textContent || '').trim() === want
    );
    if (!btn) {
      console.error('[Brooklyn] Day button not found for day', want);
      return false;
    }
    await clickHumanAsync(btn, 25);
    await sleep(250);
    return true;
  }

  async function closePickerIfOpen() {
    const root = getDateFieldRoot();
    const input = getServiceDateInput();
    const trigger = root?.querySelector(sel.calendarTrigger);

    for (let i = 0; i < 25; i++) {
      if (!isPickerOpen()) return;
      await sleep(80);
    }
    input?.blur();
    await sleep(100);
    if (trigger && shown(trigger)) {
      await clickHumanAsync(trigger, 25);
      await sleep(200);
    }
    if (!isPickerOpen()) return;
    input?.focus();
    await sleep(80);
    pressKey(input, 'Tab', 'Tab', 9);
    await sleep(200);
  }

  async function setServiceDateViaCalendar(deliveryISO) {
    const target = isoToDate(deliveryISO);
    console.log('[Brooklyn] Calendar path for delivery date:', toMDY(target));

    if (!(await openSingleDatePicker())) return false;
    await sleep(300);

    if (!(await ensureMonthVisible(target))) {
      console.error('[Brooklyn] Could not navigate calendar to target month.');
      return false;
    }
    if (!(await clickDayInCalendar(target))) return false;

    await closePickerIfOpen();
    await sleep(200);
    return true;
  }

  async function setServiceDateViaInput(deliveryISO) {
    const input = getServiceDateInput();
    if (!input) {
      console.error('[Brooklyn] #provided-service-date not found.');
      return false;
    }
    const mdy = toMDY(deliveryISO);
    console.log('[Brooklyn] Input path: setting', mdy);
    input.focus();
    await sleep(100);
    setNativeValue(input, mdy);
    fire(input, 'input');
    fire(input, 'change');
    await sleep(100);
    pressKey(input, 'Tab', 'Tab', 9);
    await sleep(150);
    input.blur();
    return true;
  }

  async function setServiceDate(deliveryISO) {
    const okRadio = await selectSingleDateRadio();
    if (!okRadio) return { ok: false, error: 'Single Date radio not selected' };

    await sleep(200);

    let calendarOk = false;
    try {
      calendarOk = await setServiceDateViaCalendar(deliveryISO);
    } catch (e) {
      console.warn('[Brooklyn] Calendar path threw:', e);
    }

    const input = getServiceDateInput();
    const expected = toMDY(deliveryISO);
    if (!calendarOk || input?.value !== expected) {
      console.log('[Brooklyn] Calendar path incomplete; trying input fallback...');
      await setServiceDateViaInput(deliveryISO);
    }

    await sleep(200);
    const finalVal = input?.value || '';
    const ok = finalVal === expected;
    console.log('[Brooklyn] Service date result:', finalVal, ok ? 'OK' : 'MISMATCH (expected ' + expected + ')');
    return { ok, value: finalVal, expected };
  }

  function fillInteractionNote(weekStartISO, weekEndISO, orderURLs) {
    const ta = getNoteTextarea();
    if (!ta) {
      console.error('[Brooklyn] #interactionNote not found.');
      return { ok: false, error: 'note textarea missing' };
    }
    const text = buildNoteText(weekStartISO, weekEndISO, orderURLs);
    console.log('[Brooklyn] Setting note:', text);
    ta.focus();
    setNativeValue(ta, text);
    fire(ta, 'input');
    fire(ta, 'change');
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true, text };
  }

  function verify() {
    const input = getServiceDateInput();
    const ta = getNoteTextarea();
    const dateError = getDateFieldRoot()?.querySelector('.ui-form-field__error');
    const result = {
      singleDateRadioChecked: findSingleDateRadio()?.checked ?? null,
      dateRangeRadioChecked:
        document.getElementById(sel.dateRangeRadioId)?.checked ?? null,
      serviceDateValue: input?.value ?? null,
      serviceDateHasError: dateError ? shown(dateError) : null,
      serviceDateErrorText: dateError?.textContent?.trim() || null,
      noteValue: ta?.value ?? null,
      noteLength: ta?.value?.length ?? 0,
    };
    console.table(result);
    return result;
  }

  async function run(apiPayload) {
    const {
      date,
      endDate,
      deliveryDate,
      orderURLs,
      useCalendar = true,
    } = apiPayload || {};

    if (!date || !endDate || !deliveryDate) {
      const msg =
        'Pass { date, endDate, deliveryDate } — all ISO YYYY-MM-DD';
      console.error('[Brooklyn]', msg);
      return { ok: false, error: msg };
    }

    console.log('[Brooklyn] Starting full test...', { date, endDate, deliveryDate });

    const radioOk = await selectSingleDateRadio();
    if (!radioOk) return { ok: false, step: 'radio' };

    const dateResult = useCalendar
      ? await setServiceDate(deliveryDate)
      : await setServiceDateViaInput(deliveryDate).then(() => ({
          ok: getServiceDateInput()?.value === toMDY(deliveryDate),
          value: getServiceDateInput()?.value,
          expected: toMDY(deliveryDate),
        }));

    const noteResult = fillInteractionNote(date, endDate, orderURLs);
    const check = verify();

    const ok =
      radioOk &&
      dateResult.ok &&
      noteResult.ok &&
      !check.serviceDateHasError;

    console.log(ok ? '[Brooklyn] PASS' : '[Brooklyn] FAIL — see table above');
    return { ok, dateResult, noteResult, verify: check };
  }

  const api = {
    run,
    selectSingleDateRadio,
    setServiceDate,
    setServiceDateViaCalendar,
    setServiceDateViaInput,
    fillInteractionNote,
    buildNoteText,
    verify,
    toMDY,
    formatNoteDate,
    sel,
  };

  window.brooklynBilling = api;

  console.log('brooklynBilling loaded.');
  console.log('Example:');
  console.log(`  await brooklynBilling.run({
    date: '2026-02-23',
    endDate: '2026-03-01',
    deliveryDate: '2026-02-26'
  })`);
})();
