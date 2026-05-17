const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const db = new Database(process.env.DB_PATH || 'camp_manager.db');
const upload = multer({ dest: 'uploads/' });

// Maps a camper-facing period + activity side to the DB period used for staff/counselor lookups.
// Sports P3 PM (lower camp, Red/Carolina) → DB P4; sports P4 → DB P5; sports P5 → DB P6.
function staffDbPeriod(camperPeriod, sideOfCamp, isLowerCamp = false) {
    if (sideOfCamp === 'Sports') {
        if (camperPeriod === 3) return isLowerCamp ? 4 : 3;
        if (camperPeriod === 4) return 5;
        if (camperPeriod === 5) return 6;
    }
    return camperPeriod;
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());

// Make viewMode available in all templates
app.use((req, res, next) => {
    res.locals.viewMode = req.cookies.viewMode || 'staff';
    next();
});

// Protect admin-only paths
const ADMIN_ONLY_PREFIXES = [
    '/admin', '/settings', '/swap-tool', '/process-swap', '/get-options',
    '/schedule-history', '/archive-schedule-changes', '/staff-lookup',
    '/faculty-summer', '/upload-staff-week', '/clear-staff-week',
    '/counselor-directory', '/counselor-view', '/promotions',
    '/promote-waitlist', '/promote-all', '/upload-campers', '/upload-counselors',
    '/upload-staff', '/upload-activity-rules', '/add-activity',
    '/delete-activity', '/update-activity', '/add-activity-period-group',
    '/delete-activity-period-group',
    '/counselor-scheduling', '/upload-weekly-offerings', '/clear-weekly-offerings',
    '/save-counselor-assignments', '/export-counselor-schedule', '/export-staff-schedule',
    '/export-master-schedule', '/save-counselor-group-assignments',
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
        PersonType TEXT NOT NULL CHECK(PersonType IN ('Camper', 'Counselor', 'Staff')),
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
        PersonType   TEXT NOT NULL CHECK(PersonType IN ('Counselor', 'Staff')),
        UNIQUE(PeriodNumber, PersonID, PersonType)
    );
