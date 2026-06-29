const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
const db = new Database(process.env.DB_PATH || 'camp_manager.db');
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

const HOME_GROUP_LABELS = {
    Red: 'Red', Carolina: 'Carolina', Green: 'Green', Navy: 'Navy',
    Bus: 'Bus', LilPlace: "Li'l Place", KinderPlace: 'Kinder Place', SPLIT: 'SPLIT',
    SPRC: 'SPRC', Swim: 'Swim Staff'
};
const SPECIALTY_CAMP_COLORS = ['LilPlace', 'KinderPlace', 'SPLIT', 'SPRC', 'Swim'];

// Period flip schedules — all times EST (UTC-5), 24-hour format.
// clockBlock = universal time-block number (1-6 matching Sports period numbering).
// Block 3 = Sports only (Green/Navy). Block 4 = S4 (Red/Carolina) + E3 (Green/Navy).
// Block 6 = Sports only (Red/Carolina). Enrichment runs in blocks 1, 2, 4, 5 only.
const SPORTS_PERIODS = [
    { startH: 9,  startM: 0,  label: 'Sports 1', clockBlock: 1 },
    { startH: 10, startM: 0,  label: 'Sports 2', clockBlock: 2 },
    { startH: 11, startM: 0,  label: 'Sports 3', clockBlock: 3 },
    { startH: 13, startM: 0,  label: 'Sports 4', clockBlock: 4 },
    { startH: 14, startM: 20, label: 'Sports 5', clockBlock: 5 },
    { startH: 15, startM: 30, label: 'Sports 6', clockBlock: 6 },
];

const ENRICHMENT_PERIODS = [
    { startH: 9,  startM: 0,  label: 'Enrichment 1', clockBlock: 1 },
    { startH: 10, startM: 35, label: 'Enrichment 2', clockBlock: 2 },
    { startH: 13, startM: 0,  label: 'Enrichment 3', clockBlock: 4 },
    { startH: 14, startM: 40, label: 'Enrichment 4', clockBlock: 5 },
];

const CAMP_DAY_START_MINS = 9 * 60;        // 9:00 AM
const CAMP_DAY_END_MINS   = 16 * 60 + 5;   // 4:05 PM (after Sports 6 ends)

function getESTMins() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour').value);
    const m = parseInt(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
}

function getTodayEST() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York'
    }).format(new Date()); // returns YYYY-MM-DD
}

// Returns the last period whose start time <= estMins (holds until next period begins).
function getActivePeriod(schedule, estMins) {
    let active = null;
    for (const p of schedule) {
        if (estMins >= p.startH * 60 + p.startM) active = p;
        else break;
    }
    return active;
}

// Given a pickup time (HH:MM) and a camper's HomeGroupColor, returns the clock block
// they will be in. Green/Navy do Sports in the morning and Enrichment in the afternoon;
// Red/Carolina do the reverse. Specialty camps return null (can't infer).
function inferPeriodFromTime(timeMins, homeGroupColor) {
    if (!homeGroupColor || SPECIALTY_CAMP_COLORS.includes(homeGroupColor)) return null;
    if (timeMins < CAMP_DAY_START_MINS || timeMins >= CAMP_DAY_END_MINS) return null;
    const isGreenNavy = homeGroupColor === 'Green' || homeGroupColor === 'Navy';
    const isMorning   = timeMins < 13 * 60;
    const schedule    = (isGreenNavy === isMorning) ? SPORTS_PERIODS : ENRICHMENT_PERIODS;
    return getActivePeriod(schedule, timeMins)?.clockBlock ?? null;
}

function getHubMode(estMins) {
    if (estMins < CAMP_DAY_START_MINS) return 'precamp';
    if (estMins >= CAMP_DAY_END_MINS)  return 'postcamp';
    if (estMins >= 12 * 60 && estMins < 13 * 60) return 'lunch';
    return 'classes';
}

// Photo of the Day phases (NY EST):
//   submission  — 9:00 AM to  3:59 PM  (9*60 – 16*60)
//   voting      — 4:00 PM to  4:14 PM  (16*60 – 16*60+15)
//   winner      — 4:15 PM onward       (>= 16*60+15)
//   closed      — before 9:00 AM
function getPhotoPhase() {
    const mins = getESTMins();
    if (mins < 9 * 60)        return 'closed';
    if (mins < 16 * 60)       return 'submission';
    if (mins < 16 * 60 + 15)  return 'voting';
    return 'winner';
}

