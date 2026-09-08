// The canonical list of every location that gets a QR sign at Aston Martin
// Residences. This file is the source of truth -- editing it and re-running
// "npm run seed -- --building" adds anything new without touching what exists.
//
// Elevator inventory confirmed by Operations 2026-08-30: 17 cabs total.
//   Service      S1-S5                        (5)
//   Residential  P1-P9, P11, P12              (11 -- there is no P10)
//   LULA                                      (1)
//
// sort_order controls dashboard and sign-sheet ordering. Alphabetical would
// interleave P1, P11, P12, P2 -- which is exactly the kind of thing that gets a
// sticker installed in the wrong cab.
'use strict';

const locations = [];
let order = 0;

// Which buttons the resident sees. Offering an option that makes no sense in
// the room teaches people to stop reading the screen, so these are deliberate:
//
//   CLEAN_FIX     cleaning + repair. Anywhere that can be dirty or broken but
//                 holds no consumables -- elevators, cinemas, the golf sim.
//   FULL          cleaning + repair + resupply. Anywhere stocked with towels,
//                 paper or amenities.
//   SUPPLY_FIX    resupply + repair. A dispenser: nobody asks for it to be
//                 cleaned, but it runs out and it breaks.
const CLEAN_FIX = ['cleaning', 'repair'];
const FULL = ['cleaning', 'repair', 'supply'];
const SUPPLY_FIX = ['supply', 'repair'];

function add(labelEn, labelEs, kind, department, services) {
  locations.push({
    labelEn, labelEs, kind, department,
    services: services || CLEAN_FIX,
    sortOrder: (order += 10),
  });
}

// --- Elevators -------------------------------------------------------------

for (const n of [1, 2, 3, 4, 5]) {
  add(`Service Elevator S${n}`, `Ascensor de Servicio S${n}`, 'elevator', 'housekeeping');
}

for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]) {
  add(`Residential Elevator P${n}`, `Ascensor Residencial P${n}`, 'elevator', 'housekeeping');
}

// LULA: Limited Use / Limited Application. Kept as the technical name in both
// languages because that is what it is labelled in the cab and what Engineering
// and the elevator contractor call it.
add('LULA Elevator', 'Ascensor LULA', 'elevator', 'housekeeping');

// --- Amenities -------------------------------------------------------------
//
// Compound names from the amenity list have been split into separate signs
// wherever they are separate rooms. That is the reversible direction: merging
// two signs later means deactivating one, while splitting one sign later means
// new tokens and a reprint. A QR whose whole purpose is to say exactly where
// the problem is should not answer "one of these two cinemas".

add('Main Pool Deck', 'Terraza de la Piscina Principal', 'amenity', 'housekeeping', FULL);
add('Indoor Pool', 'Piscina Interior', 'amenity', 'housekeeping', FULL);
add('Rooftop Cabana and Spa', 'Cabaña y Spa en la Azotea', 'amenity', 'housekeeping', FULL);
add('Fitness Center', 'Gimnasio', 'amenity', 'housekeeping', FULL);

// "His and Her Spa" -> two facilities. A housekeeper sent to the wrong one has
// to walk back out, and in a spa that is not a neutral mistake.
add("Men's Spa", 'Spa de Caballeros', 'amenity', 'housekeeping', FULL);
add("Women's Spa", 'Spa de Damas', 'amenity', 'housekeeping', FULL);

add('Treatment Rooms', 'Salas de Tratamiento', 'amenity', 'housekeeping', FULL);
add('Conference Room', 'Sala de Conferencias', 'amenity', 'housekeeping');
add('Business Center', 'Centro de Negocios', 'amenity', 'housekeeping');

// "Barber Shop and Beauty Salon" -> split for the same reason as the spa.
add('Barber Shop', 'Barbería', 'amenity', 'housekeeping');
add('Beauty Salon', 'Salón de Belleza', 'amenity', 'housekeeping');

add('Golf Simulator', 'Simulador de Golf', 'amenity', 'housekeeping');
add('Interactive Putting Green', 'Putting Green Interactivo', 'amenity', 'housekeeping');

// "Grand Cinema and Small Cinema" -> two rooms.
add('Grand Cinema', 'Gran Cine', 'amenity', 'housekeeping');
add('Small Cinema', 'Cine Pequeño', 'amenity', 'housekeeping');

// "Teens Room and Kids Playroom" -> two rooms, and the difference matters for
// what kind of mess is being reported.
add('Teens Room', 'Sala de Adolescentes', 'amenity', 'housekeeping');
add('Kids Playroom', 'Sala de Juegos Infantil', 'amenity', 'housekeeping');

add('Grand Salon', 'Gran Salón', 'amenity', 'housekeeping');

// --- Added 2026-09-08 by Operations ----------------------------------------

// Six rooftop cabanas, each with its own code. A shared cabana code would tell
// housekeeping the roof needs attention without saying which cabana, which is
// the one thing this system exists to avoid.
for (const n of [1, 2, 3, 4, 5, 6]) {
  add(`Cabana ${n}`, `Cabaña ${n}`, 'amenity', 'housekeeping', FULL);
}

// Lobby restrooms, split by gender: a housekeeper sent to the wrong one has to
// walk back out, and in a lobby that is not a discreet mistake.
add("Lobby Men's Restroom", 'Baño de Caballeros del Vestíbulo', 'amenity', 'housekeeping', FULL);
add("Lobby Women's Restroom", 'Baño de Damas del Vestíbulo', 'amenity', 'housekeeping', FULL);

// Dog waste bag dispensers around the building perimeter.
//
// Kind is 'supply' rather than 'amenity' so the printed sign reads "Supply
// Request -- scan to report empty or running low". Asking a resident holding a
// dog to "request housekeeping service" would be the wrong question.
//
// One code covers the whole perimeter as requested. If there is more than one
// dispenser out there, housekeeping will know a station is empty but not which
// one -- see the note in README under "Adding a location".
add('Dog Bag Station', 'Estación de Bolsas para Perros', 'supply', 'housekeeping', SUPPLY_FIX);

module.exports = {
  locations,
  counts: {
    elevators: locations.filter((l) => l.kind === 'elevator').length,
    amenities: locations.filter((l) => l.kind === 'amenity').length,
    supply: locations.filter((l) => l.kind === 'supply').length,
    total: locations.length,
  },
};
