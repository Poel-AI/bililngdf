/**
 * Paste this entire file into the browser console to test the date-fill process
 * (single date → start + end, or date + endDate).
 *
 * Usage:
 *   fillDates({ date: '2026-02-23' })                    // one date → 7-day window
 *   fillDates({ date: '2026-02-23', endDate: '2026-03-01' })  // two dates
 *   fillDates({ date: '2026-02-23', endDate: 'nope' })    // invalid endDate → fallback to +6
 */

(function () {
  function fillDates(req) {
    const toISO = (d) => d.toISOString().split('T')[0];
    try {
      const [year, month, day] = req.date.split('-').map(Number);
      const reqStart = new Date(Date.UTC(year, month - 1, day));
      const reqEnd = new Date(reqStart);
      reqEnd.setUTCDate(reqEnd.getUTCDate() + 6); // 7 days inclusive

      req.start = toISO(reqStart);
      req.end =
        req.endDate && String(req.endDate).match(/^\d{4}-\d{2}-\d{2}$/)
          ? String(req.endDate)
          : toISO(reqEnd);

      return { start: req.start, end: req.end };
    } catch (e) {
      return { error: e.message };
    }
  }

  // --- Run examples ---
  const oneDate = { date: '2026-02-23' };
  const twoDates = { date: '2026-02-23', endDate: '2026-03-01' };
  const invalidEnd = { date: '2026-02-23', endDate: 'nope' };

  console.log('One date (2026-02-23):', fillDates({ ...oneDate }));
  console.log('Two dates (2026-02-23 + 2026-03-01):', fillDates({ ...twoDates }));
  console.log('One date + invalid endDate:', fillDates({ ...invalidEnd }));

  // Expose for manual tests: fillDates({ date: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' })
  window.fillDates = fillDates;
  console.log('Manual test: fillDates({ date: "2026-02-23" }) or fillDates({ date: "2026-02-23", endDate: "2026-03-01" })');
})();