function computeClassAttStats(clockBlock, side, today) {
    const classes = db.prepare(`
        SELECT DISTINCT s.ActivityName
        FROM Schedules s
        JOIN Activities a ON a.Name = s.ActivityName
        WHERE s.PersonType = 'Camper' AND s.PeriodNumber = ? AND a.SideOfCamp = ?
    `).all(clockBlock, side);
    if (classes.length === 0) return { total: 0, submitted: 0 };
    const checkTotal   = db.prepare("SELECT COUNT(*) as n FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?");
    const checkHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?)
        )
    `);
    let submitted = 0;
    for (const c of classes) {
        const total   = checkTotal.get(clockBlock, c.ActivityName)?.n || 0;
        const handled = checkHandled.get(today, clockBlock, c.ActivityName, today, clockBlock, c.ActivityName)?.n || 0;
        if (total > 0 && handled >= total) submitted++;
    }
    return { total: classes.length, submitted };
}

function computeExtAttStats(session, today) {
    const n = db.prepare(
        "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType=?"
    ).get(today, `extended_${session}`)?.n || 0;
    return { total: 1, submitted: n > 0 ? 1 : 0 };
}

function computeBusAttStats(session, today) {
    const total = db.prepare(
        "SELECT COUNT(DISTINCT BusRoute) as n FROM Campers WHERE BusRoute IS NOT NULL AND BusRoute != '' AND LOWER(CAST(BusRoute AS TEXT)) != 'null'"
    ).get().n || 0;
    const submitted = db.prepare(`
        SELECT COUNT(DISTINCT c.BusRoute) as n
        FROM Attendance att
        JOIN Campers c ON c.CamperID = att.CamperID
        WHERE att.Date=? AND att.SessionType=?
    `).get(today, `bus_${session}`)?.n || 0;
    return { total, submitted };
}

function getAbsentByGroup(today, camperIdSet) {
    const attRows = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor, a.Status
        FROM Attendance a JOIN Campers c ON c.CamperID = a.CamperID
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status IN ('absent', 'late', 'nurse')
    `).all(today);
    const dismissalRows = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor, 'dismissed' AS Status
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        WHERE ed.Date = ?
    `).all(today);
    const byId = new Map();
    for (const r of attRows) byId.set(r.CamperID, r);
    for (const r of dismissalRows) byId.set(r.CamperID, r); // dismissed overwrites absent/late
    const all = [...byId.values()];
    const filtered = camperIdSet ? all.filter(r => camperIdSet.has(r.CamperID)) : all;
    filtered.sort((a, b) =>
        (a.HomeGroupColor || '').localeCompare(b.HomeGroupColor || '') ||
        a.LastName.localeCompare(b.LastName)
    );
    const map = {};
    for (const r of filtered) {
        if (!map[r.HomeGroupColor]) map[r.HomeGroupColor] = [];
        map[r.HomeGroupColor].push(r);
    }
    return map;
}

function getNurseAMSet(date) {
    return new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='nurse'")
            .all(date).map(r => r.CamperID)
    );
}

function getCaseLogSet(date) {
    return new Set(
        db.prepare("SELECT CamperID FROM CaseLog WHERE Date=? AND CheckOutTime IS NULL AND Dismissed=0")
            .all(date).map(r => r.CamperID)
    );
}

function computeHomegroupAttStats(session, today) {
    const total = db.prepare(`
        SELECT COUNT(DISTINCT co.CounselorID) as n
        FROM Counselors co
        JOIN Campers ca ON ca.HomeGroupCounselorID = co.CounselorID
    `).get().n || 0;
    const submitted = db.prepare(`
        SELECT COUNT(DISTINCT c.HomeGroupCounselorID) as n
        FROM Attendance att
        JOIN Campers c ON c.CamperID = att.CamperID
        WHERE att.Date=? AND att.SessionType=?
    `).get(today, `homegroup_${session}`)?.n || 0;
    return { total, submitted };
}

// Camper ordinal period (1-5 from CSV) → clock block (1-6) based on home group.
// Green/Navy: AM=Sports (blocks 1-3), PM=Enrichment (blocks 4-5). Identity for blocks 1-5.
// Red/Carolina: AM=Enrichment (blocks 1-2), PM=Sports (blocks 4-6). P3→4, P4→5, P5→6.
function camperOrdinalToClockBlock(ordinalPeriod, homeGroupColor) {
    if (['Red', 'Carolina'].includes(homeGroupColor)) {
        const map = { 1: 1, 2: 2, 3: 4, 4: 5, 5: 6 };
        return map[ordinalPeriod] ?? ordinalPeriod;
    }
    return ordinalPeriod; // Green/Navy: ordinal already equals clock block
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());

// Make viewMode and timestamp helper available in all templates
app.use((req, res, next) => {
    res.locals.viewMode = req.cookies.viewMode || 'staff';
    // SQLite CURRENT_TIMESTAMP is UTC; append 'Z' to force UTC parse, then convert to Eastern.
    res.locals.fmtTime = (s, dateOnly = false) => {
        if (!s) return '—';
        const d = new Date(String(s).includes('Z') || String(s).includes('+') ? s : s + 'Z');
        const opts = { timeZone: 'America/New_York' };
        return dateOnly ? d.toLocaleDateString('en-US', opts) : d.toLocaleString('en-US', opts);
    };
    res.locals.fmtTimeOnly = (s) => {
        if (!s) return '—';
        const d = new Date(String(s).includes('Z') || String(s).includes('+') ? s : s + 'Z');
        return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    };
    res.locals.fmtPickupTime = (t) => {
        if (!t) return '—';
        const [h, m] = t.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    };
    next();
});

// Protect admin-only paths
const ADMIN_ONLY_PREFIXES = [
    '/admin', '/settings', '/swap-tool', '/process-swap', '/get-options',
    '/schedule-history', '/archive-schedule-changes', '/staff-lookup',
    '/faculty-summer', '/upload-staff-week', '/clear-staff-week',
    '/counselor-directory', '/counselor-view', '/promotions',
    '/promote-waitlist', '/promote-all', '/remove-waitlist', '/upload-campers', '/upload-campers-schedule', '/upload-counselors',
    '/upload-staff', '/upload-instructors', '/upload-activity-rules', '/add-activity',
    '/delete-activity', '/update-activity', '/add-activity-period-group',
    '/delete-activity-period-group',
    '/counselor-scheduling', '/upload-weekly-offerings', '/clear-weekly-offerings', '/sync-offerings-from-schedule', '/api/sync-offerings',
    '/save-counselor-assignments', '/backup-counselor-assignments', '/counselor-schedule-backups', '/restore-counselor-backup', '/delete-counselor-backup',
    '/export-counselor-schedule', '/export-staff-schedule',
    '/export-master-schedule', '/save-counselor-group-assignments', '/auto-assign-homegroups', '/sync-homegroup-colors',
    '/hub-content', '/director-notes', '/photo-gallery', '/photo-vote',
    '/set-active-week', '/set-released-week', '/update-session-label',
    '/clear-counselor-week', '/counselor-week-assignments', '/clear-counselor-schedule', '/clear-counselor-homegroups',
    '/audit', '/merge-class', '/set-activity-side', '/delete-counselor',
    '/update-staff-info', '/update-staff-period', '/remove-staff-period',
    '/homegroup-assignment', '/counselor-preferences-summary',
    '/attendance/dismissal-archive',
    '/dismissals',
    '/nurse',  '/nurse/archive',
    '/case-log', '/case-log/archive',
    '/split-scheduling', '/save-split-assignments',
    '/reports', '/upload-pdf',
    '/create-staff', '/create-camper', '/assign-camper-schedule', '/get-new-camper-options', '/assign-camper-class',
];
const UNPROTECTED = new Set(['/admin-login', '/logout', '/choose-view', '/']);
app.use((req, res, next) => {
    if (UNPROTECTED.has(req.path)) return next();
    const isAdminPath = ADMIN_ONLY_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));
    if (isAdminPath && req.cookies.adminAuth !== 'true') {
        return res.redirect('/admin-login');
    }
    next();
});

// --- HELPER: Database Initialization ---
// This ensures your tables match the logic used in the routes
db.exec(`
    CREATE TABLE IF NOT EXISTS Campers (
        CamperID INTEGER PRIMARY KEY AUTOINCREMENT,
        FirstName TEXT NOT NULL,
        LastName TEXT NOT NULL,
        Age INTEGER,
        HomeGroupColor TEXT,
        HomeGroupCounselorID INTEGER,
        BusRoute TEXT,
        ExtendedHours TEXT,
        CampLunch TEXT DEFAULT 'No'
    );
    CREATE TABLE IF NOT EXISTS Counselors (
        CounselorID INTEGER PRIMARY KEY AUTOINCREMENT,
        FirstName TEXT NOT NULL,
        LastName TEXT NOT NULL,
        HomeGroupColor TEXT,
        ScheduleType TEXT,
        BusRoute TEXT,
        ExtendedHours TEXT
    );
    CREATE TABLE IF NOT EXISTS Staff (
        StaffID INTEGER PRIMARY KEY AUTOINCREMENT,
        FirstName TEXT NOT NULL,
        LastName TEXT NOT NULL,
        HomeGroupColor TEXT,
        StaffType TEXT
    );
    CREATE TABLE IF NOT EXISTS Schedules (
        ScheduleID INTEGER PRIMARY KEY AUTOINCREMENT,
        PersonID INTEGER NOT NULL,
        PersonType TEXT NOT NULL CHECK(PersonType IN ('Camper', 'Counselor', 'Staff', 'Instructor')),
        PeriodNumber INTEGER NOT NULL,
        ActivityName TEXT NOT NULL,
        Location TEXT
    );
    CREATE TABLE IF NOT EXISTS Activities (
        ActivityID INTEGER PRIMARY KEY AUTOINCREMENT,
        Name TEXT UNIQUE NOT NULL,
        SideOfCamp TEXT CHECK(SideOfCamp IN ('Sports', 'Enrichment')),
        MaxCapacity INTEGER DEFAULT 20,
        Location TEXT,
        AllowedGroups TEXT CHECK(AllowedGroups IN ('Red', 'Carolina', 'Red-Carolina', 'Green-Navy') OR AllowedGroups IS NULL)
    );
    CREATE TABLE IF NOT EXISTS StaffWeekSchedules (
        StaffID      INTEGER NOT NULL,
        WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
        ActivityName TEXT    NOT NULL,
        Location     TEXT,
        PRIMARY KEY (StaffID, WeekNumber, PeriodNumber),
        FOREIGN KEY (StaffID) REFERENCES Staff(StaffID) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ScheduleChanges (
        ChangeID     INTEGER PRIMARY KEY AUTOINCREMENT,
        CamperID     INTEGER NOT NULL,
        CamperName   TEXT    NOT NULL,
        ColorGroup   TEXT,
        PeriodNumber INTEGER NOT NULL,
        OldActivity  TEXT    NOT NULL,
        NewActivity  TEXT    NOT NULL,
        ChangedAt    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    );
    CREATE TABLE IF NOT EXISTS ScheduleChangesArchive (
        ChangeID     INTEGER PRIMARY KEY,
        CamperID     INTEGER NOT NULL,
        CamperName   TEXT    NOT NULL,
        ColorGroup   TEXT,
        PeriodNumber INTEGER NOT NULL,
        OldActivity  TEXT    NOT NULL,
        NewActivity  TEXT    NOT NULL,
        ChangedAt    DATETIME,
        ArchivedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ActivityPeriodGroups (
        ActivityName  TEXT    NOT NULL,
        PeriodNumber  INTEGER NOT NULL,
        AllowedGroups TEXT    NOT NULL CHECK(AllowedGroups IN ('Red', 'Carolina', 'Red-Carolina', 'Green-Navy')),
        PRIMARY KEY (ActivityName, PeriodNumber),
        FOREIGN KEY (ActivityName) REFERENCES Activities(Name) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS Waitlists (
        WaitlistID INTEGER PRIMARY KEY AUTOINCREMENT,
        CamperID INTEGER,
        PeriodNumber INTEGER,
        RequestedActivity TEXT,
        TimeOfDay TEXT,
        Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    );
    CREATE TABLE IF NOT EXISTS Attendance (
        AttendanceID  INTEGER PRIMARY KEY AUTOINCREMENT,
        Date          TEXT    NOT NULL,
        CamperID      INTEGER NOT NULL,
        SessionType   TEXT    NOT NULL,
        PeriodNumber  INTEGER NOT NULL DEFAULT 0,
        ActivityName  TEXT    NOT NULL DEFAULT '',
        Status        TEXT    NOT NULL DEFAULT 'present',
        Notes         TEXT,
        MarkedAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID),
        UNIQUE (Date, CamperID, SessionType, PeriodNumber, ActivityName)
    );
    CREATE TABLE IF NOT EXISTS EarlyDismissals (
        DismissalID   INTEGER PRIMARY KEY AUTOINCREMENT,
        Date          TEXT    NOT NULL,
        CamperID      INTEGER NOT NULL,
        DismissalTime TEXT,
        Notes         TEXT,
        CreatedAt     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (Date, CamperID),
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    );
    CREATE TABLE IF NOT EXISTS CounselorPreferences (
        CounselorID          INTEGER PRIMARY KEY,
        HomeGroupPreference  TEXT,
        SchedulePreference   TEXT,
        ActivityPreferences  TEXT,
        SubmittedAt          DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS WeeklyOfferings (
        OfferingID            INTEGER PRIMARY KEY AUTOINCREMENT,
        ActivityName          TEXT NOT NULL,
        PreliminaryEnrollment INTEGER DEFAULT 0,
        SideOfCamp            TEXT
    );
    CREATE TABLE IF NOT EXISTS CounselorScheduleAssignments (
        AssignmentID INTEGER PRIMARY KEY AUTOINCREMENT,
        PeriodNumber INTEGER NOT NULL,
        ActivityName TEXT NOT NULL,
        PersonID     INTEGER NOT NULL,
        PersonType   TEXT NOT NULL CHECK(PersonType IN ('Counselor', 'Staff', 'Instructor')),
        UNIQUE(PeriodNumber, PersonID, PersonType)
    );
    CREATE TABLE IF NOT EXISTS HubContent (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS PhotoSubmissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        counselorName TEXT NOT NULL,
        imageUrl TEXT NOT NULL,
        submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS PhotoVotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photoId INTEGER NOT NULL REFERENCES PhotoSubmissions(id),
        voterName TEXT,
        voteDate TEXT,
        votedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS AdminUsers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
    );
`);
db.prepare("INSERT OR IGNORE INTO HubContent (id, content) VALUES ('announcement', '')").run();
db.prepare("INSERT OR IGNORE INTO HubContent (id, content) VALUES ('director_notes', '')").run();

db.exec(`CREATE TABLE IF NOT EXISTS DirectorNotes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    body      TEXT NOT NULL,
    author    TEXT NOT NULL DEFAULT 'Admin',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Migration: if Campers was created with a CHECK constraint on ExtendedHours, recreate it without one.
// Safe to run on an empty table (upload couldn't have succeeded with the constraint in place).
try {
    db.prepare("INSERT INTO Campers (FirstName, LastName, ExtendedHours) VALUES ('__chk__','__chk__','No')").run();
    db.prepare("DELETE FROM Campers WHERE FirstName='__chk__' AND LastName='__chk__'").run();
} catch (e) {
    if (e.message && e.message.includes('CHECK constraint failed')) {
        db.exec(`
            DROP TABLE Campers;
            CREATE TABLE Campers (
                CamperID INTEGER PRIMARY KEY AUTOINCREMENT,
                FirstName TEXT NOT NULL,
                LastName TEXT NOT NULL,
                Age INTEGER,
                HomeGroupColor TEXT,
                HomeGroupCounselorID INTEGER,
                BusRoute TEXT,
                ExtendedHours TEXT,
                CampLunch TEXT DEFAULT 'No'
            );
        `);
    }
}

// Migration: add PeriodNumber column to WeeklyOfferings if it doesn't exist yet
try {
    db.prepare("SELECT PeriodNumber FROM WeeklyOfferings LIMIT 1").get();
} catch {
    db.exec("ALTER TABLE WeeklyOfferings ADD COLUMN PeriodNumber INTEGER");
}

// Migration: add AllowedGroups column to Activities if it doesn't exist yet
try {
    db.prepare("SELECT AllowedGroups FROM Activities LIMIT 1").get();
} catch (e) {
    db.prepare("ALTER TABLE Activities ADD COLUMN AllowedGroups TEXT").run();
}

// Migration: create ActivityPeriodGroups table if it doesn't exist yet
db.exec(`
    CREATE TABLE IF NOT EXISTS ActivityPeriodGroups (
        ActivityName  TEXT    NOT NULL,
        PeriodNumber  INTEGER NOT NULL,
        AllowedGroups TEXT    NOT NULL CHECK(AllowedGroups IN ('Red', 'Carolina', 'Red-Carolina', 'Green-Navy')),
        PRIMARY KEY (ActivityName, PeriodNumber),
        FOREIGN KEY (ActivityName) REFERENCES Activities(Name) ON DELETE CASCADE
    );
`);

// Migration: create StaffWeekSchedules table if it doesn't exist yet
db.exec(`
    CREATE TABLE IF NOT EXISTS StaffWeekSchedules (
        StaffID      INTEGER NOT NULL,
        WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
        ActivityName TEXT    NOT NULL,
        Location     TEXT,
        PRIMARY KEY (StaffID, WeekNumber, PeriodNumber),
        FOREIGN KEY (StaffID) REFERENCES Staff(StaffID) ON DELETE CASCADE
    );
`);

// Migration: fix StaffWeekSchedules FK — was referencing Staff(StaffID) but uploads use Counselors(CounselorID)
try {
    const swsFKs = db.prepare("PRAGMA foreign_key_list(StaffWeekSchedules)").all();
    const wrongFK = swsFKs.some(fk => fk.table === 'Staff');
    if (wrongFK) {
        db.exec(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE StaffWeekSchedules_new (
                StaffID      INTEGER NOT NULL,
                WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
                PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
                ActivityName TEXT    NOT NULL,
                Location     TEXT,
                PRIMARY KEY (StaffID, WeekNumber, PeriodNumber),
                FOREIGN KEY (StaffID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
            );
            INSERT INTO StaffWeekSchedules_new SELECT * FROM StaffWeekSchedules;
            DROP TABLE StaffWeekSchedules;
            ALTER TABLE StaffWeekSchedules_new RENAME TO StaffWeekSchedules;
            PRAGMA foreign_keys = ON;
        `);
        console.log('[migration] StaffWeekSchedules FK corrected to Counselors(CounselorID)');
    }
} catch(e) { console.error('[migration] StaffWeekSchedules FK fix:', e.message); }

// Migration: add WeekNumber to CounselorScheduleAssignments and fix unique constraint
try {
    const csaCols = db.prepare("PRAGMA table_info(CounselorScheduleAssignments)").all().map(c => c.name);
    if (!csaCols.includes('WeekNumber')) {
        db.exec(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE CounselorScheduleAssignments_new (
                AssignmentID INTEGER PRIMARY KEY AUTOINCREMENT,
                WeekNumber   INTEGER NOT NULL DEFAULT 1,
                PeriodNumber INTEGER NOT NULL,
                ActivityName TEXT NOT NULL,
                PersonID     INTEGER NOT NULL,
                PersonType   TEXT NOT NULL CHECK(PersonType IN ('Counselor', 'Staff', 'Instructor')),
                UNIQUE(WeekNumber, PeriodNumber, PersonID, PersonType)
            );
            INSERT INTO CounselorScheduleAssignments_new (WeekNumber, PeriodNumber, ActivityName, PersonID, PersonType)
                SELECT 1, PeriodNumber, ActivityName, PersonID, PersonType FROM CounselorScheduleAssignments;
            DROP TABLE CounselorScheduleAssignments;
            ALTER TABLE CounselorScheduleAssignments_new RENAME TO CounselorScheduleAssignments;
            PRAGMA foreign_keys = ON;
        `);
        console.log('[migration] CounselorScheduleAssignments: added WeekNumber column');
    }
} catch(e) { console.error('[migration] CounselorScheduleAssignments WeekNumber:', e.message); }

// Migration: create schedule change log tables if they don't exist yet
db.exec(`
    CREATE TABLE IF NOT EXISTS ScheduleChanges (
        ChangeID     INTEGER PRIMARY KEY AUTOINCREMENT,
        CamperID     INTEGER NOT NULL,
        CamperName   TEXT    NOT NULL,
        ColorGroup   TEXT,
        PeriodNumber INTEGER NOT NULL,
        OldActivity  TEXT    NOT NULL,
        NewActivity  TEXT    NOT NULL,
        ChangedAt    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    );
    CREATE TABLE IF NOT EXISTS ScheduleChangesArchive (
        ChangeID     INTEGER PRIMARY KEY,
        CamperID     INTEGER NOT NULL,
        CamperName   TEXT    NOT NULL,
        ColorGroup   TEXT,
        PeriodNumber INTEGER NOT NULL,
        OldActivity  TEXT    NOT NULL,
        NewActivity  TEXT    NOT NULL,
        ChangedAt    DATETIME,
        ArchivedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Multi-week counselor scheduling tables
db.exec(`
    CREATE TABLE IF NOT EXISTS Sessions (
        weekNumber  INTEGER PRIMARY KEY CHECK(weekNumber BETWEEN 1 AND 6),
        label       TEXT NOT NULL DEFAULT '',
        startDate   TEXT,
        isActive    INTEGER NOT NULL DEFAULT 0,
        isReleased  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS CounselorWeekSchedules (
        CounselorID  INTEGER NOT NULL,
        WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
        ActivityName TEXT    NOT NULL,
        PRIMARY KEY (CounselorID, WeekNumber, PeriodNumber),
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS CounselorWeekAttributes (
        CounselorID    INTEGER NOT NULL,
        WeekNumber     INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        HomeGroupColor TEXT,
        ScheduleType   TEXT,
        BusRoute       TEXT,
        ExtendedHours  TEXT,
        PRIMARY KEY (CounselorID, WeekNumber),
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS CamperHomeGroups (
        CamperID    INTEGER NOT NULL,
        WeekNumber  INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        CounselorID INTEGER,
        PRIMARY KEY (CamperID, WeekNumber),
        FOREIGN KEY (CamperID)    REFERENCES Campers(CamperID),
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID)
    );
`);

// Migration: add WeekNumber, MaxCapacity, Location to WeeklyOfferings
try { db.prepare("SELECT WeekNumber FROM WeeklyOfferings LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE WeeklyOfferings ADD COLUMN WeekNumber INTEGER NOT NULL DEFAULT 1");
}
try { db.prepare("SELECT MaxCapacity FROM WeeklyOfferings LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE WeeklyOfferings ADD COLUMN MaxCapacity INTEGER");
}
try { db.prepare("SELECT Location FROM WeeklyOfferings LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE WeeklyOfferings ADD COLUMN Location TEXT");
}

// Migration: convert CounselorWeekSchedules.PeriodNumber from TEXT ('3AM','3PM', etc.)
// to INTEGER clock blocks (1-6). Runs only when the column type is still TEXT.
// '3AM'→3, '3PM'→4, Enrichment P5→4, Enrichment P6→5, free-period P4 rows deleted.
try {
    const _cols = db.prepare("PRAGMA table_info(CounselorWeekSchedules)").all();
    const _col  = _cols.find(c => c.name === 'PeriodNumber');
    if (_col && _col.type.toUpperCase() === 'TEXT') {
        db.exec("PRAGMA foreign_keys = OFF;");
        // Remap split-period labels to clock block numbers
        db.exec(`
            UPDATE OR IGNORE CounselorWeekSchedules SET PeriodNumber = '3' WHERE PeriodNumber = '3AM';
            UPDATE OR IGNORE CounselorWeekSchedules SET PeriodNumber = '4' WHERE PeriodNumber = '3PM';
        `);
        // Enrichment counselors at old '5'/'6' were offset by the free-period hack;
        // map them to their actual clock blocks (E3=4, E4=5).
        // Do P5→4 before P6→5 to avoid collisions.
        // UPDATE OR IGNORE skips rows where the target period is already taken (e.g. counselor
        // has both a '3PM' Sports entry that became '4' and a P5 Enrichment entry).
        db.exec(`
            UPDATE OR IGNORE CounselorWeekSchedules
            SET PeriodNumber = '4'
            WHERE PeriodNumber = '5'
              AND ActivityName IN (SELECT Name FROM Activities WHERE SideOfCamp = 'Enrichment');

            UPDATE OR IGNORE CounselorWeekSchedules
            SET PeriodNumber = '5'
            WHERE PeriodNumber = '6'
              AND ActivityName IN (SELECT Name FROM Activities WHERE SideOfCamp = 'Enrichment');
        `);
        // Remove any stale free-period placeholder rows (PeriodNumber '4' with no real activity)
        db.exec(`DELETE FROM CounselorWeekSchedules
                 WHERE PeriodNumber = '4'
                   AND ActivityName NOT IN (SELECT Name FROM Activities);`);
        // Recreate table with INTEGER PeriodNumber
        db.exec(`
            ALTER TABLE CounselorWeekSchedules RENAME TO _CounselorWeekSchedules_v2;
            CREATE TABLE CounselorWeekSchedules (
                CounselorID  INTEGER NOT NULL,
                WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
                PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
                ActivityName TEXT    NOT NULL,
                PRIMARY KEY (CounselorID, WeekNumber, PeriodNumber),
                FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
            );
            INSERT OR IGNORE INTO CounselorWeekSchedules
                SELECT CounselorID, WeekNumber, CAST(PeriodNumber AS INTEGER), ActivityName
                FROM _CounselorWeekSchedules_v2;
            DROP TABLE _CounselorWeekSchedules_v2;
            PRAGMA foreign_keys = ON;
        `);
    }
} catch (e) {
    console.error('[migration] CounselorWeekSchedules period migration failed:', e.message);
}

// Migration: remap WeeklyOfferings.PeriodNumber to clock blocks.
// Enrichment E3 was stored as period 5, E4 as period 6 (offset by free-period hack).
// '3AM'/'3PM' text values map to blocks 3 and 4.
try {
    const hasTextPeriod = db.prepare(
        "SELECT 1 FROM WeeklyOfferings WHERE TYPEOF(PeriodNumber)='text' LIMIT 1"
    ).get();
    const hasEnrichP6 = db.prepare(
        "SELECT 1 FROM WeeklyOfferings WHERE PeriodNumber=6 AND SideOfCamp='Enrichment' LIMIT 1"
    ).get();
    if (hasTextPeriod || hasEnrichP6) {
        db.exec(`
            UPDATE WeeklyOfferings SET PeriodNumber = 3 WHERE TYPEOF(PeriodNumber)='text' AND PeriodNumber = '3AM';
            UPDATE WeeklyOfferings SET PeriodNumber = 4 WHERE TYPEOF(PeriodNumber)='text' AND PeriodNumber = '3PM';
        `);
        // P5→4 first, then P6→5 (order matters to avoid double-migration)
        db.exec(`
            UPDATE WeeklyOfferings SET PeriodNumber = 4 WHERE PeriodNumber = 5 AND SideOfCamp = 'Enrichment';
            UPDATE WeeklyOfferings SET PeriodNumber = 5 WHERE PeriodNumber = 6 AND SideOfCamp = 'Enrichment';
        `);
    }
} catch (e) {
    console.error('[migration] WeeklyOfferings period migration failed:', e.message);
}

// Migration: remap camper Schedules to clock blocks for Red/Carolina groups.
// Their ordinal P3 = clock block 4 (S4), P4 = block 5, P5 = block 6.
// Green/Navy ordinals already equal clock blocks (no change needed).
// Executed in reverse order (P5→6, P4→5, P3→4) to avoid value collisions.
try {
    const needsMigration = db.prepare(`
        SELECT 1 FROM Schedules s
        JOIN Campers c ON s.PersonID = c.CamperID
        WHERE s.PersonType = 'Camper' AND s.PeriodNumber = 3
          AND c.HomeGroupColor IN ('Red','Carolina')
        LIMIT 1
    `).get();
    if (needsMigration) {
        db.exec(`
            UPDATE Schedules SET PeriodNumber = 6
            WHERE PersonType = 'Camper' AND PeriodNumber = 5
              AND PersonID IN (SELECT CamperID FROM Campers WHERE HomeGroupColor IN ('Red','Carolina'));

            UPDATE Schedules SET PeriodNumber = 5
            WHERE PersonType = 'Camper' AND PeriodNumber = 4
              AND PersonID IN (SELECT CamperID FROM Campers WHERE HomeGroupColor IN ('Red','Carolina'));

            UPDATE Schedules SET PeriodNumber = 4
            WHERE PersonType = 'Camper' AND PeriodNumber = 3
              AND PersonID IN (SELECT CamperID FROM Campers WHERE HomeGroupColor IN ('Red','Carolina'));
        `);
    }
} catch (e) {
    console.error('[migration] Camper Schedules clock block migration failed:', e.message);
}

// Migration: add voterName / voteDate to PhotoVotes if missing
try {
    const pvCols = db.prepare("PRAGMA table_info(PhotoVotes)").all().map(c => c.name);
    if (!pvCols.includes('voterName')) db.exec("ALTER TABLE PhotoVotes ADD COLUMN voterName TEXT");
    if (!pvCols.includes('voteDate'))  db.exec("ALTER TABLE PhotoVotes ADD COLUMN voteDate TEXT");
} catch(e) { console.error('[migration] PhotoVotes columns:', e.message); }

try {
    const attCols = db.prepare("PRAGMA table_info(Attendance)").all().map(c => c.name);
    if (!attCols.includes('MarkedBy')) db.exec("ALTER TABLE Attendance ADD COLUMN MarkedBy TEXT");
} catch(e) { console.error('[migration] Attendance.MarkedBy:', e.message); }

try {
    const edCols = db.prepare("PRAGMA table_info(EarlyDismissals)").all().map(c => c.name);
    if (!edCols.includes('MarkedBy')) db.exec("ALTER TABLE EarlyDismissals ADD COLUMN MarkedBy TEXT");
} catch(e) { console.error('[migration] EarlyDismissals.MarkedBy:', e.message); }
try {
    db.exec(`CREATE TABLE IF NOT EXISTS ScheduledPickups (
        PickupID   INTEGER PRIMARY KEY AUTOINCREMENT,
        Date       TEXT    NOT NULL,
        CamperID   INTEGER NOT NULL,
        PickupTime TEXT    NOT NULL,
        Notes      TEXT,
        CreatedBy  TEXT,
        CreatedAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (Date, CamperID),
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    )`);
} catch(e) { console.error('[migration] ScheduledPickups:', e.message); }
try {
    const spCols = db.prepare("PRAGMA table_info(ScheduledPickups)").all().map(c => c.name);
    if (!spCols.includes('PeriodNumber')) db.exec("ALTER TABLE ScheduledPickups ADD COLUMN PeriodNumber INTEGER");
} catch(e) { console.error('[migration] ScheduledPickups.PeriodNumber:', e.message); }
try {
    const woCols = db.prepare("PRAGMA table_info(WeeklyOfferings)").all().map(c => c.name);
    if (!woCols.includes('AllowedGroups')) db.exec("ALTER TABLE WeeklyOfferings ADD COLUMN AllowedGroups TEXT");
} catch(e) { console.error('[migration] WeeklyOfferings.AllowedGroups:', e.message); }
try {
    const camperCols = db.prepare("PRAGMA table_info(Campers)").all().map(c => c.name);
    if (!camperCols.includes('Grade'))     db.exec("ALTER TABLE Campers ADD COLUMN Grade INTEGER");
    if (!camperCols.includes('ShirtSize')) db.exec("ALTER TABLE Campers ADD COLUMN ShirtSize TEXT");
    db.exec("UPDATE Campers SET Grade = Age WHERE Grade IS NULL AND Age IS NOT NULL");
} catch(e) { console.error('[migration] Campers Grade/ShirtSize:', e.message); }

try {
    const counsCols = db.prepare("PRAGMA table_info(Counselors)").all().map(c => c.name);
    if (!counsCols.includes('StaffRole')) db.exec("ALTER TABLE Counselors ADD COLUMN StaffRole TEXT DEFAULT 'Counselor'");
} catch(e) { console.error('[migration] Counselors.StaffRole:', e.message); }

try {
    const cwaCols = db.prepare("PRAGMA table_info(CounselorWeekAttributes)").all().map(c => c.name);
    if (!cwaCols.includes('SpecialtyGroup')) db.exec("ALTER TABLE CounselorWeekAttributes ADD COLUMN SpecialtyGroup TEXT");
} catch(e) { console.error('[migration] CounselorWeekAttributes.SpecialtyGroup:', e.message); }

try {
    const cCols = db.prepare("PRAGMA table_info(Counselors)").all().map(c => c.name);
    if (!cCols.includes('Phone')) db.exec("ALTER TABLE Counselors ADD COLUMN Phone TEXT");
    if (!cCols.includes('Email')) db.exec("ALTER TABLE Counselors ADD COLUMN Email TEXT");
    if (!cCols.includes('IncludeInStaffDropdown')) db.exec("ALTER TABLE Counselors ADD COLUMN IncludeInStaffDropdown INTEGER DEFAULT 0");
} catch(e) { console.error('[migration] Counselors.Phone/Email/IncludeInStaffDropdown:', e.message); }

try {
    db.exec(`CREATE TABLE IF NOT EXISTS NurseLog (
        VisitID      INTEGER PRIMARY KEY AUTOINCREMENT,
        Date         TEXT    NOT NULL,
        CamperID     INTEGER NOT NULL,
        CheckInTime  TEXT    NOT NULL,
        CheckOutTime TEXT,
        Notes        TEXT,
        Dismissed    INTEGER DEFAULT 0,
        CreatedBy    TEXT,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    )`);
} catch(e) { console.error('[migration] NurseLog:', e.message); }

try {
    db.exec(`CREATE TABLE IF NOT EXISTS CaseLog (
        VisitID      INTEGER PRIMARY KEY AUTOINCREMENT,
        Date         TEXT    NOT NULL,
        CamperID     INTEGER NOT NULL,
        CheckInTime  TEXT    NOT NULL,
        CheckOutTime TEXT,
        Notes        TEXT,
        Dismissed    INTEGER DEFAULT 0,
        CreatedBy    TEXT,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
    )`);
} catch(e) { console.error('[migration] CaseLog:', e.message); }

// Staff → Counselors migration removed; Staff table is legacy and no longer written to.
db.exec(`DELETE FROM Staff`);

// Seed Sessions 1-6 and migrate existing counselor data into week 1
for (let w = 1; w <= 6; w++) {
    db.prepare("INSERT OR IGNORE INTO Sessions (weekNumber, label, isActive) VALUES (?, ?, ?)").run(w, `Week ${w}`, w === 1 ? 1 : 0);
}
db.exec(`INSERT OR IGNORE INTO CounselorWeekSchedules (CounselorID, WeekNumber, PeriodNumber, ActivityName)
    SELECT PersonID, 1, PeriodNumber, ActivityName FROM Schedules WHERE PersonType = 'Counselor'`);
db.exec(`INSERT OR IGNORE INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
    SELECT CounselorID, 1, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours FROM Counselors`);

// Normalize literal "null" strings left by CSV imports
db.exec(`UPDATE Campers    SET BusRoute = NULL WHERE LOWER(TRIM(BusRoute)) = 'null' OR TRIM(BusRoute) = ''`);
db.exec(`UPDATE Counselors SET BusRoute = NULL WHERE LOWER(TRIM(BusRoute)) = 'null' OR TRIM(BusRoute) = ''`);
db.exec(`UPDATE Campers    SET ExtendedHours = NULL WHERE LOWER(TRIM(ExtendedHours)) = 'null' OR TRIM(ExtendedHours) = ''`);
// Normalize float bus routes to whole numbers (e.g. "3.0" → "3")
db.exec(`UPDATE Campers SET BusRoute = CAST(CAST(BusRoute AS INTEGER) AS TEXT) WHERE BusRoute GLOB '[0-9]*.[0-9]*'`);
// Remove group color names erroneously stored as bus routes
db.exec(`UPDATE Campers SET BusRoute = NULL WHERE BusRoute IN ('Red','Carolina','Green','Navy','LilPlace','KinderPlace','SPLIT','SPRC','Swim')`);

// Clear any invalid HomeGroupColor values on Counselors (e.g. role names stored in the wrong column)
db.exec(`UPDATE Counselors SET HomeGroupColor = NULL WHERE HomeGroupColor NOT IN ('Red','Carolina','Green','Navy','LilPlace','KinderPlace','SPLIT','SPRC','Swim') AND HomeGroupColor IS NOT NULL`);

// Auto-infer counselor HomeGroupColor from CamperHomeGroups when no color assignments exist for a week.
// This handles databases where counselors were imported without colors but campers were already assigned.
try {
    const upsertCWAColor = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET HomeGroupColor = excluded.HomeGroupColor
    `);
    const weeksWithAssignments = db.prepare(
        "SELECT DISTINCT WeekNumber FROM CamperHomeGroups"
    ).all().map(r => r.WeekNumber);

    for (const weekNumber of weeksWithAssignments) {
        const alreadyColored = db.prepare(
            "SELECT COUNT(*) as cnt FROM CounselorWeekAttributes WHERE WeekNumber=? AND HomeGroupColor IN ('Red','Carolina','Green','Navy')"
        ).get(weekNumber).cnt;
        if (alreadyColored > 0) continue;

        // Find each counselor's most common camper color for this week
        const rows = db.prepare(`
            SELECT chg.CounselorID, c.HomeGroupColor, COUNT(*) as cnt
            FROM CamperHomeGroups chg
            JOIN Campers c ON c.CamperID = chg.CamperID
            WHERE chg.WeekNumber = ? AND c.HomeGroupColor IN ('Red','Carolina','Green','Navy')
            GROUP BY chg.CounselorID, c.HomeGroupColor
        `).all(weekNumber);

        const best = {};
        for (const r of rows) {
            if (!best[r.CounselorID] || r.cnt > best[r.CounselorID].cnt) {
                best[r.CounselorID] = { color: r.HomeGroupColor, cnt: r.cnt };
            }
        }
        for (const [cId, { color }] of Object.entries(best)) {
            upsertCWAColor.run(parseInt(cId), weekNumber, color);
        }
        if (Object.keys(best).length) {
            console.log(`[migration] inferred home group colors for ${Object.keys(best).length} counselors in week ${weekNumber}`);
        }
    }
} catch(e) { console.error('[migration] infer counselor group colors:', e.message); }

// SPLIT field trip flag table
db.exec(`CREATE TABLE IF NOT EXISTS SplitFieldTrip (
    Date     TEXT PRIMARY KEY,
    MarkedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Counselor schedule backup snapshots
db.exec(`CREATE TABLE IF NOT EXISTS CounselorScheduleBackups (
    BackupID        INTEGER PRIMARY KEY AUTOINCREMENT,
    WeekNumber      INTEGER NOT NULL,
    Label           TEXT    NOT NULL DEFAULT '',
    CreatedAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
    AssignmentsJSON TEXT    NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS PdfDocuments (
    slug        TEXT PRIMARY KEY,
    filename    TEXT,
    data        BLOB NOT NULL,
    uploadedAt  DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Migrate any PDFs already on disk into the database, then remove them.
(function migratePdfsFromDisk() {
    const PDF_SLUGS = [
        'camper-notes', 'icp-notes', 'am-enrichment-locations',
        'snack-break-locations', 'lunch-enrichment-locations',
        'popsicle-break-locations', 'enrichment-map'
    ];
    const insert = db.prepare(`INSERT OR IGNORE INTO PdfDocuments (slug, filename, data) VALUES (?, ?, ?)`);
    for (const slug of PDF_SLUGS) {
        const filePath = path.join(__dirname, 'uploads', `${slug}.pdf`);
        if (fs.existsSync(filePath)) {
            try {
                insert.run(slug, `${slug}.pdf`, fs.readFileSync(filePath));
                fs.unlinkSync(filePath);
                console.log(`[pdf-migrate] ${slug} moved to database`);
            } catch (e) {
                console.error(`[pdf-migrate] failed for ${slug}:`, e.message);
            }
        }
    }
})();

// Migration: add category column to DirectorNotes
try {
    db.prepare("SELECT category FROM DirectorNotes LIMIT 1").get();
} catch {
    db.exec("ALTER TABLE DirectorNotes ADD COLUMN category TEXT NOT NULL DEFAULT 'director'");
}

// --- WEEK HELPERS ---
function getActiveWeek() {
    return db.prepare("SELECT weekNumber FROM Sessions WHERE isActive=1 LIMIT 1").get()?.weekNumber ?? 1;
}
function getReleasedWeek() {
    return db.prepare("SELECT * FROM Sessions WHERE isReleased=1 LIMIT 1").get() ?? null;
}

// Returns campers for a counselor, preferring week-keyed CamperHomeGroups over legacy HomeGroupCounselorID.
function getWeekCampersForCounselor(counselorId, weekNumber) {
    const hasWeekData = db.prepare(
        "SELECT 1 FROM CamperHomeGroups WHERE WeekNumber=? LIMIT 1"
    ).get(weekNumber);
    if (hasWeekData) {
        return db.prepare(`
            SELECT c.* FROM Campers c
            JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID
              AND chg.WeekNumber = ? AND chg.CounselorID = ?
            ORDER BY c.LastName, c.FirstName
        `).all(weekNumber, counselorId);
    }
    return db.prepare(
        "SELECT * FROM Campers WHERE HomeGroupCounselorID=? ORDER BY LastName, FirstName"
    ).all(counselorId);
}

// --- AUTO WEEK ROLLOVER ---
// Rolls the active week to the next one at 23:59 on the Friday of the active session's start week.
function checkWeekRollover() {
    const activeSession = db.prepare("SELECT * FROM Sessions WHERE isActive=1 LIMIT 1").get();
    if (!activeSession || !activeSession.startDate) return;

    // Parse startDate as local time, find the Friday of that week
    const start = new Date(activeSession.startDate + 'T00:00:00');
    const daysToFriday = (5 - start.getDay() + 7) % 7;
    const friday = new Date(start);
    friday.setDate(start.getDate() + daysToFriday);
    friday.setHours(23, 59, 0, 0);

    if (new Date() >= friday) {
        const nextSession = db.prepare("SELECT * FROM Sessions WHERE weekNumber=?").get(activeSession.weekNumber + 1);
        if (nextSession) {
            db.exec('UPDATE Sessions SET isActive = 0');
            db.prepare('UPDATE Sessions SET isActive = 1 WHERE weekNumber = ?').run(nextSession.weekNumber);
            console.log(`[auto-rollover] Week ${activeSession.weekNumber} → Week ${nextSession.weekNumber}`);
        }
    }
}
checkWeekRollover(); // catch any missed rollover on startup
setInterval(checkWeekRollover, 60 * 1000); // check every minute

// --- VIEW SELECTION & AUTH ---
app.get('/', (req, res) => {
    const { viewMode, adminAuth } = req.cookies;
    if (viewMode === 'staff') return res.redirect('/staff');
    if (viewMode === 'admin') {
        return adminAuth === 'true' ? res.redirect('/admin') : res.redirect('/admin-login');
    }
    res.render('splash');
});

app.post('/choose-view', (req, res) => {
    const { view } = req.body;
    if (view === 'staff') {
        res.cookie('viewMode', 'staff', { maxAge: 365 * 24 * 60 * 60 * 1000 });
        return res.redirect('/staff');
    }
    if (view === 'admin') {
        res.cookie('viewMode', 'admin', { maxAge: 365 * 24 * 60 * 60 * 1000 });
        return req.cookies.adminAuth === 'true' ? res.redirect('/admin') : res.redirect('/admin-login');
    }
    res.redirect('/');
});

app.get('/admin-login', (req, res) => {
    if (req.cookies.adminAuth === 'true') return res.redirect('/admin');
    res.render('admin-login', { error: null });
});

app.post('/admin-login', (req, res) => {
    if (req.body.password === 'N0placeLike') {
        res.cookie('adminAuth', 'true', { maxAge: 8 * 60 * 60 * 1000, httpOnly: true });
        res.cookie('viewMode', 'admin', { maxAge: 365 * 24 * 60 * 60 * 1000 });
        return res.redirect('/admin');
    }
    res.render('admin-login', { error: 'Incorrect password. Please try again.' });
});

app.get('/logout', (_req, res) => {
    res.clearCookie('adminAuth');
    res.cookie('viewMode', 'staff', { maxAge: 365 * 24 * 60 * 60 * 1000 });
    res.redirect('/staff');
});

app.get('/staff', (req, res) => {
    const cid = parseInt(req.cookies.selectedCounselor) || null;
    const cRow = cid ? db.prepare('SELECT FirstName, LastName FROM Counselors WHERE CounselorID = ?').get(cid) : null;
    const selectedCounselorName = cRow ? `${cRow.FirstName} ${cRow.LastName}` : null;
    const announcement = db.prepare("SELECT content FROM HubContent WHERE id='announcement'").get()?.content || '';
    const released = getReleasedWeek();
    const releasedSchedule = (released && cid)
        ? db.prepare('SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID=? AND WeekNumber=? ORDER BY PeriodNumber').all(cid, released.weekNumber)
        : null;
    const releasedSessionLabel = released?.label ?? null;
    const yesterdayWinner = db.prepare(`
        SELECT p.counselorName, p.imageUrl, COUNT(v.id) as votes
        FROM PhotoSubmissions p
        LEFT JOIN PhotoVotes v ON v.photoId = p.id
        WHERE p.date = ?
        GROUP BY p.id ORDER BY votes DESC, p.submittedAt ASC LIMIT 1
    `).get(yesterdayStr()) || null;

    // --- Today's activity feed ---
    const today = todayStr();
    const aw = getActiveWeek();

    // Build counselor roster camper ID set for filtering (if a counselor is selected)
    let rosterCamperIds = null;
    if (cid) {
        const homeGroupIds = db.prepare(
            `SELECT CamperID FROM CamperHomeGroups WHERE CounselorID = ? AND WeekNumber = ?`
        ).all(cid, aw).map(r => r.CamperID);

        const ca = db.prepare(`
            SELECT COALESCE(cwa.BusRoute, c.BusRoute) AS BusRoute,
                   COALESCE(cwa.ExtendedHours, c.ExtendedHours) AS ExtendedHours
            FROM Counselors c
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            WHERE c.CounselorID = ?
        `).get(aw, cid);

        const busIds = ca?.BusRoute
            ? db.prepare('SELECT CamperID FROM Campers WHERE BusRoute = ?').all(ca.BusRoute).map(r => r.CamperID)
            : [];

        let extIds = [];
        if (ca?.ExtendedHours === 'AM')   extIds = db.prepare("SELECT CamperID FROM Campers WHERE ExtendedHours IN ('AM','Both')").all().map(r => r.CamperID);
        else if (ca?.ExtendedHours === 'PM')   extIds = db.prepare("SELECT CamperID FROM Campers WHERE ExtendedHours IN ('PM','Both')").all().map(r => r.CamperID);
        else if (ca?.ExtendedHours === 'Both') extIds = db.prepare("SELECT CamperID FROM Campers WHERE ExtendedHours IS NOT NULL").all().map(r => r.CamperID);

        const counselorActivities = db.prepare(
            'SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ?'
        ).all(cid, aw);
        let classIds = [];
        for (const act of counselorActivities) {
            db.prepare("SELECT PersonID AS CamperID FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?")
                .all(act.PeriodNumber, act.ActivityName).forEach(r => classIds.push(r.CamperID));
        }

        rosterCamperIds = new Set([...homeGroupIds, ...busIds, ...extIds, ...classIds]);
    }

    const filterByRoster = (rows) => rosterCamperIds ? rows.filter(r => rosterCamperIds.has(r.CamperID)) : rows;

    const allPickups = db.prepare(`
        SELECT sp.PickupTime, sp.PeriodNumber, sp.Notes, c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               s.ActivityName
        FROM ScheduledPickups sp JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber
        WHERE sp.Date = ? ORDER BY sp.PickupTime
    `).all(today);

    const allLateArrivals = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor, a.MarkedAt
        FROM Attendance a JOIN Campers c ON c.CamperID = a.CamperID
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status = 'late'
        ORDER BY a.MarkedAt
    `).all(today);

    const allEarlyDismissals = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               ed.DismissalTime, ed.Notes
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        WHERE ed.Date = ? ORDER BY ed.DismissalTime
    `).all(today);

    const allScheduleChanges = db.prepare(`
        SELECT ChangeID, CamperID, CamperName, ColorGroup, PeriodNumber, OldActivity, NewActivity, ChangedAt
        FROM ScheduleChanges
        WHERE date(ChangedAt, 'localtime') = ?
        ORDER BY ChangedAt DESC
    `).all(today);

    const todayPickups        = filterByRoster(allPickups);
    const todayLateArrivals   = filterByRoster(allLateArrivals);
    const todayEarlyDismissals= filterByRoster(allEarlyDismissals);
    const todayScheduleChanges= rosterCamperIds
        ? allScheduleChanges.filter(c => rosterCamperIds.has(c.CamperID))
        : allScheduleChanges;

    const absentByGroup = getAbsentByGroup(today, rosterCamperIds);

    res.render('staff-hub', {
        selectedCounselorName, announcement, releasedSchedule, releasedSessionLabel, yesterdayWinner,
        todayPickups, todayLateArrivals, todayEarlyDismissals, todayScheduleChanges, today, absentByGroup
    });
});

app.post('/admin-set-name', (req, res) => {
    const { existingName, newName } = req.body;
    const name = (existingName === '__new__' ? newName : existingName || '').trim();
    if (!name) return res.redirect('/admin');
    db.prepare("INSERT OR IGNORE INTO AdminUsers (name) VALUES (?)").run(name);
    res.cookie('adminName', name, { maxAge: 365 * 24 * 60 * 60 * 1000 });
    res.redirect('/admin');
});

app.post('/director-notes', (req, res) => {
    const body = (req.body.body || '').trim();
    if (!body) return res.redirect('/admin');
    const author = req.cookies.adminName || 'Admin';
    const VALID_CATS = new Set(['director', 'camper', 'staff', 'timesheet']);
    const category = VALID_CATS.has(req.body.category) ? req.body.category : 'director';
    db.prepare("INSERT INTO DirectorNotes (body, author, category) VALUES (?, ?, ?)").run(body, author, category);
    res.redirect('/admin');
});

app.post('/director-notes/delete/:id', (req, res) => {
    db.prepare("DELETE FROM DirectorNotes WHERE id = ?").run(req.params.id);
    res.redirect('/admin');
});

app.post('/hub-content/:id', (req, res) => {
    const allowed = ['announcement', 'director_notes'];
    if (!allowed.includes(req.params.id)) return res.status(400).json({ error: 'Invalid' });
    db.prepare("UPDATE HubContent SET content=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?")
        .run(req.body.content || '', req.params.id);
    res.json({ ok: true });
});

// --- DASHBOARD ---
app.get('/admin', (req, res) => {
    const camperTotal = db.prepare("SELECT COUNT(*) AS count FROM Campers").get().count;
    const activityCount = db.prepare(
        "SELECT COUNT(DISTINCT ActivityName) AS count FROM WeeklyOfferings WHERE WeekNumber=?"
    ).get(getActiveWeek()).count;

    const groupRows = db.prepare(
        "SELECT HomeGroupColor AS color, COUNT(*) AS cnt FROM Campers WHERE HomeGroupColor IS NOT NULL AND HomeGroupColor != '' GROUP BY HomeGroupColor"
    ).all();
    const groupCounts = {};
    for (const r of groupRows) groupCounts[r.color] = r.cnt;

    const pendingChanges = db.prepare("SELECT COUNT(*) AS count FROM ScheduleChanges").get().count;

    const waitlistCount = db.prepare(`
        SELECT COUNT(*) as count FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE (SELECT COUNT(*) FROM Schedules WHERE ActivityName = a.Name AND PeriodNumber = w.PeriodNumber) < a.MaxCapacity
    `).get().count;

    const estMins = getESTMins();
    const today   = getTodayEST();
    const hubMode = getHubMode(estMins);

    const hubStats = { mode: hubMode };
    if (hubMode === 'classes') {
        const sp = getActivePeriod(SPORTS_PERIODS, estMins);
        const ep = getActivePeriod(ENRICHMENT_PERIODS, estMins);
        hubStats.sports = sp ? { label: sp.label, clockBlock: sp.clockBlock, ...computeClassAttStats(sp.clockBlock, 'Sports', today) } : null;
        hubStats.enrich = ep ? { label: ep.label, clockBlock: ep.clockBlock, ...computeClassAttStats(ep.clockBlock, 'Enrichment', today) } : null;
    } else if (hubMode === 'lunch') {
        hubStats.lunchHg = computeHomegroupAttStats('lunch', today);
    } else {
        hubStats.amExt = computeExtAttStats('am', today);
        hubStats.amBus = computeBusAttStats('am', today);
        hubStats.amHg  = computeHomegroupAttStats('am', today);
        hubStats.pmBus = computeBusAttStats('pm', today);
        hubStats.pmExt = computeExtAttStats('pm', today);
        hubStats.pmHg  = computeHomegroupAttStats('pm', today);
    }

    const announcement  = db.prepare("SELECT content FROM HubContent WHERE id='announcement'").get()?.content || '';
    const directorNotes = db.prepare("SELECT id, body, author, category, createdAt FROM DirectorNotes ORDER BY createdAt DESC LIMIT 200").all();
    const sessions = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();

    const adminName  = req.cookies.adminName || null;
    const adminUsers = db.prepare("SELECT name FROM AdminUsers ORDER BY name").all().map(r => r.name);

    const absentByGroup = getAbsentByGroup(today);

    const nurseCount = db.prepare(
        "SELECT COUNT(*) AS count FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='nurse'"
    ).get(today).count;

    res.render('index', {
        camperTotal, activityCount, groupCounts,
        pendingChanges, waitlistCount, nurseCount,
        hubStats, today,
        alertMessage: req.query.message,
        announcement, directorNotes, sessions,
        adminName, adminUsers, absentByGroup
    });
});

// --- AUDIT ROSTER ---
app.get('/audit', (req, res) => {
    const activeWeek = getActiveWeek();
    const activeSession = db.prepare('SELECT * FROM Sessions WHERE weekNumber=?').get(activeWeek);
    const alertMessage = req.query.message || null;

    const noCounselor = db.prepare(`
        SELECT CamperID, FirstName, LastName, HomeGroupColor
        FROM Campers
        WHERE HomeGroupCounselorID IS NULL
          AND CamperID NOT IN (SELECT CamperID FROM CamperHomeGroups WHERE WeekNumber = ?)
          AND HomeGroupColor NOT IN ('LilPlace', 'KinderPlace', 'SPLIT', 'SPRC')
          AND HomeGroupColor IS NOT NULL AND HomeGroupColor != ''
        ORDER BY HomeGroupColor, LastName
    `).all(activeWeek);

    const missingSchedule = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               COUNT(s.PeriodNumber) AS classCount
        FROM Campers c
        LEFT JOIN Schedules s ON s.PersonID = c.CamperID AND s.PersonType = 'Camper'
        WHERE c.HomeGroupColor NOT IN ('LilPlace', 'KinderPlace', 'SPLIT', 'SPRC')
          AND c.HomeGroupColor IS NOT NULL AND c.HomeGroupColor != ''
        GROUP BY c.CamperID
        HAVING classCount < 5
        ORDER BY c.HomeGroupColor, c.LastName
    `).all();

    const EXPECTED = { 'All Sports': 6, 'All Enrichment': 4, 'AM Sports / PM Enrichment': 5, 'AM Enrichment / PM Sports': 5 };

    const allCounselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName,
               COALESCE(cwa.ScheduleType, c.ScheduleType) AS ScheduleType,
               COUNT(cws.PeriodNumber) AS classCount
        FROM Counselors c
        LEFT JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID AND cws.WeekNumber = ?
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        GROUP BY c.CounselorID
        ORDER BY c.LastName
    `).all(activeWeek, activeWeek);

    const counselorMismatch = allCounselors.filter(c => {
        const expected = EXPECTED[c.ScheduleType];
        return expected != null && c.classCount !== expected;
    });

    const suspectRows = db.prepare(`
        SELECT ActivityName, COUNT(*) AS totalCampers,
               GROUP_CONCAT(DISTINCT PeriodNumber ORDER BY PeriodNumber) AS periods
        FROM Schedules
        WHERE PersonType = 'Camper'
        GROUP BY ActivityName
        HAVING totalCampers <= 3
        ORDER BY totalCampers, ActivityName
    `).all();

    const allClassNames = db.prepare(
        "SELECT DISTINCT ActivityName FROM Schedules WHERE PersonType='Camper' ORDER BY ActivityName"
    ).all().map(r => r.ActivityName);

    function suggestTargets(suspectName, names) {
        const tok = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().split(/\s+/)[0];
        const sFirst = tok(suspectName);
        const minLen = Math.max(4, Math.floor(sFirst.length * 0.7));
        return names.filter(n => {
            if (n === suspectName) return false;
            const nFirst = tok(n);
            const shorter = sFirst.length <= nFirst.length ? sFirst : nFirst;
            const longer  = sFirst.length <= nFirst.length ? nFirst : sFirst;
            return longer.startsWith(shorter.slice(0, minLen));
        });
    }

    const suspects = suspectRows.map(r => ({
        activityName: r.ActivityName,
        totalCampers: r.totalCampers,
        periods: r.periods,
        suggestions: suggestTargets(r.ActivityName, allClassNames)
    }));

    const unclassifiedActivities = db.prepare(`
        SELECT a.Name, a.SideOfCamp,
               COUNT(s.PersonID) AS enrollment
        FROM Activities a
        LEFT JOIN Schedules s ON s.ActivityName = a.Name AND s.PersonType = 'Camper'
        WHERE a.SideOfCamp IS NULL OR a.SideOfCamp NOT IN ('Sports', 'Enrichment')
        GROUP BY a.Name, a.SideOfCamp
        ORDER BY a.Name
    `).all();

    res.render('audit', { activeSession, alertMessage, noCounselor, missingSchedule, counselorMismatch, EXPECTED, suspects, allClassNames, unclassifiedActivities });
});

app.post('/set-activity-side', (req, res) => {
    const { activityName, sideOfCamp } = req.body;
    if (!activityName || !['Sports', 'Enrichment'].includes(sideOfCamp))
        return res.redirect('/audit?message=Invalid+request.');
    db.prepare("UPDATE Activities SET SideOfCamp = ? WHERE Name = ?").run(sideOfCamp, activityName);
    res.redirect(`/audit?message=Set+"${encodeURIComponent(activityName)}"+to+${sideOfCamp}.`);
});

app.post('/merge-class', (req, res) => {
    const fromName = (req.body.fromName || '').trim();
    const toName   = (req.body.toName   || '').trim();
    if (!fromName || !toName || fromName === toName)
        return res.redirect('/audit?message=Invalid+merge+request.');

    db.transaction(() => {
        // Drop any Schedules rows where the camper/counselor is already enrolled in toName
        // at the same period (avoids duplicate period entries after rename)
        db.prepare(`
            DELETE FROM Schedules
            WHERE ActivityName = ?
              AND EXISTS (
                SELECT 1 FROM Schedules s2
                WHERE s2.PersonID     = Schedules.PersonID
                  AND s2.PeriodNumber = Schedules.PeriodNumber
                  AND s2.PersonType   = Schedules.PersonType
                  AND s2.ActivityName = ?
              )
        `).run(fromName, toName);

        // Rename the rest
        db.prepare("UPDATE Schedules SET ActivityName = ? WHERE ActivityName = ?").run(toName, fromName);

        // Update counselor schedule assignments globally
        db.prepare(`
            DELETE FROM CounselorScheduleAssignments
            WHERE ActivityName = ?
              AND EXISTS (
                SELECT 1 FROM CounselorScheduleAssignments csa2
                WHERE csa2.PersonID     = CounselorScheduleAssignments.PersonID
                  AND csa2.PeriodNumber = CounselorScheduleAssignments.PeriodNumber
                  AND csa2.PersonType   = CounselorScheduleAssignments.PersonType
                  AND csa2.ActivityName = ?
              )
        `).run(fromName, toName);
        db.prepare("UPDATE CounselorScheduleAssignments SET ActivityName = ? WHERE ActivityName = ?").run(toName, fromName);

        // Remove typo from WeeklyOfferings (all weeks)
        db.prepare("DELETE FROM WeeklyOfferings WHERE ActivityName = ?").run(fromName);

        // Remove typo from Activities (target already exists or will be auto-created on next sync)
        db.prepare("DELETE FROM Activities WHERE Name = ?").run(fromName);
    })();

    res.redirect(`/audit?message=Merged+"${encodeURIComponent(fromName)}"+into+"${encodeURIComponent(toName)}".`);
});

// --- MASTER SCHEDULE ---
app.get('/master-schedule', (req, res) => {
    try {
        const classes = db.prepare(`
            SELECT DISTINCT
                s.PeriodNumber  AS periodNumber,
                s.ActivityName  AS activityName,
                a.SideOfCamp    AS sideOfCamp,
                a.MaxCapacity   AS maxCapacity,
                a.Location      AS location
            FROM Schedules s
            LEFT JOIN Activities a ON s.ActivityName = a.Name
            WHERE s.PersonType = 'Camper'
              AND s.ActivityName NOT LIKE '#REF%'
            ORDER BY s.PeriodNumber, s.ActivityName
        `).all();

        const getLocation = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM StaffWeekSchedules
            WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `);
        const getColorGroups = db.prepare(`
            SELECT DISTINCT c.HomeGroupColor
            FROM Campers c JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ? ORDER BY c.HomeGroupColor
        `);
        const getEnrollment = db.prepare(
            "SELECT COUNT(*) as n FROM Schedules WHERE PersonType = 'Camper' AND PeriodNumber = ? AND ActivityName = ?"
        );
        const getStaff = db.prepare(`
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            UNION
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN StaffWeekSchedules sws ON sws.StaffID = st.CounselorID
            WHERE sws.WeekNumber = ? AND sws.PeriodNumber = ? AND sws.ActivityName = ? COLLATE NOCASE
            UNION
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN CounselorScheduleAssignments csa ON csa.PersonID = st.CounselorID
            WHERE csa.WeekNumber = ? AND csa.PeriodNumber = ? AND csa.ActivityName = ? COLLATE NOCASE
              AND csa.PersonType IN ('Instructor', 'Staff')
        `);
        const aw = getActiveWeek();
        const getCounselors = db.prepare(`
            SELECT c.CounselorID, c.FirstName, c.LastName,
                   COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            JOIN CounselorWeekSchedules cws
                ON cws.CounselorID = c.CounselorID AND cws.WeekNumber = ? AND cws.PeriodNumber = ? AND cws.ActivityName = ? COLLATE NOCASE
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            ORDER BY HomeGroupColor, c.LastName
        `);
        const getBusPresence = db.prepare(`
            SELECT 1 FROM Campers c JOIN Schedules s ON c.CamperID=s.PersonID AND s.PersonType='Camper'
            WHERE s.PeriodNumber=? AND s.ActivityName=? AND c.BusRoute IS NOT NULL AND c.BusRoute!='' LIMIT 1
        `);
        const getExtGroups = db.prepare(`
            SELECT DISTINCT c.ExtendedHours FROM Campers c JOIN Schedules s ON c.CamperID=s.PersonID AND s.PersonType='Camper'
            WHERE s.PeriodNumber=? AND s.ActivityName=? AND c.ExtendedHours IS NOT NULL AND c.ExtendedHours!=''
        `);

        // Each row in Schedules now uses clock blocks (1-6) — no P3 AM/PM split needed.
        const enriched = classes.map(cls => {
            const locRow = getLocation.get(cls.periodNumber, cls.activityName, aw, cls.periodNumber, cls.activityName);
            return {
                ...cls,
                location:    locRow ? locRow.Location : (cls.location || null),
                enrolled:    getEnrollment.get(cls.periodNumber, cls.activityName).n,
                colorGroups: getColorGroups.all(cls.periodNumber, cls.activityName).map(r => r.HomeGroupColor),
                staff:       getStaff.all(cls.periodNumber, cls.activityName, aw, cls.periodNumber, cls.activityName, aw, cls.periodNumber, cls.activityName),
                counselors:  getCounselors.all(aw, cls.periodNumber, cls.activityName, aw),
                busPresent:  !!getBusPresence.get(cls.periodNumber, cls.activityName),
                extGroups:   getExtGroups.all(cls.periodNumber, cls.activityName).map(r => r.ExtendedHours)
            };
        });

        const periodMap = new Map();
        for (const cls of enriched) {
            if (!periodMap.has(cls.periodNumber)) periodMap.set(cls.periodNumber, []);
            periodMap.get(cls.periodNumber).push(cls);
        }

        const schedule = [];
        for (const periodNumber of [...periodMap.keys()].sort((a, b) => a - b)) {
            schedule.push({ periodNumber, periodLabel: String(periodNumber), classes: periodMap.get(periodNumber) });
        }

        res.render('master-schedule', { schedule });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading Master Schedule: ' + err.message);
    }
});

// --- CLASS ROSTER ---
app.get('/class-roster/:period/:activity', (req, res) => {
    try {
        const period = parseInt(req.params.period);
        const activityName = req.params.activity;

        const activity = db.prepare('SELECT * FROM Activities WHERE Name = ?').get(activityName);

        const activeWeek = getActiveWeek();
        const campers = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, c.Grade, c.HomeGroupColor,
                   c.BusRoute, c.ExtendedHours,
                   n.CounselorID, n.FirstName AS CounselorFirstName, n.LastName AS CounselorLastName
            FROM Campers c
            JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
            LEFT JOIN Counselors n ON n.CounselorID = COALESCE(chg.CounselorID, c.HomeGroupCounselorID)
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            ORDER BY c.HomeGroupColor, c.LastName
        `).all(activeWeek, period, activityName);

        const colorGroups = [...new Set(campers.map(c => c.HomeGroupColor).filter(Boolean))];

        // Period is now a clock block (1-6); no translation needed.
        const locRow = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND ActivityName = ? AND PeriodNumber = ?
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM StaffWeekSchedules
            WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM Activities
            WHERE Name = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `).get(activityName, period, activeWeek, period, activityName, activityName);

        const staff = db.prepare(`
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
        `).all(period, activityName);

        const counselors = db.prepare(`
            SELECT c.CounselorID, c.FirstName, c.LastName,
                   COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID AND cws.WeekNumber = ? AND cws.PeriodNumber = ? AND cws.ActivityName = ? COLLATE NOCASE
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            ORDER BY HomeGroupColor, c.LastName
        `).all(activeWeek, period, activityName, activeWeek);

        res.render('class-roster', {
            periodNumber: period,
            activityName,
            sideOfCamp:  activity ? activity.SideOfCamp  : null,
            maxCapacity: activity ? activity.MaxCapacity : null,
            location:    locRow   ? locRow.Location      : null,
            campers,
            colorGroups,
            staff,
            counselors
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading class roster: ' + err.message);
    }
});


// Update location for all staff schedule rows at a given period + activity
app.post('/update-class-location', (req, res) => {
    const { activityName, periodNumber, location } = req.body;
    const aw = getActiveWeek();
    db.prepare(
        "UPDATE Schedules SET Location = ? WHERE PersonType = 'Instructor' AND PeriodNumber = ? AND ActivityName = ?"
    ).run(location || null, parseInt(periodNumber), activityName);
    db.prepare(
        "UPDATE StaffWeekSchedules SET Location = ? WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE"
    ).run(location || null, aw, parseInt(periodNumber), activityName);
    db.prepare(
        "UPDATE Activities SET Location = ? WHERE Name = ?"
    ).run(location || null, activityName);
    res.redirect(`/class-roster/${periodNumber}/${encodeURIComponent(activityName)}`);
});

app.get('/search', (req, res) => {
    try {
        const query = req.query.name || '';
        const aw = getActiveWeek();
        const camperList = db.prepare(`
            SELECT
                c.*,
                COALESCE(chg.CounselorID, c.HomeGroupCounselorID) AS HomeGroupCounselorIDResolved,
                n.FirstName || ' ' || n.LastName AS HomeCounselorName,
                s1.ActivityName AS P1,
                s2.ActivityName AS P2,
                s3.ActivityName AS P3,
                s4.ActivityName AS P4,
                s5.ActivityName AS P5,
                s6.ActivityName AS P6
            FROM Campers c
            LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
            LEFT JOIN Counselors n ON COALESCE(chg.CounselorID, c.HomeGroupCounselorID) = n.CounselorID
            LEFT JOIN Schedules s1 ON c.CamperID = s1.PersonID AND s1.PeriodNumber = 1 AND s1.PersonType = 'Camper'
            LEFT JOIN Schedules s2 ON c.CamperID = s2.PersonID AND s2.PeriodNumber = 2 AND s2.PersonType = 'Camper'
            LEFT JOIN Schedules s3 ON c.CamperID = s3.PersonID AND s3.PeriodNumber = 3 AND s3.PersonType = 'Camper'
            LEFT JOIN Schedules s4 ON c.CamperID = s4.PersonID AND s4.PeriodNumber = 4 AND s4.PersonType = 'Camper'
            LEFT JOIN Schedules s5 ON c.CamperID = s5.PersonID AND s5.PeriodNumber = 5 AND s5.PersonType = 'Camper'
            LEFT JOIN Schedules s6 ON c.CamperID = s6.PersonID AND s6.PeriodNumber = 6 AND s6.PersonType = 'Camper'
            WHERE (c.FirstName || ' ' || c.LastName LIKE ?) OR (? = '')
            ORDER BY c.LastName ASC
        `).all(aw, `%${query}%`, query);

        res.render('search', { 
            camper: camperList, 
            query: query 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Search error: " + err.message);
    }
});

app.get('/counselor-directory', (req, res) => {
    const counselors = db.prepare("SELECT * FROM Counselors ORDER BY StaffRole, HomeGroupColor, LastName ASC").all();
    res.render('counselor-directory', { counselors });
});

app.get('/staff-lookup', (req, res) => res.redirect('/counselor-directory'));

app.get('/faculty-summer', (req, res) => {
    const allStaff = db.prepare(`
        SELECT CounselorID AS StaffID, FirstName, LastName, StaffRole AS StaffType, HomeGroupColor
        FROM Counselors
        WHERE StaffRole IN ('Instructor','Unit Leader','Sports Leader')
        ORDER BY StaffRole, LastName, FirstName
    `).all();

    // Pivot StaffWeekSchedules into one row per (StaffID, WeekNumber) with P1-P6 / L1-L6 columns
    const weekRows = db.prepare(`
        SELECT
            StaffID, WeekNumber,
            MAX(CASE WHEN PeriodNumber = 1 THEN ActivityName END) AS P1,
            MAX(CASE WHEN PeriodNumber = 1 THEN Location END)     AS L1,
            MAX(CASE WHEN PeriodNumber = 2 THEN ActivityName END) AS P2,
            MAX(CASE WHEN PeriodNumber = 2 THEN Location END)     AS L2,
            MAX(CASE WHEN PeriodNumber = 3 THEN ActivityName END) AS P3,
            MAX(CASE WHEN PeriodNumber = 3 THEN Location END)     AS L3,
            MAX(CASE WHEN PeriodNumber = 4 THEN ActivityName END) AS P4,
            MAX(CASE WHEN PeriodNumber = 4 THEN Location END)     AS L4,
            MAX(CASE WHEN PeriodNumber = 5 THEN ActivityName END) AS P5,
            MAX(CASE WHEN PeriodNumber = 5 THEN Location END)     AS L5,
            MAX(CASE WHEN PeriodNumber = 6 THEN ActivityName END) AS P6,
            MAX(CASE WHEN PeriodNumber = 6 THEN Location END)     AS L6
        FROM StaffWeekSchedules
        GROUP BY StaffID, WeekNumber
        ORDER BY StaffID, WeekNumber
    `).all();

    const weekMap = {};
    for (const row of weekRows) {
        if (!weekMap[row.StaffID]) weekMap[row.StaffID] = [];
        weekMap[row.StaffID].push(row);
    }
    const staff = allStaff.map(s => ({ ...s, weeks: weekMap[s.StaffID] || [] }));
    const weekCounts = {};
    for (const row of weekRows) {
        weekCounts[row.WeekNumber] = (weekCounts[row.WeekNumber] || 0) + 1;
    }

    res.render('faculty-summer', { staff, weekCounts, alertMessage: req.query.message });
});

app.get('/counselor-profile/:id', (req, res) => {
    const aw = getActiveWeek();
    const counselor = db.prepare(`
        SELECT c.*,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType,
               COALESCE(cwa.BusRoute,       c.BusRoute)       AS BusRoute,
               COALESCE(cwa.ExtendedHours,  c.ExtendedHours)  AS ExtendedHours
        FROM Counselors c
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        WHERE c.CounselorID = ?
    `).get(aw, req.params.id);
    if (!counselor) return res.status(404).send('Staff member not found');
    const isCounselor = counselor.StaffRole === 'Counselor' || counselor.StaffRole === 'Swim Counselor';
    const isInstructor = ['Instructor','Unit Leader','Sports Leader'].includes(counselor.StaffRole);
    const schedule = isCounselor
        ? db.prepare("SELECT PeriodNumber, ActivityName, NULL AS Location FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ? ORDER BY PeriodNumber ASC").all(req.params.id, aw)
        : [];
    const instructorSchedule = isInstructor
        ? db.prepare(`
            SELECT PeriodNumber, ActivityName, Location FROM StaffWeekSchedules
            WHERE StaffID = ? AND WeekNumber = ?
            UNION
            SELECT PeriodNumber, ActivityName, NULL AS Location FROM CounselorScheduleAssignments
            WHERE PersonID = ? AND WeekNumber = ? AND PersonType IN ('Instructor', 'Staff')
            ORDER BY PeriodNumber ASC
          `).all(req.params.id, aw, req.params.id, aw)
        : [];
    const staffWeekSchedules = isInstructor
        ? db.prepare("SELECT WeekNumber, PeriodNumber, ActivityName, Location FROM StaffWeekSchedules WHERE StaffID = ? ORDER BY WeekNumber ASC, PeriodNumber ASC").all(req.params.id)
        : [];
    const allActivities = isInstructor
        ? db.prepare(`
            SELECT DISTINCT Name AS ActivityName FROM Activities WHERE Name IS NOT NULL AND Name != ''
            UNION
            SELECT DISTINCT ActivityName FROM StaffWeekSchedules WHERE ActivityName IS NOT NULL AND ActivityName != ''
            UNION
            SELECT DISTINCT ActivityName FROM Schedules WHERE ActivityName IS NOT NULL AND ActivityName != '' AND PersonType = 'Instructor'
            ORDER BY ActivityName ASC
          `).all().map(r => r.ActivityName)
        : [];
    const campers = isCounselor ? getWeekCampersForCounselor(parseInt(req.params.id), aw) : [];
    const message = req.query.message || null;
    res.render('counselor-view', { counselor, schedule, instructorSchedule, campers, staffWeekSchedules, allActivities, message });
});

app.post('/delete-counselor/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.redirect('/counselor-directory?message=Invalid+ID');
    const person = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID = ?").get(id);
    if (!person) return res.redirect('/counselor-directory?message=Staff+member+not+found');

    db.transaction(() => {
        db.prepare("UPDATE Campers SET HomeGroupCounselorID = NULL WHERE HomeGroupCounselorID = ?").run(id);
        db.prepare("UPDATE CamperHomeGroups SET CounselorID = NULL WHERE CounselorID = ?").run(id);
        db.prepare("DELETE FROM Schedules WHERE PersonID = ? AND PersonType = 'Counselor'").run(id);
        db.prepare("DELETE FROM StaffWeekSchedules WHERE StaffID = ?").run(id);
        db.prepare("DELETE FROM CounselorScheduleAssignments WHERE PersonID = ?").run(id);
        db.prepare("DELETE FROM CounselorWeekSchedules WHERE CounselorID = ?").run(id);
        db.prepare("DELETE FROM CounselorWeekAttributes WHERE CounselorID = ?").run(id);
        db.prepare("DELETE FROM CounselorPreferences WHERE CounselorID = ?").run(id);
        db.prepare("DELETE FROM Counselors WHERE CounselorID = ?").run(id);
    })();

    const name = encodeURIComponent(person.FirstName + ' ' + person.LastName);
    res.redirect(`/counselor-directory?message=${name}+deleted`);
});

app.get('/camper/:id', (req, res) => {
    try {
        const aw = getActiveWeek();
        const camper = db.prepare(`
            SELECT c.*,
                   COALESCE(
                       (SELECT co2.FirstName || ' ' || co2.LastName
                        FROM CamperHomeGroups chg
                        JOIN Counselors co2 ON co2.CounselorID = chg.CounselorID
                        WHERE chg.CamperID = c.CamperID AND chg.WeekNumber = ?),
                       (SELECT co3.FirstName || ' ' || co3.LastName
                        FROM Counselors co3 WHERE co3.CounselorID = c.HomeGroupCounselorID)
                   ) AS HomeCounselorName,
                   COALESCE(
                       (SELECT chg2.CounselorID FROM CamperHomeGroups chg2
                        WHERE chg2.CamperID = c.CamperID AND chg2.WeekNumber = ?),
                       c.HomeGroupCounselorID
                   ) AS ResolvedCounselorID
            FROM Campers c
            WHERE c.CamperID = ?
        `).get(aw, aw, req.params.id);

        if (!camper) return res.status(404).send('Camper not found');

        const schedule = db.prepare(`
            SELECT s.PeriodNumber, s.ActivityName, s.Location, a.SideOfCamp
            FROM Schedules s
            LEFT JOIN Activities a ON s.ActivityName = a.Name
            WHERE s.PersonID = ? AND s.PersonType = 'Camper'
            ORDER BY s.PeriodNumber ASC
        `).all(req.params.id);

        // SPLIT campers have periods 1,2,5,6 — inject a display-only period 3 row
        if (camper.HomeGroupColor === 'SPLIT' && !schedule.some(s => s.PeriodNumber === 3)) {
            const insertAt = schedule.findIndex(s => s.PeriodNumber > 3);
            schedule.splice(insertAt === -1 ? schedule.length : insertAt, 0,
                { PeriodNumber: 3, ActivityName: 'SPLIT Sport', Location: null, SideOfCamp: 'Sports' });
        }

        const counselors = db.prepare(`
            SELECT c.CounselorID, c.FirstName, c.LastName,
                COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            WHERE c.StaffRole = 'Counselor'
              AND COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) IN ('Red','Carolina','Green','Navy')
            ORDER BY COALESCE(cwa.HomeGroupColor, c.HomeGroupColor), c.LastName
        `).all(getActiveWeek());

        res.render('camper-profile', { camper, schedule, counselors, alertMessage: req.query.message || null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading camper profile: ' + err.message);
    }
});

app.post('/camper/:id/update', (req, res) => {
    try {
        const { homeGroupCounselorID, busRoute, extendedHours, campLunch } = req.body;
        db.prepare(`
            UPDATE Campers
            SET HomeGroupCounselorID = ?,
                BusRoute             = ?,
                ExtendedHours        = ?,
                CampLunch            = ?
            WHERE CamperID = ?
        `).run(
            homeGroupCounselorID ? parseInt(homeGroupCounselorID) : null,
            busRoute ? busRoute.trim() : null,
            extendedHours || null,
            campLunch || 'No',
            req.params.id
        );
        res.redirect(`/camper/${req.params.id}?message=Saved`);
    } catch (err) {
        console.error(err);
        res.redirect(`/camper/${req.params.id}?message=Error+saving+changes`);
    }
});

app.post('/camper/:id/delete', (req, res) => {
    const id = req.params.id;
    db.transaction(() => {
        db.prepare("DELETE FROM Schedules       WHERE PersonID = ? AND PersonType = 'Camper'").run(id);
        db.prepare("DELETE FROM Waitlists       WHERE CamperID = ?").run(id);
        db.prepare("DELETE FROM Attendance      WHERE CamperID = ?").run(id);
        db.prepare("DELETE FROM EarlyDismissals WHERE CamperID = ?").run(id);
        db.prepare("DELETE FROM CamperHomeGroups WHERE CamperID = ?").run(id);
        db.prepare("DELETE FROM Campers         WHERE CamperID = ?").run(id);
    })();
    res.redirect('/search');
});

// --- SETTINGS & ACTIVITY MANAGEMENT ---
app.get('/settings', (req, res) => {
    const activities = db.prepare('SELECT * FROM Activities ORDER BY SideOfCamp, Name').all();
    const periodOverrides = db.prepare('SELECT * FROM ActivityPeriodGroups ORDER BY ActivityName, PeriodNumber').all();
    const sessions = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();
    // Attach counselor + offering counts per week
    const totalActiveStaff = db.prepare("SELECT COUNT(*) as n FROM Counselors WHERE StaffRole NOT IN ('Director','Office Staff','Nurse','Equipment Manager','CPR Instructor','Internship')").get().n;
    sessions.forEach(s => {
        s.counselorCount = totalActiveStaff;
        s.offeringCount  = db.prepare('SELECT COUNT(*) as n FROM WeeklyOfferings WHERE WeekNumber=?').get(s.weekNumber).n;
    });
    const uploadedSlugs = new Set(db.prepare("SELECT slug FROM PdfDocuments").all().map(r => r.slug));
    const pdfExists = {};
    PDF_DOCS.forEach(d => { pdfExists[d.slug] = uploadedSlugs.has(d.slug); });
    res.render('settings', {
        activities, periodOverrides, sessions, alertMessage: req.query.message,
        confirmWeek: req.query.confirmWeek || null, weekCount: req.query.weekCount || null,
        confirmOfferWeek: req.query.confirmOfferWeek || null, offerCount: req.query.offerCount || null,
        pdfExists, docs: PDF_DOCS
    });
});
// --- CREATE STAFF ---
app.post('/create-staff', (req, res) => {
    const firstName = (req.body.firstName || '').trim();
    const lastName  = (req.body.lastName  || '').trim();
    if (!firstName || !lastName) return res.redirect('/settings?message=First+and+last+name+required');

    const staffRole     = (req.body.staffRole     || 'Counselor').trim();
    const homeGroupColor = (req.body.homeGroupColor || '').trim() || null;
    const scheduleType  = (req.body.scheduleType  || '').trim() || null;
    const busRoute      = (req.body.busRoute      || '').trim() || null;
    const extendedHours = (req.body.extendedHours || '').trim() || null;
    const phone         = (req.body.phone         || '').trim() || null;
    const email         = (req.body.email         || '').trim() || null;

    try {
        const result = db.prepare(`
            INSERT INTO Counselors (FirstName, LastName, StaffRole, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours, Phone, Email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(firstName, lastName, staffRole, homeGroupColor, scheduleType, busRoute, extendedHours, phone, email);

        const newId = result.lastInsertRowid;
        const aw = getActiveWeek();
        db.prepare(`
            INSERT OR IGNORE INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(newId, aw, homeGroupColor, scheduleType, busRoute, extendedHours);

        res.redirect('/settings?message=Staff+member+added');
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Error+adding+staff+member');
    }
});

// --- CREATE CAMPER ---
app.post('/create-camper', (req, res) => {
    const firstName = (req.body.firstName || '').trim();
    const lastName  = (req.body.lastName  || '').trim();
    if (!firstName || !lastName) return res.redirect('/settings?message=First+and+last+name+required');

    const grade         = parseInt(req.body.grade) || 0;
    const homeGroupColor = (req.body.homeGroupColor || '').trim() || null;
    const busRoute      = (req.body.busRoute      || '').trim() || null;
    const extendedHours = (req.body.extendedHours || '').trim() || null;
    const campLunch     = (req.body.campLunch     || 'No').trim();
    const shirtSize     = (req.body.shirtSize     || '').trim() || null;

    try {
        const result = db.prepare(`
            INSERT INTO Campers (FirstName, LastName, Grade, Age, HomeGroupColor, BusRoute, ExtendedHours, CampLunch, ShirtSize)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(firstName, lastName, grade, grade, homeGroupColor, busRoute, extendedHours, campLunch, shirtSize);

        const newId = result.lastInsertRowid;
        res.redirect(`/assign-camper-schedule/${newId}`);
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Error+adding+camper');
    }
});

// --- ASSIGN CAMPER SCHEDULE (view) ---
app.get('/assign-camper-schedule/:id', (req, res) => {
    const id = req.params.id;
    const camper = db.prepare('SELECT * FROM Campers WHERE CamperID = ?').get(id);
    if (!camper) return res.redirect('/settings?message=Camper+not+found');

    const scheduleRows = db.prepare(`
        SELECT PeriodNumber, ActivityName FROM Schedules
        WHERE PersonID = ? AND PersonType = 'Camper'
        ORDER BY PeriodNumber ASC
    `).all(id);

    const schedMap = {};
    scheduleRows.forEach(r => { schedMap[r.PeriodNumber] = r.ActivityName; });

    const color = camper.HomeGroupColor;
    let periods = [];
    if (color === 'Red' || color === 'Carolina') {
        periods = [
            { clockBlock: 1, side: 'Enrichment', label: 'E1' },
            { clockBlock: 2, side: 'Enrichment', label: 'E2' },
            { clockBlock: 4, side: 'Sports',     label: 'S4' },
            { clockBlock: 5, side: 'Sports',     label: 'S5' },
            { clockBlock: 6, side: 'Sports',     label: 'S6' },
        ];
    } else if (color === 'Green' || color === 'Navy') {
        periods = [
            { clockBlock: 1, side: 'Sports',     label: 'S1' },
            { clockBlock: 2, side: 'Sports',     label: 'S2' },
            { clockBlock: 3, side: 'Sports',     label: 'S3' },
            { clockBlock: 4, side: 'Enrichment', label: 'E3' },
            { clockBlock: 5, side: 'Enrichment', label: 'E4' },
        ];
    }

    res.render('assign-camper-schedule', {
        camper, schedMap, periods, alertMessage: req.query.message || null
    });
});

// --- GET OPTIONS FOR NEW CAMPER (AJAX) ---
app.get('/get-new-camper-options/:camperId/:period', (req, res) => {
    const { camperId, period } = req.params;
    const week = getActiveWeek();

    const camper = db.prepare('SELECT HomeGroupColor FROM Campers WHERE CamperID = ?').get(camperId);
    const color = camper ? camper.HomeGroupColor : null;

    // Derive side of camp from color + period
    let sideOfCamp = null;
    const p = parseInt(period);
    if (color === 'Red' || color === 'Carolina') {
        sideOfCamp = p <= 2 ? 'Enrichment' : 'Sports';
    } else if (color === 'Green' || color === 'Navy') {
        sideOfCamp = p <= 3 ? 'Sports' : 'Enrichment';
    }

    const options = db.prepare(`
        WITH effective AS (
            SELECT wo.ActivityName AS Name, wo.SideOfCamp,
                   COALESCE(wo.MaxCapacity, a.MaxCapacity) AS MaxCapacity,
                   COALESCE(apg.AllowedGroups, a.AllowedGroups) AS EffectiveGroups,
                   (SELECT COUNT(*) FROM Schedules s
                    WHERE s.ActivityName = wo.ActivityName AND s.PeriodNumber = @period AND s.PersonType = 'Camper') AS CurrentEnrollment
            FROM WeeklyOfferings wo
            JOIN Activities a ON a.Name = wo.ActivityName
            LEFT JOIN ActivityPeriodGroups apg
                   ON apg.ActivityName = wo.ActivityName AND apg.PeriodNumber = @period
            WHERE wo.PeriodNumber = @period AND wo.WeekNumber = @week
        )
        SELECT * FROM effective
        WHERE (@sideOfCamp IS NULL OR SideOfCamp = @sideOfCamp)
          AND (
              EffectiveGroups IS NULL OR
              EffectiveGroups = @color OR
              (EffectiveGroups = 'Red-Carolina' AND @color IN ('Red', 'Carolina')) OR
              (EffectiveGroups = 'Green-Navy'   AND @color IN ('Green', 'Navy'))
          )
        ORDER BY CurrentEnrollment ASC, Name ASC
    `).all({ period, color, sideOfCamp, week });

    res.json({ options, sideOfCamp });
});

// --- ASSIGN CAMPER CLASS ---
app.get('/assign-camper-class', (req, res) => {
    const { camperId, period, activity } = req.query;
    if (!camperId || !period || !activity) {
        return res.redirect('/settings?message=Missing+parameters');
    }

    const act = db.prepare('SELECT * FROM Activities WHERE Name = ?').get(activity);
    if (!act) return res.redirect(`/assign-camper-schedule/${camperId}?message=Activity+not+found`);

    // Check capacity (use WeeklyOfferings capacity override if present)
    const offering = db.prepare(`
        SELECT COALESCE(wo.MaxCapacity, a.MaxCapacity) AS MaxCapacity
        FROM WeeklyOfferings wo
        JOIN Activities a ON a.Name = wo.ActivityName
        WHERE wo.ActivityName = ? AND wo.PeriodNumber = ? AND wo.WeekNumber = ?
    `).get(activity, period, getActiveWeek());

    const maxCap = offering ? offering.MaxCapacity : act.MaxCapacity;

    const enrollment = db.prepare(`
        SELECT COUNT(*) as count FROM Schedules
        WHERE ActivityName = ? AND PeriodNumber = ? AND PersonType = 'Camper'
    `).get(activity, period).count;

    if (enrollment >= maxCap) {
        db.prepare(`
            INSERT INTO Waitlists (CamperID, PeriodNumber, RequestedActivity)
            VALUES (?, ?, ?)
        `).run(camperId, period, activity);
        return res.redirect(`/assign-camper-schedule/${camperId}?message=Class+full+%E2%80%94+added+to+waitlist`);
    }

    // DELETE + INSERT in a transaction
    db.transaction(() => {
        db.prepare(`
            DELETE FROM Schedules WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
        `).run(camperId, period);
        db.prepare(`
            INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName)
            VALUES (?, 'Camper', ?, ?)
        `).run(camperId, period, activity);
    })();

    res.redirect(`/assign-camper-schedule/${camperId}?message=Class+assigned`);
});

app.post('/upload-activity-rules', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const validGroups = ['Red', 'Carolina', 'Red-Carolina', 'Green-Navy'];
            const upsertActivity = db.prepare(`
                INSERT INTO Activities (Name, SideOfCamp, MaxCapacity, Location, AllowedGroups)
                VALUES (@Name, @SideOfCamp, @MaxCapacity, @Location, @AllowedGroups)
                ON CONFLICT(Name) DO UPDATE SET
                    SideOfCamp    = excluded.SideOfCamp,
                    MaxCapacity   = excluded.MaxCapacity,
                    Location      = excluded.Location,
                    AllowedGroups = excluded.AllowedGroups
            `);

            const insertBatch = db.transaction((dataArray) => {
                for (const row of dataArray) {
                    const rawGroups = row.AllowedGroups ? row.AllowedGroups.trim() : null;
                    upsertActivity.run({
                        Name:          row.Name.trim(),
                        SideOfCamp:    row.SideOfCamp ? row.SideOfCamp.trim() : null,
                        MaxCapacity:   parseInt(row.MaxCapacity) || 20,
                        Location:      row.Location ? row.Location.trim() : null,
                        AllowedGroups: validGroups.includes(rawGroups) ? rawGroups : null
                    });
                }
            });

            try {
                insertBatch(results);
                fs.unlinkSync(req.file.path);
                res.redirect('/settings?message=Activity+Rules+Updated');
            } catch (err) {
                console.error(err);
                res.redirect('/settings?message=Error+importing+activities');
            }
        });
});
app.post('/add-activity', (req, res) => {
    const activityName = (req.body.activityName || '').trim();
    const { side, capacity, location, allowedGroups } = req.body;
    if (!activityName) return res.redirect('/settings?message=Activity+name+cannot+be+empty');
    const validGroups = ['Red', 'Carolina', 'Red-Carolina', 'Green-Navy'];
    const groups = validGroups.includes(allowedGroups) ? allowedGroups : null;
    try {
        db.prepare("INSERT INTO Activities (Name, SideOfCamp, MaxCapacity, Location, AllowedGroups) VALUES (?, ?, ?, ?, ?)").run(activityName, side, parseInt(capacity) || 20, location || null, groups);
        res.redirect('/settings?message=Activity+Added');
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Activity+already+exists');
    }
});

app.post('/delete-activity/:name', (req, res) => {
    db.prepare("DELETE FROM Activities WHERE Name = ?").run(req.params.name);
    res.redirect('/settings?message=Activity+Deleted');
});
app.post('/update-activity', (req, res) => {
    const { activityName, maxCapacity, location, allowedGroups } = req.body;
    const validGroups = ['Red', 'Carolina', 'Red-Carolina', 'Green-Navy'];
    const groups = validGroups.includes(allowedGroups) ? allowedGroups : null;
    try {
        db.prepare("UPDATE Activities SET MaxCapacity = ?, Location = ?, AllowedGroups = ? WHERE Name = ?")
          .run(parseInt(maxCapacity) || 20, location || null, groups, activityName);
        res.redirect('/settings?message=Activity+Updated');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating activity");
    }
});
// --- ACTIVITY PERIOD OVERRIDES ---
app.post('/add-activity-period-group', (req, res) => {
    const { activityName, periodNumber, allowedGroups } = req.body;
    const validGroups = ['Red', 'Carolina', 'Red-Carolina', 'Green-Navy'];
    if (!activityName || !periodNumber || !validGroups.includes(allowedGroups)) {
        return res.redirect('/settings?message=Invalid+period+override+data');
    }
    try {
        db.prepare(`
            INSERT INTO ActivityPeriodGroups (ActivityName, PeriodNumber, AllowedGroups)
            VALUES (?, ?, ?)
            ON CONFLICT(ActivityName, PeriodNumber) DO UPDATE SET AllowedGroups = excluded.AllowedGroups
        `).run(activityName, parseInt(periodNumber), allowedGroups);
        res.redirect('/settings?message=Period+Override+Saved');
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Error+saving+period+override');
    }
});

app.post('/delete-activity-period-group', (req, res) => {
    const { activityName, periodNumber } = req.body;
    db.prepare("DELETE FROM ActivityPeriodGroups WHERE ActivityName = ? AND PeriodNumber = ?")
      .run(activityName, parseInt(periodNumber));
    res.redirect('/settings?message=Period+Override+Removed');
});

// --- WAITLIST & PROMOTIONS ---
app.get('/promotions', (req, res) => {
    const potentialPromotions = db.prepare(`
        SELECT w.*, c.FirstName, c.LastName, c.HomeGroupColor, a.MaxCapacity,
        (SELECT COUNT(*) FROM Schedules s WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber AND s.PersonType = 'Camper') as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE CurrentEnrollment < a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();
    const waitlistQueue = db.prepare(`
        SELECT w.*, c.FirstName, c.LastName, c.HomeGroupColor, a.MaxCapacity,
        (SELECT COUNT(*) FROM Schedules s WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber AND s.PersonType = 'Camper') as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE CurrentEnrollment >= a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();
    res.render('promotions', { potentialPromotions, waitlistQueue, alertMessage: req.query.message || null });
});

app.post('/promote-waitlist', (req, res) => {
    const entry = db.prepare('SELECT * FROM Waitlists WHERE WaitlistID = ?').get(req.body.WaitlistID);
    if (entry) {
        // Re-check capacity to guard against race conditions
        const activity = db.prepare('SELECT MaxCapacity FROM Activities WHERE Name = ?').get(entry.RequestedActivity);
        const currentCount = db.prepare(
            `SELECT COUNT(*) as count FROM Schedules WHERE ActivityName = ? AND PeriodNumber = ? AND PersonType = 'Camper'`
        ).get(entry.RequestedActivity, entry.PeriodNumber);

        if (activity && currentCount.count >= activity.MaxCapacity) {
            return res.redirect('/promotions?message=Spot+was+already+filled+by+another+camper');
        }

        db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'`)
            .run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber);
        db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(req.body.WaitlistID);
    }
    res.redirect('/promotions?message=Camper+Promoted');
});

// Promote ALL eligible waitlisted campers at once
app.post('/promote-all', (req, res) => {
    const eligible = db.prepare(`
        SELECT w.*, a.MaxCapacity,
        (SELECT COUNT(*) FROM Schedules s WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber AND s.PersonType = 'Camper') as CurrentEnrollment
        FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE CurrentEnrollment < a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();

    const promoteAll = db.transaction((entries) => {
        let promoted = 0;
        for (const entry of entries) {
            // Re-check live enrollment inside transaction to avoid double-filling
            const liveCount = db.prepare(
                `SELECT COUNT(*) as count FROM Schedules WHERE ActivityName = ? AND PeriodNumber = ? AND PersonType = 'Camper'`
            ).get(entry.RequestedActivity, entry.PeriodNumber);
            if (liveCount.count < entry.MaxCapacity) {
                db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'`)
                    .run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber);
                db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(entry.WaitlistID);
                promoted++;
            }
        }
        return promoted;
    });

    const count = promoteAll(eligible);
    res.redirect(`/promotions?message=${count}+camper(s)+promoted`);
});