`);

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

app.get('/staff', (_req, res) => {
    res.render('staff-hub');
});

// --- DASHBOARD ---
app.get('/admin', (req, res) => {
    const camperTotal = db.prepare("SELECT COUNT(*) AS count FROM Campers").get().count;
    const staffTotal = db.prepare("SELECT COUNT(*) AS count FROM Counselors").get().count;
    const activityCount = db.prepare("SELECT COUNT(*) AS count FROM Activities").get().count;

    const waitlistCount = db.prepare(`
        SELECT COUNT(*) as count FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE (SELECT COUNT(*) FROM Schedules WHERE ActivityName = a.Name AND PeriodNumber = w.PeriodNumber) < a.MaxCapacity
    `).get().count;

    res.render('index', {
        camperTotal,
        staffTotal,
        activityCount,
        waitlistCount,
        alertMessage: req.query.message
    });
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

        // Location stored in Staff Schedules rows (per period, per activity)
        const getLocation = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Staff' AND PeriodNumber = ? AND ActivityName = ?
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `);

        // Standard queries for all non-P3 periods
        const getColorGroups = db.prepare(`
            SELECT DISTINCT c.HomeGroupColor
            FROM Campers c JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ? ORDER BY c.HomeGroupColor
        `);
        const getEnrollment = db.prepare(
            "SELECT COUNT(*) as n FROM Schedules WHERE PersonType = 'Camper' AND PeriodNumber = ? AND ActivityName = ?"
        );
        const getStaff = db.prepare(`
            SELECT st.FirstName, st.LastName, st.StaffType
            FROM Staff st JOIN Schedules s ON st.StaffID = s.PersonID AND s.PersonType = 'Staff'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
        `);
        const getCounselors = db.prepare(`
            SELECT n.CounselorID, n.FirstName, n.LastName, n.HomeGroupColor
            FROM Counselors n JOIN Schedules s ON n.CounselorID = s.PersonID AND s.PersonType = 'Counselor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            ORDER BY n.HomeGroupColor, n.LastName
        `);

        // Filtered queries for P3 — upper camp (Green/Navy = AM) and lower camp (Red/Carolina = PM)
        const getColorGroupsUpper = db.prepare(`
            SELECT DISTINCT c.HomeGroupColor
            FROM Campers c JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND c.HomeGroupColor IN ('Green', 'Navy')
            ORDER BY c.HomeGroupColor
        `);
        const getColorGroupsLower = db.prepare(`
            SELECT DISTINCT c.HomeGroupColor
            FROM Campers c JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND c.HomeGroupColor IN ('Red', 'Carolina')
            ORDER BY c.HomeGroupColor
        `);
        const getEnrollmentUpper = db.prepare(`
            SELECT COUNT(*) as n FROM Schedules s
            JOIN Campers c ON s.PersonID = c.CamperID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND c.HomeGroupColor IN ('Green', 'Navy')
        `);
        const getEnrollmentLower = db.prepare(`
            SELECT COUNT(*) as n FROM Schedules s
            JOIN Campers c ON s.PersonID = c.CamperID AND s.PersonType = 'Camper'
            WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND c.HomeGroupColor IN ('Red', 'Carolina')
        `);
        const getCounselorsUpper = db.prepare(`
            SELECT n.CounselorID, n.FirstName, n.LastName, n.HomeGroupColor
            FROM Counselors n JOIN Schedules s ON n.CounselorID = s.PersonID AND s.PersonType = 'Counselor'
            WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND n.HomeGroupColor IN ('Green', 'Navy')
            ORDER BY n.HomeGroupColor, n.LastName
        `);

        // Separate P3 raw classes so they can be enriched with filtered queries
        const p3Raw = classes.filter(cls => cls.periodNumber === 3);
        const otherRaw = classes.filter(cls => cls.periodNumber !== 3);

        const enriched = otherRaw.map(cls => {
            const dbP = staffDbPeriod(cls.periodNumber, cls.sideOfCamp);
            const locRow = getLocation.get(dbP, cls.activityName);
            return {
                ...cls,
                location:    locRow ? locRow.Location : null,
                enrolled:    getEnrollment.get(cls.periodNumber, cls.activityName).n,
                colorGroups: getColorGroups.all(cls.periodNumber, cls.activityName).map(r => r.HomeGroupColor),
                staff:       getStaff.all(dbP, cls.activityName),
                counselors:  getCounselors.all(dbP, cls.activityName)
            };
        });

        // Enrich P3 twice — once per camp half — then drop any that have no campers in that half
        const p3AM = p3Raw.map(cls => {
            const locRow = getLocation.get(3, cls.activityName);
            return {
                ...cls,
                location:    locRow ? locRow.Location : null,
                enrolled:    getEnrollmentUpper.get(cls.activityName).n,
                colorGroups: getColorGroupsUpper.all(cls.activityName).map(r => r.HomeGroupColor),
                staff:       getStaff.all(3, cls.activityName),
                counselors:  getCounselorsUpper.all(cls.activityName)
            };
        }).filter(cls => cls.colorGroups.length > 0);

        const p3PM = p3Raw.map(cls => {
            const locRow = getLocation.get(4, cls.activityName);
            return {
                ...cls,
                location:    locRow ? locRow.Location : null,
                enrolled:    getEnrollmentLower.get(cls.activityName).n,
                colorGroups: getColorGroupsLower.all(cls.activityName).map(r => r.HomeGroupColor),
                staff:       getStaff.all(4, cls.activityName),
                counselors:  getCounselors.all(4, cls.activityName)
            };
        }).filter(cls => cls.colorGroups.length > 0);

        // Group non-P3 by period and build schedule in order, inserting P3 AM/PM after period 2
        const periodMap = new Map();
        for (const cls of enriched) {
            if (!periodMap.has(cls.periodNumber)) periodMap.set(cls.periodNumber, []);
            periodMap.get(cls.periodNumber).push(cls);
        }

        const schedule = [];
        for (const periodNumber of [...periodMap.keys()].sort((a, b) => a - b)) {
            schedule.push({ periodNumber, periodLabel: String(periodNumber), classes: periodMap.get(periodNumber) });
            if (periodNumber === 2) {
                if (p3AM.length) schedule.push({ periodNumber: 3, periodLabel: '3 AM', classes: p3AM });
                if (p3PM.length) schedule.push({ periodNumber: 3, periodLabel: '3 PM', classes: p3PM });
            }
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

        const campers = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, c.Age, c.HomeGroupColor,
                   c.BusRoute, c.ExtendedHours,
                   n.CounselorID, n.FirstName AS CounselorFirstName, n.LastName AS CounselorLastName
            FROM Campers c
            JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            LEFT JOIN Counselors n ON c.HomeGroupCounselorID = n.CounselorID
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            ORDER BY c.HomeGroupColor, c.LastName
        `).all(period, activityName);

        const colorGroups = [...new Set(campers.map(c => c.HomeGroupColor).filter(Boolean))];

        // Determine the DB period for staff/counselor/location lookups.
        const isLowerCamp = colorGroups.some(g => ['Red', 'Carolina'].includes(g));
        const dbPeriod = staffDbPeriod(period, activity ? activity.SideOfCamp : null, isLowerCamp);

        const locRow = db.prepare(
            "SELECT Location FROM Schedules WHERE PersonType = 'Staff' AND ActivityName = ? AND PeriodNumber = ? AND Location IS NOT NULL AND Location != '' LIMIT 1"
        ).get(activityName, dbPeriod);

        const staff = db.prepare(`
            SELECT st.FirstName, st.LastName, st.StaffType
            FROM Staff st JOIN Schedules s ON st.StaffID = s.PersonID AND s.PersonType = 'Staff'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
        `).all(dbPeriod, activityName);

        const counselors = db.prepare(`
            SELECT n.CounselorID, n.FirstName, n.LastName, n.HomeGroupColor
            FROM Counselors n JOIN Schedules s ON n.CounselorID = s.PersonID AND s.PersonType = 'Counselor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            ORDER BY n.HomeGroupColor, n.LastName
        `).all(dbPeriod, activityName);

        res.render('class-roster', {
            periodNumber: period,
            dbPeriod,
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


// Update location for all staff schedule rows at a given DB period + activity
app.post('/update-class-location', (req, res) => {
    const { activityName, periodNumber, dbPeriod, location } = req.body;
    db.prepare(
        "UPDATE Schedules SET Location = ? WHERE PersonType = 'Staff' AND PeriodNumber = ? AND ActivityName = ?"
    ).run(location || null, parseInt(dbPeriod), activityName);
    res.redirect(`/class-roster/${periodNumber}/${encodeURIComponent(activityName)}`);
});

app.get('/search', (req, res) => {
    try {
        const query = req.query.name || '';
        
        const camperList = db.prepare(`
            SELECT 
                c.*, 
                n.FirstName || ' ' || n.LastName AS HomeCounselorName,
                s1.ActivityName AS P1,
                s2.ActivityName AS P2,
                s3.ActivityName AS P3,
                s4.ActivityName AS P4,
                s5.ActivityName AS P5
            FROM Campers c
            LEFT JOIN Counselors n ON c.HomeGroupCounselorID = n.CounselorID
            LEFT JOIN Schedules s1 ON c.CamperID = s1.PersonID AND s1.PeriodNumber = 1 AND s1.PersonType = 'Camper'
            LEFT JOIN Schedules s2 ON c.CamperID = s2.PersonID AND s2.PeriodNumber = 2 AND s2.PersonType = 'Camper'
            LEFT JOIN Schedules s3 ON c.CamperID = s3.PersonID AND s3.PeriodNumber = 3 AND s3.PersonType = 'Camper'
            LEFT JOIN Schedules s4 ON c.CamperID = s4.PersonID AND s4.PeriodNumber = 4 AND s4.PersonType = 'Camper'
            LEFT JOIN Schedules s5 ON c.CamperID = s5.PersonID AND s5.PeriodNumber = 5 AND s5.PersonType = 'Camper'
            WHERE (c.FirstName || ' ' || c.LastName LIKE ?) OR (? = '')
            ORDER BY c.LastName ASC
        `).all(`%${query}%`, query);

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
    const counselors = db.prepare("SELECT * FROM Counselors ORDER BY HomeGroupColor, LastName ASC").all();
    res.render('counselor-directory', { counselors });
});

app.get('/staff-lookup', (req, res) => {
    const query = req.query.name || '';
    const staff = db.prepare(`
        SELECT st.*,
            s1.ActivityName AS P1, s1.Location AS L1,
            s2.ActivityName AS P2, s2.Location AS L2,
            s3.ActivityName AS P3, s3.Location AS L3,
            s4.ActivityName AS P4, s4.Location AS L4,
            s5.ActivityName AS P5, s5.Location AS L5,
            s6.ActivityName AS P6, s6.Location AS L6
        FROM Staff st
        LEFT JOIN Schedules s1 ON st.StaffID = s1.PersonID AND s1.PersonType = 'Staff' AND s1.PeriodNumber = 1
        LEFT JOIN Schedules s2 ON st.StaffID = s2.PersonID AND s2.PersonType = 'Staff' AND s2.PeriodNumber = 2
        LEFT JOIN Schedules s3 ON st.StaffID = s3.PersonID AND s3.PersonType = 'Staff' AND s3.PeriodNumber = 3
        LEFT JOIN Schedules s4 ON st.StaffID = s4.PersonID AND s4.PersonType = 'Staff' AND s4.PeriodNumber = 4
        LEFT JOIN Schedules s5 ON st.StaffID = s5.PersonID AND s5.PersonType = 'Staff' AND s5.PeriodNumber = 5
        LEFT JOIN Schedules s6 ON st.StaffID = s6.PersonID AND s6.PersonType = 'Staff' AND s6.PeriodNumber = 6
        WHERE (st.FirstName || ' ' || st.LastName LIKE ?) OR (? = '')
        ORDER BY st.StaffType, st.LastName, st.FirstName
    `).all(`%${query}%`, query);
    res.render('staff-lookup', { staff, query });
});

app.get('/faculty-summer', (req, res) => {
    const allStaff = db.prepare('SELECT * FROM Staff ORDER BY StaffType, LastName, FirstName').all();

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

    // Build map: staffId -> array of week objects
    const weekMap = {};
    for (const row of weekRows) {
        if (!weekMap[row.StaffID]) weekMap[row.StaffID] = [];
        weekMap[row.StaffID].push(row);
    }

    // Attach weeks to each staff member
    const staff = allStaff.map(s => ({ ...s, weeks: weekMap[s.StaffID] || [] }));

    // Count staff per week for the upload section header badges
    const weekCounts = {};
    for (const row of weekRows) {
        weekCounts[row.WeekNumber] = (weekCounts[row.WeekNumber] || 0) + 1;
    }

    res.render('faculty-summer', { staff, weekCounts, alertMessage: req.query.message });
});

app.get('/counselor-profile/:id', (req, res) => {
    const counselor = db.prepare('SELECT * FROM Counselors WHERE CounselorID = ?').get(req.params.id);
    const schedule = db.prepare("SELECT * FROM Schedules WHERE PersonID = ? AND PersonType = 'Counselor' ORDER BY PeriodNumber ASC").all(req.params.id);
    const campers = db.prepare("SELECT * FROM Campers WHERE HomeGroupCounselorID = ? ORDER BY LastName ASC").all(req.params.id);
    res.render('counselor-view', { counselor, schedule, campers });
});

app.get('/camper/:id', (req, res) => {
    try {
        const camper = db.prepare(`
            SELECT c.*, co.FirstName || ' ' || co.LastName AS HomeCounselorName
            FROM Campers c
            LEFT JOIN Counselors co ON c.HomeGroupCounselorID = co.CounselorID
            WHERE c.CamperID = ?
        `).get(req.params.id);

        if (!camper) return res.status(404).send('Camper not found');

        const schedule = db.prepare(`
            SELECT s.PeriodNumber, s.ActivityName, s.Location, a.SideOfCamp
            FROM Schedules s
            LEFT JOIN Activities a ON s.ActivityName = a.Name
            WHERE s.PersonID = ? AND s.PersonType = 'Camper'
            ORDER BY s.PeriodNumber ASC
        `).all(req.params.id);

        const counselors = db.prepare(
            'SELECT CounselorID, FirstName, LastName, HomeGroupColor FROM Counselors ORDER BY HomeGroupColor, LastName ASC'
        ).all();

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

// --- SETTINGS & ACTIVITY MANAGEMENT ---
app.get('/settings', (req, res) => {
    const activities = db.prepare('SELECT * FROM Activities ORDER BY SideOfCamp, Name').all();
    const periodOverrides = db.prepare('SELECT * FROM ActivityPeriodGroups ORDER BY ActivityName, PeriodNumber').all();
    res.render('settings', { activities, periodOverrides, alertMessage: req.query.message });
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
    res.render('promotions', { potentialPromotions, alertMessage: req.query.message || null });
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


// --- CSV IMPORTS (Consolidated) ---
app.post('/upload-campers', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const findCounselor = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
            const findCamper    = db.prepare("SELECT CamperID FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
            const insertCamper  = db.prepare(`
                INSERT INTO Campers (FirstName, LastName, Age, HomeGroupColor, HomeGroupCounselorID, BusRoute, ExtendedHours, CampLunch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const updateCamper  = db.prepare(`
                UPDATE Campers SET Age = ?, HomeGroupColor = ?, HomeGroupCounselorID = ?, BusRoute = ?, ExtendedHours = ?, CampLunch = ?
                WHERE CamperID = ?
            `);
            const deleteSched   = db.prepare(`DELETE FROM Schedules WHERE PersonID = ? AND PersonType = 'Camper'`);
            const insertSched   = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName) VALUES (?, 'Camper', ?, ?)`);

            const safeTrim = (val) => (val && typeof val === 'string') ? val.trim() : '';

            try {
                db.transaction((data) => {
                    for (const row of data) {
                        const firstName = safeTrim(row.FirstName);
                        const lastName  = safeTrim(row.LastName);
                        const counselorNameLookup = safeTrim(row.HomeGroupCounselor);
                        const counselor = counselorNameLookup ? findCounselor.get(counselorNameLookup) : null;
                        const cID = counselor ? counselor.CounselorID : null;

                        const existing = findCamper.get(`${firstName} ${lastName}`);
                        let personId;
                        if (existing) {
                            updateCamper.run(
                                row.Age || 0, safeTrim(row.HomeGroupColor), cID,
                                safeTrim(row.BusRoute), safeTrim(row.ExtendedHours) || null,
                                safeTrim(row.CampLunch) || 'No', existing.CamperID
                            );
                            personId = existing.CamperID;
                        } else {
                            personId = insertCamper.run(
                                firstName, lastName, row.Age || 0, safeTrim(row.HomeGroupColor),
                                cID, safeTrim(row.BusRoute), safeTrim(row.ExtendedHours) || null,
                                safeTrim(row.CampLunch) || 'No'
                            ).lastInsertRowid;
                        }

                        deleteSched.run(personId);
                        for (let i = 1; i <= 5; i++) {
                            const act = row[`P${i}`];
                            if (act && act.trim() !== '') insertSched.run(personId, i, act.trim());
                        }
                    }
                })(results);

                res.redirect('/settings?message=Camper+Import+Success');
            } catch (err) {
                console.error('Database Error:', err);
                res.redirect('/settings?message=Database+Error+Check+Console');
            } finally {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            }
        });
});
// 1. IMPORT COUNSELORS
app.post('/upload-counselors', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        const findCounselor = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
        const insCounselor  = db.prepare(`INSERT INTO Counselors (FirstName, LastName, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours) VALUES (?, ?, ?, ?, ?, ?)`);
        const updCounselor  = db.prepare(`UPDATE Counselors SET HomeGroupColor = ?, ScheduleType = ?, BusRoute = ?, ExtendedHours = ? WHERE CounselorID = ?`);
        const deleteSched   = db.prepare(`DELETE FROM Schedules WHERE PersonID = ? AND PersonType = 'Counselor'`);
        const insSched      = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName) VALUES (?, 'Counselor', ?, ?)`);

        try {
            db.transaction((data) => {
                for (const row of data) {
                    const firstName = (row.FirstName || '').trim();
                    const lastName  = (row.LastName  || '').trim();
                    const existing  = findCounselor.get(`${firstName} ${lastName}`);
                    let personId;
                    if (existing) {
                        updCounselor.run(row.HomeGroupColor, row.ScheduleType, row.Bus, row.Extended, existing.CounselorID);
                        personId = existing.CounselorID;
                    } else {
                        personId = insCounselor.run(firstName, lastName, row.HomeGroupColor, row.ScheduleType, row.Bus, row.Extended).lastInsertRowid;
                    }
                    deleteSched.run(personId);
                    for (let i = 1; i <= 6; i++) {
                        if (row[`P${i}`]) insSched.run(personId, i, row[`P${i}`]);
                    }
                }
            })(results);
            res.redirect('/settings?message=Counselors+Imported');
        } catch (err) {
            console.error('Counselor import error:', err);
            res.redirect('/settings?message=Error+Importing+Counselors');
        } finally {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        }
    });
});

