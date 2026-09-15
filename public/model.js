/* ==========================================================================
   The rules. No DOM here.

   Everything the page computes from the records lives in this file, and the
   tests require the same file — so a figure can never be derived two ways.

   The one idea: a day is clean unless a record says otherwise. The store only
   ever lists the days that broke a streak, each carrying one boolean per
   habit, and a day whose every habit is unmarked is deleted rather than kept
   as a row of falses. A streak is then simply the distance from today back to
   the nearest record with that habit marked.
   ========================================================================== */

'use strict';

const Model = (() => {
  // The habits the view tracks, in the order they are shown: the streak tiles
  // read left to right in this order, and so do the two halves of every
  // calendar day. A record carries one boolean under each key. Adding a habit
  // here adds a tile and a third slice to every day; nothing else changes.
  const HABITS = [
    { key: 'alcohol', label: 'Alcohol' },
    { key: 'cannabis', label: 'Cannabis' },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const parts = (s) => s.split('-').map(Number);

  /**
   * A Date as YYYY-MM-DD in *local* time.
   *
   * Date.toISOString() is UTC, which after 5pm on the Pacific coast is already
   * tomorrow. A streak counted from that would gain a day every evening and
   * lose it again every morning, and a click at 9pm would mark the wrong day.
   * Every "today" in the app comes through here.
   */
  function dayOf(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const monthOf = (day) => day.slice(0, 7);

  /**
   * Whole days from `from` to `to`, both YYYY-MM-DD; negative when `to` is
   * earlier. Done in UTC on purpose: local-time subtraction across a clock
   * change comes out at 23 or 25 hours, and rounding that is a bug that waits
   * for March to show itself.
   */
  function daysBetween(from, to) {
    const [fy, fm, fd] = parts(from);
    const [ty, tm, td] = parts(to);
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
  }

  /** The month `delta` months on from `ym` (YYYY-MM); negative goes back. */
  function shiftMonth(ym, delta) {
    const [y, m] = parts(ym);
    const total = y * 12 + (m - 1) + delta;
    const year = Math.floor(total / 12);
    return `${year}-${pad(total - year * 12 + 1)}`;
  }

  /**
   * The weeks of a month as rows of seven day ids, Sunday first, the way the
   * calendar on this machine prints them. Cells outside the month are null so
   * the grid keeps its shape and the page draws a blank there rather than the
   * tail of the previous month — which would be clickable, and a click on a
   * day that belongs to another month is the kind of slip a streak tracker
   * should not invite.
   */
  function monthGrid(ym) {
    const [y, m] = parts(ym);
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = Array(lead).fill(null);
    for (let d = 1; d <= count; d++) cells.push(`${ym}-${pad(d)}`);
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  const find = (records, id) => records.find((r) => r.id === id) || null;

  /** Whether a habit is marked on a day. Absent record, absent flag: clean. */
  const used = (records, id, habit) => Boolean(find(records, id)?.[habit]);

  /**
   * The most recent day on or before `today` with the habit marked, or null
   * when it has never been marked. Days after today are ignored: the calendar
   * refuses to mark them, but a record could still arrive from another device
   * whose clock is ahead, and a use in the future must not turn the streak
   * negative.
   */
  function lastUse(records, habit, today) {
    return records.reduce((best, r) => (
      r[habit] && r.id <= today && (!best || r.id > best) ? r.id : best
    ), null);
  }

  /**
   * Days since the last use: 0 on the day itself, 1 the day after, and so on.
   * Null when nothing has ever been logged, because "days without" has no
   * start to count from — the page shows a dash rather than a number it
   * invented.
   */
  function streak(records, habit, today) {
    const last = lastUse(records, habit, today);
    return last === null ? null : daysBetween(last, today);
  }

  /**
   * What a click on one half of one day produces. Never mutates the list.
   *
   * The caller saves `record`, or deletes it when `clean` says every habit is
   * now unmarked — a clean day is the absence of a record, so the file only
   * ever lists the days that broke a streak and never fills up with rows of
   * falses. `stored` says whether there is anything to delete: a day never
   * saved cannot go clean, but the check costs nothing and a 404 on delete
   * would read as an error.
   */
  function toggle(records, id, habit) {
    const current = find(records, id);
    const record = { ...(current || { id }) };
    for (const h of HABITS) record[h.key] = Boolean(record[h.key]);
    record[habit] = !record[habit];
    const clean = HABITS.every((h) => !record[h.key]);
    return { record, clean, stored: current !== null };
  }

  return { HABITS, dayOf, monthOf, daysBetween, shiftMonth, monthGrid, used, lastUse, streak, toggle };
})();

if (typeof module !== 'undefined') module.exports = Model;