app.post('/remove-waitlist/:id', (req, res) => {
    db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(req.params.id);
    res.redirect('/promotions?message=Removed+from+waitlist');
});

// --- CSV IMPORTS (Consolidated) ---

// Shared name parser for "Last, First" format used by camp management exports.
function parseLastFirst(raw) {
    if (!raw) return { firstName: '', lastName: '' };
    const commaIdx = raw.indexOf(',');
    if (commaIdx === -1) return { firstName: raw.trim(), lastName: '' };
    return {
        lastName:  raw.slice(0, commaIdx).trim(),
        firstName: raw.slice(commaIdx + 1).trim()
    };
}

// Synchronous CSV line parser — handles quoted fields with embedded commas.
function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQuotes = !inQuotes; }
        else if (c === ',' && !inQuotes) { fields.push(field); field = ''; }
        else { field += c; }
    }
    fields.push(field);
    return fields;
}

// Color mapping from ACR-005 display values to DB values.
const COLOR_MAP = {
    'kinderplace': 'KinderPlace',
    "li'l place":  'LilPlace',
    'lil place':   'LilPlace',
};
function mapColor(raw) {
    if (!raw || raw.trim() === '') return 'SPRC';
    return COLOR_MAP[raw.trim().toLowerCase()] || raw.trim();
}