// 2. IMPORT GENERAL STAFF
app.post('/upload-staff', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        const findStaff  = db.prepare("SELECT StaffID FROM Staff WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
        const insStaff   = db.prepare(`INSERT INTO Staff (FirstName, LastName, HomeGroupColor, StaffType) VALUES (?, ?, ?, ?)`);
        const updStaff   = db.prepare(`UPDATE Staff SET HomeGroupColor = ?, StaffType = ? WHERE StaffID = ?`);
        const deleteSched = db.prepare(`DELETE FROM Schedules WHERE PersonID = ? AND PersonType = 'Staff'`);
        const insSched   = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, Location) VALUES (?, 'Staff', ?, ?, ?)`);

        try {
            db.transaction((data) => {
                for (const row of data) {
                    const firstName = (row.FirstName || '').trim();
                    const lastName  = (row.LastName  || '').trim();
                    const existing  = findStaff.get(`${firstName} ${lastName}`);
                    let personId;
                    if (existing) {
                        updStaff.run(row.HomeGroupColor, row.StaffType, existing.StaffID);
                        personId = existing.StaffID;
                    } else {
                        personId = insStaff.run(firstName, lastName, row.HomeGroupColor, row.StaffType).lastInsertRowid;
                    }
                    deleteSched.run(personId);
                    for (let i = 1; i <= 6; i++) {
                        if (row[`P${i}`]) insSched.run(personId, i, row[`P${i}`], row[`L${i}`] || null);
                    }
                }
            })(results);
            res.redirect('/settings?message=Staff+Imported');
        } catch (err) {
            console.error('Staff import error:', err);
            res.redirect('/settings?message=Error+Importing+Staff');
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
        const findStaff  = db.prepare('SELECT StaffID FROM Staff WHERE FirstName = ? AND LastName = ? LIMIT 1');
        const insStaff   = db.prepare('INSERT INTO Staff (FirstName, LastName, HomeGroupColor, StaffType) VALUES (?, ?, ?, ?)');
        const delWeek    = db.prepare('DELETE FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ?');
        const insSchedule = db.prepare('INSERT OR REPLACE INTO StaffWeekSchedules (StaffID, WeekNumber, PeriodNumber, ActivityName, Location) VALUES (?, ?, ?, ?, ?)');

        try {
            db.transaction((data) => {
                for (const row of data) {
                    const firstName = (row.FirstName || '').trim();
                    const lastName  = (row.LastName  || '').trim();
                    if (!firstName && !lastName) continue;

                    let found = findStaff.get(firstName, lastName);
                    const staffId = found
                        ? found.StaffID
                        : insStaff.run(firstName, lastName, row.HomeGroupColor || null, row.StaffType || null).lastInsertRowid;

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
            res.redirect(`/faculty-summer?message=Error+importing+Week+${weekNumber}`);
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

// CLEAR STAFF
app.post('/clear-staff', (req, res) => {
    db.prepare("DELETE FROM Schedules WHERE PersonType = 'Staff'").run();
    db.prepare("DELETE FROM Staff").run();
    res.redirect('/settings?message=Staff+Cleared');
});

// CLEAR CAMPERS
app.post('/clear-campers', (req, res) => {
    db.prepare("DELETE FROM Schedules WHERE PersonType = 'Camper'").run();
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

    res.render('swap-tool', { camper, currentSchedule, query });
});

// Returns available activity options for a given camper's period
app.get('/get-options/:camperId/:period', (req, res) => {
    const { camperId, period } = req.params;

    // Get the camper's home group color for AllowedGroups filtering
    const camper = db.prepare('SELECT HomeGroupColor FROM Campers WHERE CamperID = ?').get(camperId);
    const color = camper ? camper.HomeGroupColor : null;

    // Resolve effective AllowedGroups: period-specific override takes precedence over activity default.
    // Only return activities whose effective group permits this camper's color, with enrollment > 0.
    const options = db.prepare(`
        WITH effective AS (
            SELECT a.Name, a.SideOfCamp, a.MaxCapacity,
                   COALESCE(apg.AllowedGroups, a.AllowedGroups) AS EffectiveGroups,
                   (SELECT COUNT(*) FROM Schedules s
                    WHERE s.ActivityName = a.Name AND s.PeriodNumber = @period AND s.PersonType = 'Camper') AS CurrentEnrollment
            FROM Activities a
            LEFT JOIN ActivityPeriodGroups apg
                   ON apg.ActivityName = a.Name AND apg.PeriodNumber = @period
        )
        SELECT * FROM effective
        WHERE CurrentEnrollment > 0
          AND (
              EffectiveGroups IS NULL OR
              EffectiveGroups = @color OR
              (EffectiveGroups = 'Red-Carolina' AND @color IN ('Red', 'Carolina')) OR
              (EffectiveGroups = 'Green-Navy'   AND @color IN ('Green', 'Navy'))
          )
        ORDER BY CurrentEnrollment ASC, Name ASC
    `).all({ period, color });

    res.json({ options, colorGroup: color || 'All' });
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
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Sessions that should show the "absent AM" indicator (i.e. everything after homegroup_am)
const SHOW_AM_INDICATOR = new Set(['class','homegroup_pm','bus_pm','extended_pm']);

// --- ATTENDANCE OVERVIEW ---
app.get('/attendance', (req, res) => {
    const date = req.query.date || todayStr();

    // Homegroup sessions — grouped by counselor
    const homegroupCounselors = db.prepare(`
        SELECT co.CounselorID, co.FirstName, co.LastName, co.HomeGroupColor,
               COUNT(ca.CamperID) as camperCount
        FROM Counselors co
        JOIN Campers ca ON ca.HomeGroupCounselorID = co.CounselorID
        GROUP BY co.CounselorID
        ORDER BY co.LastName, co.FirstName
    `).all();
    const homegroupSessions = [];
    for (const counselor of homegroupCounselors) {
        for (const session of ['am', 'pm']) {
            const sessionType = `homegroup_${session}`;
            const markedCount = db.prepare(`
                SELECT COUNT(*) as n FROM Attendance a
                JOIN Campers c ON a.CamperID = c.CamperID
                WHERE a.Date=? AND a.SessionType=? AND c.HomeGroupCounselorID=?
            `).get(date, sessionType, counselor.CounselorID)?.n || 0;
            homegroupSessions.push({
                label: `${counselor.FirstName} ${counselor.LastName} — ${session.toUpperCase()}`,
                counselorId: counselor.CounselorID,
                color: counselor.HomeGroupColor,
                session: session,
                link: `/attendance/homegroup/counselor/${counselor.CounselorID}/${session}?date=${date}`,
                submitted: markedCount > 0
            });
        }
    }

    // Class sessions — pull distinct period+activity combos from Camper schedules
    const classRows = db.prepare(`
        SELECT DISTINCT s.PeriodNumber, s.ActivityName
        FROM Schedules s
        WHERE s.PersonType = 'Camper' AND s.ActivityName NOT LIKE '#REF%'
        ORDER BY s.PeriodNumber, s.ActivityName
    `).all();

    const checkP3Half = db.prepare(`
        SELECT 1 FROM Schedules s
        JOIN Campers c ON s.PersonID = c.CamperID AND s.PersonType = 'Camper'
        WHERE s.PeriodNumber = 3 AND s.ActivityName = ? AND c.HomeGroupColor IN (?, ?)
        LIMIT 1
    `);
    const countP3Half = db.prepare(`
        SELECT COUNT(*) as n FROM Attendance a
        JOIN Campers c ON a.CamperID = c.CamperID
        WHERE a.Date=? AND a.SessionType='class' AND a.PeriodNumber=3 AND a.ActivityName=?
        AND c.HomeGroupColor IN (?, ?)
    `);

    const classSessions = [];
    for (const r of classRows) {
        if (r.PeriodNumber === 3) {
            if (checkP3Half.get(r.ActivityName, 'Green', 'Navy')) {
                const count = countP3Half.get(date, r.ActivityName, 'Green', 'Navy')?.n || 0;
                classSessions.push({
                    label: `P3 AM — ${r.ActivityName}`,
                    periodNumber: 3, periodKey: '3am', periodLabel: '3 AM',
                    activityName: r.ActivityName,
                    link: `/attendance/class/3/${encodeURIComponent(r.ActivityName)}?date=${date}&half=am`,
                    submitted: count > 0
                });
            }
            if (checkP3Half.get(r.ActivityName, 'Red', 'Carolina')) {
                const count = countP3Half.get(date, r.ActivityName, 'Red', 'Carolina')?.n || 0;
                classSessions.push({
                    label: `P3 PM — ${r.ActivityName}`,
                    periodNumber: 3, periodKey: '3pm', periodLabel: '3 PM',
                    activityName: r.ActivityName,
                    link: `/attendance/class/3/${encodeURIComponent(r.ActivityName)}?date=${date}&half=pm`,
                    submitted: count > 0
                });
            }
        } else {
            const count = db.prepare(
                "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?"
            ).get(date, r.PeriodNumber, r.ActivityName)?.n || 0;
            classSessions.push({
                label: `P${r.PeriodNumber} — ${r.ActivityName}`,
                periodNumber: r.PeriodNumber, periodKey: String(r.PeriodNumber), periodLabel: String(r.PeriodNumber),
                activityName: r.ActivityName,
                link: `/attendance/class/${r.PeriodNumber}/${encodeURIComponent(r.ActivityName)}?date=${date}`,
                submitted: count > 0
            });
        }
    }

    // Bus sessions
    const busRoutes = db.prepare("SELECT DISTINCT BusRoute FROM Campers WHERE BusRoute IS NOT NULL AND BusRoute != '' AND LOWER(CAST(BusRoute AS TEXT)) != 'null' ORDER BY BusRoute").all().map(r => r.BusRoute);
    const busSessions = [];
    for (const route of busRoutes) {
        for (const session of ['am', 'pm']) {
            const sessionType = `bus_${session}`;
            const count = db.prepare(
                "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType=?"
            ).get(date, sessionType)?.n || 0;
            busSessions.push({
                label: `Bus ${route} — ${session.toUpperCase()}`,
                route,
                session: session,
                link: `/attendance/bus/${encodeURIComponent(route)}/${session}?date=${date}`,
                submitted: count > 0
            });
        }
    }

    // Extended sessions
    const extSessions = [];
    for (const session of ['am', 'pm']) {
        const sessionType = `extended_${session}`;
        const col = session === 'am' ? "('AM','Both')" : "('PM','Both')";
        const hasCampers = db.prepare(`SELECT 1 FROM Campers WHERE ExtendedHours IN ${col} LIMIT 1`).get();
        if (hasCampers) {
            const count = db.prepare(
                "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType=?"
            ).get(date, sessionType)?.n || 0;
            extSessions.push({
                label: `Extended ${session.toUpperCase()}`,
                session: session,
                link: `/attendance/extended/${session}?date=${date}`,
                submitted: count > 0
            });
        }
    }

    // Late arrivals count
    const lateCount = db.prepare(
        "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'"
    ).get(date)?.n || 0;

    res.render('attendance-overview', { date, homegroupSessions, classSessions, busSessions, extSessions, lateCount });
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

    const campers = db.prepare("SELECT * FROM Campers WHERE HomeGroupCounselorID=? ORDER BY LastName, FirstName").all(counselorId);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'")
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

    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || 'present',
        absentAM: absentAMSet.has(c.CamperID),
        absentBusAM: absentBusAMSet.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID)
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
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'")
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

    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || 'present',
        absentAM: absentAMSet.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID)
    }));

    res.render('attendance-form', {
        title: `${color} Group — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        backLink: `/attendance?date=${date}`,
        roster
    });
});

