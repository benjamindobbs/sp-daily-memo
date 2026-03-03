// Converts "Week 6 Counselor Assignment Tool - Schedules By Name.csv"
// into a properly formatted counselors-import.csv for the camp hub importer.
// Run: node convert-counselors.js

const fs = require('fs');

// Parse a single CSV line, respecting double-quoted fields that may contain commas
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

// Wrap a field in quotes if it contains a comma or double-quote
function csvField(val) {
    if (val.includes(',') || val.includes('"')) return `"${val.replace(/"/g, '""')}"`;
    return val;
}

const COLOR_MAP = { N: 'Navy', G: 'Green', R: 'Red', C: 'Carolina' };

// For each schedule type: which 0-based column indices hold the activity names,
// and which DB period number each maps to.
const PERIOD_MAP = {
    'All Sports':              { cols: [3,5,7,9,11,13], periods: [1,2,3,4,5,6] },
    'All Enrichment':          { cols: [3,6,9,12],      periods: [1,2,4,5]     },
    'AM Sports PM Enrichment': { cols: [3,5,7,9,12],    periods: [1,2,3,4,5]   },
    'AM Enrichment PM Sports': { cols: [3,6,9,11,13],   periods: [1,2,4,5,6]   },
};

const SCHED_TYPE_RENAME = {
    'AM Sports PM Enrichment': 'Sports AM Enrichment PM',
    'AM Enrichment PM Sports': 'Enrichment AM Sports PM',
};

const inputFile  = 'Week 6 Counselor Assignment Tool - Schedules By Name.csv';
const outputFile = 'counselors-import.csv';

const content = fs.readFileSync(inputFile, 'utf8');
const lines   = content.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());

const outputRows = [
    ['FirstName','LastName','HomeGroupColor','ScheduleType','Bus','Extended','P1','P2','P3','P4','P5','P6']
];

for (const line of lines.slice(1)) { // skip header row
    const cols         = parseCSVLine(line);
    const scheduleType = cols[0] || '';
    const fullName     = cols[1] || '';
    const colorAbbr    = cols[2] || '';

    // Skip rows without a recognised schedule type (e.g. embedded legend rows)
    if (!fullName || !PERIOD_MAP[scheduleType]) continue;

    // Last word → LastName; everything before → FirstName
    const nameParts = fullName.split(' ');
    const lastName  = nameParts.pop();
    const firstName = nameParts.join(' ');

    const color     = COLOR_MAP[colorAbbr] || '';
    const schedType = SCHED_TYPE_RENAME[scheduleType] || scheduleType;

    const { cols: actCols, periods } = PERIOD_MAP[scheduleType];
    const periodSlots = ['', '', '', '', '', '']; // index 0–5 = P1–P6

    for (let i = 0; i < actCols.length; i++) {
        const colIdx     = actCols[i];
        const dbPeriodIdx = periods[i] - 1; // convert 1-based period to 0-based index
        let activity = colIdx < cols.length ? cols[colIdx] : '';
        if (activity === 'Not Assigned') activity = '';
        periodSlots[dbPeriodIdx] = activity;
    }

    outputRows.push([firstName, lastName, color, schedType, '', '', ...periodSlots]);
}

const csvContent = outputRows.map(row => row.map(csvField).join(',')).join('\n');
fs.writeFileSync(outputFile, csvContent, 'utf8');
console.log(`Done — converted ${outputRows.length - 1} counselors → ${outputFile}`);