// ACR-005 roster upload: upserts campers with color, lunch, shirt.
// Parses homegroup section headers to assign CamperHomeGroups for the active week.
// Does NOT touch Grade, BusRoute, ExtendedHours, or Schedules.
app.post('/upload-campers', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');

    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }

    // Split into pages at each occurrence of "ACR-005 Attendance Roster by Cabin".
    // Handles both CSV format (title followed by commas) and text/MD format (title followed by //).
    // Extra empty segments (from the footer+header pair in MD format) are harmlessly dropped
    // when no Camper,Color header is found (headerIdx === -1).
    const pages = rawText.split(/(?:\r?\n|^)ACR-005 Attendance Roster by Cabin(?:,| \/\/|$)/m);

    // Labels that identify session/cabin header rows (not counselor names)
    const SESSION_PREFIXES = ['SP Week', 'KP Week', 'LP Week', 'LIT Session', 'Robotics', 'Unassigned Cabin'];

    const sections = [];
    for (const page of pages) {
        const lines = page.split(/\r?\n/);

        // Find the "Camper,Color,..." data header row
        const headerIdx = lines.findIndex(l =>
            l.trim().startsWith('Camper,Color') || l.trim().startsWith('"Camper","Color"')
        );
        if (headerIdx === -1) continue;

        // Parse data rows synchronously
        const headerFields = parseCsvLine(lines[headerIdx].trim());
        const dataRows = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (!l) continue;
            const fields = parseCsvLine(l);
            const row = {};
            headerFields.forEach((h, idx) => { row[h.trim()] = (fields[idx] || '').trim(); });
            // Camper names are always "Last, First" — rows without a comma are page headers,
            // counselor names, session labels, or column header repetitions.
            if (row['Camper'] && row['Camper'].includes(',')) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;

        // Detect homegroup sections — they have a "Home Group-" line before the data header.
        // Structure: "Home Group- Week 1" → "SP Week 1" → [Counselor Name] → ",,,Week 1" → header
        let counselorName = null;
        const hgIdx = lines.findIndex(l => l.trim().startsWith('Home Group-'));
        if (hgIdx !== -1) {
            for (let i = hgIdx + 1; i < headerIdx; i++) {
                const l = lines[i].trim();
                // Skip empty, comma-only (e.g. ",,,Week 1,..."), and session label lines
                if (!l || l.startsWith(',') || l.startsWith('ACR-005')) continue;
                if (SESSION_PREFIXES.some(p => l.startsWith(p))) continue;
                // First remaining line is the counselor name
                const name = parseCsvLine(l)[0].trim();
                if (name) { counselorName = name; break; }
            }
        }

        sections.push({ counselorName, dataRows });
    }

    if (sections.length === 0) return res.redirect('/settings?message=Invalid+file+format+(ACR-005+expected)');

    const safeTrim = v => { const s = (v && typeof v === 'string') ? v.trim() : ''; return s.toLowerCase() === 'null' ? '' : s; };
    const findCamper    = db.prepare("SELECT CamperID, CampLunch FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const insertCamper  = db.prepare("INSERT INTO Campers (FirstName, LastName, HomeGroupColor, ShirtSize, CampLunch) VALUES (?,?,?,?,?)");
    const updateCamper  = db.prepare("UPDATE Campers SET HomeGroupColor=?, ShirtSize=?, CampLunch=? WHERE CamperID=?");
    const findCounselor = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const upsertHg      = db.prepare("INSERT OR REPLACE INTO CamperHomeGroups (CamperID, WeekNumber, CounselorID) VALUES (?,?,?)");
    const aw = getActiveWeek();

    try {
        db.transaction(() => {
            for (const section of sections) {
                // Resolve counselor ID once per section (null for specialty/unassigned sections)
                let counselorId = null;
                if (section.counselorName) {
                    counselorId = findCounselor.get(section.counselorName)?.CounselorID || null;
                }

                for (const row of section.dataRows) {
                    const camperRaw = safeTrim(row['Camper']);
                    if (!camperRaw) continue;

                    const { firstName, lastName } = parseLastFirst(camperRaw);
                    if (!firstName && !lastName) continue;

                    const color    = mapColor(safeTrim(row['Color']));
                    const shirt    = safeTrim(row['T-Shirt']) || null;
                    const lunchRaw = safeTrim(row['Lunch']);
                    const fullName = `${firstName} ${lastName}`;
                    const existing = findCamper.get(fullName);

                    let camperId;
                    if (existing) {
                        const lunch = existing.CampLunch === 'Allergy' ? 'Allergy' : (lunchRaw || 'No');
                        updateCamper.run(color, shirt, lunch, existing.CamperID);
                        camperId = existing.CamperID;
                    } else {
                        const info = insertCamper.run(firstName, lastName, color, shirt, lunchRaw || 'No');
                        camperId = info.lastInsertRowid;
                    }

                    if (counselorId && camperId) {
                        upsertHg.run(camperId, aw, counselorId);
                    }
                }
            }
        })();

        res.redirect('/settings?message=Camper+Roster+Import+Success');
    } catch (err) {
        console.error('ACR-005 upload error:', err);
        res.redirect('/settings?message=Database+Error+Check+Console');
    }
});

// Strips CampBrain page-break artifacts from an ACR-255 CSV export, then merges any
// continuation rows (where a camper's data was split across a page boundary) back into
// their base rows by concatenating the non-empty fields at each column position.
function preprocessACR255CSV(rawText) {
    const lines = rawText.split(/\r?\n/);
    const cleaned = [];
    let inPageBreak = false;
    let foundHeader = false;

    for (const line of lines) {
        if (/^Master Camper Schedule/i.test(line)) { inPageBreak = true; continue; }
        if (/^"?Camper"?,"?Shirt"?/i.test(line)) {
            inPageBreak = false;
            if (!foundHeader) { foundHeader = true; cleaned.push(line); }
            continue; // skip repeated headers
        }
        if (inPageBreak || !foundHeader || !line.trim()) continue;
        cleaned.push(line);
    }

    // A continuation row is any non-header row whose first field is not in "Last, First"
    // quoted format (i.e. does not open with a quoted string containing a comma).
    const result = [];
    for (const line of cleaned) {
        if (/^"?Camper"?,"?Shirt"?/i.test(line) || /^"[^"]+,[^"]+"/.test(line)) {
            result.push(line);
        } else if (result.length > 0) {
            // Merge continuation fields onto the previous row
            const base = parseCsvLine(result[result.length - 1]);
            const cont = parseCsvLine(line);
            const len = Math.max(base.length, cont.length);
            const merged = [];
            for (let i = 0; i < len; i++) {
                const b = base[i] || '';
                const c = (cont[i] || '').trim();
                merged.push(c ? b + c : b);
            }
            result[result.length - 1] = merged.map(f => {
                if (f.includes(',') || f.includes('"') || f.includes('\n'))
                    return '"' + f.replace(/"/g, '""') + '"';
                return f;
            }).join(',');
        }
    }

    return result.join('\n');
}

// ACR-255 upload: enriches existing campers with grade, bus, extended hours, and P1–P5 schedules.
// Update-only — never inserts (ACR-005 is the roster authority).
app.post('/upload-campers-schedule', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');

    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }

    const csvSlice = preprocessACR255CSV(rawText);
    if (!csvSlice || !/^"?Camper"?,"?Shirt"?/i.test(csvSlice.split(/\r?\n/)[0]))
        return res.redirect('/settings?message=Invalid+file+format+(Master+Camper+Schedule+ACR-255+expected)');

    const results = [];
    const Readable = require('stream').Readable;
    const s = new Readable(); s.push(csvSlice); s.push(null);
    s.pipe(csv())
     .on('data', d => results.push(d))
     .on('end', () => {
        const safeTrim = v => { const s = (v && typeof v === 'string') ? v.trim() : ''; return s.toLowerCase() === 'null' ? '' : s; };
        const findCamper  = db.prepare("SELECT CamperID, HomeGroupColor FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
        const updateCamper = db.prepare("UPDATE Campers SET Grade=?, BusRoute=?, ExtendedHours=? WHERE CamperID=?");
        const deleteSched  = db.prepare("DELETE FROM Schedules WHERE PersonID=? AND PersonType='Camper'");
        const insertSched  = db.prepare("INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName) VALUES (?, 'Camper', ?, ?)");

        try {
            db.transaction((rows) => {
                for (const row of rows) {
                    const camperRaw = safeTrim(row['Camper']);
                    if (!camperRaw || camperRaw === 'Camper' || camperRaw.startsWith('Master') ||
                        camperRaw.startsWith('To go') || camperRaw.startsWith('SP Session') ||
                        camperRaw.startsWith('Filter') || camperRaw.startsWith('((')) continue;

                    const { firstName, lastName } = parseLastFirst(camperRaw);
                    if (!firstName && !lastName) continue;

                    const existing = findCamper.get(`${firstName} ${lastName}`);
                    if (!existing) continue; // update-only

                    const grade = parseInt(safeTrim(row['Grade'])) || 0;
                    const busRaw = safeTrim(row['Bus Number']).replace(/^Bus\s*/i, '');
                    const bus = busRaw ? (parseInt(busRaw) || null) : null;
                    const amExt = safeTrim(row['AM Ext']);
                    const pmExt = safeTrim(row['PM Ext']);
                    const extHours = (amExt && pmExt) ? 'Both' : (amExt || pmExt || null);

                    updateCamper.run(grade, bus, extHours, existing.CamperID);

                    // Re-import schedule
                    deleteSched.run(existing.CamperID);
                    const grpColor = existing.HomeGroupColor || '';
                    for (let i = 1; i <= 5; i++) {
                        const act = safeTrim(row[`Period ${i}`]);
                        if (act) insertSched.run(existing.CamperID, camperOrdinalToClockBlock(i, grpColor), act);
                    }
                }
            })(results);

            // Auto-sync offerings for all sessions from newly imported schedule
            const allSessions = db.prepare("SELECT weekNumber FROM Sessions").all();
            for (const { weekNumber } of allSessions) {
                try { syncOfferingsForWeek(weekNumber); } catch(e) { console.error('[sync offerings]', e.message); }
            }
            res.redirect('/settings?message=Master+Camper+Schedule+Import+Success+(offerings+synced)');
        } catch (err) {
            console.error('Master Schedule upload error:', err);
            res.redirect('/settings?message=Database+Error+Check+Console');
        }
     });
});
// 1. IMPORT COUNSELORS — Name/Positions/Camp CSV from camp management software
app.post('/upload-counselors', upload.single('file'), (req, res) => {
    const CAMP_COLOR_MAP = {
        "li'l place": 'LilPlace', 'lil place': 'LilPlace',
        'kinderplace': 'KinderPlace', 'kinder place': 'KinderPlace',
        'split': 'SPLIT', 'sprc': 'SPRC',
    };
    function mapCampToColor(camp) {
        if (!camp) return null;
        const key = camp.trim().toLowerCase();
        if (key === 'summer place') return null;
        return CAMP_COLOR_MAP[key] || camp.trim();
    }
    const POSITION_TO_ROLE = {
        'counselor': 'Counselor', 'swim counselor': 'Swim Counselor',
        'faculty': 'Instructor', 'unit leader': 'Unit Leader',
        'sports leader': 'Sports Leader', 'director': 'Director',
        'office staff': 'Office Staff', 'nurse': 'Nurse',
        'cpr instructor': 'CPR Instructor', 'equipment manager': 'Equipment Manager',
        'internship': 'Internship',
    };
    // Rank for same-side deduplication (higher = wins)
    const ROLE_RANK = { 'Instructor': 5, 'Unit Leader': 4, 'Sports Leader': 4, 'Swim Counselor': 3, 'Counselor': 2 };
    // Sports-side roles vs enrichment-side
    const SPORTS_SIDE = new Set(['Counselor', 'Swim Counselor', 'Unit Leader', 'Sports Leader']);
    const ENRICH_SIDE = new Set(['Instructor']);

    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        try {
            // Group rows by normalized full name
            const grouped = new Map();
            for (const row of results) {
                const raw = (row.Name || '').trim();
                if (!raw) continue;
                const commaIdx = raw.indexOf(',');
                let firstName, lastName;
                if (commaIdx === -1) { firstName = raw; lastName = ''; }
                else { lastName = raw.slice(0, commaIdx).trim(); firstName = raw.slice(commaIdx + 1).trim(); }
                if (!firstName && !lastName) continue;
                const key = `${firstName.toUpperCase()} ${lastName.toUpperCase()}`;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push({ firstName, lastName, row });
            }

            const findCounselor = db.prepare("SELECT CounselorID, StaffRole FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
            const insCounselor  = db.prepare("INSERT INTO Counselors (FirstName, LastName, HomeGroupColor, StaffRole) VALUES (?, ?, ?, ?)");
            const updCounselor  = db.prepare("UPDATE Counselors SET HomeGroupColor = ?, StaffRole = ? WHERE CounselorID = ?");

            let imported = 0, flagged = [];
            db.transaction(() => {
                for (const [, entries] of grouped) {
                    const { firstName, lastName } = entries[0];
                    const fullName = `${firstName} ${lastName}`;

                    if (entries.length === 1) {
                        const e = entries[0];
                        const role = POSITION_TO_ROLE[(e.row.Positions || '').trim().toLowerCase()] || (e.row.Positions || '').trim();
                        const homeColor = mapCampToColor(e.row.Camp) || (role === 'Swim Counselor' ? 'Swim' : null);
                        const existing = findCounselor.get(fullName);
                        if (existing) { updCounselor.run(homeColor, role, existing.CounselorID); }
                        else { insCounselor.run(firstName, lastName, homeColor, role); }
                        imported++;
                    } else {
                        // Classify each entry's side
                        const parsed = entries.map(e => {
                            const role = POSITION_TO_ROLE[(e.row.Positions || '').trim().toLowerCase()] || (e.row.Positions || '').trim();
                            const side = SPORTS_SIDE.has(role) ? 'sports' : ENRICH_SIDE.has(role) ? 'enrichment' : 'other';
                            return { ...e, role, side };
                        });

                        const sides = new Set(parsed.map(p => p.side));
                        const isCrossSide = sides.has('sports') && sides.has('enrichment');

                        if (isCrossSide) {
                            // Opposite sides: create one record per distinct side
                            const bySide = {};
                            for (const p of parsed) {
                                if (!bySide[p.side] || (ROLE_RANK[p.role] || 1) > (ROLE_RANK[bySide[p.side].role] || 1)) {
                                    bySide[p.side] = p;
                                }
                            }
                            for (const [, e] of Object.entries(bySide)) {
                                const homeColor = mapCampToColor(e.row.Camp) || (e.role === 'Swim Counselor' ? 'Swim' : null);
                                const existing = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) AND StaffRole = ? LIMIT 1").get(fullName, e.role);
                                if (existing) { updCounselor.run(homeColor, e.role, existing.CounselorID); }
                                else { insCounselor.run(firstName, lastName, homeColor, e.role); }
                                imported++;
                            }
                            flagged.push(`${firstName} ${lastName} (dual-role: ${[...sides].join('+')})`);
                        } else {
                            const hasCounselor    = parsed.some(p => p.role === 'Counselor');
                            const hasSportsLeader = parsed.some(p => p.role === 'Sports Leader');
                            if (hasCounselor && hasSportsLeader) {
                                // Counselor + Sports Leader on same side: import as Counselor
                                // with flag so they also appear in the scheduler staff dropdown
                                const cEntry = parsed.find(p => p.role === 'Counselor');
                                const homeColor = mapCampToColor(cEntry.row.Camp) || null;
                                const existing = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) AND StaffRole = 'Counselor' LIMIT 1").get(fullName);
                                if (existing) {
                                    db.prepare("UPDATE Counselors SET HomeGroupColor = ?, StaffRole = 'Counselor', IncludeInStaffDropdown = 1 WHERE CounselorID = ?").run(homeColor, existing.CounselorID);
                                } else {
                                    db.prepare("INSERT INTO Counselors (FirstName, LastName, HomeGroupColor, StaffRole, IncludeInStaffDropdown) VALUES (?, ?, ?, 'Counselor', 1)").run(firstName, lastName, homeColor);
                                }
                                flagged.push(`${firstName} ${lastName} (counselor + sports leader: imported as Counselor with staff dropdown access)`);
                                imported++;
                            } else {
                                // Same side: keep highest-rank entry
                                const winner = parsed.reduce((best, p) => (ROLE_RANK[p.role] || 1) >= (ROLE_RANK[best.role] || 1) ? p : best);
                                const homeColor = mapCampToColor(winner.row.Camp) || (winner.role === 'Swim Counselor' ? 'Swim' : null);
                                const existing = findCounselor.get(fullName);
                                if (existing) { updCounselor.run(homeColor, winner.role, existing.CounselorID); }
                                else { insCounselor.run(firstName, lastName, homeColor, winner.role); }
                                imported++;
                            }
                        }
                    }
                }
            })();

            const msg = flagged.length
                ? `Imported+${imported}+staff.+Dual-role+flagged:+${encodeURIComponent(flagged.join(', '))}`
                : `Imported+${imported}+staff+successfully`;
            res.redirect(`/settings?message=${msg}`);
        } catch (err) {
            console.error('Counselor import error:', err);
            res.redirect('/settings?message=Error+Importing+Counselors');
        } finally {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        }
    });
});

// 2. IMPORT INSTRUCTORS — uploads to active week (same format as /upload-staff-week)
// CSV: FirstName, LastName, P1–P6, L1–L6. Unknown names are auto-inserted as Instructors.
app.post('/upload-instructors', upload.single('file'), (req, res) => {
    const weekNumber = getActiveWeek();
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        const findStaff   = db.prepare("SELECT CounselorID AS StaffID FROM Counselors WHERE FirstName = ? AND LastName = ? LIMIT 1");
        const insertStaff = db.prepare("INSERT INTO Counselors (FirstName, LastName, StaffRole) VALUES (?, ?, 'Instructor')");
        const delWeek     = db.prepare('DELETE FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ?');
        const insSchedule = db.prepare('INSERT OR REPLACE INTO StaffWeekSchedules (StaffID, WeekNumber, PeriodNumber, ActivityName, Location) VALUES (?, ?, ?, ?, ?)');

        try {
            let updated = 0, inserted = 0;
            db.transaction((data) => {
                for (const row of data) {
                    const firstName = (row.FirstName || '').trim();
                    const lastName  = (row.LastName  || '').trim();
                    if (!firstName && !lastName) continue;

                    let found = findStaff.get(firstName, lastName);
                    if (!found) {
                        const info = insertStaff.run(firstName, lastName);
                        found = { StaffID: info.lastInsertRowid };
                        inserted++;
                    }
                    const staffId = found.StaffID;
                    delWeek.run(staffId, weekNumber);
                    for (let i = 1; i <= 6; i++) {
                        if (row[`P${i}`] && row[`P${i}`].trim()) {
                            insSchedule.run(staffId, weekNumber, i, row[`P${i}`].trim(), row[`L${i}`] ? row[`L${i}`].trim() : null);
                        }
                    }
                    updated++;
                }
            })(results);
            res.redirect(`/settings?message=Week+${weekNumber}+imported:+${updated}+instructors+(${inserted}+new)`);
        } catch (err) {
            console.error('Instructor import error:', err);
            const detail = encodeURIComponent(err.message || 'unknown error');
            res.redirect(`/settings?message=Error+importing+instructors:+${detail}`);
        } finally {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        }
    });
});