// --- ATTENDANCE FORM: CLASS ---
app.get('/attendance/class/:period/:activity', (req, res) => {
    const period = parseInt(req.params.period);
    const activityName = req.params.activity;
    const date = req.query.date || todayStr();
    const half = req.query.half || '';
    const sessionType = 'class';

    let campersSql = `
        SELECT c.* FROM Campers c
        JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
        WHERE s.PeriodNumber = ? AND s.ActivityName = ?`;
    if (half === 'am') campersSql += ` AND c.HomeGroupColor IN ('Green', 'Navy')`;
    if (half === 'pm') campersSql += ` AND c.HomeGroupColor IN ('Red', 'Carolina')`;
    campersSql += ` ORDER BY c.HomeGroupColor, c.LastName, c.FirstName`;

    const campers = db.prepare(campersSql).all(period, activityName);

    const absentAMSet = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'")
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

    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || 'present',
        absentAM: absentAMSet.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID)
    }));

    const pLabel = period === 3 && half ? `3 ${half.toUpperCase()}` : String(period);
    res.render('attendance-form', {
        title: `P${pLabel} — ${activityName}`,
        sessionType, date, half,
        periodNumber: period, activityName,
        backLink: `/attendance?date=${date}`,
        roster
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
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'")
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

    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || 'present',
        absentAM: absentAMSet.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID)
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
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='homegroup_am' AND Status='absent'")
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

    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || 'present',
        absentAM: absentAMSet.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID)
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
    try {
        db.prepare(`
            INSERT INTO Attendance (Date, CamperID, SessionType, PeriodNumber, ActivityName, Status)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (Date, CamperID, SessionType, PeriodNumber, ActivityName)
            DO UPDATE SET Status = excluded.Status, MarkedAt = CURRENT_TIMESTAMP
        `).run(date, camperId, sessionType, periodNumber, activityName, status);
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

    // Attach their schedule for context
    const roster = campers.map(c => {
        const schedule = db.prepare(
            "SELECT PeriodNumber, ActivityName FROM Schedules WHERE PersonID=? AND PersonType='Camper' ORDER BY PeriodNumber"
        ).all(c.CamperID);
        return { ...c, schedule };
    });

    res.render('attendance-late-arrivals', { date, roster });
});

