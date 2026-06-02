/**
 * Paste into the browser console on the billing form page to test:
 * - When dates are CLAMPED to one day (start === end), we do NOT currently
 *   use a different entry path (e.g. "Single Date" radio + one field).
 * - We always use "Date Range" and fill start + end (same value when one day).
 *
 * This script:
 * 1. Defines the decision: is it a single day? (start === end)
 * 2. Exposes helpers to try "Single Date" path vs "Date Range" path so you can
 *    test manually which works when the form is clamped to one date.
 *
 * Usage (after pasting):
 *   singleDateVsRange.isOneDay('2026-02-23', '2026-02-23')  // true
 *   singleDateVsRange.isOneDay('2026-02-23', '2026-03-01')  // false
 *   singleDateVsRange.useSingleDatePath('2/23/2026')        // click Single Date radio, fill one field (you may need to adjust selectors)
 *   singleDateVsRange.useDateRangePath('2/23/2026', '2/23/2026')  // current behavior: Date Range + same start/end
 */

(function () {
  const toMDY = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${m}/${d}/${y}`;
  };

  const isOneDay = (startISO, endISO) => {
    if (!startISO || !endISO) return false;
    return startISO === endISO;
  };

  /** Current app behavior: we always use Date Range and set start + end (same when clamped to one day). */
  const useDateRangePath = (startMDY, endMDY) => {
    const period = {
      dateRangeRadioId: 'provided-service-period-of-service-1',
      dateRangeLabelId: 'Date Range-label',
    };
    const dr = {
      startInputId: 'provided-service-dates-start',
      endInputId: 'provided-service-dates-end',
    };
    const byId = (id) => document.getElementById(id);
    const dateRangeRadio =
      byId(period.dateRangeRadioId) ||
      document.querySelector('input[name="provided_service.period_of_service"][value="Date Range"]');
    if (dateRangeRadio && !dateRangeRadio.checked) {
      dateRangeRadio.click();
      console.log('[Test] Selected "Date Range" radio.');
    }
    const startInput = byId(dr.startInputId);
    const endInput = byId(dr.endInputId);
    if (startInput && endInput) {
      const set = (el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(startInput, startMDY);
      set(endInput, endMDY);
      console.log('[Test] Date Range path: set start=%s end=%s', startMDY, endMDY);
      return true;
    }
    console.warn('[Test] Date Range inputs not found.');
    return false;
  };

  /**
   * Alternative path when clamped to one date: select "Single Date" and fill one field.
   * Radio value/ids are guesses (often -0 = Single Date, -1 = Date Range). Adjust if your form differs.
   */
  const useSingleDatePath = (singleDateMDY) => {
    const singleDateRadio =
      document.getElementById('provided-service-period-of-service-0') ||
      document.querySelector('input[name="provided_service.period_of_service"][value="Single Date"]') ||
      Array.from(document.querySelectorAll('input[name="provided_service.period_of_service"]')).find(
        (r) => (r.nextElementSibling?.textContent || '').trim().toLowerCase().includes('single')
      );
    if (!singleDateRadio) {
      console.warn('[Test] "Single Date" radio not found. Try inspecting the form for the correct id/value.');
      return false;
    }
    if (!singleDateRadio.checked) {
      singleDateRadio.click();
      console.log('[Test] Selected "Single Date" radio.');
    }
    // Single-date field may be the same trigger but one input when Single Date is selected (e.g. provided-service-date or one of the start/end ids).
    const singleInput =
      document.getElementById('provided-service-date') ||
      document.getElementById('provided-service-dates-start');
    if (singleInput) {
      singleInput.value = singleDateMDY;
      singleInput.dispatchEvent(new Event('input', { bubbles: true }));
      singleInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[Test] Single Date path: set date=%s', singleDateMDY);
      return true;
    }
    console.warn('[Test] Single date input not found.');
    return false;
  };

  const api = {
    isOneDay,
    toMDY,
    useDateRangePath,
    useSingleDatePath,
    /** Simulate clamp result: one day. */
    runOneDayTest() {
      const start = '2026-02-23';
      const end = '2026-02-23';
      console.log('One-day (clamped) scenario: start=%s end=%s', start, end);
      console.log('isOneDay:', isOneDay(start, end));
      const mdy = toMDY(start);
      console.log('To try Single Date path: singleDateVsRange.useSingleDatePath("' + mdy + '")');
      console.log('To try Date Range path (current): singleDateVsRange.useDateRangePath("' + mdy + '", "' + mdy + '")');
    },
  };

  window.singleDateVsRange = api;

  // Demo
  console.log('singleDateVsRange loaded.');
  console.log('Clamped to one day?', isOneDay('2026-02-23', '2026-02-23'));
  console.log('Range?', isOneDay('2026-02-23', '2026-03-01'));
  api.runOneDayTest();
})();