// UPLOAD STAFF FULL-SUMMER WEEK (replaces all data for that week number)
app.post('/upload-staff-week/:weekNumber', upload.single('file'), (req, res) => {
    const weekNumber = parseInt(req.params.weekNumber);
    if (weekNumber < 1 || weekNumber > 6) return res.redirect('/faculty-summer?message=Invalid+week+number');

    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        const findStaff   = db.prepare("SELECT CounselorID AS StaffID FROM Counselors WHERE FirstName = ? AND LastName = ? LIMIT 1");
        const insertStaff = db.prepare("INSERT INTO Counselors (FirstName, LastName, StaffRole) VALUES (?, ?, 'Instructor')");
        const delWeek     = db.prepare('DELETE FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ?');
        const insSchedule = db.prepare('INSERT OR REPLACE INTO StaffWeekSchedules (StaffID, WeekNumber, PeriodNumber, ActivityName, Location) VALUES (?, ?, ?, ?, ?)');

        try {
            db.transaction((data) => {
                for (const row of data) {
                    const firstName = (row.FirstName || '').trim();
                    const lastName  = (row.LastName  || '').trim();
                    if (!firstName && !lastName) continue;

                    let found = findStaff.get(firstName, lastName);
                    if (!found) {
                        const info = insertStaff.run(firstName, lastName);
                        found = { StaffID: info.lastInsertRowid };
                    }
                    const staffId = found.StaffID;

                    delWeek.run(staffId, weekNumber);
                    for (let i = 1; i <= 6; i++) {
                        if (row[`P${i}`] && row[`P${i}`].trim()) {
                            insSchedule.run(staffId, weekNumber, i, row[`P${i}`].trim(), row[`L${i}`] ? row[`L${i}`].trim() : null);
                        }
                    }
                }
            })(results);
            res.redirect(`/faculty-summer?message=Week+${weekNumber}+Imported`);
        } catch (err) {
            console.error('Week upload error:', err);
            const detail = encodeURIComponent(err.message || 'unknown error');
            res.redirect(`/faculty-summer?message=Error+importing+Week+${weekNumber}:+${detail}`);
        } finally {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        }
    });
});

app.post('/clear-staff-week/:weekNumber', (req, res) => {
    const weekNumber = parseInt(req.params.weekNumber);
    db.prepare('DELETE FROM StaffWeekSchedules WHERE WeekNumber = ?').run(weekNumber);
    res.redirect(`/faculty-summer?message=Week+${weekNumber}+Cleared`);
});

// STAFF PROFILE EDITING
app.post('/update-staff-info/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const firstName      = (req.body.firstName      || '').trim();
    const lastName       = (req.body.lastName       || '').trim();
    const staffRole      = (req.body.staffRole      || '').trim();
    const validRoles = ['Instructor','Unit Leader','Sports Leader','Counselor','Swim Counselor',
                        'Director','Office Staff','Nurse','Equipment Manager','CPR Instructor','Internship'];
    if (!firstName || !lastName) return res.redirect(`/counselor-profile/${id}?message=Name+required`);
    if (!validRoles.includes(staffRole)) return res.redirect(`/counselor-profile/${id}?message=Invalid+role`);
    const homeGroupColor = (req.body.homeGroupColor || '').trim() || null;
    const scheduleType   = (req.body.scheduleType   || '').trim() || null;
    const busRoute       = (req.body.busRoute       || '').trim() || null;
    const extendedHours  = (req.body.extendedHours  || '').trim() || null;
    const phone          = (req.body.phone          || '').trim() || null;
    const email          = (req.body.email          || '').trim() || null;
    db.prepare(`
        UPDATE Counselors
        SET FirstName = ?, LastName = ?, StaffRole = ?, HomeGroupColor = ?,
            ScheduleType = ?, BusRoute = ?, ExtendedHours = ?, Phone = ?, Email = ?
        WHERE CounselorID = ?
    `).run(firstName, lastName, staffRole, homeGroupColor, scheduleType, busRoute, extendedHours, phone, email, id);
    const aw = getActiveWeek();
    db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            ScheduleType   = excluded.ScheduleType,
            BusRoute       = excluded.BusRoute,
            ExtendedHours  = excluded.ExtendedHours
    `).run(id, aw, homeGroupColor, scheduleType, busRoute, extendedHours);
    res.redirect(`/counselor-profile/${id}?message=Profile+updated`);
});

app.post('/update-staff-period', (req, res) => {
    const staffId      = parseInt(req.body.staffId);
    const weekNumber   = parseInt(req.body.weekNumber);
    const periodNumber = parseInt(req.body.periodNumber);
    const activityName = (req.body.activityName || '').trim();
    const location     = (req.body.location || '').trim() || null;
    if (!staffId || !weekNumber || !periodNumber || !activityName) return res.redirect('/counselor-directory');
    db.prepare("INSERT OR REPLACE INTO StaffWeekSchedules (StaffID, WeekNumber, PeriodNumber, ActivityName, Location) VALUES (?, ?, ?, ?, ?)").run(staffId, weekNumber, periodNumber, activityName, location);
    res.redirect(`/counselor-profile/${staffId}?message=Saved`);
});

app.post('/remove-staff-period', (req, res) => {
    const staffId      = parseInt(req.body.staffId);
    const weekNumber   = parseInt(req.body.weekNumber);
    const periodNumber = parseInt(req.body.periodNumber);
    if (!staffId || !weekNumber || !periodNumber) return res.redirect('/counselor-directory');
    db.prepare("DELETE FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ? AND PeriodNumber = ?").run(staffId, weekNumber, periodNumber);
    res.redirect(`/counselor-profile/${staffId}?message=Period+removed`);
});

// CLEAR ACTIVITIES
app.post('/clear-activities', (req, res) => {
    db.prepare("DELETE FROM Activities").run();
    res.redirect('/settings?message=Activities+Cleared');
});

// CLEAR COUNSELORS
app.post('/clear-counselors', (req, res) => {
    db.transaction(() => {
        // Null out camper references first to satisfy the foreign key constraint
        db.prepare("UPDATE Campers SET HomeGroupCounselorID = NULL").run();
        db.prepare("DELETE FROM Schedules WHERE PersonType = 'Counselor'").run();
        db.prepare("DELETE FROM Counselors").run();
    })();
    res.redirect('/settings?message=Counselors+Cleared');
});

// CLEAR STAFF (instructors, unit leaders, sports leaders)
app.post('/clear-staff', (req, res) => {
    db.prepare("DELETE FROM Schedules WHERE PersonType = 'Instructor'").run();
    db.prepare("DELETE FROM StaffWeekSchedules WHERE StaffID IN (SELECT CounselorID FROM Counselors WHERE StaffRole IN ('Instructor','Unit Leader','Sports Leader'))").run();
    db.prepare("DELETE FROM Counselors WHERE StaffRole IN ('Instructor','Unit Leader','Sports Leader','Director','Office Staff','Nurse','Equipment Manager','CPR Instructor','Internship')").run();
    res.redirect('/settings?message=Staff+Cleared');
});

// CLEAR CAMPERS
app.post('/clear-campers', (req, res) => {
    db.prepare("DELETE FROM Schedules WHERE PersonType = 'Camper'").run();
    db.prepare("DELETE FROM Waitlists").run();
    db.prepare("DELETE FROM Attendance").run();
    db.prepare("DELETE FROM EarlyDismissals").run();
    db.prepare("DELETE FROM ScheduledPickups").run();
    db.prepare("DELETE FROM ScheduleChanges").run();
    db.prepare("DELETE FROM CamperHomeGroups").run();
    db.prepare("DELETE FROM NurseLog").run();
    db.prepare("DELETE FROM CaseLog").run();
    db.prepare("DELETE FROM Campers").run();
    res.redirect('/settings?message=Campers+Cleared');
});
// --- SWAP TOOL ROUTES ---
app.get('/swap-tool', (req, res) => {
    const query = req.query.name || '';
    let camper = null;
    let currentSchedule = [];

    if (query) {
        camper = db.prepare(`
            SELECT * FROM Campers
            WHERE (FirstName || ' ' || LastName) LIKE ?
            LIMIT 1
        `).get(`%${query}%`);

        if (camper) {
            currentSchedule = db.prepare(`
                SELECT * FROM Schedules
                WHERE PersonID = ? AND PersonType = 'Camper'
                ORDER BY PeriodNumber ASC
            `).all(camper.CamperID);
        }
    }

    const allCampers = db.prepare(
        `SELECT CamperID, FirstName, LastName FROM Campers ORDER BY LastName, FirstName`
    ).all();

    res.render('swap-tool', { camper, currentSchedule, query, allCampers });
});

// Returns available activity options for a given camper's period
app.get('/get-options/:camperId/:period', (req, res) => {
    const { camperId, period } = req.params;
    const week = getActiveWeek();

    // Get the camper's home group color
    const camper = db.prepare('SELECT HomeGroupColor FROM Campers WHERE CamperID = ?').get(camperId);
    const color = camper ? camper.HomeGroupColor : null;

    // Determine the camper's current activity and its side of camp for this period
    const currentSlot = db.prepare(`
        SELECT a.SideOfCamp FROM Schedules sc
        JOIN Activities a ON a.Name = sc.ActivityName
        WHERE sc.PersonID = ? AND sc.PeriodNumber = ? AND sc.PersonType = 'Camper'
    `).get(camperId, period);
    const sideOfCamp = currentSlot ? currentSlot.SideOfCamp : null;

    // Only return activities that are actually offered this period (WeeklyOfferings),
    // on the same side of camp, accepting this camper's color.
    const options = db.prepare(`
        WITH effective AS (
            SELECT wo.ActivityName AS Name, wo.SideOfCamp,
                   COALESCE(wo.MaxCapacity, a.MaxCapacity) AS MaxCapacity,
                   COALESCE(apg.AllowedGroups, a.AllowedGroups) AS EffectiveGroups,
                   (SELECT COUNT(*) FROM Schedules s
                    WHERE s.ActivityName = wo.ActivityName AND s.PeriodNumber = @period AND s.PersonType = 'Camper') AS CurrentEnrollment
            FROM WeeklyOfferings wo
            JOIN Activities a ON a.Name = wo.ActivityName
            LEFT JOIN ActivityPeriodGroups apg
                   ON apg.ActivityName = wo.ActivityName AND apg.PeriodNumber = @period
            WHERE wo.PeriodNumber = @period AND wo.WeekNumber = @week
        )
        SELECT * FROM effective
        WHERE (@sideOfCamp IS NULL OR SideOfCamp = @sideOfCamp)
          AND (
              EffectiveGroups IS NULL OR
              EffectiveGroups = @color OR
              (EffectiveGroups = 'Red-Carolina' AND @color IN ('Red', 'Carolina')) OR
              (EffectiveGroups = 'Green-Navy'   AND @color IN ('Green', 'Navy'))
          )
        ORDER BY CurrentEnrollment ASC, Name ASC
    `).all({ period, color, sideOfCamp, week });

    res.json({ options, colorGroup: color || 'All', sideOfCamp: sideOfCamp || null });
});

// Processes a swap — updates schedule or adds to waitlist if full
app.get('/process-swap', (req, res) => {
    const { camperId, period, newActivity } = req.query;

    if (!camperId || !period || !newActivity) {
        return res.redirect('/swap-tool?error=Missing+parameters');
    }

    const activity = db.prepare('SELECT * FROM Activities WHERE Name = ?').get(newActivity);
    if (!activity) return res.redirect('/swap-tool?error=Activity+not+found');

    const currentEnrollment = db.prepare(`
        SELECT COUNT(*) as count FROM Schedules
        WHERE ActivityName = ? AND PeriodNumber = ? AND PersonType = 'Camper'
    `).get(newActivity, period);

    const camper = db.prepare('SELECT * FROM Campers WHERE CamperID = ?').get(camperId);

    if (currentEnrollment.count >= activity.MaxCapacity) {
        // Activity is full — add to waitlist instead
        db.prepare(`
            INSERT INTO Waitlists (CamperID, PeriodNumber, RequestedActivity)
            VALUES (?, ?, ?)
        `).run(camperId, period, newActivity);
    } else {
        // Capture current activity before overwriting it
        const currentSlot = db.prepare(`
            SELECT ActivityName FROM Schedules
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
        `).get(camperId, period);

        // Do the swap
        db.prepare(`
            UPDATE Schedules SET ActivityName = ?
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
        `).run(newActivity, camperId, period);

        // Log the change
        if (camper && currentSlot) {
            db.prepare(`
                INSERT INTO ScheduleChanges (CamperID, CamperName, ColorGroup, PeriodNumber, OldActivity, NewActivity)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                camper.CamperID,
                `${camper.FirstName} ${camper.LastName}`,
                camper.HomeGroupColor || null,
                parseInt(period),
                currentSlot.ActivityName,
                newActivity
            );
        }
    }

    const name = camper ? `${camper.FirstName}+${camper.LastName}` : '';
    res.redirect(`/swap-tool?name=${name}&message=Schedule+Updated`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE HISTORY
// ─────────────────────────────────────────────────────────────────────────────

app.get('/schedule-history', (req, res) => {
    const changes = db.prepare(`
        SELECT * FROM ScheduleChanges ORDER BY ChangedAt DESC
    `).all();
    const archived = db.prepare(`
        SELECT * FROM ScheduleChangesArchive ORDER BY ArchivedAt DESC
    `).all();
    res.render('schedule-history', { changes, archived, alertMessage: req.query.message });
});

app.post('/archive-schedule-changes', (req, res) => {
    // ids may come in as a single string or an array depending on how many are checked
    const raw = req.body.changeIds;
    if (!raw) return res.redirect('/schedule-history?message=Nothing+selected');

    const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Boolean);
    if (!ids.length) return res.redirect('/schedule-history?message=Nothing+selected');

    const archiveOne = db.prepare(`
        INSERT OR IGNORE INTO ScheduleChangesArchive
            (ChangeID, CamperID, CamperName, ColorGroup, PeriodNumber, OldActivity, NewActivity, ChangedAt)
        SELECT ChangeID, CamperID, CamperName, ColorGroup, PeriodNumber, OldActivity, NewActivity, ChangedAt
        FROM ScheduleChanges WHERE ChangeID = ?
    `);
    const deleteOne = db.prepare('DELETE FROM ScheduleChanges WHERE ChangeID = ?');

    const moveSelected = db.transaction((selectedIds) => {
        for (const id of selectedIds) {
            archiveOne.run(id);
            deleteOne.run(id);
        }
    });

    try {
        moveSelected(ids);
        res.redirect('/schedule-history?message=Marked+as+Updated+in+CampBrain');
    } catch (err) {
        console.error(err);
        res.redirect('/schedule-history?message=Error+archiving+changes');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

// Helper: today's date as YYYY-MM-DD in local time
function todayStr() {
    const d = new Date();
    const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${eastern.getFullYear()}-${String(eastern.getMonth()+1).padStart(2,'0')}-${String(eastern.getDate()).padStart(2,'0')}`;
}
function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getViewerName(req) {
    if (req.cookies.viewMode === 'admin') return req.cookies.adminName || 'Admin';
    const cid = parseInt(req.cookies.selectedCounselor) || 0;
    if (!cid) return 'Staff';
    const c = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?").get(cid);
    return c ? `${c.FirstName} ${c.LastName}` : 'Staff';
}

function getScheduledPickupMap(date) {
    const rows = db.prepare(`
        SELECT sp.CamperID, sp.PickupTime, sp.Notes, sp.PeriodNumber,
               s.ActivityName
        FROM ScheduledPickups sp
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber
        WHERE sp.Date = ?
    `).all(date);
    const map = {};
    for (const r of rows) map[r.CamperID] = {
        pickupTime: r.PickupTime,
        notes: r.Notes,
        periodNumber: r.PeriodNumber,
        activityName: r.ActivityName
    };
    return map;
}

// Sessions that should show the "absent AM" indicator (i.e. everything after homegroup_am)
const SHOW_AM_INDICATOR = new Set(['class','homegroup_lunch','homegroup_pm','bus_pm','extended_pm','specialty_pm']);

// --- ATTENDANCE OVERVIEW ---
app.get('/attendance', (req, res) => {
    const date = req.query.date || todayStr();

    const isStaff = req.cookies.viewMode !== 'admin';
    const showAll = req.query.showAll === '1';
    const filterCid = (isStaff && !showAll) ? (parseInt(req.cookies.selectedCounselor) || null) : null;
    let selectedCounselorName = null;
    let allowedClasses = null;
    let counselorBusRoute = null;
    let counselorExtHours = null;
    let counselorGroupColor = null;
    let isStaffMemberFilter = false;
    const STAFF_ROLES = new Set(['Instructor', 'Unit Leader', 'Sports Leader']);
    if (filterCid) {
        const cRow = db.prepare(`
            SELECT c.FirstName, c.LastName, c.StaffRole,
                   COALESCE(cwa.BusRoute, c.BusRoute) AS BusRoute,
                   COALESCE(cwa.ExtendedHours, c.ExtendedHours) AS ExtendedHours,
                   COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            WHERE c.CounselorID = ?
        `).get(getActiveWeek(), filterCid);
        if (cRow) {
            selectedCounselorName = `${cRow.FirstName} ${cRow.LastName}`;
            isStaffMemberFilter = STAFF_ROLES.has(cRow.StaffRole);
            counselorBusRoute = isStaffMemberFilter ? null : (cRow.BusRoute || null);
            counselorExtHours = isStaffMemberFilter ? null : (cRow.ExtendedHours || null);
            counselorGroupColor = isStaffMemberFilter ? null : (cRow.HomeGroupColor || null);
        }
        allowedClasses = new Set();
        if (isStaffMemberFilter) {
            // Instructors/Unit Leaders/Sports Leaders: scheduled in StaffWeekSchedules
            const assignments = db.prepare(
                'SELECT PeriodNumber, ActivityName FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ?'
            ).all(filterCid, getActiveWeek());
            for (const a of assignments) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
        } else {
            // Counselors: scheduled in CounselorWeekSchedules
            const assignments = db.prepare(
                'SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ?'
            ).all(filterCid, getActiveWeek());
            for (const a of assignments) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
        }
    }

    // Homegroup sessions — grouped by counselor
    // Mirror getWeekCampersForCounselor: prefer CamperHomeGroups for the active week,
    // fall back to the legacy HomeGroupCounselorID column if no week data exists.
    const aw = getActiveWeek();
    const hasWeekHgData = db.prepare("SELECT 1 FROM CamperHomeGroups WHERE WeekNumber=? LIMIT 1").get(aw);

    let homegroupCounselors;
    let checkHgHandled;
    if (hasWeekHgData) {
        homegroupCounselors = db.prepare(`
            SELECT co.CounselorID, co.FirstName, co.LastName,
                   COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) AS HomeGroupColor,
                   COUNT(chg.CamperID) as camperCount
            FROM Counselors co
            JOIN CamperHomeGroups chg ON chg.CounselorID = co.CounselorID AND chg.WeekNumber = ?
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
            GROUP BY co.CounselorID
            ORDER BY co.LastName, co.FirstName
        `).all(aw, aw);
        checkHgHandled = db.prepare(`
            SELECT COUNT(*) as n FROM (
                SELECT CamperID FROM Attendance
                WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                  AND CamperID IN (SELECT CamperID FROM CamperHomeGroups WHERE CounselorID=? AND WeekNumber=?)
                UNION
                SELECT CamperID FROM EarlyDismissals WHERE Date=?
                  AND CamperID IN (SELECT CamperID FROM CamperHomeGroups WHERE CounselorID=? AND WeekNumber=?)
            )
        `);
    } else {
        homegroupCounselors = db.prepare(`
            SELECT co.CounselorID, co.FirstName, co.LastName, co.HomeGroupColor,
                   COUNT(ca.CamperID) as camperCount
            FROM Counselors co
            JOIN Campers ca ON ca.HomeGroupCounselorID = co.CounselorID
            GROUP BY co.CounselorID
            ORDER BY co.LastName, co.FirstName
        `).all();
        checkHgHandled = db.prepare(`
            SELECT COUNT(*) as n FROM (
                SELECT CamperID FROM Attendance
                WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                  AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupCounselorID=?)
                UNION
                SELECT CamperID FROM EarlyDismissals WHERE Date=?
                  AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupCounselorID=?)
            )
        `);
    }

    const homegroupSessions = [];
    for (const counselor of homegroupCounselors) {
        for (const session of ['am', 'lunch', 'pm']) {
            const sessionType = `homegroup_${session}`;
            const handledCount = hasWeekHgData
                ? checkHgHandled.get(date, sessionType, counselor.CounselorID, aw, date, counselor.CounselorID, aw)?.n || 0
                : checkHgHandled.get(date, sessionType, counselor.CounselorID, date, counselor.CounselorID)?.n || 0;
            const sessionLabel = session === 'lunch' ? 'Lunch' : session.toUpperCase();
            homegroupSessions.push({
                label: `${counselor.FirstName} ${counselor.LastName} — ${sessionLabel}`,
                counselorId: counselor.CounselorID,
                color: counselor.HomeGroupColor,
                session: session,
                link: `/attendance/homegroup/counselor/${counselor.CounselorID}/${session}?date=${date}`,
                submitted: counselor.camperCount > 0 && handledCount >= counselor.camperCount
            });
        }
    }

    // Class sessions — each row is a distinct clock-block + activity (no AM/PM split needed).
    const classRows = db.prepare(`
        SELECT DISTINCT s.PeriodNumber, s.ActivityName
        FROM Schedules s
        WHERE s.PersonType = 'Camper' AND s.ActivityName NOT LIKE '#REF%'
        ORDER BY s.PeriodNumber, s.ActivityName
    `).all();

    const checkClassTotal = db.prepare(
        "SELECT COUNT(*) as n FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?"
    );
    const checkClassHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?)
        )
    `);

    const classSessions = [];
    for (const r of classRows) {
        const total = checkClassTotal.get(r.PeriodNumber, r.ActivityName)?.n || 0;
        const handled = checkClassHandled.get(date, r.PeriodNumber, r.ActivityName, date, r.PeriodNumber, r.ActivityName)?.n || 0;
        classSessions.push({
            label: `Block ${r.PeriodNumber} — ${r.ActivityName}`,
            periodNumber: r.PeriodNumber, periodKey: String(r.PeriodNumber), periodLabel: String(r.PeriodNumber),
            activityName: r.ActivityName, filterPeriod: r.PeriodNumber,
            link: `/attendance/class/${r.PeriodNumber}/${encodeURIComponent(r.ActivityName)}?date=${date}`,
            submitted: total > 0 && handled >= total
        });
    }

    // Bus sessions
    const busRoutes = db.prepare("SELECT DISTINCT BusRoute FROM Campers WHERE BusRoute IS NOT NULL AND BusRoute != '' AND LOWER(CAST(BusRoute AS TEXT)) != 'null' ORDER BY BusRoute").all().map(r => r.BusRoute);
    const checkBusHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
              AND CamperID IN (SELECT CamperID FROM Campers WHERE BusRoute=?)
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT CamperID FROM Campers WHERE BusRoute=?)
        )
    `);
    const busSessions = [];
    for (const route of busRoutes) {
        const busTotal = db.prepare("SELECT COUNT(*) as n FROM Campers WHERE BusRoute=?").get(route)?.n || 0;
        for (const session of ['am', 'pm']) {
            const sessionType = `bus_${session}`;
            const handled = checkBusHandled.get(date, sessionType, route, date, route)?.n || 0;
            busSessions.push({
                label: `Bus ${route} — ${session.toUpperCase()}`,
                route,
                session: session,
                link: `/attendance/bus/${encodeURIComponent(route)}/${session}?date=${date}`,
                submitted: busTotal > 0 && handled >= busTotal
            });
        }
    }

    // Extended sessions
    const extSessions = [];
    for (const session of ['am', 'pm']) {
        const sessionType = `extended_${session}`;
        const col = session === 'am' ? "('AM','Both')" : "('PM','Both')";
        const extTotal = db.prepare(`SELECT COUNT(*) as n FROM Campers WHERE ExtendedHours IN ${col}`).get()?.n || 0;
        if (extTotal > 0) {
            const handled = db.prepare(`
                SELECT COUNT(*) as n FROM (
                    SELECT CamperID FROM Attendance
                    WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                      AND CamperID IN (SELECT CamperID FROM Campers WHERE ExtendedHours IN ${col})
                    UNION
                    SELECT CamperID FROM EarlyDismissals WHERE Date=?
                      AND CamperID IN (SELECT CamperID FROM Campers WHERE ExtendedHours IN ${col})
                )
            `).get(date, sessionType, date)?.n || 0;
            extSessions.push({
                label: `Extended ${session.toUpperCase()}`,
                session: session,
                link: `/attendance/extended/${session}?date=${date}`,
                submitted: handled >= extTotal
            });
        }
    }

    // Specialty camp sessions — color-based shared view
    const specialtySessions = [];
    for (const color of SPECIALTY_CAMP_COLORS) {
        const total = db.prepare(
            "SELECT COUNT(*) as n FROM Campers WHERE HomeGroupColor=?"
        ).get(color)?.n || 0;
        if (total === 0) continue;
        const checkSpHandled = db.prepare(`
            SELECT COUNT(*) as n FROM (
                SELECT CamperID FROM Attendance
                WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                  AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupColor=?)
                UNION
                SELECT CamperID FROM EarlyDismissals WHERE Date=?
                  AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupColor=?)
            )
        `);
        for (const session of ['am', 'pm']) {
            const sessionType = `specialty_${session}`;
            const handled = checkSpHandled.get(date, sessionType, color, date, color)?.n || 0;
            specialtySessions.push({
                label: `${HOME_GROUP_LABELS[color] || color} — ${session.toUpperCase()}`,
                color, session,
                link: `/attendance/specialty/${color}/${session}?date=${date}`,
                submitted: total > 0 && handled >= total
            });
        }
    }

    // Late arrivals count
    const lateCount = db.prepare(
        "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')"
    ).get(date)?.n || 0;

    let filteredHomegroupSessions = homegroupSessions;
    let filteredClassSessions = classSessions;
    let filteredBusSessions = busSessions;
    let filteredExtSessions = extSessions;
    let filteredSpecialtySessions = specialtySessions;
    if (filterCid) {
        filteredClassSessions = classSessions.filter(s =>
            allowedClasses.has(`${s.filterPeriod}|${s.activityName.toLowerCase()}`)
        );
        if (isStaffMemberFilter) {
            // Instructors/ULs/SLs: no home groups, bus, extended, or specialty
            filteredHomegroupSessions = [];
            filteredBusSessions = [];
            filteredExtSessions = [];
            filteredSpecialtySessions = [];
        } else {
            filteredHomegroupSessions = homegroupSessions.filter(s => s.counselorId === filterCid);
            filteredBusSessions = counselorBusRoute
                ? busSessions.filter(s => s.route === counselorBusRoute)
                : [];
            filteredExtSessions = extSessions.filter(s => {
                if (!counselorExtHours) return false;
                if (counselorExtHours === 'Both') return true;
                return s.session.toUpperCase() === counselorExtHours.toUpperCase();
            });
            filteredSpecialtySessions = SPECIALTY_CAMP_COLORS.includes(counselorGroupColor)
                ? specialtySessions.filter(s => s.color === counselorGroupColor)
                : [];
        }
    }

    res.render('attendance-overview', {
        date,
        homegroupSessions: filteredHomegroupSessions,
        classSessions: filteredClassSessions,
        busSessions: filteredBusSessions,
        extSessions: filteredExtSessions,
        specialtySessions: filteredSpecialtySessions,
        lateCount,
        counselorFilterActive: !!filterCid,
        selectedCounselorName
    });
});

// --- ATTENDANCE FORM: HOMEGROUP BY COUNSELOR ---
app.get('/attendance/homegroup/counselor/:counselorId/:session', (req, res) => {
    const counselorId = parseInt(req.params.counselorId);
    const { session } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = `homegroup_${session}`;
    const showAmIndicator = SHOW_AM_INDICATOR.has(sessionType);

    const counselor = db.prepare("SELECT * FROM Counselors WHERE CounselorID=?").get(counselorId);
    if (!counselor) return res.status(404).send('Counselor not found');

    const campers = getWeekCampersForCounselor(counselorId, getActiveWeek());

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')")
            .all(date).forEach(r => absentAMSet.add(r.CamperID));
    }
    const absentBusAMSet = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='bus_am' AND Status='absent'")
            .all(date).map(r => r.CamperID)
    );
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''")
        .all(date, sessionType).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = ? AND PeriodNumber = 0 AND ActivityName = '')`)
            .all(date, sessionType).map(r => r.CamperID)
    );

    const nurseAMSet1 = getNurseAMSet(date);
    const caseLogSet1 = getCaseLogSet(date);
    const pickupMap1 = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        absentBusAM: absentBusAMSet.has(c.CamperID),
        nurseAM: nurseAMSet1.has(c.CamperID),
        caseLog: caseLogSet1.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMap1[c.CamperID] || null
    }));

    res.render('attendance-form', {
        title: `${counselor.FirstName} ${counselor.LastName}'s Group — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster
    });
});

// --- ATTENDANCE FORM: HOMEGROUP BY COLOR (legacy) ---
app.get('/attendance/homegroup/:color/:session', (req, res) => {
    const { color, session } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = `homegroup_${session}`;
    const showAmIndicator = SHOW_AM_INDICATOR.has(sessionType);

    const campers = db.prepare("SELECT * FROM Campers WHERE HomeGroupColor=? ORDER BY LastName, FirstName").all(color);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')")
            .all(date).forEach(r => absentAMSet.add(r.CamperID));
    }
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''")
        .all(date, sessionType).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = ? AND PeriodNumber = 0 AND ActivityName = '')`)
            .all(date, sessionType).map(r => r.CamperID)
    );

    const nurseAMSet2 = getNurseAMSet(date);
    const caseLogSet2 = getCaseLogSet(date);
    const pickupMap2 = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        nurseAM: nurseAMSet2.has(c.CamperID),
        caseLog: caseLogSet2.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMap2[c.CamperID] || null
    }));

    res.render('attendance-form', {
        title: `${color} Group — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster
    });
});

// --- ATTENDANCE FORM: SPECIALTY CAMP (color-based, shared view) ---
app.get('/attendance/specialty/:color/:session', (req, res) => {
    const { color, session } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = `specialty_${session}`;
    const showAmIndicator = SHOW_AM_INDICATOR.has(sessionType);

    const campers = db.prepare(
        "SELECT * FROM Campers WHERE HomeGroupColor=? ORDER BY LastName, FirstName"
    ).all(color);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='specialty_am' AND Status='absent'")
            .all(date).forEach(r => absentAMSet.add(r.CamperID));
    }
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''")
        .all(date, sessionType).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = ? AND PeriodNumber = 0 AND ActivityName = '')`)
            .all(date, sessionType).map(r => r.CamperID)
    );

    const nurseAMSet3 = getNurseAMSet(date);
    const caseLogSet3 = getCaseLogSet(date);
    const pickupMap3 = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        nurseAM: nurseAMSet3.has(c.CamperID),
        caseLog: caseLogSet3.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMap3[c.CamperID] || null
    }));

    const isSplitAM = color === 'SPLIT' && session === 'am';
    const fieldTripActive = isSplitAM
        ? !!db.prepare("SELECT 1 FROM SplitFieldTrip WHERE Date=?").get(date)
        : false;

    res.render('attendance-form', {
        title: `${HOME_GROUP_LABELS[color] || color} — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster,
        isSplitAM, fieldTripActive,
        splitColor: color
    });
});

// --- ATTENDANCE FORM: CLASS ---
app.get('/attendance/class/:period/:activity', (req, res) => {
    const period = parseInt(req.params.period);
    const activityName = req.params.activity;
    const date = req.query.date || todayStr();
    const sessionType = 'class';

    // Each clock block + activity is attended by exactly one group, no half filter needed.
    const campers = db.prepare(`
        SELECT c.* FROM Campers c
        JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
        WHERE s.PeriodNumber = ? AND s.ActivityName = ?
        ORDER BY c.HomeGroupColor, c.LastName, c.FirstName
    `).all(period, activityName);

    const absentAMSet = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')")
            .all(date).map(r => r.CamperID)
    );
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?")
        .all(date, period, activityName).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = 'class' AND PeriodNumber = ? AND ActivityName = ?)`)
            .all(date, period, activityName).map(r => r.CamperID)
    );

    const nurseAMSet4 = getNurseAMSet(date);
    const caseLogSet4 = getCaseLogSet(date);
    const pickupMap4 = getScheduledPickupMap(date);

    // SPLIT campers in this class are read-only; their status comes from specialty_am
    const splitIds4 = campers.filter(c => c.HomeGroupColor === 'SPLIT').map(c => c.CamperID);
    const splitSpecialtyStatus4 = {};
    if (splitIds4.length > 0) {
        const ph4 = splitIds4.map(() => '?').join(',');
        db.prepare(`SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType='specialty_am' AND CamperID IN (${ph4})`).all(date, ...splitIds4)
            .forEach(r => { splitSpecialtyStatus4[r.CamperID] = r.Status; });
    }
    const classFieldTrip4 = splitIds4.length > 0 ? !!db.prepare("SELECT 1 FROM SplitFieldTrip WHERE Date=?").get(date) : false;

    const roster = campers.map(c => {
        const isSplit = c.HomeGroupColor === 'SPLIT';
        return {
            ...c,
            currentStatus: isSplit ? splitSpecialtyStatus4[c.CamperID] || null : statusMap[c.CamperID] || null,
            absentAM: absentAMSet.has(c.CamperID),
            nurseAM: nurseAMSet4.has(c.CamperID),
            caseLog: caseLogSet4.has(c.CamperID),
            dismissed: dismissedSet.has(c.CamperID),
            seenEarlier: seenEarlierSet.has(c.CamperID),
            scheduledPickup: pickupMap4[c.CamperID] || null,
            isSplit,
            fieldTripActive: isSplit ? classFieldTrip4 : false
        };
    });
    const hasSplits = splitIds4.length > 0;

    const locationRow = db.prepare(
        "SELECT Location FROM Schedules WHERE PersonType='Instructor' AND PeriodNumber=? AND ActivityName=? AND Location IS NOT NULL AND Location!='' LIMIT 1"
    ).get(period, activityName);

    const staffRows = db.prepare(`
        SELECT st.FirstName, st.LastName, st.StaffRole AS StaffType
        FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
        WHERE s.PeriodNumber = ? AND s.ActivityName = ?
        ORDER BY st.StaffRole, st.LastName
    `).all(period, activityName);

    const counselorRows = db.prepare(`
        SELECT c.FirstName, c.LastName
        FROM Counselors c
        JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID
        WHERE cws.PeriodNumber = ? AND cws.ActivityName = ? COLLATE NOCASE AND cws.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(period, activityName, getActiveWeek());

    res.render('attendance-form', {
        title: `Block ${period} — ${activityName}`,
        sessionType, date,
        periodNumber: period, activityName,
        location: locationRow ? locationRow.Location : null,
        staffRows, counselorRows,
        backLink: `/attendance?date=${date}`,
        roster,
        hasSplits, fieldTripActive: classFieldTrip4
    });
});

// --- ATTENDANCE FORM: BUS ---
app.get('/attendance/bus/:route/:session', (req, res) => {
    const { route, session } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = `bus_${session}`;
    const showAmIndicator = SHOW_AM_INDICATOR.has(sessionType);

    const campers = db.prepare("SELECT * FROM Campers WHERE BusRoute=? ORDER BY LastName, FirstName").all(route);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')")
            .all(date).forEach(r => absentAMSet.add(r.CamperID));
    }
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''")
        .all(date, sessionType).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = ? AND PeriodNumber = 0 AND ActivityName = '')`)
            .all(date, sessionType).map(r => r.CamperID)
    );

    const nurseAMSet5 = getNurseAMSet(date);
    const caseLogSet5 = getCaseLogSet(date);
    const pickupMap5 = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        nurseAM: nurseAMSet5.has(c.CamperID),
        caseLog: caseLogSet5.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMap5[c.CamperID] || null
    }));

    res.render('attendance-form', {
        title: `Bus ${route} — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster
    });
});

// --- ATTENDANCE FORM: EXTENDED ---
app.get('/attendance/extended/:session', (req, res) => {
    const { session } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = `extended_${session}`;
    const showAmIndicator = SHOW_AM_INDICATOR.has(sessionType);

    const col = session === 'am' ? "('AM','Both')" : "('PM','Both')";
    const campers = db.prepare(`SELECT * FROM Campers WHERE ExtendedHours IN ${col} ORDER BY LastName, FirstName`).all();

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status IN ('absent','nurse')")
            .all(date).forEach(r => absentAMSet.add(r.CamperID));
    }
    const dismissedSet = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(date).map(r => r.CamperID)
    );
    const statusMap = {};
    db.prepare("SELECT CamperID, Status FROM Attendance WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''")
        .all(date, sessionType).forEach(r => { statusMap[r.CamperID] = r.Status; });

    const seenEarlierSet = new Set(
        db.prepare(`SELECT DISTINCT CamperID FROM Attendance
                    WHERE Date = ? AND Status IN ('present','late')
                      AND NOT (SessionType = ? AND PeriodNumber = 0 AND ActivityName = '')`)
            .all(date, sessionType).map(r => r.CamperID)
    );

    const nurseAMSet6 = getNurseAMSet(date);
    const caseLogSet6 = getCaseLogSet(date);
    const pickupMap6 = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        nurseAM: nurseAMSet6.has(c.CamperID),
        caseLog: caseLogSet6.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMap6[c.CamperID] || null
    }));

    res.render('attendance-form', {
        title: `Extended ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster
    });
});