app.post('/attendance/check-in', (req, res) => {
    const { date, camperId } = req.body;
    db.prepare(`
        UPDATE Attendance SET Status = 'late', MarkedAt = CURRENT_TIMESTAMP
        WHERE Date = ? AND CamperID = ? AND SessionType = 'homegroup_am'
    `).run(date, camperId);
    res.redirect(`/attendance/late-arrivals?date=${date}`);
});

// --- EARLY DISMISSAL ---
app.post('/attendance/early-dismissal', (req, res) => {
    const { date, camperId, dismissalTime, notes, returnTo } = req.body;
    db.prepare(`
        INSERT INTO EarlyDismissals (Date, CamperID, DismissalTime, Notes)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (Date, CamperID) DO UPDATE SET
            DismissalTime = excluded.DismissalTime,
            Notes = excluded.Notes
    `).run(date, camperId, dismissalTime || null, notes || null);
    res.redirect(returnTo || `/attendance?date=${date}`);
});

// --- Counselor Scheduling Tool ---
app.get('/counselor-scheduling', (req, res) => {
    const offerings = db.prepare("SELECT * FROM WeeklyOfferings ORDER BY SideOfCamp, ActivityName").all();
    const counselors = db.prepare("SELECT CounselorID, FirstName, LastName, HomeGroupColor, BusRoute, ScheduleType FROM Counselors ORDER BY LastName, FirstName").all();
    const alertMessage = req.query.message || null;

    const availability = {};
    const staffAvailability = {};

    for (let p = 1; p <= 6; p++) {
        availability[p] = {
            Sports: db.prepare(`
                SELECT DISTINCT c.CounselorID, c.FirstName, c.LastName, c.HomeGroupColor
                FROM Counselors c
                JOIN Schedules s ON s.PersonID = c.CounselorID AND s.PersonType = 'Counselor' AND s.PeriodNumber = ?
                JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Sports'
                ORDER BY c.LastName, c.FirstName
            `).all(p),
            Enrichment: db.prepare(`
                SELECT DISTINCT c.CounselorID, c.FirstName, c.LastName, c.HomeGroupColor
                FROM Counselors c
                JOIN Schedules s ON s.PersonID = c.CounselorID AND s.PersonType = 'Counselor' AND s.PeriodNumber = ?
                JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Enrichment'
                ORDER BY c.LastName, c.FirstName
            `).all(p),
        };
        staffAvailability[p] = {
            Sports: db.prepare(`
                SELECT DISTINCT st.StaffID, st.FirstName, st.LastName, st.StaffType
                FROM Staff st
                JOIN Schedules s ON s.PersonID = st.StaffID AND s.PersonType = 'Staff' AND s.PeriodNumber = ?
                JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Sports'
                ORDER BY st.LastName, st.FirstName
            `).all(p),
            Enrichment: db.prepare(`
                SELECT DISTINCT st.StaffID, st.FirstName, st.LastName, st.StaffType
                FROM Staff st
                JOIN Schedules s ON s.PersonID = st.StaffID AND s.PersonType = 'Staff' AND s.PeriodNumber = ?
                JOIN Activities a ON a.Name = s.ActivityName AND a.SideOfCamp = 'Enrichment'
                ORDER BY st.LastName, st.FirstName
            `).all(p),
        };
    }

    const rawAssignments = db.prepare("SELECT * FROM CounselorScheduleAssignments").all();
    const existingAssignments = {};
    rawAssignments.forEach(a => {
        const key = `${a.PeriodNumber}|${a.ActivityName}`;
        if (!existingAssignments[key]) existingAssignments[key] = { counselors: [], staff: [] };
        if (a.PersonType === 'Counselor') existingAssignments[key].counselors.push(a.PersonID);
        else existingAssignments[key].staff.push(a.PersonID);
    });

    res.render('counselor-scheduling', { offerings, counselors, availability, staffAvailability, existingAssignments, alertMessage });
});

