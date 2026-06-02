/**
 * DATE RANGE – Direct set test (bypass picker)
 * =============================================
 * Instead of opening the picker and filling start/end inputs, this tries to set
 * the element that DISPLAYS the dates (the "original" readout) directly.
 *
 * 1. Paste this entire file into the console once.
 * 2. Edit DATE_DISPLAY_SELECTOR below: replace with the selector or XPath for
 *    the element that shows the entered dates (inspect in DevTools, copy selector).
 * 3. Run: await step1_selectDateRangeButton() then await step2_setDatesDirect()
 *
 * If the app uses a hidden input or a contenteditable, we set value/text and
 * fire input/change so the form updates.
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byXPath = (xp) => {
    const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return r.singleNodeValue || null;
  };
  const bySelector = (sel) => {
    if (sel.startsWith('/')) return byXPath(sel);
    return document.querySelector(sel) || document.getElementById(sel.replace(/^#/, ''));
  };
  const shown = (el) => !!(el && (el.offsetParent !== null || (el.getClientRects?.().length || 0) > 0));
  const M = (el, t) => el && el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  const P = (el, t) => el && el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  const clickLikeHuman = (el) => {
    if (!el) return;
    P(el, 'pointerdown');
    M(el, 'mousedown');
    P(el, 'pointerup');
    M(el, 'mouseup');
    M(el, 'click');
  };
  const fire = (el, type) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  const toMDY = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  };
  const setNativeValue = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  };

  const periodOfService = {
    dateRangeRadioId: 'provided-service-period-of-service-1',
    dateRangeLabelId: 'Date Range-label',
  };

  // --- REPLACE with the element that shows the dates (e.g. id, class, or XPath) ---
  const DATE_DISPLAY_SELECTOR = '#provided-service-dates';  // example: or '.ui-duration-field__fake-input__value' or XPath
  const DATE_DISPLAY_XPATH = '/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[1]';  // or the display div

  const defaultStart = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();
  const defaultEnd = new Date();

  window.step1_selectDateRangeButton = async function () {
    console.log('[Direct] Step 1: Selecting "Date Range" radio...');
    const radio =
      document.getElementById(periodOfService.dateRangeRadioId) ||
      document.querySelector('input[name="provided_service.period_of_service"][value="Date Range"]') ||
      (() => {
        const label = document.getElementById(periodOfService.dateRangeLabelId) ||
          Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === 'Date Range');
        return label ? document.getElementById(label.getAttribute('for')) : null;
      })();
    if (!radio) {
      console.error('[Direct] "Date Range" radio not found.');
      return;
    }
    if (!radio.checked) {
      clickLikeHuman(radio);
      await sleep(400);
      const labelFor = document.querySelector(`label[for="${periodOfService.dateRangeRadioId}"]`);
      if (labelFor && !radio.checked) clickLikeHuman(labelFor);
      await sleep(300);
    }
    console.log('[Direct] Step 1 done.');
  };

  /**
   * Set the date range by updating the display element directly (no picker).
   * Tries: (1) element is an input -> set value; (2) element is div/span -> set textContent + input/change.
   */
  window.step2_setDatesDirect = async function (startStr, endStr) {
    const start = startStr != null ? (typeof startStr === 'string' ? startStr : toMDY(startStr)) : toMDY(defaultStart);
    const end = endStr != null ? (typeof endStr === 'string' ? endStr : toMDY(endStr)) : toMDY(defaultEnd);
    const rangeText = `${start} - ${end}`;
    console.log('[Direct] Step 2: Setting date display to:', rangeText);

    const el = bySelector(DATE_DISPLAY_SELECTOR) || byXPath(DATE_DISPLAY_XPATH);
    if (!el) {
      console.error('[Direct] Date display element not found. Edit DATE_DISPLAY_SELECTOR or DATE_DISPLAY_XPATH in the script.');
      return;
    }
    if (!shown(el)) {
      console.warn('[Direct] Element found but not visible:', el);
    }

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      setNativeValue(el, rangeText);
      fire(el, 'input');
      fire(el, 'change');
      el.blur();
      console.log('[Direct] Set input value:', el.value);
    } else {
      el.textContent = rangeText;
      if (el.getAttribute('contenteditable') === 'true') {
        fire(el, 'input');
        fire(el, 'change');
      }
      console.log('[Direct] Set textContent:', el.textContent);
    }
    await sleep(200);
    console.log('[Direct] Step 2 done.');
  };

  /**
   * Optional: set both the visible display AND the two hidden/backing inputs
   * (#provided-service-dates-start, #provided-service-dates-end) so the form has both.
   */
  window.step2_setDatesDirectAndInputs = async function (startStr, endStr) {
    const start = startStr != null ? (typeof startStr === 'string' ? startStr : toMDY(startStr)) : toMDY(defaultStart);
    const end = endStr != null ? (typeof endStr === 'string' ? endStr : toMDY(endStr)) : toMDY(defaultEnd);
    const rangeText = `${start} - ${end}`;
    console.log('[Direct] Setting display + start/end inputs to:', rangeText);

    const displayEl = bySelector(DATE_DISPLAY_SELECTOR) || byXPath(DATE_DISPLAY_XPATH);
    const startInput = document.getElementById('provided-service-dates-start') || byXPath("/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[1]");
    const endInput = document.getElementById('provided-service-dates-end') || byXPath("/html/body/div[2]/div[2]/main/div/section/div/div[2]/div/div[1]/div[2]/div[2]/div/div[2]/div/form/div[4]/div[1]/div/div/div[2]/div[1]/input[2]");

    if (displayEl) {
      const tag = (displayEl.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        setNativeValue(displayEl, rangeText);
        fire(displayEl, 'input');
        fire(displayEl, 'change');
      } else {
        displayEl.textContent = rangeText;
        fire(displayEl, 'input');
        fire(displayEl, 'change');
      }
      console.log('[Direct] Updated display element.');
    }
    if (startInput) {
      setNativeValue(startInput, start);
      fire(startInput, 'input');
      fire(startInput, 'change');
      console.log('[Direct] Updated start input:', start);
    }
    if (endInput) {
      setNativeValue(endInput, end);
      fire(endInput, 'input');
      fire(endInput, 'change');
      console.log('[Direct] Updated end input:', end);
    }
    await sleep(200);
    console.log('[Direct] Done.');
  };

  console.log('Direct date set loaded. Edit DATE_DISPLAY_SELECTOR / DATE_DISPLAY_XPATH, then run:');
  console.log('  await step1_selectDateRangeButton()');
  console.log('  await step2_setDatesDirect()');
  console.log('Or with start/end inputs too: await step2_setDatesDirectAndInputs()');
})();