// --- MARK ATTENDANCE (AJAX) ---
app.use(express.json());
app.post('/attendance/mark', (req, res) => {
    const { date, camperId, sessionType, periodNumber = 0, activityName = '', status } = req.body;
    if (!date || !camperId || !sessionType || !status) return res.status(400).json({ ok: false });
    const markedBy = getViewerName(req);
    try {
        db.prepare(`
            INSERT INTO Attendance (Date, CamperID, SessionType, PeriodNumber, ActivityName, Status, MarkedBy)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (Date, CamperID, SessionType, PeriodNumber, ActivityName)
            DO UPDATE SET Status = excluded.Status, MarkedAt = CURRENT_TIMESTAMP, MarkedBy = excluded.MarkedBy
        `).run(date, camperId, sessionType, periodNumber, activityName, status, markedBy);
        res.json({ ok: true, status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- LATE ARRIVALS ---
app.get('/attendance/late-arrivals', (req, res) => {
    const date = req.query.date || todayStr();
    const campers = db.prepare(`
        SELECT c.*, a.Status AS AttendanceStatus
        FROM Campers c
        JOIN Attendance a ON c.CamperID = a.CamperID
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status = 'absent'
        ORDER BY c.HomeGroupColor, c.LastName, c.FirstName
    `).all(date);

    const roster = campers.map(c => {
        const schedule = db.prepare(
            "SELECT PeriodNumber, ActivityName FROM Schedules WHERE PersonID=? AND PersonType='Camper' ORDER BY PeriodNumber"
        ).all(c.CamperID);
        return { ...c, schedule };
    });

    const dismissed = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               ed.DismissalTime, ed.Notes, ed.MarkedBy, ed.CreatedAt
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        WHERE ed.Date = ?
        ORDER BY ed.CreatedAt
    `).all(date);

    res.render('attendance-late-arrivals', { date, roster, dismissed });
});

app.post('/attendance/check-in', (req, res) => {
    const { date, camperId } = req.body;
    const markedBy = getViewerName(req);
    db.prepare(`
        UPDATE Attendance SET Status = 'late', MarkedAt = CURRENT_TIMESTAMP, MarkedBy = ?
        WHERE Date = ? AND CamperID = ? AND SessionType = 'homegroup_am'
    `).run(markedBy, date, camperId);
    res.redirect(`/attendance/late-arrivals?date=${date}`);
});

// --- EARLY DISMISSAL ---
app.post('/attendance/early-dismissal', (req, res) => {
    const { date, camperId, dismissalTime, notes, returnTo } = req.body;
    const markedBy = getViewerName(req);
    db.prepare(`
        INSERT INTO EarlyDismissals (Date, CamperID, DismissalTime, Notes, MarkedBy)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (Date, CamperID) DO UPDATE SET
            DismissalTime = excluded.DismissalTime,
            Notes = excluded.Notes,
            MarkedBy = excluded.MarkedBy
    `).run(date, camperId, dismissalTime || null, notes || null, markedBy);
    res.redirect(returnTo || `/attendance?date=${date}`);
});

// --- DISMISSAL ARCHIVE ---
app.get('/attendance/dismissal-archive', (req, res) => {
    const date = req.query.date || todayStr();
    const dismissals = db.prepare(`
        SELECT c.FirstName, c.LastName, c.HomeGroupColor,
               ed.DismissalTime, ed.Notes, ed.MarkedBy, ed.CreatedAt
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        WHERE ed.Date = ? ORDER BY ed.CreatedAt
    `).all(date);
    const checkIns = db.prepare(`
        SELECT c.FirstName, c.LastName, c.HomeGroupColor,
               a.MarkedAt, a.MarkedBy
        FROM Attendance a JOIN Campers c ON c.CamperID = a.CamperID
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status = 'late'
        ORDER BY a.MarkedAt
    `).all(date);
    const scheduledPickups = db.prepare(`
        SELECT sp.PickupTime, sp.Notes, sp.CreatedBy,
               c.FirstName, c.LastName, c.HomeGroupColor
        FROM ScheduledPickups sp JOIN Campers c ON c.CamperID = sp.CamperID
        WHERE sp.Date = ? ORDER BY sp.PickupTime
    `).all(date);
    res.render('attendance-dismissal-archive', { date, dismissals, checkIns, scheduledPickups });
});

// --- NURSE LOG ---
function nowTimeStr() {
    const d = new Date();
    const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${String(eastern.getHours()).padStart(2,'0')}:${String(eastern.getMinutes()).padStart(2,'0')}`;
}

app.get('/debug-hg', (req, res) => {
    if (req.cookies.adminAuth !== 'true') return res.status(403).json({ error: 'admin only' });
    const week = parseInt(req.query.week) || getActiveWeek();
    const counselorColors = db.prepare("SELECT HomeGroupColor, COUNT(*) as cnt FROM Counselors WHERE StaffRole='Counselor' GROUP BY HomeGroupColor ORDER BY HomeGroupColor").all();
    const camperColors    = db.prepare("SELECT HomeGroupColor, COUNT(*) as cnt FROM Campers GROUP BY HomeGroupColor ORDER BY HomeGroupColor").all();
    const chgCounts       = db.prepare("SELECT WeekNumber, COUNT(*) as cnt FROM CamperHomeGroups GROUP BY WeekNumber ORDER BY WeekNumber").all();
    const cwaCount        = db.prepare("SELECT COUNT(*) as cnt FROM CounselorWeekAttributes WHERE WeekNumber=?").get(week);
    const cwaColored      = db.prepare("SELECT COUNT(*) as cnt FROM CounselorWeekAttributes WHERE WeekNumber=? AND HomeGroupColor IN ('Red','Carolina','Green','Navy')").get(week);
    const unassigned      = db.prepare("SELECT FirstName, LastName FROM Counselors co LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID=co.CounselorID AND cwa.WeekNumber=? WHERE co.StaffRole='Counselor' AND COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) IS NULL ORDER BY co.LastName").all(week);
    const activeWeek      = db.prepare("SELECT weekNumber, label FROM Sessions WHERE isActive=1").get();
    res.json({ activeWeek, queriedWeek: week, counselorColors, camperColors, chgCounts, cwaCount, cwaColored, unassignedCounselors: unassigned });
});

app.get('/nurse', (req, res) => {
    const today = todayStr();
    const visits = db.prepare(`
        SELECT n.VisitID, n.CheckInTime, n.CheckOutTime, n.Notes, n.Dismissed, n.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor
        FROM NurseLog n JOIN Campers c ON c.CamperID = n.CamperID
        WHERE n.Date = ?
        ORDER BY n.CheckInTime DESC
    `).all(today);
    const campers = db.prepare(
        "SELECT CamperID, FirstName, LastName, HomeGroupColor FROM Campers ORDER BY LastName, FirstName"
    ).all();
    const message = req.query.message || null;
    res.render('nurse', { visits, campers, today, message, viewMode: req.cookies.viewMode || 'admin' });
});

app.post('/nurse/checkin', (req, res) => {
    const { camperId, notes } = req.body;
    if (!camperId) return res.redirect('/nurse');
    const today = todayStr();
    const checkInTime = nowTimeStr();
    const createdBy = getViewerName(req);
    db.prepare(`
        INSERT INTO NurseLog (Date, CamperID, CheckInTime, Notes, CreatedBy)
        VALUES (?, ?, ?, ?, ?)
    `).run(today, camperId, checkInTime, notes || null, createdBy);
    // Mark homegroup_am attendance as 'nurse' (absent for headcount, labeled for rosters)
    db.prepare(`
        INSERT INTO Attendance (Date, CamperID, SessionType, PeriodNumber, ActivityName, Status, MarkedBy)
        VALUES (?, ?, 'homegroup_am', 0, '', 'nurse', ?)
        ON CONFLICT (Date, CamperID, SessionType, PeriodNumber, ActivityName) DO UPDATE SET
            Status = 'nurse', MarkedBy = excluded.MarkedBy
    `).run(today, camperId, createdBy);
    res.redirect('/nurse');
});

app.post('/nurse/checkout/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const visit = db.prepare("SELECT * FROM NurseLog WHERE VisitID = ?").get(visitId);
    if (!visit) return res.redirect('/nurse');
    db.prepare("UPDATE NurseLog SET CheckOutTime = ? WHERE VisitID = ?").run(nowTimeStr(), visitId);
    // Clear the nurse attendance so the camper returns to unmarked and counselors can re-mark them
    db.prepare(
        "DELETE FROM Attendance WHERE Date=? AND CamperID=? AND SessionType='homegroup_am' AND Status='nurse'"
    ).run(visit.Date, visit.CamperID);
    res.redirect('/nurse');
});

app.post('/nurse/dismiss/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const visit = db.prepare("SELECT * FROM NurseLog WHERE VisitID = ?").get(visitId);
    if (!visit) return res.redirect('/nurse');
    const today = todayStr();
    const dismissalTime = nowTimeStr();
    const markedBy = getViewerName(req);
    // Check out if not already
    if (!visit.CheckOutTime) {
        db.prepare("UPDATE NurseLog SET CheckOutTime = ?, Dismissed = 1 WHERE VisitID = ?")
            .run(dismissalTime, visitId);
    } else {
        db.prepare("UPDATE NurseLog SET Dismissed = 1 WHERE VisitID = ?").run(visitId);
    }
    // Insert into EarlyDismissals so they're marked dismissed on all attendance forms
    db.prepare(`
        INSERT INTO EarlyDismissals (Date, CamperID, DismissalTime, Notes, MarkedBy)
        VALUES (?, ?, ?, 'Dismissed from nurse', ?)
        ON CONFLICT (Date, CamperID) DO UPDATE SET
            DismissalTime = excluded.DismissalTime,
            Notes = excluded.Notes,
            MarkedBy = excluded.MarkedBy
    `).run(today, visit.CamperID, dismissalTime, markedBy);
    // Remove the nurse attendance record so they no longer appear in any absence grid
    db.prepare(
        "DELETE FROM Attendance WHERE Date=? AND CamperID=? AND SessionType='homegroup_am' AND Status='nurse'"
    ).run(visit.Date, visit.CamperID);
    res.redirect('/nurse');
});

app.post('/nurse/update-notes/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const { notes } = req.body;
    db.prepare("UPDATE NurseLog SET Notes = ? WHERE VisitID = ?").run(notes || null, visitId);
    res.redirect('/nurse');
});

app.get('/nurse/archive', (req, res) => {
    const rows = db.prepare(`
        SELECT n.VisitID, n.Date, n.CheckInTime, n.CheckOutTime, n.Notes, n.Dismissed, n.CreatedBy,
               c.FirstName, c.LastName, c.HomeGroupColor
        FROM NurseLog n JOIN Campers c ON c.CamperID = n.CamperID
        ORDER BY n.Date DESC, n.CheckInTime DESC
    `).all();

    const byDate = {};
    for (const r of rows) {
        if (!byDate[r.Date]) byDate[r.Date] = [];
        byDate[r.Date].push(r);
    }

    res.render('nurse-archive', { byDate, viewMode: req.cookies.viewMode || 'admin' });
});

// --- CASE LOG ---
app.get('/case-log', (req, res) => {
    const today = todayStr();
    const visits = db.prepare(`
        SELECT cl.VisitID, cl.CheckInTime, cl.CheckOutTime, cl.Notes, cl.Dismissed, cl.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor
        FROM CaseLog cl JOIN Campers c ON c.CamperID = cl.CamperID
        WHERE cl.Date = ?
        ORDER BY cl.CheckInTime DESC
    `).all(today);
    const campers = db.prepare("SELECT CamperID, FirstName, LastName, HomeGroupColor FROM Campers ORDER BY LastName, FirstName").all();
    const message = req.query.message || null;
    res.render('case-log', { visits, campers, today, message, viewMode: req.cookies.viewMode || 'admin' });
});

app.post('/case-log/checkin', (req, res) => {
    const { camperId, notes } = req.body;
    if (!camperId) return res.redirect('/case-log');
    const today = todayStr();
    const checkInTime = nowTimeStr();
    const createdBy = getViewerName(req);
    db.prepare(`
        INSERT INTO CaseLog (Date, CamperID, CheckInTime, Notes, CreatedBy)
        VALUES (?, ?, ?, ?, ?)
    `).run(today, camperId, checkInTime, notes || null, createdBy);
    res.redirect('/case-log');
});

app.post('/case-log/checkout/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const visit = db.prepare("SELECT * FROM CaseLog WHERE VisitID = ?").get(visitId);
    if (!visit) return res.redirect('/case-log');
    db.prepare("UPDATE CaseLog SET CheckOutTime = ? WHERE VisitID = ?").run(nowTimeStr(), visitId);
    res.redirect('/case-log');
});

app.post('/case-log/dismiss/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const visit = db.prepare("SELECT * FROM CaseLog WHERE VisitID = ?").get(visitId);
    if (!visit) return res.redirect('/case-log');
    const today = todayStr();
    const dismissalTime = nowTimeStr();
    const markedBy = getViewerName(req);
    if (!visit.CheckOutTime) {
        db.prepare("UPDATE CaseLog SET CheckOutTime = ?, Dismissed = 1 WHERE VisitID = ?")
            .run(dismissalTime, visitId);
    } else {
        db.prepare("UPDATE CaseLog SET Dismissed = 1 WHERE VisitID = ?").run(visitId);
    }
    db.prepare(`
        INSERT INTO EarlyDismissals (Date, CamperID, DismissalTime, Notes, MarkedBy)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (Date, CamperID) DO UPDATE SET
            DismissalTime = excluded.DismissalTime, Notes = excluded.Notes, MarkedBy = excluded.MarkedBy
    `).run(today, visit.CamperID, dismissalTime, 'Via Case Log', markedBy);
    res.redirect('/case-log');
});

app.post('/case-log/update-notes/:visitId', (req, res) => {
    const visitId = parseInt(req.params.visitId);
    const { notes } = req.body;
    db.prepare("UPDATE CaseLog SET Notes = ? WHERE VisitID = ?").run(notes || null, visitId);
    res.redirect('/case-log');
});

app.get('/case-log/archive', (req, res) => {
    const rows = db.prepare(`
        SELECT cl.VisitID, cl.Date, cl.CheckInTime, cl.CheckOutTime, cl.Notes, cl.Dismissed, cl.CreatedBy,
               c.FirstName, c.LastName, c.HomeGroupColor
        FROM CaseLog cl JOIN Campers c ON c.CamperID = cl.CamperID
        ORDER BY cl.Date DESC, cl.CheckInTime DESC
    `).all();
    const byDate = {};
    for (const r of rows) {
        if (!byDate[r.Date]) byDate[r.Date] = [];
        byDate[r.Date].push(r);
    }
    res.render('case-log-archive', { byDate, viewMode: req.cookies.viewMode || 'admin' });
});

// --- SCHEDULED PICKUPS / DISMISSALS TOOL ---
app.get('/dismissals', (req, res) => {
    const today = todayStr();
    const q = (req.query.q || '').trim();
    const selectedId = parseInt(req.query.camperId) || null;

    let searchResults = [];
    if (q.length >= 2) {
        searchResults = db.prepare(`
            SELECT CamperID, FirstName, LastName, HomeGroupColor
            FROM Campers
            WHERE FirstName LIKE ? OR LastName LIKE ?
               OR (FirstName || ' ' || LastName) LIKE ?
            ORDER BY LastName, FirstName LIMIT 20
        `).all(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    let selectedCamper = null;
    let existingPickup = null;
    if (selectedId) {
        selectedCamper = db.prepare(`SELECT * FROM Campers WHERE CamperID = ?`).get(selectedId);
        existingPickup = db.prepare(`SELECT * FROM ScheduledPickups WHERE CamperID = ? AND Date = ?`).get(selectedId, today);
    }

    const todayPickups = db.prepare(`
        SELECT sp.PickupID, sp.PickupTime, sp.PeriodNumber, sp.Notes, sp.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               s.ActivityName
        FROM ScheduledPickups sp
        JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber
        WHERE sp.Date = ?
        ORDER BY sp.PickupTime
    `).all(today);

    res.render('dismissals', { q, searchResults, selectedCamper, existingPickup, todayPickups, today });
});

app.post('/dismissals/schedule', (req, res) => {
    const { camperId, date, pickupTime, notes } = req.body;
    const createdBy = getViewerName(req);
    const camper = db.prepare("SELECT HomeGroupColor FROM Campers WHERE CamperID = ?").get(parseInt(camperId));
    let periodNumber = null;
    if (pickupTime && camper) {
        const [h, m] = pickupTime.split(':').map(Number);
        periodNumber = inferPeriodFromTime(h * 60 + m, camper.HomeGroupColor);
    }
    db.prepare(`
        INSERT INTO ScheduledPickups (Date, CamperID, PickupTime, PeriodNumber, Notes, CreatedBy)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (Date, CamperID) DO UPDATE SET
            PickupTime = excluded.PickupTime,
            PeriodNumber = excluded.PeriodNumber,
            Notes = excluded.Notes,
            CreatedBy = excluded.CreatedBy
    `).run(date, parseInt(camperId), pickupTime, periodNumber, notes || null, createdBy);
    res.redirect(`/dismissals?camperId=${camperId}`);
});

app.post('/dismissals/cancel', (req, res) => {
    const { pickupId, returnTo } = req.body;
    db.prepare(`DELETE FROM ScheduledPickups WHERE PickupID = ?`).run(parseInt(pickupId));
    res.redirect(returnTo === 'all' ? '/dismissals/all' : '/dismissals');
});

app.get('/dismissals/all', (_req, res) => {
    const pickups = db.prepare(`
        SELECT sp.PickupID, sp.Date, sp.PickupTime, sp.PeriodNumber, sp.Notes, sp.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               s.ActivityName
        FROM ScheduledPickups sp
        JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber
        ORDER BY sp.Date ASC, sp.PickupTime ASC
    `).all();
    const today = todayStr();
    res.render('dismissals-all', { pickups, today });
});

app.post('/dismissals/update', (req, res) => {
    const { pickupId, pickupTime, notes } = req.body;
    const id = parseInt(pickupId);
    const row = db.prepare(`
        SELECT sp.PeriodNumber, c.HomeGroupColor
        FROM ScheduledPickups sp JOIN Campers c ON c.CamperID = sp.CamperID
        WHERE sp.PickupID = ?
    `).get(id);
    if (!row) return res.redirect('/dismissals/all');
    let periodNumber = null;
    if (pickupTime) {
        const [h, m] = pickupTime.split(':').map(Number);
        periodNumber = inferPeriodFromTime(h * 60 + m, row.HomeGroupColor);
    }
    db.prepare(`
        UPDATE ScheduledPickups SET PickupTime = ?, PeriodNumber = ?, Notes = ? WHERE PickupID = ?
    `).run(pickupTime, periodNumber, notes || null, id);
    res.redirect('/dismissals/all');
});

// --- Counselor Scheduling Tool ---
app.get('/counselor-scheduling', (req, res) => {
    const sessions   = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();
    const planWeek   = Math.min(6, Math.max(1, parseInt(req.query.week) || getActiveWeek()));
    const alertMessage = req.query.message || null;

    // Offerings filtered to planning week, with per-week capacity/location overrides
    const offerings = db.prepare(`
        SELECT wo.*, COALESCE(wo.MaxCapacity, a.MaxCapacity) AS EffectiveCapacity,
               COALESCE(wo.Location, a.Location) AS EffectiveLocation
        FROM WeeklyOfferings wo
        LEFT JOIN Activities a ON a.Name = wo.ActivityName
        WHERE wo.WeekNumber = ?
        ORDER BY wo.SideOfCamp, wo.ActivityName
    `).all(planWeek);

    // Counselors with week-specific attributes (fall back to Counselors table)
    // Only Counselor and Swim Counselor roles — not Instructors, Unit Leaders, etc.
    const allCounselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName, c.StaffRole,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.BusRoute,       c.BusRoute)       AS BusRoute,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType,
               COALESCE(cwa.ExtendedHours,  c.ExtendedHours)  AS ExtendedHours,
               cwa.SpecialtyGroup
        FROM Counselors c
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        WHERE c.StaffRole IN ('Counselor', 'Swim Counselor')
        ORDER BY c.LastName, c.FirstName
    `).all(planWeek);

    const SPECIALTY_SET = new Set(SPECIALTY_CAMP_COLORS);
    // Auto-set HomeGroupColor for Swim Counselors who don't have it yet
    for (const c of allCounselors) {
        if (c.StaffRole === 'Swim Counselor' && !c.HomeGroupColor) c.HomeGroupColor = 'Swim';
    }
    const mainCounselors      = allCounselors.filter(c => (!SPECIALTY_SET.has(c.HomeGroupColor) || c.SpecialtyGroup) && !(c.StaffRole === 'Swim Counselor' && !c.ScheduleType));
    const specialtyCounselors = [];
    for (const c of allCounselors) {
        if (SPECIALTY_SET.has(c.HomeGroupColor)) {
            specialtyCounselors.push(c);
        } else if (c.SpecialtyGroup) {
            // Dual-assigned: also appears in specialty section with specialty color
            specialtyCounselors.push({ ...c, HomeGroupColor: c.SpecialtyGroup, _dualAssigned: true });
        } else if (c.StaffRole === 'Swim Counselor') {
            // Swim counselor assigned to a main homegroup — still appears in Swim section
            specialtyCounselors.push({ ...c, HomeGroupColor: 'Swim', _dualAssigned: true });
        }
    }
    // Keep counselors array as all for backwards-compat with availability/assignment logic below
    const counselors = allCounselors;

    const availability = {};
    const staffAvailability = {};

    // Derive periods from the actual offerings (supports '3AM', '3PM', integers, etc.)
    const availSports = db.prepare(`
        SELECT DISTINCT c.CounselorID, c.FirstName, c.LastName,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType
        FROM Counselors c
        JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID AND cws.WeekNumber = ? AND cws.PeriodNumber = ?
        JOIN Activities a ON a.Name = cws.ActivityName AND a.SideOfCamp = 'Sports'
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `);
    const availEnrich = db.prepare(`
        SELECT DISTINCT c.CounselorID, c.FirstName, c.LastName,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType
        FROM Counselors c
        JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID AND cws.WeekNumber = ? AND cws.PeriodNumber = ?
        JOIN Activities a ON a.Name = cws.ActivityName AND a.SideOfCamp = 'Enrichment'
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `);
    const staffSports = db.prepare(`
        SELECT DISTINCT st.CounselorID AS StaffID, st.FirstName, st.LastName, st.StaffRole AS StaffType
        FROM Counselors st
        JOIN Schedules s ON s.PersonID = st.CounselorID AND s.PersonType = 'Instructor' AND s.PeriodNumber = ?
        JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Sports'
        ORDER BY st.LastName, st.FirstName
    `);
    const staffEnrich = db.prepare(`
        SELECT DISTINCT st.CounselorID AS StaffID, st.FirstName, st.LastName, st.StaffRole AS StaffType
        FROM Counselors st
        JOIN Schedules s ON s.PersonID = st.CounselorID AND s.PersonType = 'Instructor' AND s.PeriodNumber = ?
        JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Enrichment'
        ORDER BY st.LastName, st.FirstName
    `);

    const offeringPeriods = [...new Set(offerings.map(o => o.PeriodNumber).filter(p => p != null))];
    for (const p of offeringPeriods) {
        const pInt = parseInt(p);
        availability[p] = {
            Sports:     availSports.all(planWeek, pInt, planWeek),
            Enrichment: availEnrich.all(planWeek, pInt, planWeek),
        };
        staffAvailability[p] = {
            Sports:     staffSports.all(pInt),
            Enrichment: staffEnrich.all(pInt),
        };
    }

    // Load existing counselor assignments from CounselorWeekSchedules for this planning week
    const rawCounselorAssignments = db.prepare('SELECT CounselorID, PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber=?').all(planWeek);
    // Load existing staff assignments from CounselorScheduleAssignments for this planning week
    const rawStaffAssignments = db.prepare("SELECT PersonID, PeriodNumber, ActivityName FROM CounselorScheduleAssignments WHERE PersonType='Instructor' AND WeekNumber=?").all(planWeek);
    const existingAssignments = {};
    rawCounselorAssignments.forEach(a => {
        const key = `${a.PeriodNumber}|${a.ActivityName}`;
        if (!existingAssignments[key]) existingAssignments[key] = { counselors: [], staff: [] };
        existingAssignments[key].counselors.push(a.CounselorID);
    });
    rawStaffAssignments.forEach(a => {
        const key = `${a.PeriodNumber}|${a.ActivityName}`;
        if (!existingAssignments[key]) existingAssignments[key] = { counselors: [], staff: [] };
        existingAssignments[key].staff.push(a.PersonID);
    });

    const camperCountRows = db.prepare(
        "SELECT HomeGroupColor, COUNT(*) as n FROM Campers WHERE HomeGroupColor IN ('Red','Carolina','Green','Navy') GROUP BY HomeGroupColor"
    ).all();
    const camperCounts = {};
    for (const r of camperCountRows) camperCounts[r.HomeGroupColor] = r.n;

    const rawPrefs = db.prepare("SELECT * FROM CounselorPreferences").all();
    const preferences = rawPrefs.map(p => ({
        ...p,
        ActivityPreferences: JSON.parse(p.ActivityPreferences || '[]')
    }));

    const staffMembers = db.prepare(`
        SELECT CounselorID AS StaffID, FirstName, LastName,
            CASE WHEN IncludeInStaffDropdown = 1 AND StaffRole = 'Counselor'
                 THEN 'Sports Leader'
                 ELSE StaffRole
            END AS StaffType
        FROM Counselors
        WHERE StaffRole IN ('Instructor', 'Unit Leader', 'Sports Leader')
           OR IncludeInStaffDropdown = 1
        ORDER BY LastName, FirstName
    `).all();

    res.render('counselor-scheduling', { offerings, counselors, mainCounselors, specialtyCounselors, availability, staffAvailability, existingAssignments, alertMessage, camperCounts, preferences, sessions, planWeek, staffMembers });
});

app.post('/auto-assign-homegroups', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getActiveWeek();

    const camperRows = db.prepare(`
        SELECT HomeGroupColor, COUNT(*) as n FROM Campers
        WHERE HomeGroupColor IN ('Red','Carolina','Green','Navy')
        GROUP BY HomeGroupColor
    `).all();
    const camperCounts = Object.fromEntries(camperRows.map(r => [r.HomeGroupColor, r.n]));
    const totalCampers = Object.values(camperCounts).reduce((a, b) => a + b, 0);

    // Determine which counselors already have campers assigned in CamperHomeGroups for this week.
    // A counselor's color is pinned to the dominant color of their assigned campers so that
    // the scheduler badge stays in sync with the actual attendance roster.
    const pinnedRows = db.prepare(`
        SELECT chg.CounselorID, c.HomeGroupColor
        FROM CamperHomeGroups chg
        JOIN Campers c ON chg.CamperID = c.CamperID
        WHERE chg.WeekNumber = ?
          AND c.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
        GROUP BY chg.CounselorID
    `).all(week);
    const pinnedMap = {};
    for (const r of pinnedRows) pinnedMap[r.CounselorID] = r.HomeGroupColor;

    // Include all main-camp counselors (role='Counselor')
    const counselors = db.prepare(`
        SELECT c.CounselorID,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS CurrentColor
        FROM Counselors c
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        WHERE c.StaffRole = 'Counselor'
    `).all(week);
    const totalCounselors = counselors.length;

    if (totalCounselors === 0 || totalCampers === 0) {
        return res.redirect(`/counselor-scheduling?week=${week}&message=No+data+to+assign`);
    }

    // Proportional targets with largest-remainder rounding
    const colors = ['Red', 'Carolina', 'Green', 'Navy'];
    const targets = {};
    let assigned = 0;
    colors.forEach(color => {
        targets[color] = Math.floor(((camperCounts[color] || 0) / totalCampers) * totalCounselors);
        assigned += targets[color];
    });
    const remainder = totalCounselors - assigned;
    colors
        .map(c => ({ c, frac: ((camperCounts[c] || 0) / totalCampers) * totalCounselors - targets[c] }))
        .sort((a, b) => b.frac - a.frac)
        .slice(0, remainder)
        .forEach(({ c }) => targets[c]++);

    // Split counselors into pinned (have existing homegroup roster) and free (to be randomly assigned)
    const pinned   = counselors.filter(c =>  pinnedMap[c.CounselorID]);
    const free     = counselors.filter(c => !pinnedMap[c.CounselorID]);

    // Remaining slots after accounting for pinned counselors
    const remaining = Object.fromEntries(colors.map(col => {
        const pinnedCount = pinned.filter(c => pinnedMap[c.CounselorID] === col).length;
        return [col, Math.max(0, targets[col] - pinnedCount)];
    }));

    // If pinned counselors over-subscribed a color, redistribute those extra slots
    // to whichever free color has the most remaining capacity
    const totalRemaining = Object.values(remaining).reduce((a, b) => a + b, 0);
    let overflow = free.length - totalRemaining;
    if (overflow > 0) {
        while (overflow-- > 0) {
            const col = colors.reduce((a, b) => remaining[a] >= remaining[b] ? a : b);
            remaining[col]++;
        }
    }

    const shuffled = [...free].sort(() => Math.random() - 0.5);
    const scheduleFor = color => (['Red','Carolina'].includes(color) ? 'AM Enrichment / PM Sports' : 'AM Sports / PM Enrichment');

    const upsert = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            ScheduleType   = excluded.ScheduleType
    `);

    db.transaction(() => {
        // Write pinned counselors with the color derived from their actual homegroup roster
        for (const c of pinned) {
            const col = pinnedMap[c.CounselorID];
            upsert.run(c.CounselorID, week, col, scheduleFor(col));
        }
        // Randomly assign free counselors into the remaining slots
        let offset = 0;
        for (const color of colors) {
            const slice = shuffled.slice(offset, offset + remaining[color]);
            offset += remaining[color];
            for (const c of slice) upsert.run(c.CounselorID, week, color, scheduleFor(color));
        }
    })();

    res.redirect(`/counselor-scheduling?week=${week}&message=Homegroups+auto-assigned`);
});

app.post('/sync-homegroup-colors', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getActiveWeek();

    // For each counselor who has campers assigned in CamperHomeGroups, derive their color
    // from the dominant color of those campers and write it to CounselorWeekAttributes.
    // Counselors with no assigned campers are left untouched.
    const pinnedRows = db.prepare(`
        SELECT chg.CounselorID, c.HomeGroupColor
        FROM CamperHomeGroups chg
        JOIN Campers c ON chg.CamperID = c.CamperID
        WHERE chg.WeekNumber = ?
          AND c.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
        GROUP BY chg.CounselorID
    `).all(week);

    if (pinnedRows.length === 0) {
        return res.redirect(`/counselor-scheduling?week=${week}&message=No+homegroup+roster+data+found+for+this+week`);
    }

    const scheduleFor = color => (['Red','Carolina'].includes(color) ? 'AM Enrichment / PM Sports' : 'AM Sports / PM Enrichment');
    const upsert = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            ScheduleType   = excluded.ScheduleType
    `);

    db.transaction(() => {
        for (const r of pinnedRows) {
            upsert.run(r.CounselorID, week, r.HomeGroupColor, scheduleFor(r.HomeGroupColor));
        }
    })();

    res.redirect(`/counselor-scheduling?week=${week}&message=Synced+${pinnedRows.length}+counselor+colors+from+roster`);
});

app.post('/save-counselor-group-assignments', (req, res) => {
    const { counselors, weekNumber } = req.body;
    if (!Array.isArray(counselors)) return res.status(400).json({ error: 'Invalid payload' });
    const week = parseInt(weekNumber) || getActiveWeek();
    const upsert = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours, SpecialtyGroup)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            ScheduleType   = excluded.ScheduleType,
            BusRoute       = excluded.BusRoute,
            ExtendedHours  = excluded.ExtendedHours,
            SpecialtyGroup = excluded.SpecialtyGroup
    `);
    db.transaction(list => {
        for (const c of list) {
            if (!c.counselorID) continue;
            upsert.run(
                c.counselorID,
                week,
                c.homeGroupColor || null,
                c.scheduleType   || null,
                c.busRoute       || null,
                c.extendedHours  || null,
                c.specialtyGroup || null
            );
        }
    })(counselors);
    res.json({ ok: true });
});

