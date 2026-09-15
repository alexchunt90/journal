/*
 * The rules in public/model.js, run as the page runs them.
 *
 * Every function takes `today` as an argument rather than reading the clock,
 * which is what lets these be properties over fixed dates instead of tests
 * that pass on one day of the year.
 *
 *   node --test test/model.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Model, readExample, clone } = require('./helpers.js');

const records = () => clone(readExample('data/days.json'));
const TODAY = '2026-09-15';

describe('dayOf', () => {
  test('is the local calendar day, whatever the hour and wherever the machine is', () => {
    // 23:30 local is tomorrow in UTC anywhere west of Greenwich, and 00:30 is
    // yesterday anywhere east. Both must come out as the day that was set.
    assert.equal(Model.dayOf(new Date(2026, 8, 15, 23, 30)), '2026-09-15');
    assert.equal(Model.dayOf(new Date(2026, 8, 15, 0, 30)), '2026-09-15');
    assert.equal(Model.dayOf(new Date(2026, 0, 1)), '2026-01-01', 'zero-padded');
  });
});

describe('daysBetween', () => {
  test('counts whole days, negative backwards, and is unmoved by clock changes', () => {
    assert.equal(Model.daysBetween('2026-09-12', '2026-09-15'), 3);
    assert.equal(Model.daysBetween('2026-09-15', '2026-09-12'), -3);
    assert.equal(Model.daysBetween('2026-09-15', '2026-09-15'), 0);
    // Across the March and November changes in the Pacific zone.
    assert.equal(Model.daysBetween('2026-03-07', '2026-03-09'), 2);
    assert.equal(Model.daysBetween('2026-10-31', '2026-11-02'), 2);
    assert.equal(Model.daysBetween('2025-09-12', '2026-09-12'), 365);
  });
});

describe('shiftMonth', () => {
  test('a step forward and a step back is where it started, for every month', () => {
    for (let m = 1; m <= 12; m++) {
      const ym = `2026-${String(m).padStart(2, '0')}`;
      assert.equal(Model.shiftMonth(Model.shiftMonth(ym, 1), -1), ym);
      assert.equal(Model.shiftMonth(Model.shiftMonth(ym, -13), 13), ym);
    }
  });

  test('crosses a year boundary in both directions', () => {
    assert.equal(Model.shiftMonth('2026-12', 1), '2027-01');
    assert.equal(Model.shiftMonth('2026-01', -1), '2025-12');
    assert.equal(Model.shiftMonth('2026-09', -12), '2025-09');
    assert.equal(Model.shiftMonth('2026-09', 0), '2026-09');
  });
});

describe('monthGrid', () => {
  const months = ['2026-01', '2026-02', '2026-09', '2026-10', '2027-02', '2028-02', '2026-05'];

  test('every day of the month appears exactly once, in order, and nothing else does', () => {
    for (const ym of months) {
      const days = Model.monthGrid(ym).flat().filter(Boolean);
      const count = new Date(Date.UTC(...ym.split('-').map(Number), 0)).getUTCDate();
      assert.equal(days.length, count, ym);
      days.forEach((id, i) => assert.equal(id, `${ym}-${String(i + 1).padStart(2, '0')}`));
    }
  });

  test('rows are whole weeks that start on a Sunday', () => {
    for (const ym of months) {
      const weeks = Model.monthGrid(ym);
      for (const week of weeks) assert.equal(week.length, 7, ym);
      const first = weeks.flat().indexOf(`${ym}-01`);
      assert.equal(first, new Date(`${ym}-01T00:00:00Z`).getUTCDay(), `${ym} starts in the right column`);
      assert.ok(weeks.length >= 4 && weeks.length <= 6, `${ym} has ${weeks.length} weeks`);
    }
  });

  test('a 28-day month starting on a Sunday is exactly four rows', () => {
    // February 2027 begins on a Monday; February 2026 on a Sunday.
    assert.equal(Model.monthGrid('2026-02').length, 4);
    assert.equal(Model.monthGrid('2027-02').length, 5);
  });
});

describe('streak', () => {
  test('is null with nothing logged, because there is no day to count from', () => {
    assert.equal(Model.streak([], 'alcohol', TODAY), null);
    assert.equal(Model.lastUse([], 'alcohol', TODAY), null);
  });

  test('is zero on the day of a use and grows by one each day after', () => {
    const list = [{ id: '2026-09-12', alcohol: true, cannabis: false }];
    assert.equal(Model.streak(list, 'alcohol', '2026-09-12'), 0);
    for (let n = 0; n < 40; n++) {
      const day = Model.dayOf(new Date(2026, 8, 12 + n));
      assert.equal(Model.streak(list, 'alcohol', day), n);
    }
  });

  test('each habit counts from its own last use', () => {
    const list = records();
    assert.equal(Model.streak(list, 'alcohol', TODAY), Model.daysBetween('2026-08-29', TODAY));
    assert.equal(Model.streak(list, 'cannabis', TODAY), Model.daysBetween('2026-08-14', TODAY));
  });

  test('the latest use wins whatever order the records are in', () => {
    const list = records();
    const forwards = Model.streak(list, 'alcohol', TODAY);
    assert.equal(Model.streak(list.slice().reverse(), 'alcohol', TODAY), forwards);
    list.push({ id: '2026-09-01', alcohol: true, cannabis: false });
    assert.equal(Model.streak(list, 'alcohol', TODAY), Model.daysBetween('2026-09-01', TODAY));
  });

  test('a use after today is ignored rather than counted backwards', () => {
    const list = [...records(), { id: '2026-09-20', alcohol: true, cannabis: true }];
    assert.equal(Model.lastUse(list, 'alcohol', TODAY), '2026-08-29');
    assert.ok(Model.streak(list, 'cannabis', TODAY) > 0);
  });
});

describe('toggle', () => {
  test('marks a clean day, and the other habit stays clean', () => {
    const { record, clean, stored } = Model.toggle(records(), '2026-09-10', 'cannabis');
    assert.deepEqual(record, { id: '2026-09-10', alcohol: false, cannabis: true });
    assert.equal(clean, false);
    assert.equal(stored, false, 'nothing to delete: the day was never saved');
  });

  test('unmarking the only habit on a day makes the day clean, and the record is the one to delete', () => {
    const { record, clean, stored } = Model.toggle(records(), '2026-08-29', 'alcohol');
    assert.equal(clean, true);
    assert.equal(stored, true);
    assert.equal(record.version, 1, 'the version travels, so the delete is accepted');
  });

  test('two toggles of the same half are where it started', () => {
    const list = records();
    for (const id of ['2026-08-14', '2026-08-29', '2026-09-01']) {
      for (const h of Model.HABITS) {
        const before = Model.used(list, id, h.key);
        const once = Model.toggle(list, id, h.key).record;
        const twice = Model.toggle([...list.filter((r) => r.id !== id), once], id, h.key).record;
        assert.equal(Boolean(twice[h.key]), before, `${id} ${h.key}`);
      }
    }
  });

  test('never mutates the saved list', () => {
    const list = records();
    const snapshot = clone(list);
    Model.toggle(list, '2026-08-14', 'alcohol');
    Model.toggle(list, '2026-09-01', 'cannabis');
    assert.deepEqual(list, snapshot);
  });

  test('used reads absent records and absent flags as clean', () => {
    assert.equal(Model.used(records(), '2026-09-10', 'alcohol'), false);
    assert.equal(Model.used([{ id: '2026-09-10' }], '2026-09-10', 'alcohol'), false);
    assert.equal(Model.used(records(), '2026-08-29', 'cannabis'), false);
    assert.equal(Model.used(records(), '2026-08-29', 'alcohol'), true);
  });
});