app.post('/save-counselor-group-assignments', (req, res) => {
    const { counselors } = req.body;
    if (!Array.isArray(counselors)) return res.status(400).json({ error: 'Invalid payload' });
    const update = db.prepare('UPDATE Counselors SET HomeGroupColor = ?, BusRoute = ?, ScheduleType = ? WHERE CounselorID = ?');
    db.transaction(list => {
        for (const c of list) {
            if (c.counselorID) update.run(c.homeGroupColor || null, c.busRoute || null, c.scheduleType || null, c.counselorID);
        }
    })(counselors);
    res.json({ ok: true });
});

app.post('/upload-weekly-offerings', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/counselor-scheduling?message=No+file+uploaded.');
    const rows = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', row => {
            const name       = (row.ActivityName || '').trim();
            const enrollment = parseInt(row.PreliminaryEnrollment) || 0;
            const side       = (row.SideOfCamp || '').trim();
            const period     = parseInt(row.PeriodNumber) || null;
            if (name) rows.push([name, enrollment, side, period]);
        })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            db.exec('DELETE FROM WeeklyOfferings; DELETE FROM CounselorScheduleAssignments;');
            const ins = db.prepare('INSERT INTO WeeklyOfferings (ActivityName, PreliminaryEnrollment, SideOfCamp, PeriodNumber) VALUES (?, ?, ?, ?)');
            db.transaction(items => { for (const item of items) ins.run(...item); })(rows);
            res.redirect(`/counselor-scheduling?message=Loaded+${rows.length}+offerings.`);
        })
        .on('error', () => res.redirect('/counselor-scheduling?message=Error+reading+file.'));
});

