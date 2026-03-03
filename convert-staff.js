// Converts "Week 6 Counselor Assignment Tool - Course Variables.csv"
// into staff-import.csv for the camp hub staff importer.
// Run: node convert-staff.js

const fs = require('fs');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function csvField(val) {
    if (!val) return '';
    if (val.includes(',') || val.includes('"') || val.includes('\n'))
        return `"${val.replace(/"/g, '""')}"`;
    return val;
}

// Maps sports course names to their correct locations.
// Indoor/Outdoor labels in the source CSV are replaced using this.
const LOCATION_MAP = {
    'Archery':                  'Archery Range',
    'Basketball':               'Sports Center Gym',
    'Board Games':              'Hawk Hall',
    'Cheerleading':             'Sports Center Gym',
    'Dance':                    'Dance Studio',
    'Fitness Training':         'Yoga Studio',
    'Flag Football':            'Al-Marzook Field',
    'Game of the Day':          'Fiondella Field',
    'Go Girl':                  'Fiondella Field',
    'Indoor Soccer/Broomball':  'Sports Center Gym',
    'Indoor Soccer':            'Sports Center Gym',
    'Lacrosse':                 'Al-Marzook Field',
    'Rec Swim':                 'Pool',
    'Soccer':                   'Al-Marzook Field',
    'Sports Pals (triple period)': 'Sports Center Gym',
    'Street Hockey':            'Sports Center Gym',
    'Swim Lessons':             'Pool',
    'Swim Lesson':              'Pool',
    'Tee Ball/Kickball':        'Softball Field',
    'Teeball/Kickball':         'Softball Field',
    'Tennis':                   'Tennis Court',
    'Yard Games':               'Fiondella Field',
    'Yoga':                     'Yoga Studio',
    'Baseball/Softball':        'Softball Field',
};

function getSportsLocation(courseName) {
    if (!courseName) return '';
    if (LOCATION_MAP[courseName]) return LOCATION_MAP[courseName];
    // Partial match fallback
    for (const [key, val] of Object.entries(LOCATION_MAP)) {
        if (courseName.toLowerCase().includes(key.toLowerCase())) return val;
    }
    return 'Sports Center Gym'; // default
}

// Split "First Last" into { firstName, lastName }.
// Single-word names (sports ULs) get empty lastName.
function splitName(fullName) {
    const parts = fullName.trim().split(' ');
    const lastName = parts.length > 1 ? parts.pop() : '';
    return { firstName: parts.join(' '), lastName };
}

// ── Read file ───────────────────────────────────────────────────────────────
const content  = fs.readFileSync('Week 6 Counselor Assignment Tool - Course Variables.csv', 'utf8');
const rawLines = content.split('\n').map(l => l.replace(/\r$/, ''));

// Sports data rows: display lines 4–13 → 0-based indices 3–12
const sportsRows = rawLines.slice(3, 13);

// Enrichment data rows: display lines 31–43 → 0-based indices 30–42
const enrichmentRows = rawLines.slice(30, 43);

// ── Parse sports (6 periods × 6 columns each) ────────────────────────────
// Layout per period i (0-based): base = 1 + 6*i
//   base+0 = Course, base+1 = UL name, base+3 = Location (ignored — use LOCATION_MAP)
const DB_SPORTS_PERIODS = [1, 2, 3, 4, 5, 6];

const ulSchedule = {}; // { ulName: { dbPeriod: { course, location } } }

for (const rawLine of sportsRows) {
    if (!rawLine.trim()) continue;
    const cols = parseCSVLine(rawLine);

    for (let i = 0; i < 6; i++) {
        const base   = 1 + 6 * i;
        const course = cols[base]     || '';
        const ul     = cols[base + 1] || '';
        if (!course || !ul || ul === 'Counselor/Other') continue;

        const dbPeriod = DB_SPORTS_PERIODS[i];
        const location = getSportsLocation(course);

        if (!ulSchedule[ul]) ulSchedule[ul] = {};
        ulSchedule[ul][dbPeriod] = { course, location };
    }
}

// ── Parse enrichment (4 periods × 6 columns each, DB periods 1,2,4,5) ────
// Layout per period i (0-based): base = 1 + 6*i
//   base+0 = Course, base+1 = Instructor, base+2 = Location
const DB_ENRICHMENT_PERIODS = [1, 2, 4, 5];

const instrSchedule = {}; // { instrName: { dbPeriod: { course, location } } }

for (const rawLine of enrichmentRows) {
    if (!rawLine.trim()) continue;
    const cols = parseCSVLine(rawLine);

    for (let i = 0; i < 4; i++) {
        const base       = 1 + 6 * i;
        const course     = cols[base]     || '';
        const instructor = cols[base + 1] || '';
        const location   = cols[base + 2] || '';
        if (!course || !instructor) continue;

        const dbPeriod = DB_ENRICHMENT_PERIODS[i];

        if (!instrSchedule[instructor]) instrSchedule[instructor] = {};
        instrSchedule[instructor][dbPeriod] = { course, location };
    }
}

// ── Build output rows ────────────────────────────────────────────────────
function periodCols(schedule) {
    const out = [];
    for (let p = 1; p <= 6; p++) {
        const entry = schedule[p];
        out.push(entry ? entry.course   : '');
        out.push(entry ? entry.location : '');
    }
    return out; // [P1, L1, P2, L2, P3, L3, P4, L4, P5, L5, P6, L6]
}

const outputRows = [[
    'FirstName','LastName','StaffType','ColorGroup',
    'P1','L1','P2','L2','P3','L3','P4','L4','P5','L5','P6','L6'
]];

for (const [name, sched] of Object.entries(ulSchedule)) {
    const { firstName, lastName } = splitName(name);
    outputRows.push([firstName, lastName, 'Unit Leader', '', ...periodCols(sched)]);
}

for (const [name, sched] of Object.entries(instrSchedule)) {
    const { firstName, lastName } = splitName(name);
    outputRows.push([firstName, lastName, 'Instructor', '', ...periodCols(sched)]);
}

const csvContent = outputRows.map(row => row.map(csvField).join(',')).join('\n');
fs.writeFileSync('staff-import.csv', csvContent, 'utf8');
console.log(`Done — ${Object.keys(ulSchedule).length} Unit Leaders + ${Object.keys(instrSchedule).length} Instructors → staff-import.csv`);
