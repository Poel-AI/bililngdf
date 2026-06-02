/**
 * DATE RANGE TEST – Two flows: calendar (click dates) or input (type + Tab)
 * =========================================================================
 * Calendar flow (recommended if input doesn't register): runAllCalendar() or
 *   step1 → step2 → step3_calendar_startDate → step4_calendar_endDate → step5
 * Uses prev/next arrows to show the right month, then clicks the day in the calendar.
 *
 * Input flow: runAll() or step1 → step2 → step3_enterDate1 → step4_enterDate2 → step5
 *
 * 1. Paste this ENTIRE file into the console once (Enter).
 * 2. One shot: await runAllCalendar() or await runAllCalendar('01/15/2025', '01/22/2025')
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byXPath = (xp) => {
    const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return r.singleNodeValue || null;
  };
  const shown = (el) => !!(el && (el.offsetParent !== null || (el.getClientRects?.().length || 0) > 0));

  function getCoords(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const sx = x + (window.screenX || window.screenLeft || 0);
    const sy = y + (window.screenY || window.screenTop || 0);
    return { clientX: x, clientY: y, pageX: x + window.pageXOffset, pageY: y + window.pageYOffset, screenX: sx, screenY: sy };
  }

  const mouseOpts = (el, type, extra = {}) => {
    const c = getCoords(el);
    return { view: window, bubbles: true, cancelable: true, ...c, ...extra };
  };
  const pointerOpts = (el, extra = {}) => {
    const c = getCoords(el);
    return { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, width: 1, height: 1, ...c, bubbles: true, cancelable: true, ...extra };
  };

  const clickLikeHuman = (el) => {
    if (!el) return;
    el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts(el, { pressure: 1, buttons: 1 })));
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts(el, 'mousedown', { buttons: 1, detail: 1 })));
    el.dispatchEvent(new PointerEvent('pointerup', pointerOpts(el, { pressure: 0, buttons: 0 })));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts(el, 'mouseup', { buttons: 0, detail: 1 })));
    el.dispatchEvent(new MouseEvent('click', mouseOpts(el, 'click', { detail: 1 })));
  };

  async function clickLikeHumanAsync(el, delayMs = 20) {
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    await sleep(50);
    const coords = getCoords(el);
    el.focus?.();
    await sleep(30);
    const m = (t, o) => el.dispatchEvent(new MouseEvent(t, { view: window, bubbles: true, cancelable: true, ...coords, ...o }));
    const p = (t, o) => el.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: t === 'pointerdown' ? 1 : 0, width: 1, height: 1, ...coords, bubbles: true, cancelable: true, ...o }));
    m('mousemove', {}); p('pointermove', {});
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
  const toMDYFromDate = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  };

  const periodOfService = {
    dateRangeRadioId: 'provided-service-period-of-service-1',
    dateRangeLabelId: 'Date Range-label',
  };
  const dateRange = {
    triggerXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[1]/a',
    startInputId: 'provided-service-dates-start',
    startInputXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[1]',
    endInputId: 'provided-service-dates-end',
    endInputXpath: '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[2]',
    dropdownOpenClass: 'ui-date-field__dropdown--open',
    dropdownClass: 'ui-date-field__dropdown',
    // Calendar UI (when Date Range shows two calendars)
    calendarDropdown: '.ui-duration-field__dropdown',
    calendarControls: '.ui-duration-field__controls',
    calendarPrev: '.ui-duration-field__controls a[role="button"]:first-of-type',
    calendarNext: '.ui-duration-field__controls a[role="button"]:last-of-type',
    calendarLeft: '.ui-duration-field__calendars .ui-calendar:nth-of-type(1)',
    calendarRight: '.ui-duration-field__calendars .ui-calendar:nth-of-type(2)',
    dayButtonSel: '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]',
    startYearId: 'provided-service-dates-start-year',
    endYearId: 'provided-service-dates-end-year',
  };

  const setNativeValue = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  };
  const fire = (el, type) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

  const defaultStart = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();
  const defaultEnd = new Date();

  function pressKeyHumanLike(el, key, code, keyCode) {
    const opts = { key, code, keyCode, which: keyCode, view: window, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: keyCode }));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function isPickerOpen() {
    const openEl = dateRange.dropdownOpenClass && document.querySelector('.' + dateRange.dropdownOpenClass.replace(/\s+/g, '.'));
    if (openEl) return true;
    const dd = document.querySelector(dateRange.dropdownClass);
    if (dd && (dd.offsetParent !== null || (dd.getBoundingClientRect?.().height || 0) > 0)) return true;
    const durationDd = document.querySelector(dateRange.calendarDropdown);
    if (durationDd && (durationDd.offsetParent !== null || (durationDd.getBoundingClientRect?.().height || 0) > 0)) return true;
    const startIn = document.getElementById(dateRange.startInputId) || byXPath(dateRange.startInputXpath);
    return !!(startIn && shown(startIn));
  }

  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function monthNameToIndex(name) {
    const n = String(name || '').trim().toLowerCase();
    const i = MONTH_NAMES.indexOf(n);
    return i >= 0 ? i : -1;
  }

  // --- STEP 1: Select "Date Range" radio ---
  window.step1_selectDateRangeButton = async function () {
    console.log('[Step 1] Selecting "Date Range" radio...');
    const radio =
      document.getElementById(periodOfService.dateRangeRadioId) ||
      document.querySelector('input[name="provided_service.period_of_service"][value="Date Range"]') ||
      (() => {
        const label = document.getElementById(periodOfService.dateRangeLabelId) ||
          Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === 'Date Range');
        return label ? document.getElementById(label.getAttribute('for')) : null;
      })();
    if (!radio) {
      console.error('[Step 1] "Date Range" radio not found.');
      return;
    }
    if (!radio.checked) {
      clickLikeHuman(radio);
      await sleep(400);
      const labelFor = document.querySelector(`label[for="${periodOfService.dateRangeRadioId}"]`);
      if (labelFor && !radio.checked) clickLikeHuman(labelFor);
      await sleep(300);
    }
    console.log('[Step 1] Done.');
  };

  // --- STEP 2: Open date picker ---
  window.step2_openPicker = async function () {
    console.log('[Step 2] Opening date picker...');
    if (isPickerOpen()) {
      console.log('[Step 2] Already open.');
      return;
    }
    const triggerBtn = byXPath(dateRange.triggerXpath);
    if (!triggerBtn || !shown(triggerBtn)) {
      console.error('[Step 2] Trigger button not found at triggerXpath.');
      return;
    }
    await clickLikeHumanAsync(triggerBtn, 25);
    for (let i = 0; i < 20; i++) {
      if (isPickerOpen()) break;
      await sleep(80);
    }
    if (!isPickerOpen()) {
      console.error('[Step 2] Picker did not open.');
      return;
    }
    console.log('[Step 2] Picker is open.');
    await sleep(400);
  };

  // --- STEP 3: Enter start date (date 1) ---
  window.step3_enterDate1 = async function (startDateStr) {
    console.log('[Step 3] Entering start date...');
    const startInput = document.getElementById(dateRange.startInputId) || byXPath(dateRange.startInputXpath);
    if (!startInput) {
      console.error('[Step 3] Start input not found. Id:', dateRange.startInputId);
      return;
    }
    const value = startDateStr != null ? (typeof startDateStr === 'string' ? startDateStr : toMDYFromDate(startDateStr)) : toMDYFromDate(defaultStart);
    console.log('[Step 3] Setting value:', value);
    startInput.focus();
    await sleep(150);
    setNativeValue(startInput, value);
    fire(startInput, 'input');
    fire(startInput, 'change');
    await sleep(100);
    console.log('[Step 3] Sending Tab (like human moving to end field)...');
    pressKeyHumanLike(startInput, 'Tab', 'Tab', 9);
    await sleep(200);
    console.log('[Step 3] Done. Value now:', startInput.value);
  };

  // --- STEP 4: Enter end date (date 2) ---
  window.step4_enterDate2 = async function (endDateStr) {
    console.log('[Step 4] Entering end date...');
    const endInput = document.getElementById(dateRange.endInputId) || byXPath(dateRange.endInputXpath);
    if (!endInput) {
      console.error('[Step 4] End input not found. Id:', dateRange.endInputId);
      return;
    }
    const value = endDateStr != null ? (typeof endDateStr === 'string' ? endDateStr : toMDYFromDate(endDateStr)) : toMDYFromDate(defaultEnd);
    console.log('[Step 4] Setting value:', value);
    endInput.focus();
    await sleep(150);
    setNativeValue(endInput, value);
    fire(endInput, 'input');
    fire(endInput, 'change');
    await sleep(100);
    console.log('[Step 4] Sending Tab after end date (like human leaving field)...');
    pressKeyHumanLike(endInput, 'Tab', 'Tab', 9);
    await sleep(200);
    console.log('[Step 4] Done. Value now:', endInput.value);
  };

  // How it USED to work (extension enterBillingDetails.js): after clicking start + end days in the
  // calendar, the code did NOT press Enter. It just waited: "Let widget close itself" —
  //   for (let i=0;i<20 && isOpen(); i++) await sleep(80);
  // So the old UI closed on its own. The new UI (text inputs) may close on: blur, Tab, or Enter.

  // --- STEP 5: Close date picker. First click inside each input (end then start), then close ---
  window.step5_closeDatePicker = async function () {
    console.log('[Step 5] Closing date picker (click inside inputs first, then close)...');
    const endInput = document.getElementById(dateRange.endInputId) || byXPath(dateRange.endInputXpath);
    const startInput = document.getElementById(dateRange.startInputId) || byXPath(dateRange.startInputXpath);
    const triggerBtn = byXPath(dateRange.triggerXpath);

    if (!endInput) {
      console.error('[Step 5] End input not found.');
      return;
    }

    // Click inside each input with human-like mouse (coords + delays between events)
    if (endInput && shown(endInput)) {
      console.log('[Step 5] Human-like click inside end input...');
      await clickLikeHumanAsync(endInput, 25);
      await sleep(150);
    }
    if (startInput && shown(startInput)) {
      console.log('[Step 5] Human-like click inside start input...');
      await clickLikeHumanAsync(startInput, 25);
      await sleep(150);
    }

    // 1) Old behavior: wait for widget to close itself (up to ~2s)
    for (let i = 0; i < 25; i++) {
      if (!isPickerOpen()) {
        console.log('[Step 5] Closed (auto).');
        return;
      }
      await sleep(80);
    }

    // 2) Blur + click outside: human-like click the trigger (dismisses many dropdowns)
    endInput.blur();
    await sleep(100);
    if (triggerBtn && shown(triggerBtn)) {
      await clickLikeHumanAsync(triggerBtn, 25);
      await sleep(200);
    }
    if (!isPickerOpen()) {
      console.log('[Step 5] Closed (click outside/trigger).');
      return;
    }

    // 3) Tab key (human-like): focus end input, press Tab to move focus away
    endInput.focus();
    await sleep(80);
    pressKeyHumanLike(endInput, 'Tab', 'Tab', 9);
    await sleep(200);
    if (!isPickerOpen()) {
      console.log('[Step 5] Closed (Tab).');
      return;
    }

    // 4) Enter (human-like): full key sequence
    if (startInput) startInput.focus();
    await sleep(80);
    endInput.focus();
    await sleep(120);
    pressKeyHumanLike(endInput, 'Enter', 'Enter', 13);
    await sleep(150);
    pressKeyHumanLike(endInput, 'Enter', 'Enter', 13);
    await sleep(300);

    console.log('[Step 5] Done. Picker open?', isPickerOpen());
  };

  /** Get visible month/year from the two panes. Returns [ { monthIdx, year }, { monthIdx, year } ]. */
  function getCalendarVisibleRange(dd) {
    const container = dd || document.querySelector(dateRange.calendarDropdown);
    if (!container) return null;
    const spans = container.querySelectorAll('.ui-duration-field__controls div span');
    const startYearIn = container.querySelector('#' + dateRange.startYearId);
    const endYearIn = container.querySelector('#' + dateRange.endYearId);
    const leftMonth = spans[0] ? monthNameToIndex(spans[0].textContent) : -1;
    const rightMonth = spans[1] ? monthNameToIndex(spans[1].textContent) : -1;
    const leftYear = parseInt(startYearIn?.value || '0', 10);
    const rightYear = parseInt(endYearIn?.value || '0', 10);
    return [{ monthIdx: leftMonth, year: leftYear }, { monthIdx: rightMonth, year: rightYear }];
  }

  /** Navigate until target month/year is visible in left or right pane. */
  async function ensureMonthVisible(targetMonthIdx, targetYear) {
    const dd = document.querySelector(dateRange.calendarDropdown);
    if (!dd) return false;
    const prevBtn = dd.querySelector('.ui-duration-field__controls a[role="button"]:first-of-type');
    const nextBtn = dd.querySelector('.ui-duration-field__controls a[role="button"]:last-of-type');
    if (!prevBtn || !nextBtn) return false;
    const targetAbs = targetYear * 12 + targetMonthIdx;
    for (let i = 0; i < 36; i++) {
      const vis = getCalendarVisibleRange(dd);
      if (!vis) return false;
      const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
      const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
      if (targetAbs >= leftAbs && targetAbs <= rightAbs) return true;
      if (targetAbs < leftAbs) {
        await clickLikeHumanAsync(prevBtn, 25);
      } else {
        await clickLikeHumanAsync(nextBtn, 25);
      }
      await sleep(300);
    }
    return false;
  }

  /** Click a day (1-31) in the given calendar element. */
  async function clickDayInCalendar(calendarEl, dayNum) {
    const want = String(dayNum);
    const cells = calendarEl.querySelectorAll(dateRange.dayButtonSel);
    const btn = Array.from(cells).find((b) => (b.textContent || '').trim() === want);
    if (!btn) return false;
    await clickLikeHumanAsync(btn, 25);
    await sleep(200);
    return true;
  }

  /** STEP 3 (calendar): Navigate to start month and click start day. */
  window.step3_calendar_startDate = async function (startDate) {
    const d = startDate ? (typeof startDate === 'string' ? (() => { const [m,d,y] = startDate.split('/'); return new Date(+y, +m - 1, +d); })() : startDate) : defaultStart;
    console.log('[Step 3 calendar] Start date:', toMDYFromDate(d));
    const dd = document.querySelector(dateRange.calendarDropdown);
    if (!dd) { console.error('[Step 3 calendar] Dropdown not found.'); return; }
    const ok = await ensureMonthVisible(d.getMonth(), d.getFullYear());
    if (!ok) { console.error('[Step 3 calendar] Could not show start month.'); return; }
    const vis = getCalendarVisibleRange(dd);
    const leftCal = dd.querySelector(dateRange.calendarLeft);
    const rightCal = dd.querySelector(dateRange.calendarRight);
    const targetAbs = d.getFullYear() * 12 + d.getMonth();
    const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
    const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
    const pane = targetAbs === leftAbs ? leftCal : targetAbs === rightAbs ? rightCal : leftCal;
    const clicked = await clickDayInCalendar(pane, d.getDate());
    console.log(clicked ? '[Step 3 calendar] Clicked start day.' : '[Step 3 calendar] Failed to click start day.');
  };

  /** STEP 4 (calendar): Navigate to end month and click end day. */
  window.step4_calendar_endDate = async function (endDate) {
    const d = endDate ? (typeof endDate === 'string' ? (() => { const [m,d,y] = endDate.split('/'); return new Date(+y, +m - 1, +d); })() : endDate) : defaultEnd;
    console.log('[Step 4 calendar] End date:', toMDYFromDate(d));
    const dd = document.querySelector(dateRange.calendarDropdown);
    if (!dd) { console.error('[Step 4 calendar] Dropdown not found.'); return; }
    const ok = await ensureMonthVisible(d.getMonth(), d.getFullYear());
    if (!ok) { console.error('[Step 4 calendar] Could not show end month.'); return; }
    const vis = getCalendarVisibleRange(dd);
    const leftCal = dd.querySelector(dateRange.calendarLeft);
    const rightCal = dd.querySelector(dateRange.calendarRight);
    const targetAbs = d.getFullYear() * 12 + d.getMonth();
    const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
    const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
    const pane = targetAbs === leftAbs ? leftCal : targetAbs === rightAbs ? rightCal : rightCal;
    const clicked = await clickDayInCalendar(pane, d.getDate());
    console.log(clicked ? '[Step 4 calendar] Clicked end day.' : '[Step 4 calendar] Failed to click end day.');
  };

  /** Run all steps in one shot (input-based). Optional: runAll(startStr, endStr) */
  window.runAll = async function (startStr, endStr) {
    console.log('[runAll] Starting (input flow)...');
    await step1_selectDateRangeButton();
    await step2_openPicker();
    await step3_enterDate1(startStr);
    await step4_enterDate2(endStr);
    await step5_closeDatePicker();
    console.log('[runAll] Done.');
  };

  /** Run full flow by clicking dates on the calendar. */
  window.runAllCalendar = async function (startStr, endStr) {
    console.log('[runAllCalendar] Starting (calendar click flow)...');
    await step1_selectDateRangeButton();
    await step2_openPicker();
    await step3_calendar_startDate(startStr);
    await step4_calendar_endDate(endStr);
    await step5_closeDatePicker();
    console.log('[runAllCalendar] Done.');
  };

  console.log('Date range steps loaded.');
  console.log('  Calendar flow: await runAllCalendar() or runAllCalendar("01/15/2025", "01/22/2025")');
  console.log('  Input flow: await runAll() or runAll("01/15/2025", "01/22/2025")');
  console.log('  Step by step calendar: step1 → step2 → step3_calendar_startDate → step4_calendar_endDate → step5');
})();