app.post('/clear-weekly-offerings', (_req, res) => {
    db.exec('DELETE FROM WeeklyOfferings; DELETE FROM CounselorScheduleAssignments;');
    res.redirect('/counselor-scheduling?message=Offerings+cleared.');
});

app.post('/save-counselor-assignments', (req, res) => {
    const { assignments } = req.body;
    if (!Array.isArray(assignments)) return res.status(400).json({ error: 'Invalid payload' });
    db.exec('DELETE FROM CounselorScheduleAssignments');
    const ins = db.prepare('INSERT OR IGNORE INTO CounselorScheduleAssignments (PeriodNumber, ActivityName, PersonID, PersonType) VALUES (?, ?, ?, ?)');
    db.transaction(items => {
        for (const a of items) {
            if (a.periodNumber && a.activityName && a.personID && a.personType) {
                ins.run(a.periodNumber, a.activityName, a.personID, a.personType);
            }
        }
    })(assignments);
    res.json({ ok: true });
});

app.get('/export-counselor-schedule', (_req, res) => {
    const counselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName, c.HomeGroupColor, c.ScheduleType, c.BusRoute, c.ExtendedHours
        FROM Counselors c
        ORDER BY c.LastName, c.FirstName
    `).all();
    const assignments = db.prepare(`
        SELECT PersonID, PeriodNumber, ActivityName
        FROM CounselorScheduleAssignments
        WHERE PersonType = 'Counselor'
    `).all();
    const periodsByID = {};
    assignments.forEach(a => {
        if (!periodsByID[a.PersonID]) periodsByID[a.PersonID] = {};
        periodsByID[a.PersonID][a.PeriodNumber] = a.ActivityName;
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
        SELECT a.PeriodNumber, a.ActivityName, st.StaffID, st.FirstName, st.LastName, st.HomeGroupColor, st.StaffType
        FROM CounselorScheduleAssignments a
        JOIN Staff st ON st.StaffID = a.PersonID AND a.PersonType = 'Staff'
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
    const rows = db.prepare(`
        SELECT
            s.PeriodNumber,
            s.ActivityName,
            a.SideOfCamp,
            (SELECT COUNT(*) FROM Schedules sc
             WHERE sc.PersonType = 'Camper' AND sc.PeriodNumber = s.PeriodNumber AND sc.ActivityName = s.ActivityName
            ) AS Enrollment,
            (SELECT GROUP_CONCAT(st.FirstName || ' ' || st.LastName, '; ')
             FROM Staff st JOIN Schedules ss ON st.StaffID = ss.PersonID AND ss.PersonType = 'Staff'
             WHERE ss.PeriodNumber = s.PeriodNumber AND ss.ActivityName = s.ActivityName
            ) AS Staff,
            (SELECT ss.Location FROM Schedules ss
             WHERE ss.PersonType = 'Staff' AND ss.PeriodNumber = s.PeriodNumber AND ss.ActivityName = s.ActivityName
             AND ss.Location IS NOT NULL AND ss.Location != '' LIMIT 1
            ) AS Location,
            (SELECT GROUP_CONCAT(c.FirstName || ' ' || c.LastName, '; ')
             FROM Counselors c JOIN Schedules ss ON c.CounselorID = ss.PersonID AND ss.PersonType = 'Counselor'
             WHERE ss.PeriodNumber = s.PeriodNumber AND ss.ActivityName = s.ActivityName
            ) AS Counselors
        FROM (SELECT DISTINCT PeriodNumber, ActivityName FROM Schedules) s
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
app.get('/counselor-preferences', (req, res) => {
    const counselors = db.prepare("SELECT CounselorID, FirstName, LastName, HomeGroupColor FROM Counselors ORDER BY LastName, FirstName").all();
    const activities = db.prepare("SELECT Name, SideOfCamp FROM Activities ORDER BY SideOfCamp, Name").all();
    const alertMessage = req.query.message || null;
    res.render('counselor-preferences', { counselors, activities, alertMessage });
});

app.post('/counselor-preferences', (req, res) => {
    const { counselorID, homeGroupPreference, schedulePreference } = req.body;
    const activityPreferences = Array.isArray(req.body.activityPreferences)
        ? req.body.activityPreferences
        : req.body.activityPreferences ? [req.body.activityPreferences] : [];

    if (!counselorID) return res.redirect('/counselor-preferences?message=Please+select+a+counselor.');

    db.prepare(`
        INSERT INTO CounselorPreferences (CounselorID, HomeGroupPreference, SchedulePreference, ActivityPreferences, SubmittedAt)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (CounselorID) DO UPDATE SET
            HomeGroupPreference  = excluded.HomeGroupPreference,
            SchedulePreference   = excluded.SchedulePreference,
            ActivityPreferences  = excluded.ActivityPreferences,
            SubmittedAt          = CURRENT_TIMESTAMP
    `).run(counselorID, homeGroupPreference || null, schedulePreference || null, JSON.stringify(activityPreferences));

    res.redirect('/counselor-preferences?message=Preferences+saved!');
});

app.listen(3000, () => console.log('Camp Manager running at http://localhost:3000'));