app.post('/upload-weekly-offerings', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/counselor-scheduling?message=No+file+uploaded.');
    const weekNumber = parseInt(req.body.weekNumber) || 1;
    const confirm    = req.body.confirm === '1';

    if (!confirm) {
        const existing = db.prepare('SELECT COUNT(*) as n FROM WeeklyOfferings WHERE WeekNumber=?').get(weekNumber);
        if (existing.n > 0) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.redirect(`/settings?confirmOfferWeek=${weekNumber}&offerCount=${existing.n}`);
        }
    }

    const rows = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', row => {
            const name          = (row.ActivityName || '').trim();
            const enrollment    = parseInt(row.PreliminaryEnrollment) || 0;
            const side          = (row.SideOfCamp || '').trim();
            const rawPeriod     = (row.PeriodNumber || '').trim();
            const period        = rawPeriod === '' ? null : (/^\d+$/.test(rawPeriod) ? parseInt(rawPeriod) : rawPeriod);
            const maxCap        = parseInt(row.MaxCapacity) || null;
            const location      = (row.Location || '').trim() || null;
            const allowedGroups = (row.AllowedGroups || '').trim() || null;
            if (name) rows.push([weekNumber, name, enrollment, side, period, maxCap, location, allowedGroups]);
        })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            db.prepare('DELETE FROM WeeklyOfferings WHERE WeekNumber=?').run(weekNumber);
            const ins = db.prepare('INSERT INTO WeeklyOfferings (WeekNumber, ActivityName, PreliminaryEnrollment, SideOfCamp, PeriodNumber, MaxCapacity, Location, AllowedGroups) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            db.transaction(items => { for (const item of items) ins.run(...item); })(rows);
            res.redirect(`/counselor-scheduling?week=${weekNumber}&message=Loaded+${rows.length}+offerings+for+Week+${weekNumber}.`);
        })
        .on('error', () => res.redirect('/counselor-scheduling?message=Error+reading+file.'));
});

app.post('/clear-weekly-offerings', (req, res) => {
    const weekNumber = parseInt(req.body.weekNumber) || getActiveWeek();
    db.prepare('DELETE FROM WeeklyOfferings WHERE WeekNumber=?').run(weekNumber);
    res.redirect(`/counselor-scheduling?week=${weekNumber}&message=Week+${weekNumber}+offerings+cleared.`);
});

function deriveSideOfCamp(color, p) {
    if (['Red','Carolina'].includes(color)) return p <= 2 ? 'Enrichment' : 'Sports';
    if (['Green','Navy'].includes(color))   return p <= 3 ? 'Sports' : 'Enrichment';
    return null;
}
function toUniversalPeriod(color, p) {
    if (['Red','Carolina'].includes(color)) return p > 3  ? p + 1 : p;
    if (['Green','Navy'].includes(color))   return p >= 3 ? p + 1 : p;
    return p;
}
function deriveAllowedGroups(colorSet) {
    const rc = colorSet.has('Red') || colorSet.has('Carolina');
    const gn = colorSet.has('Green') || colorSet.has('Navy');
    if (rc && gn) return null;
    if (colorSet.has('Red') && colorSet.has('Carolina')) return 'Red-Carolina';
    if (colorSet.has('Red'))      return 'Red';
    if (colorSet.has('Carolina')) return 'Carolina';
    return 'Green-Navy';
}

function syncOfferingsForWeek(weekNumber) {
    const rows = db.prepare(`
        SELECT s.ActivityName, s.PeriodNumber AS CamperPeriod,
               c.HomeGroupColor, COUNT(*) AS Enrollment
        FROM Schedules s
        JOIN Campers c ON s.PersonID = c.CamperID
        WHERE s.PersonType = 'Camper'
          AND c.HomeGroupColor IN ('Red','Carolina','Green','Navy')
        GROUP BY s.ActivityName, s.PeriodNumber, c.HomeGroupColor
    `).all();

    if (!rows.length) return { activitiesCount: 0, offeringsCount: 0, crossSide: [] };

    const offeringMap = new Map();
    for (const row of rows) {
        const uPeriod = row.CamperPeriod;
        const key = `${row.ActivityName}|${uPeriod}`;
        if (!offeringMap.has(key)) {
            offeringMap.set(key, {
                activityName: row.ActivityName,
                universalPeriod: uPeriod,
                side: deriveSideOfCamp(row.HomeGroupColor, row.CamperPeriod),
                colorSet: new Set(),
                enrollment: 0
            });
        }
        const entry = offeringMap.get(key);
        entry.colorSet.add(row.HomeGroupColor);
        entry.enrollment += row.Enrollment;
    }

    const activityMap = new Map();
    for (const [, entry] of offeringMap) {
        const act = activityMap.get(entry.activityName);
        if (!act) {
            activityMap.set(entry.activityName, { side: entry.side, colorSet: new Set(entry.colorSet) });
        } else {
            for (const c of entry.colorSet) act.colorSet.add(c);
            if (act.side !== entry.side) act.side = null;
        }
    }

    const crossSide = [];
    db.transaction(() => {
        const upsertAct = db.prepare(`
            INSERT INTO Activities (Name, SideOfCamp, MaxCapacity, AllowedGroups)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(Name) DO UPDATE SET
                SideOfCamp    = COALESCE(Activities.SideOfCamp,    excluded.SideOfCamp),
                MaxCapacity   = COALESCE(Activities.MaxCapacity,   excluded.MaxCapacity),
                AllowedGroups = COALESCE(Activities.AllowedGroups, excluded.AllowedGroups)
        `);
        for (const [name, act] of activityMap) {
            if (!act.side) crossSide.push(name);
            const cap = act.side === 'Sports' ? 25 : act.side === 'Enrichment' ? 16 : 20;
            upsertAct.run(name, act.side, cap, deriveAllowedGroups(act.colorSet));
        }

        db.prepare('DELETE FROM WeeklyOfferings WHERE WeekNumber=?').run(weekNumber);
        const insOffer = db.prepare(`
            INSERT INTO WeeklyOfferings
              (WeekNumber, ActivityName, PreliminaryEnrollment, SideOfCamp, PeriodNumber, MaxCapacity, AllowedGroups)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [, entry] of offeringMap) {
            const cap = entry.side === 'Sports' ? 25 : entry.side === 'Enrichment' ? 16 : 20;
            insOffer.run(weekNumber, entry.activityName, entry.enrollment,
                         entry.side, entry.universalPeriod, cap,
                         deriveAllowedGroups(entry.colorSet));
        }
    })();

    return { activitiesCount: activityMap.size, offeringsCount: offeringMap.size, crossSide };
}

app.post('/api/sync-offerings', (req, res) => {
    const weekNumber = parseInt(req.body.weekNumber) || getActiveWeek();
    const result = syncOfferingsForWeek(weekNumber);
    res.json({ ok: true, ...result });
});

app.post('/sync-offerings-from-schedule', (req, res) => {
    const weekNumber = parseInt(req.body.weekNumber) || getActiveWeek();
    const { activitiesCount, offeringsCount, crossSide } = syncOfferingsForWeek(weekNumber);
    if (activitiesCount === 0)
        return res.redirect(`/settings?message=No+standard-group+camper+schedules+found+for+Week+${weekNumber}.`);
    let msg = `Synced+${activitiesCount}+activities,+${offeringsCount}+offerings+for+Week+${weekNumber}.`;
    if (crossSide.length) msg += `+Cross-side+activities+(need+manual+review):+${crossSide.map(n => n.replace(/ /g,'+')).join(',+')}.`;
    res.redirect(`/settings?message=${msg}`);
});

app.post('/save-counselor-assignments', (req, res) => {
    const { assignments, weekNumber } = req.body;
    if (!Array.isArray(assignments)) return res.status(400).json({ error: 'Invalid payload' });
    const w = parseInt(weekNumber) || getActiveWeek();

    // Collect counselor IDs being submitted for this week
    const counselorIds = [...new Set(assignments.filter(a => a.personType === 'Counselor' && a.personID).map(a => parseInt(a.personID)))];

    try {
        db.transaction(() => {
            // Wipe this week's counselor assignments (all periods) for submitted counselors
            if (counselorIds.length > 0) {
                const placeholders = counselorIds.map(() => '?').join(',');
                db.prepare(`DELETE FROM CounselorWeekSchedules WHERE WeekNumber=? AND CounselorID IN (${placeholders})`).run(w, ...counselorIds);
            }
            // Re-insert counselor assignments for this week
            const insCws = db.prepare('INSERT OR REPLACE INTO CounselorWeekSchedules (CounselorID, WeekNumber, PeriodNumber, ActivityName) VALUES (?, ?, ?, ?)');
            // Wipe this week's staff assignments and reinsert
            db.prepare("DELETE FROM CounselorScheduleAssignments WHERE WeekNumber=? AND PersonType IN ('Instructor', 'Staff')").run(w);
            const insStaff = db.prepare('INSERT OR IGNORE INTO CounselorScheduleAssignments (WeekNumber, PeriodNumber, ActivityName, PersonID, PersonType) VALUES (?, ?, ?, ?, ?)');

            for (const a of assignments) {
                if (!a.periodNumber || !a.activityName || !a.personID || !a.personType) continue;
                const pNum = parseInt(a.periodNumber);
                if (a.personType === 'Counselor') {
                    if (isNaN(pNum) || pNum < 1 || pNum > 6) continue; // skip invalid periods
                    insCws.run(parseInt(a.personID), w, pNum, a.activityName);
                } else {
                    insStaff.run(w, pNum, a.activityName, a.personID, a.personType);
                }
            }
        })();
        res.json({ ok: true });
    } catch (err) {
        console.error('[save-counselor-assignments]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- COUNSELOR SCHEDULE BACKUPS ---
app.post('/backup-counselor-assignments', (req, res) => {
    const { weekNumber, label } = req.body;
    const w   = parseInt(weekNumber) || getActiveWeek();
    const lbl = (label || '').trim() || 'Backup';

    const counselorSchedules = db.prepare(
        'SELECT CounselorID, WeekNumber, PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber=?'
    ).all(w);
    const staffAssignments = db.prepare(
        'SELECT WeekNumber, PeriodNumber, ActivityName, PersonID, PersonType FROM CounselorScheduleAssignments WHERE WeekNumber=?'
    ).all(w);

    const snapshot = JSON.stringify({ weekNumber: w, counselorSchedules, staffAssignments });
    db.prepare('INSERT INTO CounselorScheduleBackups (WeekNumber, Label, AssignmentsJSON) VALUES (?, ?, ?)').run(w, lbl, snapshot);
    res.json({ ok: true });
});

app.get('/counselor-schedule-backups', (req, res) => {
    const backups  = db.prepare('SELECT BackupID, WeekNumber, Label, CreatedAt FROM CounselorScheduleBackups ORDER BY CreatedAt DESC').all();
    const sessions = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();
    const alertMessage = req.query.message || null;
    res.render('counselor-schedule-backups', { backups, sessions, alertMessage });
});

app.post('/restore-counselor-backup/:id', (req, res) => {
    const backup = db.prepare('SELECT * FROM CounselorScheduleBackups WHERE BackupID=?').get(req.params.id);
    if (!backup) return res.redirect('/counselor-schedule-backups?message=Backup+not+found.');

    let parsed;
    try { parsed = JSON.parse(backup.AssignmentsJSON); }
    catch { return res.redirect('/counselor-schedule-backups?message=Backup+data+is+corrupt.'); }

    const { weekNumber, counselorSchedules = [], staffAssignments = [] } = parsed;

    db.transaction(() => {
        db.prepare('DELETE FROM CounselorWeekSchedules WHERE WeekNumber=?').run(weekNumber);
        db.prepare("DELETE FROM CounselorScheduleAssignments WHERE WeekNumber=?").run(weekNumber);

        const insCws = db.prepare('INSERT OR REPLACE INTO CounselorWeekSchedules (CounselorID, WeekNumber, PeriodNumber, ActivityName) VALUES (?, ?, ?, ?)');
        for (const r of counselorSchedules) insCws.run(r.CounselorID, r.WeekNumber, r.PeriodNumber, r.ActivityName);

        const insStaff = db.prepare('INSERT OR IGNORE INTO CounselorScheduleAssignments (WeekNumber, PeriodNumber, ActivityName, PersonID, PersonType) VALUES (?, ?, ?, ?, ?)');
        for (const r of staffAssignments) insStaff.run(r.WeekNumber, r.PeriodNumber, r.ActivityName, r.PersonID, r.PersonType);
    })();

    res.redirect(`/counselor-schedule-backups?message=Restored+%22${encodeURIComponent(backup.Label)}%22+to+Week+${weekNumber}.`);
});

app.post('/delete-counselor-backup/:id', (req, res) => {
    db.prepare('DELETE FROM CounselorScheduleBackups WHERE BackupID=?').run(req.params.id);
    res.redirect('/counselor-schedule-backups?message=Backup+deleted.');
});

app.get('/export-counselor-schedule', (_req, res) => {
    const aw = getActiveWeek();
    const counselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType,
               COALESCE(cwa.BusRoute,       c.BusRoute)       AS BusRoute,
               COALESCE(cwa.ExtendedHours,  c.ExtendedHours)  AS ExtendedHours
        FROM Counselors c
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(aw);
    const assignments = db.prepare(
        'SELECT CounselorID, PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber = ?'
    ).all(aw);
    const periodsByID = {};
    assignments.forEach(a => {
        if (!periodsByID[a.CounselorID]) periodsByID[a.CounselorID] = {};
        periodsByID[a.CounselorID][a.PeriodNumber] = a.ActivityName;
    });
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let out = 'FirstName,LastName,HomeGroupColor,ScheduleType,Bus,Extended,P1,P2,P3,P4,P5,P6\n';
    counselors.forEach(c => {
        const p = periodsByID[c.CounselorID] || {};
        out += [c.FirstName, c.LastName, c.HomeGroupColor, c.ScheduleType, c.BusRoute, c.ExtendedHours,
            p[1]||'', p[2]||'', p[3]||'', p[4]||'', p[5]||'', p[6]||''].map(q).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="counselor-schedule.csv"');
    res.send(out);
});

app.get('/export-staff-schedule', (_req, res) => {
    const rows = db.prepare(`
        SELECT a.PeriodNumber, a.ActivityName, st.CounselorID AS StaffID, st.FirstName, st.LastName, st.HomeGroupColor, st.StaffRole AS StaffType
        FROM CounselorScheduleAssignments a
        JOIN Counselors st ON st.CounselorID = a.PersonID AND a.PersonType = 'Instructor'
        ORDER BY st.LastName, st.FirstName, a.PeriodNumber
    `).all();
    const byID = {};
    rows.forEach(r => {
        if (!byID[r.StaffID]) byID[r.StaffID] = { FirstName: r.FirstName, LastName: r.LastName, HomeGroupColor: r.HomeGroupColor, StaffType: r.StaffType, periods: {} };
        byID[r.StaffID].periods[r.PeriodNumber] = r.ActivityName;
    });
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let out = 'FirstName,LastName,HomeGroupColor,StaffType,P1,P2,P3,P4,P5,P6\n';
    Object.values(byID).forEach(s => {
        out += [s.FirstName, s.LastName, s.HomeGroupColor, s.StaffType,
            s.periods[1]||'', s.periods[2]||'', s.periods[3]||'',
            s.periods[4]||'', s.periods[5]||'', s.periods[6]||''].map(q).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="staff-schedule.csv"');
    res.send(out);
});

app.get('/export-master-schedule', (_req, res) => {
    const aw = getActiveWeek();
    const rows = db.prepare(`
        SELECT
            s.PeriodNumber,
            s.ActivityName,
            a.SideOfCamp,
            (SELECT COUNT(*) FROM Schedules sc
             WHERE sc.PersonType = 'Camper' AND sc.PeriodNumber = s.PeriodNumber AND sc.ActivityName = s.ActivityName
            ) AS Enrollment,
            (SELECT GROUP_CONCAT(name, '; ') FROM (
               SELECT c.FirstName || ' ' || c.LastName AS name
               FROM Counselors c JOIN StaffWeekSchedules sws ON c.CounselorID = sws.StaffID
               WHERE sws.WeekNumber = ${aw} AND sws.PeriodNumber = s.PeriodNumber AND sws.ActivityName = s.ActivityName
               UNION
               SELECT c.FirstName || ' ' || c.LastName AS name
               FROM Counselors c JOIN CounselorScheduleAssignments csa ON c.CounselorID = csa.PersonID
               WHERE csa.WeekNumber = ${aw} AND csa.PeriodNumber = s.PeriodNumber AND csa.ActivityName = s.ActivityName
                 AND c.StaffRole IN ('Unit Leader', 'Sports Leader', 'Instructor')
             )) AS Staff,
            COALESCE(
              (SELECT sws.Location FROM StaffWeekSchedules sws
               WHERE sws.WeekNumber = ${aw} AND sws.PeriodNumber = s.PeriodNumber AND sws.ActivityName = s.ActivityName
               AND sws.Location IS NOT NULL AND sws.Location != '' LIMIT 1),
              (SELECT wo.Location FROM WeeklyOfferings wo
               WHERE wo.WeekNumber = ${aw} AND wo.PeriodNumber = s.PeriodNumber AND wo.ActivityName = s.ActivityName
               AND wo.Location IS NOT NULL AND wo.Location != '' LIMIT 1),
              (SELECT a2.Location FROM Activities a2
               WHERE a2.Name = s.ActivityName AND a2.Location IS NOT NULL AND a2.Location != '')
            ) AS Location,
            (SELECT GROUP_CONCAT(c.FirstName || ' ' || c.LastName, '; ')
             FROM Counselors c JOIN CounselorWeekSchedules cws ON c.CounselorID = cws.CounselorID
             WHERE cws.WeekNumber = ${aw} AND cws.PeriodNumber = s.PeriodNumber AND cws.ActivityName = s.ActivityName
               AND c.StaffRole IN ('Counselor', 'Swim Counselor')
            ) AS Counselors
        FROM (SELECT DISTINCT PeriodNumber, ActivityName FROM Schedules WHERE PersonType='Camper') s
        LEFT JOIN Activities a ON s.ActivityName = a.Name
        ORDER BY s.PeriodNumber, a.SideOfCamp, s.ActivityName
    `).all();

    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let out = 'Period,Activity Name,Side of Camp,Enrollment,Staff,Location,Counselors\n';
    rows.forEach(r => {
        out += [r.PeriodNumber, r.ActivityName, r.SideOfCamp, r.Enrollment, r.Staff, r.Location, r.Counselors].map(q).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="master-schedule.csv"');
    res.send(out);
});

// --- Counselor Preferences ---
app.get('/api/counselor-preferences/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ HomeGroupPreference: null, SchedulePreference: null, activityPreferences: [] });
    const row = db.prepare("SELECT HomeGroupPreference, SchedulePreference, ActivityPreferences FROM CounselorPreferences WHERE CounselorID = ?").get(id);
    res.json({
        HomeGroupPreference: row?.HomeGroupPreference ?? null,
        SchedulePreference:  row?.SchedulePreference  ?? null,
        activityPreferences: row?.ActivityPreferences ? JSON.parse(row.ActivityPreferences) : []
    });
});

app.get('/counselor-preferences', (req, res) => {
    const counselors = db.prepare("SELECT CounselorID, FirstName, LastName, HomeGroupColor, StaffRole FROM Counselors ORDER BY LastName, FirstName").all();
    const activeWeek = getActiveWeek();
    const weekActivities = db.prepare(
        "SELECT DISTINCT ActivityName AS Name, SideOfCamp FROM WeeklyOfferings WHERE WeekNumber = ? ORDER BY SideOfCamp, ActivityName"
    ).all(activeWeek);
    const activities = weekActivities.length
        ? weekActivities
        : db.prepare("SELECT Name, SideOfCamp FROM Activities ORDER BY SideOfCamp, Name").all();
    const alertMessage = req.query.message || null;
    const selectedCounselorId = parseInt(req.cookies.selectedCounselor) || null;
    const existingPrefs = selectedCounselorId
        ? db.prepare("SELECT HomeGroupPreference, SchedulePreference, ActivityPreferences FROM CounselorPreferences WHERE CounselorID = ?").get(selectedCounselorId)
        : null;
    const savedActivityPrefs = existingPrefs?.ActivityPreferences ? JSON.parse(existingPrefs.ActivityPreferences) : [];
    const selectedCounselorRole = counselors.find(c => c.CounselorID === selectedCounselorId)?.StaffRole || null;
    res.render('counselor-preferences', { counselors, activities, alertMessage, selectedCounselorId, selectedCounselorRole, existingPrefs, savedActivityPrefs });
});

app.get('/counselor-preferences-summary', (_req, res) => {
    const activeWeek = getActiveWeek();
    const counselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName, c.StaffRole,
               c.HomeGroupColor AS defaultColor,
               cwa.HomeGroupColor AS weekColor,
               cwa.ScheduleType AS weekScheduleType,
               p.HomeGroupPreference, p.SchedulePreference, p.ActivityPreferences, p.SubmittedAt
        FROM Counselors c
        LEFT JOIN CounselorWeekAttributes cwa ON c.CounselorID = cwa.CounselorID AND cwa.WeekNumber = ?
        LEFT JOIN CounselorPreferences p ON c.CounselorID = p.CounselorID
        WHERE c.StaffRole IN ('Counselor', 'Swim Counselor')
        ORDER BY c.LastName, c.FirstName
    `).all(activeWeek);

    const weekActivities = db.prepare(
        "SELECT DISTINCT ActivityName AS Name, SideOfCamp FROM WeeklyOfferings WHERE WeekNumber = ? ORDER BY SideOfCamp, ActivityName"
    ).all(activeWeek);
    const activityMap = {};
    weekActivities.forEach(a => { activityMap[a.Name] = a.SideOfCamp; });

    const assignmentRows = db.prepare(
        "SELECT CounselorID, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber = ?"
    ).all(activeWeek);
    const assignmentMap = {};
    for (const a of assignmentRows) {
        if (!assignmentMap[a.CounselorID]) assignmentMap[a.CounselorID] = [];
        assignmentMap[a.CounselorID].push(a.ActivityName);
    }

    const MAIN_COLORS    = new Set(['Red', 'Carolina', 'Green', 'Navy']);
    const SPECIALTY_COLORS = new Set(['LilPlace', 'KinderPlace', 'SPLIT', 'SPRC', 'Swim']);

    const rows = counselors.map(c => {
        const effectiveColor = c.weekColor || c.defaultColor || '';
        const isSpecialty = c.StaffRole === 'Swim Counselor' || SPECIALTY_COLORS.has(effectiveColor);
        const inMainCamp  = MAIN_COLORS.has(effectiveColor);
        const excludeFromStats = isSpecialty && !inMainCamp;

        const prefs = c.ActivityPreferences ? JSON.parse(c.ActivityPreferences) : [];
        const sports = prefs.filter(n => activityMap[n] === 'Sports');
        const enrichment = prefs.filter(n => activityMap[n] === 'Enrichment');
        const unclassified = prefs.filter(n => !activityMap[n]);

        const assigned = assignmentMap[c.CounselorID] || [];
        const assignedCount = assigned.length;
        const matchedCount = assigned.filter(a => prefs.includes(a)).length;

        const hgMatch = c.HomeGroupPreference && effectiveColor && c.HomeGroupPreference === effectiveColor;
        const schedMatch = c.SchedulePreference && c.weekScheduleType && c.SchedulePreference === c.weekScheduleType;

        return { ...c, sports, enrichment, unclassified, hasPrefs: !!c.HomeGroupPreference, excludeFromStats,
                 assignedCount, matchedCount, hgMatch, schedMatch };
    });

    res.render('counselor-preferences-summary', { rows, activeWeek });
});

app.post('/counselor-preferences', (req, res) => {
    const { counselorID, homeGroupPreference, schedulePreference } = req.body;
    const activityPreferences = Array.isArray(req.body.activityPreferences)
        ? req.body.activityPreferences
        : req.body.activityPreferences ? [req.body.activityPreferences] : [];

    const parsedId = parseInt(counselorID, 10);
    if (!parsedId) return res.redirect('/counselor-preferences?message=Please+select+a+counselor.');
    const counselorExists = db.prepare("SELECT 1 FROM Counselors WHERE CounselorID = ?").get(parsedId);
    if (!counselorExists) return res.redirect('/counselor-preferences?message=Counselor+not+found.+Please+re-select+your+name.');

    res.cookie('selectedCounselor', parsedId, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });

    if (!homeGroupPreference) {
        return res.redirect('/counselor-preferences?message=Name+saved!');
    }

    db.prepare(`
        INSERT INTO CounselorPreferences (CounselorID, HomeGroupPreference, SchedulePreference, ActivityPreferences, SubmittedAt)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (CounselorID) DO UPDATE SET
            HomeGroupPreference  = excluded.HomeGroupPreference,
            SchedulePreference   = excluded.SchedulePreference,
            ActivityPreferences  = excluded.ActivityPreferences,
            SubmittedAt          = CURRENT_TIMESTAMP
    `).run(parsedId, homeGroupPreference, schedulePreference || null, JSON.stringify(activityPreferences));

    res.redirect('/counselor-preferences?message=Preferences+saved!');
});

