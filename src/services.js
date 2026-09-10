// The kinds of request a resident can file, defined once so the resident page,
// the dispatch email, the dashboard and the printed sign never drift apart.
//
// A location declares which of these it offers (locations.services). An
// elevator can be dirty or broken but never needs restocking; a dog-bag
// dispenser needs restocking and can break, but nobody asks for it to be
// cleaned. Offering a button that makes no sense in the room trains people to
// stop reading the screen.
'use strict';

const SERVICES = {
  cleaning: {
    key: 'cleaning',
    dept: 'housekeeping',
    emailPrefix: 'SERVICE REQUEST',
    // What the dispatch email says was reported.
    reported: 'needing housekeeping service',
    en: { button: 'Needs cleaning', short: 'Cleaning' },
    es: { button: 'Necesita limpieza', short: 'Limpieza' },
  },
  repair: {
    key: 'repair',
    dept: 'engineering',
    emailPrefix: 'REPAIR REQUEST',
    reported: 'reported as having something broken or not working',
    en: { button: 'Something is broken', short: 'Repair' },
    es: { button: 'Algo está roto', short: 'Reparación' },
  },
  supply: {
    key: 'supply',
    dept: 'housekeeping',
    emailPrefix: 'RESUPPLY REQUEST',
    reported: 'reported as empty or running low on supplies',
    en: { button: 'Out of supplies', short: 'Resupply' },
    es: { button: 'Faltan suministros', short: 'Suministros' },
  },
};

const ORDER = ['cleaning', 'repair', 'supply'];

// Stored as a comma-separated list rather than a join table: there are three
// possible values and no query ever filters on them, so a table would be
// ceremony without benefit.
//
// Declared order is preserved, because the first option is the one rendered as
// the primary button. At a dog-bag dispenser the likely action is "out of
// supplies", not "something is broken" -- forcing a canonical order would put
// the wrong button under the reader's thumb.
function parseServices(raw) {
  const seen = new Set();
  const wanted = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SERVICES[s] && !seen.has(s) && seen.add(s));

  // A location with no valid services would render a page with no buttons.
  return wanted.length ? wanted : ['cleaning'];
}

function serialize(list) {
  return parseServices(Array.isArray(list) ? list.join(',') : list).join(',');
}

function get(key) {
  return SERVICES[key] || SERVICES.cleaning;
}

function isValid(key) {
  return Object.prototype.hasOwnProperty.call(SERVICES, key);
}

// The resupply picker items for a location. Stored as "Towels / Toallas,Water
// / Agua": English before the slash, Spanish after, so one string carries both
// languages. Returns [{ key, en, es }]; key is what the form posts back.
function parseSupplies(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [en, es] = item.split('/').map((x) => x.trim());
      return {
        key: en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        en,
        es: es || en,
      };
    });
}

module.exports = { SERVICES, ORDER, parseServices, parseSupplies, serialize, get, isValid };