// --- PHOTO OF THE DAY ---
app.get('/photo-day', (req, res) => {
    const today = todayStr();
    const isAdmin = req.cookies.viewMode === 'admin';
    const photoPhase = getPhotoPhase();
    const viewerName = isAdmin
        ? (req.cookies.adminName || null)
        : (() => {
            const cid = parseInt(req.cookies.selectedCounselor) || null;
            if (!cid) return null;
            const row = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?").get(cid);
            return row ? `${row.FirstName} ${row.LastName}` : null;
        })();
    const submissions = db.prepare(
        "SELECT id, counselorName, imageUrl FROM PhotoSubmissions WHERE date=? ORDER BY submittedAt DESC"
    ).all(today);
    res.render('photo-day', { submissions, date: today, message: req.query.message, error: req.query.error, viewerName, photoPhase, isAdmin });
});

app.post('/photo-day', upload.single('photo'), async (req, res) => {
    if (!req.file) return res.redirect('/photo-day?error=No+file+selected');
    const isAdmin = req.cookies.viewMode === 'admin';
    if (!isAdmin && getPhotoPhase() !== 'submission') {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.redirect('/photo-day?error=' + encodeURIComponent('Photo submissions are only open from 9:00 AM to 4:00 PM.'));
    }
    let counselorName = null;
    if (isAdmin) {
        counselorName = (req.cookies.adminName || '').trim();
    } else {
        const cid = parseInt(req.cookies.selectedCounselor) || null;
        if (cid) {
            const row = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?").get(cid);
            if (row) counselorName = `${row.FirstName} ${row.LastName}`;
        }
    }
    if (!counselorName) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.redirect('/photo-day?error=' + encodeURIComponent(isAdmin ? 'Please set your admin name first.' : 'Please select your name in Preferences first.'));
    }
    try {
        const result = await cloudinary.uploader.upload(req.file.path, { folder: 'camp-photo-day' });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        db.prepare("INSERT INTO PhotoSubmissions (date, counselorName, imageUrl) VALUES (?, ?, ?)")
            .run(todayStr(), counselorName, result.secure_url);
        res.redirect('/photo-day?message=Photo+submitted!');
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.redirect('/photo-day?error=Upload+failed');
    }
});

app.get('/photo-gallery', (req, res) => {
    const date = req.query.date || todayStr();
    const isAdmin = req.cookies.viewMode === 'admin';
    const photoPhase = (date === todayStr()) ? getPhotoPhase() : 'winner';
    const viewerName = isAdmin
        ? (req.cookies.adminName || null)
        : (() => {
            const cid = parseInt(req.cookies.selectedCounselor) || null;
            if (!cid) return null;
            const row = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?").get(cid);
            return row ? `${row.FirstName} ${row.LastName}` : null;
        })();
    const voteLimit = isAdmin ? 3 : 1;
    const sentinel = viewerName || '__none__';
    const photos = db.prepare(`
        SELECT p.id, p.counselorName, p.imageUrl, COUNT(v.id) as votes,
               SUM(CASE WHEN v.voterName = ? THEN 1 ELSE 0 END) as viewerVoted
        FROM PhotoSubmissions p LEFT JOIN PhotoVotes v ON v.photoId = p.id
        WHERE p.date=? GROUP BY p.id ORDER BY votes DESC, p.submittedAt ASC
    `).all(sentinel, date);
    const viewerVoteCount = viewerName
        ? (db.prepare("SELECT COUNT(*) as n FROM PhotoVotes WHERE voterName=? AND voteDate=?").get(viewerName, date)?.n || 0)
        : 0;
    res.render('photo-gallery', { photos, date, viewerName, viewerVoteCount, voteLimit, photoPhase, isAdmin });
});

app.post('/photo-vote/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid' });
    const { voterName } = req.body;
    if (!voterName) return res.status(400).json({ error: 'No name set' });
    const today = todayStr();
    const isAdmin = req.cookies.viewMode === 'admin';
    if (!isAdmin && getPhotoPhase() !== 'voting') {
        return res.json({ ok: false, error: 'Voting is only open from 4:00 PM to 4:15 PM.' });
    }
    const voteLimit = isAdmin ? 3 : 1;
    const alreadyVoted = db.prepare("SELECT 1 FROM PhotoVotes WHERE voterName=? AND photoId=?").get(voterName, id);
    if (alreadyVoted) return res.json({ ok: false, error: 'Already voted on this photo' });
    const todayCount = db.prepare("SELECT COUNT(*) as n FROM PhotoVotes WHERE voterName=? AND voteDate=?").get(voterName, today).n;
    if (todayCount >= voteLimit) return res.json({ ok: false, error: 'Daily vote limit reached', limit: voteLimit });
    db.prepare("INSERT INTO PhotoVotes (photoId, voterName, voteDate) VALUES (?, ?, ?)").run(id, voterName, today);
    const votes = db.prepare("SELECT COUNT(*) as n FROM PhotoVotes WHERE photoId=?").get(id).n;
    res.json({ ok: true, votes, voterVoteCount: todayCount + 1, voteLimit, remaining: voteLimit - todayCount - 1 });
});

// --- SESSION MANAGEMENT ---
app.post('/set-active-week', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    if (w < 1 || w > 6) return res.redirect('/settings?message=Invalid+week');
    db.exec('UPDATE Sessions SET isActive = 0');
    db.prepare('UPDATE Sessions SET isActive = 1 WHERE weekNumber = ?').run(w);
    res.redirect('/settings?message=Active+week+updated');
});

app.post('/set-released-week', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    if (w < 1 || w > 6) return res.redirect('/settings?message=Invalid+week');
    const cur = db.prepare('SELECT isReleased FROM Sessions WHERE weekNumber=?').get(w);
    db.exec('UPDATE Sessions SET isReleased = 0');
    if (!cur?.isReleased) db.prepare('UPDATE Sessions SET isReleased = 1 WHERE weekNumber = ?').run(w);
    res.redirect('/settings?message=Schedule+release+updated');
});

app.post('/update-session-label', (req, res) => {
    const { weekNumber, label, startDate } = req.body;
    const w = parseInt(weekNumber);
    if (w < 1 || w > 6) return res.redirect('/settings?message=Invalid+week');
    db.prepare('UPDATE Sessions SET label=?, startDate=? WHERE weekNumber=?')
      .run((label || `Week ${w}`).trim(), startDate || null, w);
    res.redirect('/settings?message=Session+updated');
});

app.post('/clear-counselor-week', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    if (w < 1 || w > 6) return res.redirect('/settings?message=Invalid+week');
    db.prepare('DELETE FROM CounselorWeekSchedules WHERE WeekNumber=?').run(w);
    db.prepare('DELETE FROM CounselorWeekAttributes WHERE WeekNumber=?').run(w);
    res.redirect('/settings?message=Week+' + w + '+counselor+data+cleared');
});

app.post('/clear-counselor-schedule', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    const mode = req.body.mode; // 'full' or 'counselors'
    if (w < 1 || w > 6) return res.redirect(`/counselor-scheduling?week=${w}&message=Invalid+week`);
    db.prepare('DELETE FROM CounselorWeekSchedules WHERE WeekNumber=?').run(w);
    if (mode === 'full') {
        db.prepare('DELETE FROM CounselorScheduleAssignments').run();
    }
    res.redirect(`/counselor-scheduling?week=${w}&message=Schedule+cleared`);
});

app.post('/clear-counselor-homegroups', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    if (w < 1 || w > 6) return res.redirect(`/counselor-scheduling?week=${w}&message=Invalid+week`);
    db.prepare('UPDATE CounselorWeekAttributes SET HomeGroupColor=NULL, ScheduleType=NULL WHERE WeekNumber=?').run(w);
    res.redirect(`/counselor-scheduling?week=${w}&message=Homegroups+and+schedule+types+cleared`);
});

app.get('/counselor-week-assignments/:week', (req, res) => {
    const w = parseInt(req.params.week);
    if (w < 1 || w > 6) return res.status(400).json({ error: 'Invalid week' });
    const rows = db.prepare('SELECT CounselorID, PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber=?').all(w);
    res.json(rows);
});

// --- HOMEGROUP ASSIGNMENT TOOL ---
app.get('/homegroup-assignment', (req, res) => {
    const week = parseInt(req.query.week) || getActiveWeek();
    const sessions = db.prepare("SELECT * FROM Sessions ORDER BY weekNumber").all();

    const counselors = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName, co.StaffRole,
               COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) AS HomeGroupColor,
               cwa.ExtendedHours AS ExtendedHours
        FROM Counselors co
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        WHERE co.StaffRole IN ('Counselor', 'Swim Counselor')
          AND COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) IN ('Red','Carolina','Green','Navy')
        ORDER BY COALESCE(cwa.HomeGroupColor, co.HomeGroupColor), co.LastName, co.FirstName
    `).all(week);

    const specialtyCounselors = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName,
               COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) AS HomeGroupColor,
               cwa.ExtendedHours AS ExtendedHours
        FROM Counselors co
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        WHERE co.StaffRole = 'Counselor'
          AND COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) IN ('LilPlace','KinderPlace','SPLIT','SPRC')
        ORDER BY COALESCE(cwa.HomeGroupColor, co.HomeGroupColor), co.LastName, co.FirstName
    `).all(week);

    const swimCounselors = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName,
               COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) AS HomeGroupColor,
               cwa.ExtendedHours AS ExtendedHours
        FROM Counselors co
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        WHERE co.StaffRole = 'Swim Counselor'
          AND COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) NOT IN ('Red','Carolina','Green','Navy')
        ORDER BY co.LastName, co.FirstName
    `).all(week);

    const unassignedCounselors = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName,
               cwa.ExtendedHours AS ExtendedHours
        FROM Counselors co
        LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        WHERE co.StaffRole = 'Counselor'
          AND COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) IS NULL
        ORDER BY co.LastName, co.FirstName
    `).all(week);

    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.HomeGroupColor,
               chg.CounselorID AS AssignedCounselorID
        FROM Campers c
        LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
        WHERE c.HomeGroupColor IN ('Red','Carolina','Green','Navy')
        ORDER BY c.HomeGroupColor, c.LastName, c.FirstName
    `).all(week);

    res.render('homegroup-assignment', {
        week, sessions, counselors, specialtyCounselors, swimCounselors, unassignedCounselors, campers,
        activeWeek: getActiveWeek()
    });
});

app.post('/homegroup-assignment/save', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getActiveWeek();
    let assignments = [];
    let extHours = {};
    let groupColors = {};
    try { assignments  = JSON.parse(req.body.assignments   || '[]'); } catch { /* bad JSON */ }
    try { extHours     = JSON.parse(req.body.extendedHours || '{}'); } catch { /* bad JSON */ }
    try { groupColors  = JSON.parse(req.body.groupColors   || '{}'); } catch { /* bad JSON */ }

    const upsertAttr = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET ExtendedHours = excluded.ExtendedHours
    `);
    const upsertColor = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET HomeGroupColor = excluded.HomeGroupColor
    `);

    db.transaction(() => {
        db.prepare("DELETE FROM CamperHomeGroups WHERE WeekNumber = ?").run(week);
        const ins = db.prepare(
            "INSERT INTO CamperHomeGroups (CamperID, WeekNumber, CounselorID) VALUES (?,?,?)"
        );
        for (const { camperId, counselorId } of assignments) {
            if (camperId && counselorId) ins.run(camperId, week, counselorId);
        }
        for (const [cId, ext] of Object.entries(extHours)) {
            upsertAttr.run(parseInt(cId), week, ext || null);
        }
        for (const [cId, color] of Object.entries(groupColors)) {
            if (color) upsertColor.run(parseInt(cId), week, color);
        }
    })();

    const hasGroupChanges = Object.values(groupColors).some(v => v);
    res.json({ success: true, hasGroupChanges });
});

app.post('/homegroup-assignment/mirror', (req, res) => {
    const toWeek   = parseInt(req.body.toWeek)   || getActiveWeek();
    const fromWeek = parseInt(req.body.fromWeek) || (toWeek - 1);
    if (fromWeek < 1 || fromWeek > 6) return res.json({ mirrored: 0 });

    const result = db.prepare(`
        INSERT OR IGNORE INTO CamperHomeGroups (CamperID, WeekNumber, CounselorID)
        SELECT chg.CamperID, ?, chg.CounselorID
        FROM CamperHomeGroups chg
        JOIN Campers c ON c.CamperID = chg.CamperID
        WHERE chg.WeekNumber = ?
    `).run(toWeek, fromWeek);

    res.json({ mirrored: result.changes });
});

// ─── SPLIT SCHEDULING ────────────────────────────────────────────────────────

app.get('/split-scheduling', (req, res) => {
    const aw = getActiveWeek();
    const alertMessage = req.query.message || null;

    // RC-relevant offerings: Enrichment in blocks 1,2 and Sports in blocks 5,6
    const offerings = db.prepare(`
        SELECT ActivityName, PeriodNumber, SideOfCamp, PreliminaryEnrollment, Location
        FROM WeeklyOfferings
        WHERE WeekNumber = ?
          AND ((PeriodNumber IN (1,2) AND SideOfCamp = 'Enrichment')
            OR (PeriodNumber IN (5,6) AND SideOfCamp = 'Sports'))
        ORDER BY PeriodNumber, ActivityName
    `).all(aw);

    const splitCampers = db.prepare(
        "SELECT CamperID, FirstName, LastName FROM Campers WHERE HomeGroupColor='SPLIT' ORDER BY LastName, FirstName"
    ).all();
    const splitIds = splitCampers.map(c => c.CamperID);

    // Enrollment per class (non-SPLIT campers currently in Schedules)
    const enrollmentMap = {};
    for (const o of offerings) {
        let n;
        if (splitIds.length > 0) {
            const ph = splitIds.map(() => '?').join(',');
            n = db.prepare(`SELECT COUNT(*) as n FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=? AND PersonID NOT IN (${ph})`).get(o.PeriodNumber, o.ActivityName, ...splitIds)?.n || 0;
        } else {
            n = db.prepare("SELECT COUNT(*) as n FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=?").get(o.PeriodNumber, o.ActivityName)?.n || 0;
        }
        enrollmentMap[`${o.PeriodNumber}|${o.ActivityName}`] = n;
    }

    // Existing SPLIT assignments keyed by "period|activity" → [camperID, ...]
    const assignedByKey = {};
    if (splitIds.length > 0) {
        const ph = splitIds.map(() => '?').join(',');
        db.prepare(`SELECT PersonID, PeriodNumber, ActivityName FROM Schedules WHERE PersonType='Camper' AND PersonID IN (${ph})`).all(...splitIds)
            .forEach(r => {
                const k = `${r.PeriodNumber}|${r.ActivityName}`;
                if (!assignedByKey[k]) assignedByKey[k] = [];
                assignedByKey[k].push(r.PersonID);
            });
    }

    // Instructor(s) per class for context display
    const instructorMap = {};
    db.prepare(`
        SELECT s.PeriodNumber, s.ActivityName, c.FirstName, c.LastName
        FROM Schedules s JOIN Counselors c ON c.CounselorID = s.PersonID
        WHERE s.PersonType = 'Instructor'
    `).all().forEach(r => {
        const k = `${r.PeriodNumber}|${r.ActivityName}`;
        if (!instructorMap[k]) instructorMap[k] = [];
        instructorMap[k].push(`${r.FirstName} ${r.LastName}`);
    });

    // Counselors per class for context display (active week)
    const counselorMap = {};
    db.prepare(`
        SELECT cws.PeriodNumber, cws.ActivityName, c.FirstName, c.LastName
        FROM CounselorWeekSchedules cws JOIN Counselors c ON c.CounselorID = cws.CounselorID
        WHERE cws.WeekNumber = ?
        ORDER BY c.LastName
    `).all(aw).forEach(r => {
        const k = `${r.PeriodNumber}|${r.ActivityName}`;
        if (!counselorMap[k]) counselorMap[k] = [];
        counselorMap[k].push(`${r.FirstName} ${r.LastName}`);
    });

    res.render('split-scheduling', {
        offerings, splitCampers, enrollmentMap, assignedByKey,
        instructorMap, counselorMap, alertMessage
    });
});

app.post('/save-split-assignments', (req, res) => {
    const { assignments } = req.body;
    if (!Array.isArray(assignments)) return res.status(400).json({ error: 'Invalid payload' });

    const splitIds = db.prepare("SELECT CamperID FROM Campers WHERE HomeGroupColor='SPLIT'").all().map(c => c.CamperID);
    if (splitIds.length === 0) return res.json({ ok: true });

    const ph = splitIds.map(() => '?').join(',');
    try {
        db.transaction(() => {
            db.prepare(`DELETE FROM Schedules WHERE PersonType='Camper' AND PersonID IN (${ph})`).run(...splitIds);
            const ins = db.prepare("INSERT OR IGNORE INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName) VALUES (?,?,?,?)");
            for (const a of assignments) {
                if (a.camperID && a.periodNumber && a.activityName) {
                    ins.run(a.camperID, 'Camper', a.periodNumber, a.activityName);
                }
            }
        })();
        res.json({ ok: true });
    } catch (err) {
        console.error('[save-split-assignments]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── SPLIT FIELD TRIP ─────────────────────────────────────────────────────────

app.post('/split-field-trip/mark', (req, res) => {
    const date = req.body.date || todayStr();
    db.prepare("INSERT OR REPLACE INTO SplitFieldTrip (Date) VALUES (?)").run(date);
    res.redirect(req.body.returnTo || `/attendance/specialty/SPLIT/am?date=${date}`);
});

app.post('/split-field-trip/clear', (req, res) => {
    const date = req.body.date || todayStr();
    db.prepare("DELETE FROM SplitFieldTrip WHERE Date=?").run(date);
    res.redirect(req.body.returnTo || `/attendance/specialty/SPLIT/am?date=${date}`);
});

// ─── PRINT REPORTS ────────────────────────────────────────────────────────────

app.get('/reports/attendance-rosters', (_req, res) => {
    const aw = getActiveWeek();

    // ── Class rosters (Sports + Enrichment) ─────────────────────────────────
    const scheduleRows = db.prepare(`
        SELECT cws.CounselorID AS PersonID, co.FirstName, co.LastName,
               cws.PeriodNumber, cws.ActivityName,
               COALESCE(wo.SideOfCamp, a.SideOfCamp, 'Other') AS SideOfCamp
        FROM CounselorWeekSchedules cws
        JOIN Counselors co ON co.CounselorID = cws.CounselorID
        LEFT JOIN (SELECT ActivityName, PeriodNumber, WeekNumber, MAX(SideOfCamp) AS SideOfCamp
                   FROM WeeklyOfferings GROUP BY ActivityName, PeriodNumber, WeekNumber) wo
            ON wo.ActivityName = cws.ActivityName AND wo.PeriodNumber = cws.PeriodNumber AND wo.WeekNumber = ?
        LEFT JOIN Activities a ON a.Name = cws.ActivityName
        WHERE cws.WeekNumber = ?
        UNION
        SELECT sws.StaffID AS PersonID, co.FirstName, co.LastName,
               sws.PeriodNumber, sws.ActivityName,
               COALESCE(wo.SideOfCamp, a.SideOfCamp, 'Other') AS SideOfCamp
        FROM StaffWeekSchedules sws
        JOIN Counselors co ON co.CounselorID = sws.StaffID
        LEFT JOIN (SELECT ActivityName, PeriodNumber, WeekNumber, MAX(SideOfCamp) AS SideOfCamp
                   FROM WeeklyOfferings GROUP BY ActivityName, PeriodNumber, WeekNumber) wo
            ON wo.ActivityName = sws.ActivityName AND wo.PeriodNumber = sws.PeriodNumber AND wo.WeekNumber = ?
        LEFT JOIN Activities a ON a.Name = sws.ActivityName
        WHERE sws.WeekNumber = ?
        UNION
        SELECT csa.PersonID, co.FirstName, co.LastName,
               csa.PeriodNumber, csa.ActivityName,
               COALESCE(wo.SideOfCamp, a.SideOfCamp, 'Other') AS SideOfCamp
        FROM CounselorScheduleAssignments csa
        JOIN Counselors co ON co.CounselorID = csa.PersonID
        LEFT JOIN (SELECT ActivityName, PeriodNumber, WeekNumber, MAX(SideOfCamp) AS SideOfCamp
                   FROM WeeklyOfferings GROUP BY ActivityName, PeriodNumber, WeekNumber) wo
            ON wo.ActivityName = csa.ActivityName AND wo.PeriodNumber = csa.PeriodNumber AND wo.WeekNumber = ?
        LEFT JOIN Activities a ON a.Name = csa.ActivityName
        WHERE csa.WeekNumber = ?
          AND csa.PersonType IN ('Instructor', 'Staff')
        ORDER BY 3, 2, 4
    `).all(aw, aw, aw, aw, aw, aw);

    const counselorMap = {};
    scheduleRows.forEach(r => {
        if (!counselorMap[r.PersonID]) {
            counselorMap[r.PersonID] = {
                CounselorID: r.PersonID,
                FirstName: r.FirstName,
                LastName: r.LastName,
                periods: []
            };
        }
        const campers = db.prepare(`
            SELECT ca.CamperID, ca.FirstName, ca.LastName
            FROM Campers ca
            JOIN Schedules s ON s.PersonID = ca.CamperID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ? COLLATE NOCASE
            ORDER BY ca.LastName, ca.FirstName
        `).all(r.PeriodNumber, r.ActivityName);

        const locRow = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM StaffWeekSchedules
            WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `).get(r.PeriodNumber, r.ActivityName, aw, r.PeriodNumber, r.ActivityName);

        counselorMap[r.PersonID].periods.push({
            PeriodNumber: r.PeriodNumber,
            ActivityName: r.ActivityName,
            SideOfCamp: r.SideOfCamp,
            Location: locRow?.Location || null,
            campers
        });
    });

    // ── Homegroup rosters ────────────────────────────────────────────────────
    const hgRows = db.prepare(`
        SELECT chg.CounselorID,
               co.FirstName AS CounselorFirst, co.LastName AS CounselorLast,
               COALESCE(cwa.HomeGroupColor, co.HomeGroupColor) AS HomeGroupColor,
               ca.CamperID, ca.FirstName AS CamperFirst, ca.LastName AS CamperLast,
               ca.HomeGroupColor AS CamperColor
        FROM CamperHomeGroups chg
        JOIN Counselors co ON co.CounselorID = chg.CounselorID
        LEFT JOIN CounselorWeekAttributes cwa
            ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        JOIN Campers ca ON ca.CamperID = chg.CamperID
        WHERE chg.WeekNumber = ?
        ORDER BY co.HomeGroupColor, co.LastName, co.FirstName, ca.LastName, ca.FirstName
    `).all(aw, aw);

    const hgMap = {};
    hgRows.forEach(r => {
        if (!hgMap[r.CounselorID]) {
            hgMap[r.CounselorID] = {
                CounselorID: r.CounselorID,
                FirstName: r.CounselorFirst,
                LastName: r.CounselorLast,
                HomeGroupColor: r.HomeGroupColor,
                campers: []
            };
        }
        hgMap[r.CounselorID].campers.push({
            CamperID: r.CamperID,
            FirstName: r.CamperFirst,
            LastName: r.CamperLast,
            HomeGroupColor: r.CamperColor
        });
    });
    const homegroupSheets = Object.values(hgMap);

    // ── Bus rosters ──────────────────────────────────────────────────────────
    const busRows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.HomeGroupColor, ca.BusRoute
        FROM Campers ca
        WHERE ca.BusRoute IS NOT NULL AND TRIM(ca.BusRoute) != '' AND LOWER(TRIM(ca.BusRoute)) != 'null'
        ORDER BY ca.BusRoute, ca.LastName, ca.FirstName
    `).all();

    const busMap = {};
    busRows.forEach(r => {
        const route = r.BusRoute;
        if (!busMap[route]) busMap[route] = [];
        busMap[route].push(r);
    });
    const busSheets = Object.entries(busMap).map(([route, campers]) => ({ route, campers }));
    const busSheetsByRoute = Object.fromEntries(busSheets.map(s => [s.route, s]));

    // ── Extended care rosters ────────────────────────────────────────────────
    const extRows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.HomeGroupColor, ca.ExtendedHours
        FROM Campers ca
        WHERE ca.ExtendedHours IN ('AM', 'Both', 'PM')
        ORDER BY ca.HomeGroupColor, ca.LastName, ca.FirstName
    `).all();

    const extAM = extRows.filter(r => r.ExtendedHours === 'AM' || r.ExtendedHours === 'Both');
    const extPM = extRows.filter(r => r.ExtendedHours === 'PM' || r.ExtendedHours === 'Both');

    // ── Per-counselor bus/extended assignments ───────────────────────────────
    const counselorAttrsRows = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName,
               COALESCE(cwa.BusRoute,      co.BusRoute)      AS BusRoute,
               COALESCE(cwa.ExtendedHours, co.ExtendedHours) AS ExtendedHours
        FROM Counselors co
        LEFT JOIN CounselorWeekAttributes cwa
            ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
    `).all(aw);

    const counselorAttrsMap = {};
    counselorAttrsRows.forEach(r => {
        const bus = (r.BusRoute || '').trim();
        counselorAttrsMap[r.CounselorID] = {
            FirstName:     r.FirstName,
            LastName:      r.LastName,
            BusRoute:      (bus && bus.toLowerCase() !== 'null' && bus.toLowerCase() !== 'none') ? bus : null,
            ExtendedHours: r.ExtendedHours || null
        };
    });

    res.render('attendance-rosters', {
        counselors: Object.values(counselorMap),
        homegroupSheets,
        busSheets,
        busSheetsByRoute,
        extAM,
        extPM,
        counselorAttrsMap
    });
});

app.get('/reports/name-cards', (_req, res) => {
    const rows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.HomeGroupColor,
               s.PeriodNumber, s.ActivityName
        FROM Campers ca
        JOIN Schedules s ON s.PersonID = ca.CamperID AND s.PersonType = 'Camper'
        ORDER BY ca.LastName, ca.FirstName, s.PeriodNumber
    `).all();

    const camperMap = {};
    rows.forEach(r => {
        if (!camperMap[r.CamperID]) {
            camperMap[r.CamperID] = {
                CamperID: r.CamperID,
                FirstName: r.FirstName,
                LastName: r.LastName,
                HomeGroupColor: r.HomeGroupColor || '',
                classes: []
            };
        }
        camperMap[r.CamperID].classes.push(r.ActivityName);
    });

    res.render('name-cards', { campers: Object.values(camperMap) });
});

// ─── DOCUMENT PDF UPLOAD / SERVE ──────────────────────────────────────────────

const PDF_DOCS = [
    { slug: 'camper-notes',               label: 'Camper Notes',                       icon: '📄' },
    { slug: 'icp-notes',                  label: 'ICP Notes',                          icon: '📄' },
    { slug: 'am-enrichment-locations',    label: 'AM Enrichment Meeting Locations',    icon: '🗺️' },
    { slug: 'snack-break-locations',      label: 'Snack Break Meeting Locations',      icon: '🗺️' },
    { slug: 'lunch-enrichment-locations', label: 'Lunch Enrichment Meeting Locations', icon: '🗺️' },
    { slug: 'popsicle-break-locations',   label: 'Popsicle Break Meeting Locations',   icon: '🗺️' },
    { slug: 'enrichment-map',             label: 'Enrichment Locations Map',           icon: '🗺️' },
];
const ALLOWED_PDF_TYPES = new Set(PDF_DOCS.map(d => d.slug));

app.get('/docs', (_req, res) => {
    const pdfExists = {};
    const uploadedSlugs = new Set(db.prepare("SELECT slug FROM PdfDocuments").all().map(r => r.slug));
    PDF_DOCS.forEach(d => { pdfExists[d.slug] = uploadedSlugs.has(d.slug); });
    res.render('docs', { docs: PDF_DOCS, pdfExists });
});

app.post('/upload-pdf/:type', upload.single('file'), (req, res) => {
    const type = req.params.type;
    if (!ALLOWED_PDF_TYPES.has(type)) return res.status(400).send('Invalid document type');
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    if (!req.file.originalname.toLowerCase().endsWith('.pdf') && req.file.mimetype !== 'application/pdf') {
        fs.unlinkSync(req.file.path);
        return res.redirect('/settings?message=File+must+be+a+PDF');
    }
    try {
        const data = fs.readFileSync(req.file.path);
        db.prepare(`INSERT OR REPLACE INTO PdfDocuments (slug, filename, data, uploadedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`)
          .run(type, req.file.originalname, data);
    } finally {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
    res.redirect('/settings?message=PDF+uploaded+successfully');
});

app.get('/pdf/:type', (req, res) => {
    const type = req.params.type;
    if (!ALLOWED_PDF_TYPES.has(type)) return res.status(404).send('Not found');
    const doc = db.prepare("SELECT data FROM PdfDocuments WHERE slug = ?").get(type);
    if (!doc) {
        return res.status(404).type('html').send(
            '<p style="font-family:sans-serif;padding:40px;">No PDF has been uploaded yet. Ask an admin to upload this document via Settings.</p>'
        );
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(doc.data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Camp Manager running on port ${PORT}`));