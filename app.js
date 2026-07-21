const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const cookieParser = require('cookie-parser');
const cloudinary = require('cloudinary').v2;
const archiver = require('archiver');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const webPush = require('web-push');

const app = express();
const db = new Database(process.env.DB_PATH || 'camp_manager.db');
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

const HOME_GROUP_LABELS = {
    Red: 'Red', Carolina: 'Carolina', Green: 'Green', Navy: 'Navy',
    Bus: 'Bus', LilPlace: "Li'l Place", KinderPlace: 'Kinder Place', SPLIT: 'SPLIT',
    SPRC: 'SPRC', Swim: 'Swim Staff'
};
const SPECIALTY_CAMP_COLORS = ['LilPlace', 'KinderPlace', 'SPLIT', 'SPRC', 'Swim'];
const MAIN_CAMP_COLORS = new Set(['Red', 'Carolina', 'Green', 'Navy']);

// Activities that share a room/instructor and display as one merged class.
// Each inner array is a merge group; first entry is the canonical link target.
const MERGED_ACTIVITIES = [['Dance', 'Cheerleading']];
function getMergeGroup(activityName) {
    return MERGED_ACTIVITIES.find(g => g.includes(activityName)) || null;
}

// Period flip schedules — all times EST (UTC-5), 24-hour format.
// clockBlock = universal time-block number (1-6 matching Sports period numbering).
// Block 3 = Sports only (Green/Navy). Block 4 = S4 (Red/Carolina) + E3 (Green/Navy).
// Block 6 = Sports only (Red/Carolina). Enrichment runs in blocks 1, 2, 4, 5 only.
const SPORTS_PERIODS = [
    { startH: 9,  startM: 0,  endH: 9,  endM: 50, label: 'Sports 1', clockBlock: 1 },
    { startH: 10, startM: 0,  endH: 10, endM: 50, label: 'Sports 2', clockBlock: 2 },
    { startH: 11, startM: 0,  endH: 11, endM: 50, label: 'Sports 3', clockBlock: 3 },
    { startH: 13, startM: 0,  endH: 13, endM: 45, label: 'Sports 4', clockBlock: 4 },
    { startH: 14, startM: 20, endH: 14, endM: 55, label: 'Sports 5', clockBlock: 5 },
    { startH: 15, startM: 30, endH: 16, endM: 5,  label: 'Sports 6', clockBlock: 6 },
];

const ENRICHMENT_PERIODS = [
    { startH: 9,  startM: 0,  endH: 10, endM: 20, label: 'Enrichment 1', clockBlock: 1 },
    { startH: 10, startM: 35, endH: 12, endM: 0,  label: 'Enrichment 2', clockBlock: 2 },
    { startH: 13, startM: 0,  endH: 14, endM: 20, label: 'Enrichment 3', clockBlock: 4 },
    { startH: 14, startM: 40, endH: 16, endM: 0,  label: 'Enrichment 4', clockBlock: 5 },
];

// Full schedules including non-class blocks — used for the hub schedule bar widget.
const SPORTS_SCHEDULE_FULL = [
    { startH: 9,  startM: 0,  endH: 9,  endM: 50, label: 'Sports 1' },
    { startH: 10, startM: 0,  endH: 10, endM: 50, label: 'Sports 2' },
    { startH: 11, startM: 0,  endH: 11, endM: 50, label: 'Sports 3' },
    { startH: 12, startM: 0,  endH: 12, endM: 50, label: 'Lunch' },
    { startH: 13, startM: 10, endH: 13, endM: 45, label: 'Sports 4' },
    { startH: 13, startM: 55, endH: 14, endM: 10, label: 'Big Game' },
    { startH: 14, startM: 20, endH: 14, endM: 55, label: 'Sports 5' },
    { startH: 15, startM: 5,  endH: 15, endM: 20, label: 'Popsicle Break' },
    { startH: 15, startM: 30, endH: 16, endM: 5,  label: 'Sports 6' },
    { startH: 16, startM: 5,  endH: 16, endM: 30, label: 'Dismissal' },
];

const ENRICHMENT_SCHEDULE_FULL = [
    { startH: 9,  startM: 0,  endH: 10, endM: 20, label: 'Enrichment 1' },
    { startH: 10, startM: 20, endH: 10, endM: 40, label: 'Snack Break' },
    { startH: 10, startM: 40, endH: 12, endM: 0,  label: 'Enrichment 2' },
    { startH: 12, startM: 0,  endH: 12, endM: 50, label: 'Lunch' },
    { startH: 13, startM: 0,  endH: 14, endM: 20, label: 'Enrichment 3' },
    { startH: 14, startM: 20, endH: 14, endM: 40, label: 'Popsicle Break' },
    { startH: 14, startM: 40, endH: 16, endM: 0,  label: 'Enrichment 4' },
    { startH: 16, startM: 0,  endH: 16, endM: 30, label: 'Dismissal' },
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

// True if `today` (YYYY-MM-DD) falls on a weekend, on a known no-camp date,
// or outside the configured session range (i.e. attendance isn't expected).
function isCampDay(today) {
    const [y, m, d] = today.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return false;
    if (today === '2026-07-03') return false; // no camp on 7/3
    const w1 = db.prepare("SELECT startDate FROM Sessions WHERE weekNumber=1 LIMIT 1").get();
    const w6 = db.prepare("SELECT startDate FROM Sessions WHERE weekNumber=6 LIMIT 1").get();
    if (!w1?.startDate) return false; // sessions not configured yet
    const campStart = w1.startDate; // 'YYYY-MM-DD'
    const campEnd = (() => {
        if (!w6?.startDate) return campStart;
        const [wy, wm, wd] = w6.startDate.split('-').map(Number);
        return new Date(Date.UTC(wy, wm - 1, wd + 4)).toISOString().slice(0, 10); // Friday of W6
    })();
    return today >= campStart && today <= campEnd;
}

// True if `dateStr` (YYYY-MM-DD) falls on a Monday.
function isMonday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
}

// Parses ACR-005 "Sessions" codes (e.g. "SP01/SP02/SP03") into a sorted list of week numbers.
function parseSessionWeeks(codes) {
    if (!codes) return [];
    const weeks = [];
    const re = /SP0*(\d+)/gi;
    let m;
    while ((m = re.exec(codes))) {
        const w = parseInt(m[1], 10);
        if (w >= 1 && w <= 6) weeks.push(w);
    }
    return weeks.sort((a, b) => a - b);
}

// Shirt order info for a main-camp camper: how many shirts to hand out (session count + 1,
// capped at 5 — the max days in a camp week) and whether they already received shirts during
// an earlier, already-completed week (i.e. their earliest registered week precedes the active one).
function getShirtInfo(camper, activeWeek) {
    if (!MAIN_CAMP_COLORS.has(camper.HomeGroupColor)) return null;
    const weeks = parseSessionWeeks(camper.SessionCodes);
    if (weeks.length === 0) return null;
    return {
        shirtQty: Math.min(weeks.length + 1, 5),
        shirtsReceived: weeks[0] < activeWeek
    };
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

// Like getActivePeriod but transitions to the next period once the current one ends,
// so a viewer sees upcoming class locations before the period officially starts.
function getActiveBlockForMap(schedule, estMins) {
    let activeIdx = -1;
    for (let i = 0; i < schedule.length; i++) {
        if (estMins >= schedule[i].startH * 60 + schedule[i].startM) activeIdx = i;
        else break;
    }
    if (activeIdx === -1) return null;
    const cur = schedule[activeIdx];
    const curEnd = cur.endH * 60 + cur.endM;
    if (estMins >= curEnd) {
        const next = schedule[activeIdx + 1];
        return next ? next.clockBlock : null;
    }
    return cur.clockBlock;
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
    const aw = getActiveWeek();
    const classes = db.prepare(`
        SELECT DISTINCT s.ActivityName
        FROM Schedules s
        JOIN Activities a ON a.Name = s.ActivityName
        WHERE s.PersonType = 'Camper' AND s.PeriodNumber = ? AND a.SideOfCamp = ?
          AND s.ActivityName != 'PM Only - Hartt Chamber Program'
          AND s.WeekNumber = ?
    `).all(clockBlock, side, aw);
    if (classes.length === 0) return { total: 0, submitted: 0 };
    const checkTotal   = db.prepare(`
        SELECT COUNT(*) as n FROM Schedules s
        WHERE s.PersonType='Camper' AND s.PeriodNumber=? AND s.ActivityName=? AND s.WeekNumber=?
          AND s.PersonID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
    `);
    const checkHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND PeriodNumber=? AND ActivityName=? AND WeekNumber=?)
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
        )
    `);
    let submitted = 0;
    for (const c of classes) {
        const total   = checkTotal.get(clockBlock, c.ActivityName, aw, aw)?.n || 0;
        const handled = checkHandled.get(today, clockBlock, c.ActivityName, aw, today, clockBlock, c.ActivityName, aw, aw)?.n || 0;
        if (total === 0 || handled >= total) submitted++;
    }
    return { total: classes.length, submitted };
}

function computeExtAttStats(session, today) {
    const aw = getActiveWeek();
    const col = session === 'am' ? "('AM','Both')" : "('PM','Both')";
    // Li'l Place and KinderPlace are picked up from a separate site for PM — exclude from completion check
    const lpkp = session === 'pm' ? "AND HomeGroupColor NOT IN ('LilPlace','KinderPlace')" : '';
    const extTotal = db.prepare(`SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp}`).get(aw)?.n || 0;
    if (extTotal === 0) return { total: 1, submitted: 1 };
    const handled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp})
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp})
        )
    `).get(today, `extended_${session}`, aw, today, aw)?.n || 0;
    return { total: 1, submitted: handled >= extTotal ? 1 : 0 };
}

function computeBusAttStats(session, today) {
    const aw = getActiveWeek();
    const ridesCol = session === 'pm' ? 'BusRidesPM' : 'BusRidesAM';
    const sessionType = `bus_${session}`;
    // Li'l Place and KinderPlace board PM buses from a separate site — exclude from completion check
    const lpkp = session === 'pm' ? "AND HomeGroupColor NOT IN ('LilPlace','KinderPlace')" : '';
    const routes = db.prepare(`
        SELECT DISTINCT BusRoute FROM CamperWeekData
        WHERE WeekNumber=? AND BusRoute IS NOT NULL AND BusRoute != '' AND LOWER(CAST(BusRoute AS TEXT)) != 'null' AND ${ridesCol} = 1
    `).all(aw).map(r => r.BusRoute);

    const total = routes.length;
    if (total === 0) return { total: 0, submitted: 0 };

    const checkTotal   = db.prepare(`SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND ${ridesCol}=1 ${lpkp}`);
    const checkHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND ${ridesCol}=1 ${lpkp})
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND ${ridesCol}=1 ${lpkp})
        )
    `);

    let submitted = 0;
    for (const route of routes) {
        const busTotal = checkTotal.get(aw, route)?.n || 0;
        const handled  = checkHandled.get(today, sessionType, aw, route, today, aw, route)?.n || 0;
        if (busTotal === 0 || handled >= busTotal) submitted++;
    }
    return { total, submitted };
}

function getAbsentByGroup(today, camperIdSet) {
    const aw = getActiveWeek();
    // Only genuinely absent campers — late/dismissed/nurse are handled by separate sections.
    const lateIds = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status='late'")
            .all(today).map(r => r.CamperID)
    );
    const dismissedIds = new Set(
        db.prepare("SELECT CamperID FROM EarlyDismissals WHERE Date=?").all(today).map(r => r.CamperID)
    );
    const nurseIds = new Set(
        db.prepare("SELECT CamperID FROM NurseLog WHERE Date=? AND CheckOutTime IS NULL").all(today).map(r => r.CamperID)
    );
    const caseIds = new Set(
        db.prepare("SELECT CamperID FROM CaseLog WHERE Date=? AND CheckOutTime IS NULL AND Dismissed=0").all(today).map(r => r.CamperID)
    );
    const attRows = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM Attendance a
        JOIN Campers c ON c.CamperID = a.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE a.Date = ? AND a.SessionType IN ('homegroup_am', 'specialty_am') AND a.Status = 'absent'
    `).all(aw, today).filter(r =>
        !lateIds.has(r.CamperID) && !dismissedIds.has(r.CamperID) &&
        !nurseIds.has(r.CamperID) && !caseIds.has(r.CamperID)
    );
    const filtered = camperIdSet ? attRows.filter(r => camperIdSet.has(r.CamperID)) : attRows;
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
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status='nurse'")
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
    const sessionType = `homegroup_${session}`;
    const aw = getActiveWeek();
    const hasWeekHgData = aw && db.prepare("SELECT 1 FROM CamperHomeGroups WHERE WeekNumber=? LIMIT 1").get(aw);

    let counselors, checkHandled;
    if (hasWeekHgData) {
        counselors = db.prepare(`
            SELECT co.CounselorID, COUNT(chg.CamperID) as camperCount
            FROM Counselors co
            JOIN CamperHomeGroups chg ON chg.CounselorID = co.CounselorID AND chg.WeekNumber = ?
            GROUP BY co.CounselorID
        `).all(aw);
        checkHandled = db.prepare(`
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
        counselors = db.prepare(`
            SELECT co.CounselorID, COUNT(ca.CamperID) as camperCount
            FROM Counselors co
            JOIN Campers ca ON ca.HomeGroupCounselorID = co.CounselorID
            GROUP BY co.CounselorID
        `).all();
        checkHandled = db.prepare(`
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

    const total = counselors.length;
    let submitted = 0;
    for (const c of counselors) {
        const handled = hasWeekHgData
            ? checkHandled.get(today, sessionType, c.CounselorID, aw, today, c.CounselorID, aw)?.n || 0
            : checkHandled.get(today, sessionType, c.CounselorID, today, c.CounselorID)?.n || 0;
        if (c.camperCount === 0 || handled >= c.camperCount) submitted++;
    }
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
    // Returns a resized Cloudinary URL for display; full-size URL is preserved for downloads.
    res.locals.thumbUrl = (url, width = 600) => {
        if (!url || !url.includes('res.cloudinary.com')) return url;
        return url.replace('/upload/', `/upload/w_${width},c_limit,q_auto,f_auto/`);
    };
    next();
});

// Protect admin-only paths
const ADMIN_ONLY_PREFIXES = [
    '/admin', '/settings', '/swap-tool', '/process-swap', '/get-options',
    '/schedule-history', '/archive-schedule-changes', '/staff-lookup',
    '/faculty-summer', '/upload-staff-week', '/clear-staff-week',
    '/counselor-view', '/promotions',
    '/promote-waitlist', '/force-promote-waitlist', '/promote-all', '/remove-waitlist', '/upload-campers', '/upload-campers-schedule', '/upload-counselors',
    '/upload-bus-am', '/upload-bus-pm', '/upload-kp-lp',
    '/upload-staff', '/upload-staff-contacts', '/upload-instructors', '/upload-activity-rules', '/add-activity',
    '/swim-levels', '/upload-swim-levels', '/swim-scheduling',
    '/delete-activity', '/update-activity', '/add-activity-period-group',
    '/delete-activity-period-group', '/sync-activity-groups',
    '/counselor-scheduling', '/upload-weekly-offerings', '/clear-weekly-offerings', '/sync-offerings-from-schedule', '/api/sync-offerings',
    '/save-counselor-assignments', '/backup-counselor-assignments', '/counselor-schedule-backups', '/restore-counselor-backup', '/delete-counselor-backup',
    '/export-counselor-schedule', '/export-staff-schedule',
    '/export-master-schedule', '/save-counselor-group-assignments', '/auto-assign-homegroups', '/sync-homegroup-colors',
    '/hub-content', '/director-notes', '/director-notes/edit',
    '/set-active-week', '/set-released-week', '/set-prep-week', '/update-session-label',
    '/clear-counselor-week', '/counselor-week-assignments', '/api/week-staff-assignments', '/api/counselor-week-pinned-types', '/mirror-sports-location', '/clear-counselor-schedule', '/clear-counselor-homegroups',
    '/api/locked-offerings', '/api/toggle-lock',
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
    '/alerts', '/api/alerts',
    '/photo-gallery/all', '/photo-download',
    '/admin/building-coord', '/admin/delete-building-coord',
    '/camper-attendance',
    '/mass-edit-staff',
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
    CREATE TABLE IF NOT EXISTS CamperWeekData (
        CamperID      INTEGER NOT NULL,
        WeekNumber    INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        HomeGroupColor TEXT,
        CampLunch      TEXT    DEFAULT 'No',
        ExtendedHours  TEXT,
        BusRoute       TEXT,
        BusRidesAM     INTEGER DEFAULT 1,
        BusRidesPM     INTEGER DEFAULT 1,
        BusStopAM      TEXT,
        BusStopPM      TEXT,
        ScheduleType   TEXT,
        PRIMARY KEY (CamperID, WeekNumber),
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID) ON DELETE CASCADE
    );
`);

// Building coordinate store for the interactive camp map.
db.exec(`CREATE TABLE IF NOT EXISTS BuildingCoordinates (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT    NOT NULL UNIQUE,
    x    INTEGER NOT NULL,
    y    INTEGER NOT NULL
)`);
// Migration: add map column to BuildingCoordinates and change unique key to (name, map)
try {
    const bldgCols = db.prepare("PRAGMA table_info(BuildingCoordinates)").all();
    if (!bldgCols.some(c => c.name === 'map')) {
        db.exec(`
            ALTER TABLE BuildingCoordinates RENAME TO BuildingCoordinates_old;
            CREATE TABLE BuildingCoordinates (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT    NOT NULL,
                map  TEXT    NOT NULL DEFAULT 'enrichment',
                x    INTEGER NOT NULL,
                y    INTEGER NOT NULL,
                UNIQUE(name, map)
            );
            INSERT INTO BuildingCoordinates (id, name, map, x, y)
                SELECT id, name, 'enrichment', x, y FROM BuildingCoordinates_old;
            DROP TABLE BuildingCoordinates_old;
        `);
    }
} catch(e) { console.error('[migration] BuildingCoordinates.map:', e.message); }
// Seed building coordinates for both maps (upserts so deploys always apply corrected coords).
const _seedBuildings = db.prepare('INSERT INTO BuildingCoordinates (name, map, x, y) VALUES (?, ?, ?, ?) ON CONFLICT(name, map) DO UPDATE SET x=excluded.x, y=excluded.y');
for (const [name, map, x, y] of [
    ['Dana',                  'enrichment',  193,  919],
    ['Art',                   'enrichment',  272,  618],
    ['Ceramics',              'enrichment',  222,  526],
    ['Foundations',           'enrichment',  134,  534],
    ['Library',               'enrichment',  478,  480],
    ['Commons',               'enrichment',  272,   58],
    ['Auerbach',              'enrichment',  427, 1253],
    ['Hillyer',               'enrichment',  452, 1115],
    ['Archery Range',         'sports',      352,   33],
    ['Lot N',                 'sports',      524,   54],
    ['Track & Field Complex', 'sports',      289,  226],
    ['Baseball Field',        'sports',      545,  200],
    ['Al-Marzook',            'sports',      310,  501],
    ['Softball Field',        'sports',      511,  447],
    ['Gym',                   'sports',      297,  760],
    ['Pool',                  'sports',      310,  881],
    ['Commons',               'sports',      268, 1194],
    ['Hawk Hall',             'sports',      373, 1269],
    ['C Complex',             'sports',       62, 1015],
]) _seedBuildings.run(name, map, x, y);

// Spartan Games — annual counselor signup event
db.exec(`CREATE TABLE IF NOT EXISTS SpartanEvents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    date              TEXT    NOT NULL,
    block             TEXT    NOT NULL,
    participant_count INTEGER NOT NULL DEFAULT 1
)`);
db.exec(`CREATE TABLE IF NOT EXISTS SpartanSignups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL REFERENCES SpartanEvents(id) ON DELETE CASCADE,
    participants TEXT    NOT NULL
)`);
try { db.prepare('SELECT subtext FROM SpartanEvents LIMIT 1').get(); } catch {
    db.exec('ALTER TABLE SpartanEvents ADD COLUMN subtext TEXT');
}
try { db.prepare('SELECT enforce_gender_ratio FROM SpartanEvents LIMIT 1').get(); } catch {
    db.exec('ALTER TABLE SpartanEvents ADD COLUMN enforce_gender_ratio INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE SpartanEvents ADD COLUMN min_male INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE SpartanEvents ADD COLUMN min_female INTEGER NOT NULL DEFAULT 0');
}
db.exec(`CREATE TABLE IF NOT EXISTS SpartanGamesMeta (
    id               INTEGER PRIMARY KEY CHECK(id = 1),
    submissions_open INTEGER NOT NULL DEFAULT 1
)`);
if (!db.prepare('SELECT id FROM SpartanGamesMeta WHERE id=1').get()) {
    db.prepare('INSERT INTO SpartanGamesMeta (id, submissions_open) VALUES (1, 1)').run();
}
db.exec(`CREATE TABLE IF NOT EXISTS TalentSubmissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    counselor_id   INTEGER,
    counselor_name TEXT NOT NULL,
    description    TEXT NOT NULL,
    week_number    INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    submitted_at   TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS TalentMeta (
    id               INTEGER PRIMARY KEY CHECK(id = 1),
    submissions_open INTEGER NOT NULL DEFAULT 0
)`);
if (!db.prepare('SELECT id FROM TalentMeta WHERE id=1').get()) {
    db.prepare('INSERT INTO TalentMeta (id, submissions_open) VALUES (1, 0)').run();
}
if (db.prepare('SELECT COUNT(*) AS c FROM SpartanEvents').get().c === 0) {
    const _seedEvt = db.prepare('INSERT INTO SpartanEvents (name, date, block, participant_count) VALUES (?, ?, ?, ?)');
    for (const [name, date, block, cnt] of [
        ['Tug of War',              '7/23', 'Lunch',      3],
        ['Human Wheel Barrel',      '7/23', 'Lunch',      2],
        ['Hula Hoop',               '7/23', 'Dismissal',  1],
        ['Knock Out',               '7/24', 'Big Game',   1],
        ['1 Minute Pushups',        '7/24', 'Dismissal',  1],
        ['Dizzy Bat',               '7/29', 'Lunch',      1],
        ['Water Buckets Challenge', '7/29', 'Lunch',      2],
        ['100m Dash',               '7/29', 'Big Game',   1],
        ['Golf Cart Push',          '7/23', 'Pop Break',  2],
        ['T-Shirt Challenge',       '7/29', 'Dismissal',  1],
        ['History Geek',            '7/31', 'Lunch',      1],
        ['2 Week Step Challenge',   '7/31', 'Dismissal',  1],
    ]) _seedEvt.run(name, date, block, cnt);
}

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

// Migration: scope Waitlists to the week they were created in, so entries from a
// finished week stop appearing once the active week rolls over. Existing rows
// (created before this column existed) are backfilled to the current active week
// rather than left unscoped, since they represent real unresolved waitlist requests.
try {
    const wlCols = db.prepare("PRAGMA table_info(Waitlists)").all().map(c => c.name);
    if (!wlCols.includes('WeekNumber')) {
        db.exec("ALTER TABLE Waitlists ADD COLUMN WeekNumber INTEGER");
        const curWeek = db.prepare("SELECT weekNumber FROM Sessions WHERE isActive=1 LIMIT 1").get()?.weekNumber ?? 1;
        db.prepare("UPDATE Waitlists SET WeekNumber = ? WHERE WeekNumber IS NULL").run(curWeek);
    }
} catch(e) { console.error('[migration] Waitlists.WeekNumber:', e.message); }

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

// Migration: raw ACR-005 "Sessions" codes (e.g. "SP01/SP02/SP03"), used to compute
// shirt order quantity and detect campers who already received shirts in a prior week.
try {
    const campSessCols = db.prepare("PRAGMA table_info(Campers)").all().map(c => c.name);
    if (!campSessCols.includes('SessionCodes')) db.exec("ALTER TABLE Campers ADD COLUMN SessionCodes TEXT");
} catch(e) { console.error('[migration] Campers.SessionCodes:', e.message); }

try {
    const counsCols = db.prepare("PRAGMA table_info(Counselors)").all().map(c => c.name);
    if (!counsCols.includes('StaffRole')) db.exec("ALTER TABLE Counselors ADD COLUMN StaffRole TEXT DEFAULT 'Counselor'");
} catch(e) { console.error('[migration] Counselors.StaffRole:', e.message); }

try {
    const camperBusCols = db.prepare("PRAGMA table_info(Campers)").all().map(c => c.name);
    if (!camperBusCols.includes('BusRidesAM')) db.exec("ALTER TABLE Campers ADD COLUMN BusRidesAM INTEGER DEFAULT 1");
    if (!camperBusCols.includes('BusRidesPM')) db.exec("ALTER TABLE Campers ADD COLUMN BusRidesPM INTEGER DEFAULT 1");
    // Raw ACR-005 AM/PM bus stop text, kept for the manual bus-route audit (West Hartford 2/5,
    // Wolcott Park / Bishops Corner 3/4) where the stop name alone can't pin the route number.
    if (!camperBusCols.includes('BusStopAM')) db.exec("ALTER TABLE Campers ADD COLUMN BusStopAM TEXT");
    if (!camperBusCols.includes('BusStopPM')) db.exec("ALTER TABLE Campers ADD COLUMN BusStopPM TEXT");
} catch(e) { console.error('[migration] Campers.BusRidesAM/PM/Stops:', e.message); }

try {
    const camperNameCols = db.prepare("PRAGMA table_info(Campers)").all().map(c => c.name);
    if (!camperNameCols.includes('PreferredName')) db.exec("ALTER TABLE Campers ADD COLUMN PreferredName TEXT");
} catch(e) { console.error('[migration] Campers.PreferredName:', e.message); }

try {
    const cwaCols = db.prepare("PRAGMA table_info(CounselorWeekAttributes)").all().map(c => c.name);
    if (!cwaCols.includes('SpecialtyGroup')) db.exec("ALTER TABLE CounselorWeekAttributes ADD COLUMN SpecialtyGroup TEXT");
} catch(e) { console.error('[migration] CounselorWeekAttributes.SpecialtyGroup:', e.message); }

try {
    const cCols = db.prepare("PRAGMA table_info(Counselors)").all().map(c => c.name);
    if (!cCols.includes('Phone')) db.exec("ALTER TABLE Counselors ADD COLUMN Phone TEXT");
    if (!cCols.includes('Email')) db.exec("ALTER TABLE Counselors ADD COLUMN Email TEXT");
    if (!cCols.includes('IncludeInStaffDropdown')) db.exec("ALTER TABLE Counselors ADD COLUMN IncludeInStaffDropdown INTEGER DEFAULT 0");
    if (!cCols.includes('Gender')) db.exec("ALTER TABLE Counselors ADD COLUMN Gender TEXT CHECK(Gender IN ('M','F') OR Gender IS NULL)");
} catch(e) { console.error('[migration] Counselors.Phone/Email/IncludeInStaffDropdown/Gender:', e.message); }

// Migration: highest swim-lesson level a counselor is certified to teach (NULL = levels 1-3 only, the default floor)
try {
    const cCols = db.prepare("PRAGMA table_info(Counselors)").all().map(c => c.name);
    if (!cCols.includes('SwimMaxLevel')) db.exec("ALTER TABLE Counselors ADD COLUMN SwimMaxLevel INTEGER CHECK(SwimMaxLevel BETWEEN 1 AND 6 OR SwimMaxLevel IS NULL)");
} catch(e) { console.error('[migration] Counselors.SwimMaxLevel:', e.message); }

// Camper swim level, snapshotted per week. A missing WeekNumber row means "unchanged since
// their last recorded level" — getEffectiveSwimLevel() below walks backward to find it.
db.exec(`CREATE TABLE IF NOT EXISTS CamperSwimLevels (
    CamperID    INTEGER NOT NULL,
    WeekNumber  INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
    LevelNumber INTEGER NOT NULL CHECK(LevelNumber BETWEEN 1 AND 6),
    SubLevel    TEXT CHECK(SubLevel IN ('Low','High') OR SubLevel IS NULL),
    UpdatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (CamperID, WeekNumber),
    FOREIGN KEY (CamperID) REFERENCES Campers(CamperID) ON DELETE CASCADE
)`);

// A camper's swim level as of a given week: their own WeekNumber row if tested that week,
// otherwise the most recent earlier week's level (levels persist until retested).
function getEffectiveSwimLevel(camperId, weekNumber) {
    return db.prepare(`
        SELECT LevelNumber, SubLevel, WeekNumber
        FROM CamperSwimLevels
        WHERE CamperID = ? AND WeekNumber <= ?
        ORDER BY WeekNumber DESC
        LIMIT 1
    `).get(camperId, weekNumber) || null;
}

// Formats a level for display: "Low 2", "2", "High 2".
function formatSwimLevel(row) {
    if (!row) return null;
    return row.SubLevel ? `${row.SubLevel} ${row.LevelNumber}` : String(row.LevelNumber);
}

// Parses a swim level export value ("2", "Low 2", "High 3") into {levelNumber, subLevel}. Null if blank/unrecognized.
function parseSwimLevelValue(raw) {
    const m = /^(Low|High)?\s*([1-6])$/i.exec((raw || '').trim());
    if (!m) return null;
    return {
        levelNumber: parseInt(m[2], 10),
        subLevel: m[1] ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : null
    };
}

// Swim staffing tables — independent of CounselorWeekSchedules/WeeklyOfferings by design
// (see wiki/Swim-Scheduling.md). One SwimLessonGroups row per skill-level lesson group per
// period per week; SwimGuardAssignments covers Rec Swim lifeguards and the always-2
// Swim Lessons pool guards, which are separate from the per-group instructors.
db.exec(`
    CREATE TABLE IF NOT EXISTS SwimLessonGroups (
        GroupID      INTEGER PRIMARY KEY AUTOINCREMENT,
        WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
        LevelNumber  INTEGER NOT NULL CHECK(LevelNumber BETWEEN 1 AND 6),
        SubLevel     TEXT CHECK(SubLevel IN ('Low','High') OR SubLevel IS NULL),
        CounselorID  INTEGER,
        Locked       INTEGER DEFAULT 0,
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS SwimLessonGroupMembers (
        GroupID  INTEGER NOT NULL,
        CamperID INTEGER NOT NULL,
        PRIMARY KEY (GroupID, CamperID),
        FOREIGN KEY (GroupID) REFERENCES SwimLessonGroups(GroupID) ON DELETE CASCADE,
        FOREIGN KEY (CamperID) REFERENCES Campers(CamperID) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS SwimGuardAssignments (
        WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
        PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
        GuardRole    TEXT NOT NULL CHECK(GuardRole IN ('Rec','Lessons')),
        CounselorID  INTEGER NOT NULL,
        PRIMARY KEY (WeekNumber, PeriodNumber, GuardRole, CounselorID),
        FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
    );
`);

// Migration: lets two adjacent-level groups be merged to share one instructor. NULL means
// a normal single-level group; when set, the group spans LevelNumber..LevelRangeMax.
try {
    const slgCols = db.prepare("PRAGMA table_info(SwimLessonGroups)").all().map(c => c.name);
    if (!slgCols.includes('LevelRangeMax')) {
        db.exec("ALTER TABLE SwimLessonGroups ADD COLUMN LevelRangeMax INTEGER CHECK(LevelRangeMax BETWEEN 1 AND 6 OR LevelRangeMax IS NULL)");
    }
} catch(e) { console.error('[migration] SwimLessonGroups.LevelRangeMax:', e.message); }

// Required Rec Swim lifeguard count from enrollment (same in AM and PM).
function requiredRecGuards(enrolledCount) {
    if (enrolledCount > 15) return 3;
    if (enrolledCount >= 10) return 2;
    return 1;
}

// Splits a list into chunks no larger than maxSize, as evenly sized as possible
// (e.g. 11 campers at maxSize 6 -> [6,5], not [6,6,-1] or a lopsided [6,4,1]).
function chunkCampers(list, maxSize) {
    if (list.length === 0) return [];
    const numGroups = Math.ceil(list.length / maxSize);
    const perGroup = Math.ceil(list.length / numGroups);
    const chunks = [];
    for (let i = 0; i < list.length; i += perGroup) chunks.push(list.slice(i, i + perGroup));
    return chunks;
}

// Auto-forms skill-level lesson groups for every period offering Swim Lessons this week.
// Per period: campers are bucketed by effective swim level, then by sub-level within
// that level — a sub-level becomes its own pool only with >=3 campers, otherwise it's
// merged into one mixed pool for the level. Newly-tested campers (a CamperSwimLevels row
// written this week) are chunked separately at a smaller size (2-4) so they seed their
// own small groups instead of topping off an existing class. Existing Locked groups (and
// their campers) are left untouched; all other unlocked groups for the period are
// replaced. Campers with no recorded level are left ungrouped (shown separately in the UI
// as needing testing). Returns the number of groups created.
function generateGroupsForWeek(week) {
    const delUnlocked = db.prepare('DELETE FROM SwimLessonGroups WHERE WeekNumber = ? AND PeriodNumber = ? AND Locked = 0');
    const insGroup = db.prepare('INSERT INTO SwimLessonGroups (WeekNumber, PeriodNumber, LevelNumber, SubLevel) VALUES (?, ?, ?, ?)');
    const insMember = db.prepare('INSERT INTO SwimLessonGroupMembers (GroupID, CamperID) VALUES (?, ?)');

    let groupsCreated = 0;
    db.transaction(() => {
        for (let period = 1; period <= 6; period++) {
            const offered = db.prepare(
                "SELECT 1 FROM WeeklyOfferings WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = 'Swim Lessons'"
            ).get(week, period);
            if (!offered) continue;

            const lockedCamperIds = new Set(db.prepare(`
                SELECT m.CamperID FROM SwimLessonGroups g
                JOIN SwimLessonGroupMembers m ON m.GroupID = g.GroupID
                WHERE g.WeekNumber = ? AND g.PeriodNumber = ? AND g.Locked = 1
            `).all(week, period).map(r => r.CamperID));

            delUnlocked.run(week, period);

            const enrolled = db.prepare(`
                SELECT DISTINCT c.CamperID, c.FirstName, c.LastName
                FROM Campers c
                JOIN Schedules s ON s.PersonID = c.CamperID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
                WHERE s.PeriodNumber = ? AND s.ActivityName = 'Swim Lessons'
            `).all(week, period);

            // levelNumber -> subKey ('Low'|'High'|'none') -> [{CamperID,isNew}]
            const byLevel = {};
            for (const c of enrolled) {
                if (lockedCamperIds.has(c.CamperID)) continue;
                const eff = getEffectiveSwimLevel(c.CamperID, week);
                if (!eff) continue; // not yet tested — stays ungrouped
                const subKey = eff.SubLevel || 'none';
                (byLevel[eff.LevelNumber] ??= {})[subKey] ??= [];
                byLevel[eff.LevelNumber][subKey].push({ CamperID: c.CamperID, isNew: eff.WeekNumber === week });
            }

            for (const lvlStr of Object.keys(byLevel)) {
                const levelNumber = parseInt(lvlStr, 10);
                const subGroups = byLevel[lvlStr];

                const mixed = [];
                const pools = []; // {subLevel, campers}
                for (const subKey of Object.keys(subGroups)) {
                    const campers = subGroups[subKey];
                    if (campers.length >= 3) pools.push({ subLevel: subKey === 'none' ? null : subKey, campers });
                    else mixed.push(...campers);
                }
                if (mixed.length > 0) pools.push({ subLevel: null, campers: mixed });

                for (const pool of pools) {
                    const newly = pool.campers.filter(c => c.isNew);
                    const returning = pool.campers.filter(c => !c.isNew);
                    const chunks = [...chunkCampers(newly, 4), ...chunkCampers(returning, 6)];
                    for (const chunk of chunks) {
                        if (chunk.length === 0) continue;
                        const info = insGroup.run(week, period, levelNumber, pool.subLevel);
                        for (const camper of chunk) insMember.run(info.lastInsertRowid, camper.CamperID);
                        groupsCreated++;
                    }
                }
            }
        }
    })();

    return groupsCreated;
}

// CounselorID -> {inWater, outWater} for the given week: all guard duty counts as
// in-water; teaching a level 1-3 group counts as in-water (required), 4-6 as out-of-water.
function getCounselorWaterTally(week) {
    const tally = {};
    const bump = (id, inWater) => {
        tally[id] ??= { inWater: 0, outWater: 0 };
        tally[id][inWater ? 'inWater' : 'outWater']++;
    };
    db.prepare('SELECT CounselorID FROM SwimGuardAssignments WHERE WeekNumber = ?')
        .all(week).forEach(r => bump(r.CounselorID, true));
    db.prepare('SELECT CounselorID, LevelNumber FROM SwimLessonGroups WHERE WeekNumber = ? AND CounselorID IS NOT NULL')
        .all(week).forEach(r => bump(r.CounselorID, r.LevelNumber <= 3));
    return tally;
}

// Historical AM (period 1-3) in-water tally for weeks strictly before `week` — Phase 4's
// auto-assign uses this to bias early-morning water duty toward whoever has done the least
// of it so far this summer, before within-week balancing kicks in as a tie-break.
function getAmFairnessTally(week) {
    const tally = {};
    const bump = id => { tally[id] = (tally[id] || 0) + 1; };
    db.prepare('SELECT CounselorID FROM SwimGuardAssignments WHERE WeekNumber < ? AND PeriodNumber <= 3')
        .all(week).forEach(r => bump(r.CounselorID));
    db.prepare('SELECT CounselorID FROM SwimLessonGroups WHERE WeekNumber < ? AND PeriodNumber <= 3 AND CounselorID IS NOT NULL AND LevelNumber <= 3')
        .all(week).forEach(r => bump(r.CounselorID));
    return tally;
}

// Fills every open guard slot and un-instructored lesson group for the week. Never removes
// or changes anything already set — Locked groups, groups that already have a CounselorID,
// and existing SwimGuardAssignments rows are left as-is; this only fills the gaps. Greedy,
// period-by-period, in this order per period: Rec guards, Lessons guards, then lesson
// groups low level to high:
//   - Eligibility: a lesson group needs COALESCE(SwimMaxLevel,3) >= its effective max level;
//     anyone on the swim staff can guard.
//   - No counselor is used twice in the same period (guard duty and teaching are mutually
//     exclusive within a period).
//   - In-water slots (guarding, or a level 1-3 group) prefer, in AM periods (1-3), whoever
//     has the least cumulative AM in-water duty across prior weeks this summer; in PM
//     periods (4-6) they prefer whoever has the fewest in-water assignments so far *this*
//     week, targeting ~2 in-water PM slots per counselor.
//   - Out-of-water slots (level 4-6 groups) prefer whoever has the fewest out-of-water
//     assignments so far this week, targeting ~1 per counselor.
// Returns {filled, unfilled} slot counts for the summary message.
function autoAssignWeek(week) {
    const periods = getSwimSchedulingData(week);
    const swimCounselors = db.prepare(
        "SELECT CounselorID, SwimMaxLevel FROM Counselors WHERE StaffRole = 'Swim Counselor'"
    ).all();
    const allIds = swimCounselors.map(c => c.CounselorID);

    const amHistTally = getAmFairnessTally(week);
    const runningTally = getCounselorWaterTally(week); // id -> {inWater, outWater}, updated live as we assign
    const bumpRunning = (id, inWater) => {
        runningTally[id] ??= { inWater: 0, outWater: 0 };
        runningTally[id][inWater ? 'inWater' : 'outWater']++;
    };
    const scoreInWater = (id, period) =>
        (period <= 3 ? (amHistTally[id] || 0) * 100 : 0) + (runningTally[id]?.inWater || 0);
    const scoreOutWater = id => runningTally[id]?.outWater || 0;

    // Best-scoring eligible counselor not already used this period, or null if none qualify.
    const pick = (usedThisPeriod, eligibleIds, scoreFn) => {
        let best = null, bestScore = Infinity;
        for (const id of eligibleIds) {
            if (usedThisPeriod.has(id)) continue;
            const s = scoreFn(id);
            if (s < bestScore) { bestScore = s; best = id; }
        }
        return best;
    };

    const insGuard = db.prepare('INSERT INTO SwimGuardAssignments (WeekNumber, PeriodNumber, GuardRole, CounselorID) VALUES (?, ?, ?, ?)');
    const updGroup = db.prepare('UPDATE SwimLessonGroups SET CounselorID = ? WHERE GroupID = ?');

    let filled = 0, unfilled = 0;

    db.transaction(() => {
        for (const p of periods) {
            const usedThisPeriod = new Set();
            if (p.rec) p.rec.guards.forEach(g => usedThisPeriod.add(g.CounselorID));
            if (p.lessons) {
                p.lessons.guards.forEach(g => usedThisPeriod.add(g.CounselorID));
                p.lessons.groups.forEach(g => { if (g.CounselorID) usedThisPeriod.add(g.CounselorID); });
            }

            if (p.rec) {
                const need = p.rec.requiredGuards - p.rec.guards.length;
                for (let i = 0; i < need; i++) {
                    const id = pick(usedThisPeriod, allIds, cid => scoreInWater(cid, p.period));
                    if (id == null) { unfilled++; continue; }
                    insGuard.run(week, p.period, 'Rec', id);
                    usedThisPeriod.add(id);
                    bumpRunning(id, true);
                    filled++;
                }
            }

            if (p.lessons) {
                const guardNeed = p.lessons.requiredGuards - p.lessons.guards.length;
                for (let i = 0; i < guardNeed; i++) {
                    const id = pick(usedThisPeriod, allIds, cid => scoreInWater(cid, p.period));
                    if (id == null) { unfilled++; continue; }
                    insGuard.run(week, p.period, 'Lessons', id);
                    usedThisPeriod.add(id);
                    bumpRunning(id, true);
                    filled++;
                }

                const openGroups = p.lessons.groups
                    .filter(g => !g.Locked && !g.CounselorID)
                    .slice()
                    .sort((a, b) => a.effectiveMaxLevel - b.effectiveMaxLevel);

                for (const g of openGroups) {
                    const inWater = g.effectiveMaxLevel <= 3;
                    const eligible = swimCounselors
                        .filter(c => (c.SwimMaxLevel ?? 3) >= g.effectiveMaxLevel)
                        .map(c => c.CounselorID);
                    const id = pick(usedThisPeriod, eligible, cid => inWater ? scoreInWater(cid, p.period) : scoreOutWater(cid));
                    if (id == null) { unfilled++; continue; }
                    updGroup.run(id, g.GroupID);
                    usedThisPeriod.add(id);
                    bumpRunning(id, inWater);
                    filled++;
                }
            }
        }
    })();

    return { filled, unfilled };
}

// Migration: track schedule types set by hand so auto-build never overwrites them
try {
    const cwaCols = db.prepare("PRAGMA table_info(CounselorWeekAttributes)").all().map(c => c.name);
    if (!cwaCols.includes('ScheduleTypeManual')) db.exec("ALTER TABLE CounselorWeekAttributes ADD COLUMN ScheduleTypeManual INTEGER DEFAULT 0");
} catch(e) { console.error('[migration] CounselorWeekAttributes.ScheduleTypeManual:', e.message); }

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

// Migration: add isPrepTarget column to Sessions
try {
    const sessionCols = db.prepare("PRAGMA table_info(Sessions)").all().map(c => c.name);
    if (!sessionCols.includes('isPrepTarget')) {
        db.exec("ALTER TABLE Sessions ADD COLUMN isPrepTarget INTEGER DEFAULT 0");
    }
} catch(e) { console.error('[migration] isPrepTarget:', e.message); }

// Migration: add isWorkingThisWeek column to CounselorWeekAttributes
try {
    const cwaCols = db.prepare("PRAGMA table_info(CounselorWeekAttributes)").all().map(c => c.name);
    if (!cwaCols.includes('isWorkingThisWeek')) {
        db.exec("ALTER TABLE CounselorWeekAttributes ADD COLUMN isWorkingThisWeek INTEGER DEFAULT 1");
    }
} catch(e) { console.error('[migration] isWorkingThisWeek:', e.message); }

// Migration: create LockedOfferings table for server-side lock persistence
db.exec(`CREATE TABLE IF NOT EXISTS LockedOfferings (
    WeekNumber  INTEGER NOT NULL,
    PeriodNumber INTEGER NOT NULL,
    ActivityName TEXT NOT NULL,
    PRIMARY KEY (WeekNumber, PeriodNumber, ActivityName)
)`);

// Migration: add WeekNumber to Schedules (used for camper rows to scope per-week)
try {
    db.prepare("SELECT WeekNumber FROM Schedules LIMIT 1").get();
} catch {
    db.exec("ALTER TABLE Schedules ADD COLUMN WeekNumber INTEGER");
}

// Migration: per-week camper schedule type ('Full Day' / 'Half Day') for KP/LP campers.
// Imported from the ACR-003 Group Attendance Sheet with KP/LP.
try {
    const cwdCols = db.prepare("PRAGMA table_info(CamperWeekData)").all().map(c => c.name);
    if (!cwdCols.includes('ScheduleType')) {
        db.exec("ALTER TABLE CamperWeekData ADD COLUMN ScheduleType TEXT");
    }
} catch(e) { console.error('[migration] CamperWeekData.ScheduleType:', e.message); }

// One-time backfill: copy Campers attributes into CamperWeekData for the active week.
// Only runs when there is no CamperWeekData for that week yet, so server restarts never
// re-pollute a week with campers who were uploaded for a different week.
try {
    const _aw = db.prepare("SELECT weekNumber FROM Sessions WHERE isActive=1 LIMIT 1").get()?.weekNumber ?? 1;
    const _hasWeekData = db.prepare('SELECT 1 FROM CamperWeekData WHERE WeekNumber=? LIMIT 1').get(_aw);
    if (!_hasWeekData) {
        db.prepare(`
            INSERT OR IGNORE INTO CamperWeekData
                (CamperID, WeekNumber, HomeGroupColor, CampLunch, ExtendedHours,
                 BusRoute, BusRidesAM, BusRidesPM, BusStopAM, BusStopPM)
            SELECT CamperID, ?, HomeGroupColor, CampLunch, ExtendedHours,
                   BusRoute, COALESCE(BusRidesAM,1), COALESCE(BusRidesPM,1), BusStopAM, BusStopPM
            FROM Campers
        `).run(_aw);
        db.prepare("UPDATE Schedules SET WeekNumber = ? WHERE PersonType = 'Camper' AND WeekNumber IS NULL").run(_aw);
    }
} catch(e) { console.error('[migration] CamperWeekData backfill:', e.message); }

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
            SELECT chg.CounselorID, cwd.HomeGroupColor, COUNT(*) as cnt
            FROM CamperHomeGroups chg
            JOIN CamperWeekData cwd ON cwd.CamperID = chg.CamperID AND cwd.WeekNumber = chg.WeekNumber
            WHERE chg.WeekNumber = ? AND cwd.HomeGroupColor IN ('Red','Carolina','Green','Navy')
            GROUP BY chg.CounselorID, cwd.HomeGroupColor
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

// Persistent app config (VAPID keys, etc.)
db.exec(`CREATE TABLE IF NOT EXISTS AppConfig (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`);

// Push notification subscriptions
db.exec(`CREATE TABLE IF NOT EXISTS PushSubscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    CounselorID INTEGER NOT NULL,
    endpoint    TEXT    NOT NULL UNIQUE,
    subscription TEXT   NOT NULL,
    CreatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS AlertGroups (
    GroupID   INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    isSystem  INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS AlertGroupMembers (
    GroupID     INTEGER NOT NULL REFERENCES AlertGroups(GroupID) ON DELETE CASCADE,
    CounselorID INTEGER NOT NULL REFERENCES Counselors(CounselorID) ON DELETE CASCADE,
    PRIMARY KEY (GroupID, CounselorID)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS AlertLog (
    AlertID          INTEGER PRIMARY KEY AUTOINCREMENT,
    message          TEXT NOT NULL,
    targetLabel      TEXT NOT NULL,
    sentBy           TEXT,
    sentAt           DATETIME DEFAULT CURRENT_TIMESTAMP,
    deliveryCount    INTEGER DEFAULT 0,
    showAdminBanner  INTEGER DEFAULT 0
)`);
try {
    const alCols = db.prepare("PRAGMA table_info(AlertLog)").all().map(c => c.name);
    if (!alCols.includes('showAdminBanner')) db.exec("ALTER TABLE AlertLog ADD COLUMN showAdminBanner INTEGER DEFAULT 0");
} catch(e) { console.error('[migration] AlertLog.showAdminBanner:', e.message); }
db.exec(`CREATE TABLE IF NOT EXISTS AlertTargets (
    AlertID     INTEGER NOT NULL REFERENCES AlertLog(AlertID) ON DELETE CASCADE,
    CounselorID INTEGER NOT NULL,
    PRIMARY KEY (AlertID, CounselorID)
)`);
const SYSTEM_ALERT_GROUPS = [
    'All Staff', 'All Counselors', 'All Unit Leaders', 'All Admin',
    'All AM Sports', 'All PM Sports', 'All AM Enrichment', 'All PM Enrichment',
];
const seedGroup = db.prepare("INSERT OR IGNORE INTO AlertGroups (name, isSystem) VALUES (?, 1)");
for (const name of SYSTEM_ALERT_GROUPS) seedGroup.run(name);

// Load or generate VAPID keys (stored in DB so they survive redeploys)
let vapidPublicKey  = db.prepare("SELECT value FROM AppConfig WHERE key='vapidPublicKey'").get()?.value;
let vapidPrivateKey = db.prepare("SELECT value FROM AppConfig WHERE key='vapidPrivateKey'").get()?.value;
if (!vapidPublicKey || !vapidPrivateKey) {
    const keys = webPush.generateVAPIDKeys();
    vapidPublicKey  = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
    db.prepare("INSERT OR REPLACE INTO AppConfig (key,value) VALUES ('vapidPublicKey',?)").run(vapidPublicKey);
    db.prepare("INSERT OR REPLACE INTO AppConfig (key,value) VALUES ('vapidPrivateKey',?)").run(vapidPrivateKey);
    console.log('[vapid] Generated new VAPID keys');
}
webPush.setVapidDetails('mailto:benjamin.dobbs@gmail.com', vapidPublicKey, vapidPrivateKey);

// --- WEEK HELPERS ---
function getActiveWeek() {
    return db.prepare("SELECT weekNumber FROM Sessions WHERE isActive=1 LIMIT 1").get()?.weekNumber ?? 1;
}
function getPrepTargetWeek() {
    return db.prepare("SELECT weekNumber FROM Sessions WHERE isPrepTarget=1 LIMIT 1").get()?.weekNumber ?? null;
}
function getReleasedWeek() {
    return db.prepare("SELECT * FROM Sessions WHERE isReleased=1 LIMIT 1").get() ?? null;
}

// Resolves a class's location the same way the Master Schedule does: prefer the
// week-scoped StaffWeekSchedules row (any staff), fall back to the legacy Schedules
// Instructor row (week-agnostic, so only valid when weekNumber is the active week),
// then the Activities table's default location.
function resolveClassLocation(periodNumber, activityName, weekNumber) {
    const weekRow = db.prepare(`
        SELECT Location FROM StaffWeekSchedules
        WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
          AND Location IS NOT NULL AND Location != ''
        LIMIT 1
    `).get(weekNumber, periodNumber, activityName);
    if (weekRow) return weekRow.Location;
    if (weekNumber === getActiveWeek()) {
        const legacyRow = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `).get(periodNumber, activityName);
        if (legacyRow) return legacyRow.Location;
    }
    const actRow = db.prepare("SELECT Location FROM Activities WHERE Name = ? COLLATE NOCASE").get(activityName);
    return actRow?.Location || null;
}

// Returns campers for a counselor, preferring week-keyed CamperHomeGroups over legacy HomeGroupCounselorID.
// CamperWeekData is LEFT JOINed so week-specific fields (bus, extended hours) come from the week row
// rather than the base Campers table, which may have stale or missing values from earlier imports.
function getWeekCampersForCounselor(counselorId, weekNumber) {
    const hasWeekData = db.prepare(
        "SELECT 1 FROM CamperHomeGroups WHERE WeekNumber=? LIMIT 1"
    ).get(weekNumber);
    if (hasWeekData) {
        return db.prepare(`
            SELECT c.*,
                   COALESCE(cwd.BusRoute,    c.BusRoute)          AS BusRoute,
                   COALESCE(cwd.BusRidesAM,  c.BusRidesAM,  1)   AS BusRidesAM,
                   COALESCE(cwd.BusRidesPM,  c.BusRidesPM,  1)   AS BusRidesPM,
                   COALESCE(cwd.ExtendedHours, c.ExtendedHours)   AS ExtendedHours
            FROM Campers c
            JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID
              AND chg.WeekNumber = ? AND chg.CounselorID = ?
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            ORDER BY c.LastName, c.FirstName
        `).all(weekNumber, counselorId, weekNumber);
    }
    return db.prepare(`
        SELECT c.*,
               COALESCE(cwd.BusRoute,    c.BusRoute)          AS BusRoute,
               COALESCE(cwd.BusRidesAM,  c.BusRidesAM,  1)   AS BusRidesAM,
               COALESCE(cwd.BusRidesPM,  c.BusRidesPM,  1)   AS BusRidesPM,
               COALESCE(cwd.ExtendedHours, c.ExtendedHours)   AS ExtendedHours
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.HomeGroupCounselorID = ?
        ORDER BY c.LastName, c.FirstName
    `).all(weekNumber, counselorId);
}

// --- ACTIVITY GROUP SYNC ---
function syncActivityGroups(weekNumber) {
    // Converts a Set of enrolled HomeGroupColors to an AllowedGroups value.
    // If both camps are present (Green/Navy + Red/Carolina) the period is open to all → null.
    function colorsToGroup(colorSet) {
        const hasGN = colorSet.has('Green') || colorSet.has('Navy');
        const hasRC = colorSet.has('Red')   || colorSet.has('Carolina');
        if (hasGN && hasRC) return null;
        if (hasGN) return 'Green-Navy';
        if (hasRC) {
            if (colorSet.has('Red') && colorSet.has('Carolina')) return 'Red-Carolina';
            return colorSet.has('Red') ? 'Red' : 'Carolina';
        }
        return null;
    }

    // All (activity, side, period) combinations for this week
    const classPeriods = db.prepare(`
        SELECT DISTINCT s.ActivityName, a.SideOfCamp, s.PeriodNumber
        FROM Schedules s
        JOIN Activities a ON a.Name = s.ActivityName
        WHERE s.PersonType = 'Camper' AND s.WeekNumber = ?
        ORDER BY s.ActivityName, s.PeriodNumber
    `).all(weekNumber);

    // Colors enrolled per individual (activity, period)
    const getActivityColors = db.prepare(`
        SELECT DISTINCT cwd.HomeGroupColor
        FROM Schedules s
        JOIN CamperWeekData cwd ON cwd.CamperID = s.PersonID AND cwd.WeekNumber = ?
        WHERE s.PersonType = 'Camper' AND s.ActivityName = ? AND s.PeriodNumber = ? AND s.WeekNumber = ?
          AND cwd.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
    `);

    // All colors per (side, period) across ALL activities — used to compute period universals
    const allSidePeriodColors = db.prepare(`
        SELECT DISTINCT a.SideOfCamp, s.PeriodNumber, cwd.HomeGroupColor
        FROM Schedules s
        JOIN Activities a ON a.Name = s.ActivityName
        JOIN CamperWeekData cwd ON cwd.CamperID = s.PersonID AND cwd.WeekNumber = ?
        WHERE s.PersonType = 'Camper' AND s.WeekNumber = ?
          AND cwd.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
          AND a.SideOfCamp IS NOT NULL
    `).all(weekNumber, weekNumber);

    // periodUniversal[`${side}|${period}`] = the AllowedGroups value that covers every
    // camper attending any activity on that side during that period.
    // If it's null, all four main-camp colors are present and no restriction is needed.
    const sidePeriodColorSets = {};
    for (const row of allSidePeriodColors) {
        const key = `${row.SideOfCamp}|${row.PeriodNumber}`;
        if (!sidePeriodColorSets[key]) sidePeriodColorSets[key] = new Set();
        sidePeriodColorSets[key].add(row.HomeGroupColor);
    }
    const periodUniversal = {};
    for (const [key, colorSet] of Object.entries(sidePeriodColorSets)) {
        periodUniversal[key] = colorsToGroup(colorSet);
    }

    // Build per-activity map: actName → { side, periods: { period → group } }
    const activityMap = {};
    for (const { ActivityName, SideOfCamp, PeriodNumber } of classPeriods) {
        const colorRows = getActivityColors.all(weekNumber, ActivityName, PeriodNumber, weekNumber);
        const colors = new Set(colorRows.map(r => r.HomeGroupColor));
        const group = colorsToGroup(colors);
        if (!activityMap[ActivityName]) activityMap[ActivityName] = { side: SideOfCamp, periods: {} };
        activityMap[ActivityName].periods[PeriodNumber] = group;
    }

    const updateActivity     = db.prepare("UPDATE Activities SET AllowedGroups = ? WHERE Name = ?");
    const deletePeriodGroups = db.prepare("DELETE FROM ActivityPeriodGroups WHERE ActivityName = ?");
    const upsertPeriodGroup  = db.prepare(`
        INSERT INTO ActivityPeriodGroups (ActivityName, PeriodNumber, AllowedGroups)
        VALUES (?, ?, ?)
        ON CONFLICT (ActivityName, PeriodNumber) DO UPDATE SET AllowedGroups = excluded.AllowedGroups
    `);

    let syncedCount = 0;
    db.transaction(() => {
        for (const [actName, { side, periods }] of Object.entries(activityMap)) {
            const nonNullGroups = Object.values(periods).filter(g => g !== null);
            const uniqueGroups  = new Set(nonNullGroups);

            deletePeriodGroups.run(actName);

            if (uniqueGroups.size === 0) {
                // No main-camp colors enrolled — clear any restriction
                updateActivity.run(null, actName);
            } else if (uniqueGroups.size === 1) {
                // Same group across all periods — decide whether the activity level captures it
                const commonGroup = [...uniqueGroups][0];
                // If the activity's group matches the period-side universal for every period it
                // runs in, no explicit restriction is needed (the scheduling already enforces it).
                const allMatchUniversal = Object.entries(periods).every(([period, group]) => {
                    if (group === null) return true; // period has no main-camp enrollment, skip
                    return commonGroup === periodUniversal[`${side}|${period}`];
                });
                updateActivity.run(allMatchUniversal ? null : commonGroup, actName);
            } else {
                // Periods produce different groups — write per-period exceptions only where
                // the activity deviates from the natural universal for that side+period.
                updateActivity.run(null, actName);
                for (const [period, group] of Object.entries(periods)) {
                    if (!group) continue;
                    if (group !== periodUniversal[`${side}|${period}`]) {
                        upsertPeriodGroup.run(actName, parseInt(period), group);
                    }
                }
            }
            syncedCount++;
        }
    })();

    return syncedCount;
}

// --- AUTO WEEK ROLLOVER ---
// Rolls the active week to the next one at 23:59 on the Saturday of the active session's start week.
function checkWeekRollover() {
    const activeSession = db.prepare("SELECT * FROM Sessions WHERE isActive=1 LIMIT 1").get();
    if (!activeSession || !activeSession.startDate) return;

    // Use noon UTC anchors so day-of-week is stable across DST transitions
    const [sy, sm, sd] = activeSession.startDate.split('-').map(Number);
    const startNoon = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
    const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    const dowName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(startNoon);
    const daysToSaturday = (6 - (DOW[dowName] ?? 0) + 7) % 7;

    // Compare dates as YYYYMMDD numbers built from formatToParts — never via
    // locale-formatted strings, whose ordering breaks if the runtime falls back
    // to M/D/YYYY (this caused mid-week rollovers, e.g. "7/9" > "7/10").
    const estDateNum = (d) => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(d);
        const get = t => parseInt(parts.find(p => p.type === t).value);
        return get('year') * 10000 + get('month') * 100 + get('day');
    };

    const saturdayNoon = new Date(Date.UTC(sy, sm - 1, sd + daysToSaturday, 12, 0, 0));
    const saturdayNum = estDateNum(saturdayNoon);
    const todayNum = estDateNum(new Date());

    // Roll over once it's past Saturday 23:59 Eastern
    const estMins = getESTMins();
    const pastCutoff = todayNum > saturdayNum ||
        (todayNum === saturdayNum && estMins >= 23 * 60 + 59);

    if (!pastCutoff) return;

    const nextSession = db.prepare("SELECT * FROM Sessions WHERE weekNumber=?").get(activeSession.weekNumber + 1);
    if (nextSession) {
        db.exec('UPDATE Sessions SET isActive = 0');
        db.prepare('UPDATE Sessions SET isActive = 1 WHERE weekNumber = ?').run(nextSession.weekNumber);
        db.prepare('UPDATE TalentMeta SET submissions_open=0 WHERE id=1').run();
        console.log(`[auto-rollover] Week ${activeSession.weekNumber} → Week ${nextSession.weekNumber}`);
        const synced = syncActivityGroups(nextSession.weekNumber);
        console.log(`[auto-rollover] Synced group assignments for ${synced} activities from Week ${nextSession.weekNumber}`);
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
    const cRow = cid ? db.prepare('SELECT FirstName, LastName, StaffRole FROM Counselors WHERE CounselorID = ?').get(cid) : null;
    const selectedCounselorName = cRow ? `${cRow.FirstName} ${cRow.LastName}` : null;
    const isHomeCounselor = ['Counselor', 'Swim Counselor'].includes(cRow?.StaffRole);
    // Unit Leaders and Sports Leaders run the sports side of camp — they have no
    // CounselorWeekSchedules rows, so without this they'd fall through to enrichment.
    let staffSide = ['Unit Leader', 'Sports Leader'].includes(cRow?.StaffRole) ? 'sports' : 'enrichment';
    if (cid) {
        const _staffAw = getActiveWeek();
        const _sideRow = db.prepare(`
            SELECT a.SideOfCamp
            FROM CounselorWeekSchedules cws
            JOIN Activities a ON a.Name = cws.ActivityName
            WHERE cws.CounselorID = ? AND cws.WeekNumber = ? AND a.SideOfCamp IS NOT NULL
            LIMIT 1
        `).get(cid, _staffAw);
        if (_sideRow) staffSide = _sideRow.SideOfCamp === 'Sports' ? 'sports' : 'enrichment';
    }
    const announcement = db.prepare("SELECT content FROM HubContent WHERE id='announcement'").get()?.content || '';
    const released = getReleasedWeek();
    // Unit Leaders/Sports Leaders and Instructors don't have CounselorWeekSchedules
    // rows — their schedules live in CounselorScheduleAssignments/StaffWeekSchedules
    // (and legacy Schedules for Instructors), same sources as the map and attendance
    // filters use. Location is resolved and included for these roles only.
    let releasedSchedule = null;
    if (released && cid) {
        const rw = released.weekNumber;
        if (['Unit Leader', 'Sports Leader'].includes(cRow?.StaffRole)) {
            const rows = db.prepare(`
                SELECT PeriodNumber, ActivityName FROM CounselorScheduleAssignments
                WHERE PersonType='Instructor' AND PersonID=? AND WeekNumber=?
                UNION
                SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules
                WHERE CounselorID=? AND WeekNumber=?
                UNION
                SELECT PeriodNumber, ActivityName FROM StaffWeekSchedules
                WHERE StaffID=? AND WeekNumber=?
                ORDER BY PeriodNumber
            `).all(cid, rw, cid, rw, cid, rw);
            releasedSchedule = rows.map(r => ({ ...r, Location: resolveClassLocation(r.PeriodNumber, r.ActivityName, rw) }));
        } else if (cRow?.StaffRole === 'Instructor') {
            const includeLegacy = rw === getActiveWeek() ? 1 : 0;
            const rows = db.prepare(`
                SELECT PeriodNumber, ActivityName, Location FROM Schedules
                WHERE PersonType='Instructor' AND PersonID=? AND ? = 1
                UNION
                SELECT PeriodNumber, ActivityName, Location FROM StaffWeekSchedules
                WHERE StaffID=? AND WeekNumber=?
                ORDER BY PeriodNumber
            `).all(cid, includeLegacy, cid, rw);
            releasedSchedule = rows.map(r => ({ ...r, Location: r.Location || resolveClassLocation(r.PeriodNumber, r.ActivityName, rw) }));
        } else {
            releasedSchedule = db.prepare('SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID=? AND WeekNumber=? ORDER BY PeriodNumber').all(cid, rw);
        }
    }
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
    const photoPhase = getPhotoPhase();
    const todayWinner = photoPhase === 'winner'
        ? db.prepare(`
            SELECT p.counselorName, p.imageUrl, COUNT(v.id) as votes
            FROM PhotoSubmissions p
            LEFT JOIN PhotoVotes v ON v.photoId = p.id
            WHERE p.date = ?
            GROUP BY p.id ORDER BY votes DESC, p.submittedAt ASC LIMIT 1
        `).get(today) || null
        : null;
    const aw = getActiveWeek();

    // Build counselor roster camper ID set for filtering (home-group counselors only).
    // ULs, Directors, and Instructors see all camp data unfiltered.
    let rosterCamperIds = null;
    if (cid && isHomeCounselor) {
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
            ? db.prepare('SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute = ?').all(aw, ca.BusRoute).map(r => r.CamperID)
            : [];

        let extIds = [];
        if (ca?.ExtendedHours === 'AM')   extIds = db.prepare("SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ('AM','Both')").all(aw).map(r => r.CamperID);
        else if (ca?.ExtendedHours === 'PM')   extIds = db.prepare("SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ('PM','Both')").all(aw).map(r => r.CamperID);
        else if (ca?.ExtendedHours === 'Both') extIds = db.prepare("SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IS NOT NULL").all(aw).map(r => r.CamperID);

        const counselorActivities = db.prepare(
            'SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ?'
        ).all(cid, aw);
        let classIds = [];
        for (const act of counselorActivities) {
            db.prepare("SELECT PersonID AS CamperID FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PeriodNumber=? AND ActivityName=?")
                .all(aw, act.PeriodNumber, act.ActivityName).forEach(r => classIds.push(r.CamperID));
        }

        rosterCamperIds = new Set([...homeGroupIds, ...busIds, ...extIds, ...classIds]);
    }

    const filterByRoster = (rows) => rosterCamperIds ? rows.filter(r => rosterCamperIds.has(r.CamperID)) : rows;

    const _aw = getActiveWeek();
    const allPickups = db.prepare(`
        SELECT sp.PickupTime, sp.PeriodNumber, sp.Notes, c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               s.ActivityName
        FROM ScheduledPickups sp JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber AND s.WeekNumber=?
        WHERE sp.Date = ? ORDER BY sp.PickupTime
    `).all(_aw, _aw, today);

    const allLateArrivals = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor, a.MarkedAt
        FROM Attendance a JOIN Campers c ON c.CamperID = a.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status = 'late'
        ORDER BY a.MarkedAt
    `).all(_aw, today);

    const allEarlyDismissals = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               ed.DismissalTime, ed.Notes
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE ed.Date = ? ORDER BY ed.DismissalTime
    `).all(_aw, today);

    const allScheduleChanges = db.prepare(`
        SELECT ChangeID, CamperID, CamperName, ColorGroup, PeriodNumber, OldActivity, NewActivity, ChangedAt
        FROM ScheduleChanges
        WHERE ChangedAt >= datetime('now', '-1 day')
        ORDER BY ChangedAt DESC
    `).all().filter(r => {
        const d = new Date(r.ChangedAt.includes('Z') ? r.ChangedAt : r.ChangedAt.replace(' ', 'T') + 'Z');
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d) === today;
    });

    const todayPickups        = filterByRoster(allPickups);
    const todayLateArrivals   = filterByRoster(allLateArrivals);
    const todayEarlyDismissals= filterByRoster(allEarlyDismissals);
    const todayScheduleChanges= rosterCamperIds
        ? allScheduleChanges.filter(c => rosterCamperIds.has(c.CamperID))
        : allScheduleChanges;

    const absentByGroup = getAbsentByGroup(today); // unfiltered — Attendance at a Glance shows all camp
    const rosterAbsent = rosterCamperIds
        ? Object.values(absentByGroup).flat().filter(cam => cam.Status === 'absent' && rosterCamperIds.has(cam.CamperID))
        : null; // null = no counselor selected; Today's Memo skips the section

    const nurseNow = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor, nl.Notes, nl.CheckInTime
        FROM NurseLog nl
        JOIN Campers c ON c.CamperID = nl.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE nl.Date = ? AND nl.CheckOutTime IS NULL
        ORDER BY nl.CheckInTime
    `).all(getActiveWeek(), today);

    const caseNow = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor, cl.Notes, cl.CheckInTime
        FROM CaseLog cl
        JOIN Campers c ON c.CamperID = cl.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cl.Date = ? AND cl.CheckOutTime IS NULL AND cl.Dismissed = 0
        ORDER BY cl.CheckInTime
    `).all(getActiveWeek(), today);

    const _talentMeta = db.prepare('SELECT submissions_open FROM TalentMeta WHERE id=1').get();
    const talentOpen = _talentMeta ? _talentMeta.submissions_open === 1 : false;

    res.render('staff-hub', {
        selectedCounselorName, announcement, releasedSchedule, releasedSessionLabel,
        yesterdayWinner, todayWinner, photoPhase,
        todayPickups, todayLateArrivals, todayEarlyDismissals, todayScheduleChanges, today,
        absentByGroup, rosterAbsent, nurseNow, caseNow,
        staffSide, talentOpen,
        sportsScheduleFull:     SPORTS_SCHEDULE_FULL,
        enrichmentScheduleFull: ENRICHMENT_SCHEDULE_FULL
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

app.post('/director-notes/edit/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const adminName = req.cookies.adminName;
    if (!adminName) return res.redirect('/admin');
    const note = db.prepare("SELECT author FROM DirectorNotes WHERE id=?").get(id);
    if (!note || note.author !== adminName) return res.redirect('/admin');
    const body = (req.body.body || '').trim();
    if (!body) return res.redirect('/admin');
    const VALID_CATS = new Set(['director', 'camper', 'staff', 'timesheet']);
    const category = VALID_CATS.has(req.body.category) ? req.body.category : note.category || 'director';
    db.prepare("UPDATE DirectorNotes SET body=?, category=? WHERE id=?").run(body, category, id);
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
    const aw = getActiveWeek();
    const camperTotal = db.prepare("SELECT COUNT(*) AS count FROM CamperWeekData WHERE WeekNumber=?").get(aw).count;
    const activityCount = db.prepare(
        "SELECT COUNT(DISTINCT ActivityName) AS count FROM WeeklyOfferings WHERE WeekNumber=?"
    ).get(aw).count;

    const groupRows = db.prepare(
        `SELECT HomeGroupColor AS color, COUNT(*) AS cnt FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor IS NOT NULL AND HomeGroupColor != '' GROUP BY HomeGroupColor`
    ).all(aw);
    const groupCounts = {};
    for (const r of groupRows) groupCounts[r.color] = r.cnt;

    const pendingChanges = db.prepare("SELECT COUNT(*) AS count FROM ScheduleChanges").get().count;

    const waitlistCount = db.prepare(`
        SELECT COUNT(*) as count FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE w.WeekNumber = ${aw}
          AND (SELECT COUNT(*) FROM Schedules s
               WHERE s.ActivityName = a.Name AND s.PeriodNumber = w.PeriodNumber
                 AND s.PersonType = 'Camper' AND s.WeekNumber = ${aw}
                 AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ${aw} AND HomeGroupColor = 'SPLIT')
              ) < a.MaxCapacity
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
        "SELECT COUNT(*) AS count FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status='nurse'"
    ).get(today).count;

    const talentMeta = db.prepare('SELECT submissions_open FROM TalentMeta WHERE id=1').get();
    const talentOpen = talentMeta ? talentMeta.submissions_open === 1 : false;
    const talentSubmissions = db.prepare('SELECT * FROM TalentSubmissions WHERE week_number=? ORDER BY submitted_at ASC').all(aw);

    res.render('index', {
        camperTotal, activityCount, groupCounts,
        pendingChanges, waitlistCount, nurseCount,
        hubStats, today,
        alertMessage: req.query.message,
        announcement, directorNotes, sessions,
        adminName, adminUsers, absentByGroup,
        talentOpen, talentSubmissions,
        sportsScheduleFull: SPORTS_SCHEDULE_FULL,
        enrichmentScheduleFull: ENRICHMENT_SCHEDULE_FULL
    });
});

// --- AUDIT ROSTER ---
app.get('/audit', (req, res) => {
    const activeWeek = getPrepTargetWeek() || getActiveWeek();
    const activeSession = db.prepare('SELECT * FROM Sessions WHERE weekNumber=?').get(activeWeek);
    const alertMessage = req.query.message || null;

    const noCounselor = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.HomeGroupCounselorID IS NULL
          AND c.CamperID NOT IN (SELECT CamperID FROM CamperHomeGroups WHERE WeekNumber = ?)
          AND COALESCE(cwd.HomeGroupColor,'') NOT IN ('LilPlace', 'KinderPlace', 'SPLIT', 'SPRC')
          AND cwd.HomeGroupColor IS NOT NULL AND cwd.HomeGroupColor != ''
        ORDER BY cwd.HomeGroupColor, c.LastName
    `).all(activeWeek, activeWeek);

    const missingSchedule = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               COUNT(s.PeriodNumber) AS classCount
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        LEFT JOIN Schedules s ON s.PersonID = c.CamperID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
        WHERE COALESCE(cwd.HomeGroupColor,'') NOT IN ('LilPlace', 'KinderPlace', 'SPLIT', 'SPRC')
          AND cwd.HomeGroupColor IS NOT NULL AND cwd.HomeGroupColor != ''
        GROUP BY c.CamperID
        HAVING classCount < 5
        ORDER BY cwd.HomeGroupColor, c.LastName
    `).all(activeWeek, activeWeek);

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

    // Dual-enrolled staff (e.g. Sports Leader/Counselor, Instructor/Counselor) cover
    // some periods under their staff identity — count those periods as filled so the
    // counselor row isn't falsely flagged as short on classes.
    const auditBusyRows = db.prepare(`
        SELECT c2.CounselorID, x.PeriodNumber
        FROM (
            SELECT csa.PersonID AS pid, csa.PeriodNumber FROM CounselorScheduleAssignments csa
            WHERE csa.PersonType = 'Instructor' AND csa.WeekNumber = ?
            UNION
            SELECT s.PersonID, s.PeriodNumber FROM Schedules s WHERE s.PersonType = 'Instructor'
            UNION
            SELECT sws.StaffID, sws.PeriodNumber FROM StaffWeekSchedules sws WHERE sws.WeekNumber = ?
        ) x
        JOIN Counselors c1 ON c1.CounselorID = x.pid
        JOIN Counselors c2 ON c2.FirstName = c1.FirstName AND c2.LastName = c1.LastName
    `).all(activeWeek, activeWeek);
    const auditBusyMap = {};
    for (const r of auditBusyRows) (auditBusyMap[r.CounselorID] ??= new Set()).add(r.PeriodNumber);
    const cwsPeriodMap = {};
    db.prepare('SELECT CounselorID, PeriodNumber FROM CounselorWeekSchedules WHERE WeekNumber = ?')
        .all(activeWeek)
        .forEach(r => (cwsPeriodMap[r.CounselorID] ??= new Set()).add(r.PeriodNumber));

    const counselorMismatch = allCounselors.filter(c => {
        const expected = EXPECTED[c.ScheduleType];
        if (expected == null) return false;
        const covered = new Set([...(cwsPeriodMap[c.CounselorID] || []), ...(auditBusyMap[c.CounselorID] || [])]);
        return c.classCount !== expected && covered.size !== expected;
    });

    const suspectRows = db.prepare(`
        SELECT ActivityName, COUNT(*) AS totalCampers,
               GROUP_CONCAT(DISTINCT PeriodNumber ORDER BY PeriodNumber) AS periods
        FROM Schedules
        WHERE PersonType = 'Camper' AND WeekNumber = ?
        GROUP BY ActivityName
        HAVING totalCampers <= 3
        ORDER BY totalCampers, ActivityName
    `).all(activeWeek);

    const allClassNames = db.prepare(
        "SELECT DISTINCT ActivityName FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? ORDER BY ActivityName"
    ).all(activeWeek).map(r => r.ActivityName);

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
        LEFT JOIN Schedules s ON s.ActivityName = a.Name AND s.PersonType = 'Camper' AND s.WeekNumber = ?
        WHERE a.SideOfCamp IS NULL OR a.SideOfCamp NOT IN ('Sports', 'Enrichment')
        GROUP BY a.Name, a.SideOfCamp
        ORDER BY a.Name
    `).all(activeWeek);

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
        const isAdmin = req.cookies.adminAuth === 'true';
        const aw = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
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
              AND s.WeekNumber = ?
              AND s.ActivityName NOT LIKE '#REF%'
            ORDER BY s.PeriodNumber, s.ActivityName
        `).all(aw);

        // Legacy Schedules Instructor rows are week-agnostic — only valid when
        // viewing the active week. In prep mode staff/locations must come solely
        // from the week-scoped tables (StaffWeekSchedules, CSA) or stale data bleeds in.
        const includeLegacy = aw === getActiveWeek() ? 1 : 0;
        const getLocationWeek = db.prepare(`
            SELECT Location FROM StaffWeekSchedules
            WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `);
        const getLocationLegacy = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND PeriodNumber = ? AND ActivityName = ? COLLATE NOCASE
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `);
        const getColorGroups = db.prepare(`
            SELECT DISTINCT cwd.HomeGroupColor
            FROM CamperWeekData cwd JOIN Schedules s ON cwd.CamperID = s.PersonID AND s.PersonType = 'Camper' AND s.WeekNumber = cwd.WeekNumber
            WHERE cwd.WeekNumber = ? AND s.PeriodNumber = ? AND s.ActivityName = ? ORDER BY cwd.HomeGroupColor
        `);
        const getEnrollment = db.prepare(`
            SELECT COUNT(*) as n FROM Schedules s
            WHERE s.PersonType = 'Camper' AND s.WeekNumber = ? AND s.PeriodNumber = ? AND s.ActivityName = ?
              AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ? AND HomeGroupColor = 'SPLIT')
        `);
        const getStaff = db.prepare(`
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ? AND ? = 1
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
            SELECT 1 FROM CamperWeekData cwd JOIN Schedules s ON cwd.CamperID=s.PersonID AND s.PersonType='Camper' AND s.WeekNumber=cwd.WeekNumber
            WHERE cwd.WeekNumber=? AND s.PeriodNumber=? AND s.ActivityName=? AND cwd.BusRoute IS NOT NULL AND cwd.BusRoute!='' LIMIT 1
        `);
        const getExtGroups = db.prepare(`
            SELECT DISTINCT cwd.ExtendedHours FROM CamperWeekData cwd JOIN Schedules s ON cwd.CamperID=s.PersonID AND s.PersonType='Camper' AND s.WeekNumber=cwd.WeekNumber
            WHERE cwd.WeekNumber=? AND s.PeriodNumber=? AND s.ActivityName=? AND cwd.ExtendedHours IS NOT NULL AND cwd.ExtendedHours!=''
        `);
        const getCamperNames = db.prepare(`
            SELECT COALESCE(c.PreferredName, c.FirstName) AS First, c.LastName
            FROM Campers c JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
            WHERE s.WeekNumber = ? AND s.PeriodNumber = ? AND s.ActivityName = ?
        `);

        // Each row in Schedules now uses clock blocks (1-6) — no P3 AM/PM split needed.
        const enriched = classes.map(cls => {
            const locRow = getLocationWeek.get(aw, cls.periodNumber, cls.activityName)
                || (includeLegacy ? getLocationLegacy.get(cls.periodNumber, cls.activityName) : null);
            return {
                ...cls,
                location:     locRow ? locRow.Location : (cls.location || null),
                enrolled:     getEnrollment.get(aw, cls.periodNumber, cls.activityName, aw).n,
                colorGroups:  getColorGroups.all(aw, cls.periodNumber, cls.activityName).map(r => r.HomeGroupColor),
                staff:        getStaff.all(cls.periodNumber, cls.activityName, includeLegacy, aw, cls.periodNumber, cls.activityName, aw, cls.periodNumber, cls.activityName),
                counselors:   getCounselors.all(aw, cls.periodNumber, cls.activityName, aw),
                busPresent:   !!getBusPresence.get(aw, cls.periodNumber, cls.activityName),
                extGroups:    getExtGroups.all(aw, cls.periodNumber, cls.activityName).map(r => r.ExtendedHours),
                camperNames:  getCamperNames.all(aw, cls.periodNumber, cls.activityName).map(r => r.First + ' ' + r.LastName)
            };
        });

        // Collapse merge groups (e.g. Dance + Cheer in same period) into one row
        const absorbedKeys = new Set();
        const mergedEnriched = [];
        for (const cls of enriched) {
            const key = `${cls.periodNumber}:${cls.activityName}`;
            if (absorbedKeys.has(key)) continue;
            const group = getMergeGroup(cls.activityName);
            if (group) {
                const others = group.filter(n => n !== cls.activityName);
                const peers  = others.map(n => enriched.find(e => e.periodNumber === cls.periodNumber && e.activityName === n)).filter(Boolean);
                if (peers.length === others.length) {
                    peers.forEach(p => absorbedKeys.add(`${p.periodNumber}:${p.activityName}`));
                    const all = [cls, ...peers];
                    const seenS = new Set(), seenC = new Set();
                    const uStaff = [], uCounselors = [];
                    for (const e of all) {
                        for (const s of e.staff)      { if (!seenS.has(s.CounselorID)) { seenS.add(s.CounselorID); uStaff.push(s); } }
                        for (const c of e.counselors) { if (!seenC.has(c.CounselorID)) { seenC.add(c.CounselorID); uCounselors.push(c); } }
                    }
                    mergedEnriched.push({
                        ...cls,
                        activityName: group.join(' & '),
                        mergedNames:  group.slice(),
                        enrolled:     all.reduce((s, e) => s + e.enrolled, 0),
                        maxCapacity:  all.every(e => e.maxCapacity) ? all.reduce((s, e) => s + e.maxCapacity, 0) : null,
                        colorGroups:  [...new Set(all.flatMap(e => e.colorGroups))],
                        staff:        uStaff,
                        counselors:   uCounselors,
                        busPresent:   all.some(e => e.busPresent),
                        extGroups:    [...new Set(all.flatMap(e => e.extGroups))],
                        location:     all.map(e => e.location).find(Boolean) || null,
                        camperNames:  [...new Set(all.flatMap(e => e.camperNames))],
                    });
                    continue;
                }
            }
            mergedEnriched.push(cls);
        }

        const periodMap = new Map();
        for (const cls of mergedEnriched) {
            if (!periodMap.has(cls.periodNumber)) periodMap.set(cls.periodNumber, []);
            periodMap.get(cls.periodNumber).push(cls);
        }

        const schedule = [];
        for (const periodNumber of [...periodMap.keys()].sort((a, b) => a - b)) {
            schedule.push({ periodNumber, periodLabel: String(periodNumber), classes: periodMap.get(periodNumber) });
        }

        const session = db.prepare('SELECT label FROM Sessions WHERE weekNumber=?').get(aw);
        const weekLabel = session?.label ?? `Week ${aw}`;
        const isPrepping = isAdmin && (getPrepTargetWeek() === aw);

        res.render('master-schedule', { schedule, weekLabel, isPrepping });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading Master Schedule: ' + err.message);
    }
});

// --- CAMP MAP ---
app.get('/map', (req, res) => {
    const aw  = getActiveWeek();
    const cid = parseInt(req.cookies.selectedCounselor) || null;

    const allBuildings        = db.prepare('SELECT id, name, map, x, y FROM BuildingCoordinates ORDER BY name').all();
    const enrichmentBuildings = allBuildings.filter(b => b.map === 'enrichment');
    const sportsBuildings     = allBuildings.filter(b => b.map === 'sports');

    // Resolve location for each offering: Schedules (Instructor) → StaffWeekSchedules → Activities
    const offeringRows = db.prepare(`
        SELECT wo.ActivityName AS activity, wo.PeriodNumber AS period,
               wo.PreliminaryEnrollment AS enrollment,
               COALESCE(
                   (SELECT s.Location FROM Schedules s
                    WHERE s.PersonType='Instructor' AND s.PeriodNumber=wo.PeriodNumber
                      AND s.ActivityName=wo.ActivityName AND s.Location IS NOT NULL AND s.Location != ''
                    LIMIT 1),
                   (SELECT sws.Location FROM StaffWeekSchedules sws
                    WHERE sws.WeekNumber=? AND sws.PeriodNumber=wo.PeriodNumber
                      AND sws.ActivityName=wo.ActivityName COLLATE NOCASE AND sws.Location IS NOT NULL AND sws.Location != ''
                    LIMIT 1),
                   a.Location
               ) AS location
        FROM WeeklyOfferings wo
        LEFT JOIN Activities a ON a.Name = wo.ActivityName
        WHERE wo.WeekNumber = ?
        ORDER BY wo.PeriodNumber, wo.ActivityName
    `).all(aw, aw).filter(r => r.location);

    // Resolve the logged-in person's role first so we can pick the right schedule table
    const SPORTS_ROLES = new Set(['Unit Leader', 'Sports Leader']);
    const counselor = cid ? db.prepare('SELECT StaffRole FROM Counselors WHERE CounselorID=?').get(cid) : null;
    const role = counselor?.StaffRole ?? null;

    // Counselor's period→activity assignments for the active week (table varies by role)
    let myPeriods = [];
    if (cid) {
        if (role === 'Unit Leader' || role === 'Sports Leader') {
            // UL/SL schedules span three tables: sports slots assigned via the
            // scheduler land in CounselorScheduleAssignments (PersonType='Instructor'),
            // enrichment slots (placed as counselor) in CounselorWeekSchedules, and
            // instructor-style uploads in StaffWeekSchedules.
            myPeriods = db.prepare(`
                SELECT PeriodNumber AS period, ActivityName AS activity
                FROM CounselorScheduleAssignments WHERE PersonID=? AND WeekNumber=?
                UNION
                SELECT PeriodNumber, ActivityName
                FROM CounselorWeekSchedules WHERE CounselorID=? AND WeekNumber=?
                UNION
                SELECT PeriodNumber, ActivityName
                FROM StaffWeekSchedules WHERE StaffID=? AND WeekNumber=?
            `).all(cid, aw, cid, aw, cid, aw);
        } else if (role === 'Instructor') {
            myPeriods = db.prepare('SELECT PeriodNumber AS period, ActivityName AS activity FROM Schedules WHERE PersonType=\'Instructor\' AND PersonID=?')
                .all(cid);
        } else {
            myPeriods = db.prepare('SELECT PeriodNumber AS period, ActivityName AS activity FROM CounselorWeekSchedules WHERE CounselorID=? AND WeekNumber=?')
                .all(cid, aw);
        }
    }

    // Default map: UL/SL → sports; everyone else → enrichment.
    let defaultMap = 'enrichment';
    if (counselor && SPORTS_ROLES.has(counselor.StaffRole)) defaultMap = 'sports';
    if (myPeriods.some(mp => mp.period === 3 || mp.period === 6)) defaultMap = 'sports';

    const estMins = getESTMins();
    const enrichmentActiveBlock = getActiveBlockForMap(ENRICHMENT_PERIODS, estMins);
    const sportsActiveBlock     = getActiveBlockForMap(SPORTS_PERIODS, estMins);

    const enrichmentPeriodLabels = {};
    for (const p of ENRICHMENT_PERIODS) enrichmentPeriodLabels[p.clockBlock] = p.label;
    const sportsPeriodLabels = {};
    for (const p of SPORTS_PERIODS) sportsPeriodLabels[p.clockBlock] = p.label;

    const usedLocations = db.prepare(`
        SELECT DISTINCT Location FROM (
            SELECT Location FROM Schedules WHERE PersonType='Instructor' AND Location IS NOT NULL AND Location != ''
            UNION SELECT Location FROM StaffWeekSchedules WHERE Location IS NOT NULL AND Location != ''
            UNION SELECT Location FROM Activities WHERE Location IS NOT NULL AND Location != ''
        ) ORDER BY Location
    `).all().map(r => r.Location);

    res.render('map', {
        enrichmentBuildings, sportsBuildings, offerings: offeringRows, myPeriods,
        enrichmentActiveBlock, sportsActiveBlock,
        enrichmentPeriodLabels, sportsPeriodLabels,
        defaultMap, usedLocations,
        viewMode: req.cookies.viewMode || 'staff',
        isAdmin: req.cookies.adminAuth === 'true'
    });
});

app.post('/admin/building-coord', (req, res) => {
    const { name, map, x, y } = req.body;
    if (!name || !map || x == null || y == null) return res.redirect('/settings?message=Missing+fields#map');
    db.prepare(`
        INSERT INTO BuildingCoordinates (name, map, x, y) VALUES (?, ?, ?, ?)
        ON CONFLICT(name, map) DO UPDATE SET x=excluded.x, y=excluded.y
    `).run(name.trim(), map, parseInt(x), parseInt(y));
    res.redirect('/settings?message=Building+saved#map');
});

app.post('/admin/delete-building-coord', (req, res) => {
    const id = parseInt(req.body.id);
    if (id) db.prepare('DELETE FROM BuildingCoordinates WHERE id=?').run(id);
    res.redirect('/settings?message=Building+deleted#map');
});

// --- SPARTAN GAMES ---
app.get('/spartan-games', (req, res) => {
    const cid = parseInt(req.cookies.selectedCounselor) || null;
    const isAdmin = req.cookies.adminAuth === 'true';
    const counselorRow = cid ? db.prepare('SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?').get(cid) : null;
    const myName = counselorRow ? `${counselorRow.FirstName} ${counselorRow.LastName}` : null;

    const events = db.prepare('SELECT * FROM SpartanEvents ORDER BY date, block, name').all();
    const allSignups = db.prepare('SELECT * FROM SpartanSignups ORDER BY id').all();
    const allCounselors = db.prepare("SELECT CounselorID, FirstName, LastName FROM Counselors WHERE StaffRole IN ('Counselor', 'Swim Counselor','Equipment Manager','Unit Leader','Sports Leader') ORDER BY LastName, FirstName").all();

    // Map full name -> Gender ('M'/'F'/null) for gender-ratio validation
    const genderByName = {};
    for (const c of db.prepare('SELECT FirstName, LastName, Gender FROM Counselors').all()) {
        genderByName[`${c.FirstName} ${c.LastName}`] = c.Gender || null;
    }
    const eventsById = {};
    for (const ev of events) eventsById[ev.id] = ev;

    // Group signups by event, parsing JSON participant arrays, and flag groups that don't meet the event's gender-ratio minimums
    const signupsByEvent = {};
    for (const s of allSignups) {
        if (!signupsByEvent[s.event_id]) signupsByEvent[s.event_id] = [];
        const participants = JSON.parse(s.participants);
        const ev = eventsById[s.event_id];
        let valid = true;
        if (ev && ev.enforce_gender_ratio) {
            const maleCount = participants.filter(p => genderByName[p] === 'M').length;
            const femaleCount = participants.filter(p => genderByName[p] === 'F').length;
            valid = maleCount >= ev.min_male && femaleCount >= ev.min_female;
        }
        signupsByEvent[s.event_id].push({ id: s.id, participants, valid });
    }

    // Map of eventId -> signup object for the current counselor
    const mySignups = {};
    if (myName) {
        for (const [eid, sups] of Object.entries(signupsByEvent)) {
            const mine = sups.find(s => s.participants.includes(myName));
            if (mine) mySignups[eid] = mine;
        }
    }

    // Group events by date (sorted chronologically)
    const eventsByDate = {};
    for (const ev of events) {
        if (!eventsByDate[ev.date]) eventsByDate[ev.date] = [];
        eventsByDate[ev.date].push(ev);
    }
    const dates = Object.keys(eventsByDate).sort((a, b) => {
        const [am, ad] = a.split('/').map(Number);
        const [bm, bd] = b.split('/').map(Number);
        return am - bm || ad - bd;
    });

    const meta = db.prepare('SELECT submissions_open FROM SpartanGamesMeta WHERE id=1').get();
    const submissionsOpen = meta ? meta.submissions_open === 1 : true;

    const message = req.query.message || null;
    res.render('spartan-games', {
        events, eventsByDate, dates, signupsByEvent, mySignups,
        allCounselors, myName, isAdmin, message, submissionsOpen,
        viewMode: req.cookies.viewMode || 'staff'
    });
});

app.post('/spartan-games/signup', (req, res) => {
    const meta = db.prepare('SELECT submissions_open FROM SpartanGamesMeta WHERE id=1').get();
    if (meta && meta.submissions_open !== 1) return res.status(403).json({ error: 'Submissions are currently closed.' });

    const cid = parseInt(req.cookies.selectedCounselor) || null;
    if (!cid) return res.status(401).json({ error: 'Not logged in' });
    const counselorRow = db.prepare('SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?').get(cid);
    if (!counselorRow) return res.status(401).json({ error: 'Counselor not found' });
    const myName = `${counselorRow.FirstName} ${counselorRow.LastName}`;

    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) return res.json({ results: [] });

    const results = [];
    for (const entry of entries) {
        const event = db.prepare('SELECT * FROM SpartanEvents WHERE id=?').get(entry.eventId);
        if (!event) { results.push({ eventId: entry.eventId, success: false, error: 'Event not found' }); continue; }

        const partners = Array.isArray(entry.partners) ? entry.partners.map(p => String(p).trim()).filter(Boolean) : [];
        const participants = [myName, ...partners].sort();

        if (participants.length !== event.participant_count) {
            results.push({ eventId: entry.eventId, success: false, error: `Select exactly ${event.participant_count - 1} partner(s) for ${event.name}`, eventName: event.name });
            continue;
        }

        const existing = db.prepare('SELECT id, participants FROM SpartanSignups WHERE event_id=?').all(event.id);
        const participantsStr = JSON.stringify(participants);

        if (existing.some(s => s.participants === participantsStr)) {
            results.push({ eventId: entry.eventId, success: false, error: 'group_exists', eventName: event.name });
            continue;
        }

        let conflictName = null;
        for (const s of existing) {
            const existingParts = JSON.parse(s.participants);
            const hit = participants.find(p => existingParts.includes(p));
            if (hit) { conflictName = hit; break; }
        }
        if (conflictName) {
            results.push({ eventId: entry.eventId, success: false, error: 'name_conflict', conflictName, eventName: event.name });
            continue;
        }

        db.prepare('INSERT INTO SpartanSignups (event_id, participants) VALUES (?, ?)').run(event.id, participantsStr);
        results.push({ eventId: entry.eventId, success: true, eventName: event.name });
    }

    res.json({ results });
});

app.post('/admin/spartan-games/toggle-submissions', (req, res) => {
    const meta = db.prepare('SELECT submissions_open FROM SpartanGamesMeta WHERE id=1').get();
    const current = meta ? meta.submissions_open : 1;
    db.prepare('UPDATE SpartanGamesMeta SET submissions_open=? WHERE id=1').run(current === 1 ? 0 : 1);
    res.redirect('/spartan-games');
});

app.post('/admin/spartan-games/add-event', (req, res) => {
    const { name, date, block, participant_count, subtext, enforce_gender_ratio, min_male, min_female } = req.body;
    if (!name || !date || !block || !participant_count) return res.redirect('/spartan-games?message=Missing+fields');
    const enforceRatio = enforce_gender_ratio ? 1 : 0;
    db.prepare('INSERT INTO SpartanEvents (name, date, block, participant_count, subtext, enforce_gender_ratio, min_male, min_female) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name.trim(), date.trim(), block.trim(), parseInt(participant_count), (subtext || '').trim() || null, enforceRatio, enforceRatio ? (parseInt(min_male) || 0) : 0, enforceRatio ? (parseInt(min_female) || 0) : 0);
    res.redirect('/spartan-games?message=Event+added');
});

app.post('/admin/spartan-games/update-event', (req, res) => {
    const { id, name, date, block, participant_count, subtext, enforce_gender_ratio, min_male, min_female } = req.body;
    if (!id || !name || !date || !block || !participant_count) return res.redirect('/spartan-games?message=Missing+fields');
    const enforceRatio = enforce_gender_ratio ? 1 : 0;
    db.prepare('UPDATE SpartanEvents SET name=?, date=?, block=?, participant_count=?, subtext=?, enforce_gender_ratio=?, min_male=?, min_female=? WHERE id=?')
        .run(name.trim(), date.trim(), block.trim(), parseInt(participant_count), (subtext || '').trim() || null, enforceRatio, enforceRatio ? (parseInt(min_male) || 0) : 0, enforceRatio ? (parseInt(min_female) || 0) : 0, parseInt(id));
    res.redirect('/spartan-games?message=Event+updated');
});

app.post('/admin/spartan-games/delete-event', (req, res) => {
    const { id } = req.body;
    if (!id) return res.redirect('/spartan-games');
    db.prepare('DELETE FROM SpartanSignups WHERE event_id=?').run(parseInt(id));
    db.prepare('DELETE FROM SpartanEvents WHERE id=?').run(parseInt(id));
    res.redirect('/spartan-games?message=Event+deleted');
});

app.post('/admin/spartan-games/delete-signup', (req, res) => {
    const { id } = req.body;
    if (!id) return res.redirect('/spartan-games');
    db.prepare('DELETE FROM SpartanSignups WHERE id=?').run(parseInt(id));
    res.redirect('/spartan-games?message=Signup+deleted');
});

// --- TALENT SHOW ---
app.get('/talent-show', (req, res) => {
    const cid = parseInt(req.cookies.selectedCounselor) || null;
    const isAdmin = req.cookies.adminAuth === 'true';
    const counselorRow = cid ? db.prepare('SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?').get(cid) : null;
    const myName = counselorRow ? `${counselorRow.FirstName} ${counselorRow.LastName}` : null;
    const aw = getActiveWeek();
    const meta = db.prepare('SELECT submissions_open FROM TalentMeta WHERE id=1').get();
    const submissionsOpen = meta ? meta.submissions_open === 1 : false;
    const mySubmission = cid ? db.prepare('SELECT * FROM TalentSubmissions WHERE counselor_id=? AND week_number=?').get(cid, aw) : null;
    res.render('talent-show', { myName, mySubmission, submissionsOpen, isAdmin, activeWeek: aw, message: req.query.message || null, viewMode: req.cookies.viewMode || 'staff' });
});

app.post('/talent-show/submit', (req, res) => {
    const meta = db.prepare('SELECT submissions_open FROM TalentMeta WHERE id=1').get();
    if (!meta || meta.submissions_open !== 1) return res.redirect('/talent-show?message=Submissions+are+currently+closed');
    const cid = parseInt(req.cookies.selectedCounselor) || null;
    if (!cid) return res.redirect('/talent-show?message=Please+select+your+name+first');
    const { description } = req.body;
    if (!description || !description.trim()) return res.redirect('/talent-show?message=Please+enter+a+description');
    const counselorRow = db.prepare('SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?').get(cid);
    const counselorName = counselorRow ? `${counselorRow.FirstName} ${counselorRow.LastName}` : 'Unknown';
    const aw = getActiveWeek();
    const existing = db.prepare('SELECT id FROM TalentSubmissions WHERE counselor_id=? AND week_number=?').get(cid, aw);
    if (existing) {
        db.prepare("UPDATE TalentSubmissions SET description=?, status='pending', submitted_at=datetime('now') WHERE id=?").run(description.trim(), existing.id);
    } else {
        db.prepare('INSERT INTO TalentSubmissions (counselor_id, counselor_name, description, week_number) VALUES (?, ?, ?, ?)').run(cid, counselorName, description.trim(), aw);
    }
    res.redirect('/talent-show?message=Submitted');
});

app.post('/admin/talent-show/toggle-submissions', (req, res) => {
    const meta = db.prepare('SELECT submissions_open FROM TalentMeta WHERE id=1').get();
    const current = meta ? meta.submissions_open : 0;
    db.prepare('UPDATE TalentMeta SET submissions_open=? WHERE id=1').run(current === 1 ? 0 : 1);
    res.redirect('/admin#talent-show');
});

app.post('/admin/talent-show/review', (req, res) => {
    const { id, action } = req.body;
    if (!id || !['approve', 'deny'].includes(action)) return res.redirect('/admin#talent-show');
    db.prepare('UPDATE TalentSubmissions SET status=? WHERE id=?').run(action === 'approve' ? 'approved' : 'denied', parseInt(id));
    res.redirect('/admin#talent-show');
});

app.post('/admin/talent-show/delete', (req, res) => {
    const { id } = req.body;
    if (!id) return res.redirect('/admin#talent-show');
    db.prepare('DELETE FROM TalentSubmissions WHERE id=?').run(parseInt(id));
    res.redirect('/admin#talent-show');
});

// --- CAMPER ATTENDANCE HISTORY ---
function addDaysToDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
}

function getDayStatus(attRows, hasDismissal) {
    const morning = attRows.find(r => r.SessionType === 'homegroup_am' || r.SessionType === 'specialty_am');
    const classRows = attRows.filter(r => r.SessionType === 'class');
    if (morning?.Status === 'late' || hasDismissal) return 'yellow';
    const anyPresent = morning?.Status === 'present' || classRows.some(r => r.Status === 'present');
    if (anyPresent) return 'green';
    const anyAbsentSignal = morning?.Status === 'absent' || (classRows.length > 0 && classRows.every(r => r.Status === 'absent'));
    if (anyAbsentSignal) return 'red';
    return 'none';
}

app.get('/camper-attendance', (req, res) => {
    const camperId = parseInt(req.query.camperId) || null;
    const weeksParam = req.query.weeks;
    const selectedWeeks = weeksParam
        ? (Array.isArray(weeksParam) ? weeksParam : weeksParam.split(',')).map(Number).filter(n => n >= 1 && n <= 6)
        : null;

    const sessions = db.prepare('SELECT weekNumber, label, startDate FROM Sessions ORDER BY weekNumber').all();
    const _caAw = getActiveWeek();
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(_caAw);

    let camper = null;
    let weekData = [];

    if (camperId) {
        camper = db.prepare('SELECT CamperID, FirstName, LastName, PreferredName FROM Campers WHERE CamperID=?').get(camperId);

        if (camper) {
            const weeksToShow = sessions.filter(s =>
                s.startDate && (!selectedWeeks || selectedWeeks.includes(s.weekNumber))
            );

            if (weeksToShow.length > 0) {
                const firstDate = weeksToShow[0].startDate;
                const lastDate = addDaysToDate(weeksToShow[weeksToShow.length - 1].startDate, 4);

                const allAtt = db.prepare(`
                    SELECT Date, SessionType, Status
                    FROM Attendance
                    WHERE CamperID = ? AND Date >= ? AND Date <= ?
                `).all(camperId, firstDate, lastDate);

                const dismissalDates = new Set(
                    db.prepare(`
                        SELECT Date FROM EarlyDismissals WHERE CamperID = ? AND Date >= ? AND Date <= ?
                    `).all(camperId, firstDate, lastDate).map(r => r.Date)
                );

                const attByDate = {};
                for (const row of allAtt) {
                    (attByDate[row.Date] = attByDate[row.Date] || []).push(row);
                }

                const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
                for (const s of weeksToShow) {
                    const days = [];
                    let presentCount = 0, absentCount = 0;
                    for (let d = 0; d < 5; d++) {
                        const date = addDaysToDate(s.startDate, d);
                        const status = getDayStatus(attByDate[date] || [], dismissalDates.has(date));
                        if (status === 'green' || status === 'yellow') presentCount++;
                        else if (status === 'red') absentCount++;
                        const [, m, day] = date.split('-').map(Number);
                        days.push({ date, status, label: `${m}/${day}`, dow: DOW[d] });
                    }
                    weekData.push({ weekNumber: s.weekNumber, label: s.label, startDate: s.startDate, days, presentCount, absentCount });
                }
            }
        }
    }

    res.render('camper-attendance', {
        camper, campers, sessions, weekData,
        selectedWeeks: selectedWeeks || sessions.map(s => s.weekNumber),
        camperId,
        viewMode: req.cookies.viewMode || 'admin'
    });
});

// --- CLASS ROSTER ---
app.get('/class-roster/:period/:activity', (req, res) => {
    try {
        const period      = parseInt(req.params.period);
        const rawActivity = req.params.activity;
        const isAdmin    = req.cookies.adminAuth === 'true';
        const activeWeek = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();

        // If this activity is in a merge group and all members exist this period, show merged view
        const group = getMergeGroup(rawActivity);
        let mergedNames = null;
        if (group) {
            const allPresent = group.every(n =>
                db.prepare('SELECT 1 FROM Schedules WHERE PersonType=\'Camper\' AND ActivityName=? AND PeriodNumber=? AND WeekNumber=? LIMIT 1')
                  .get(n, period, activeWeek)
            );
            if (allPresent) mergedNames = group;
        }

        const displayName = mergedNames ? mergedNames.join(' & ') : rawActivity;
        const queryNames  = mergedNames || [rawActivity];
        const ph          = queryNames.map(() => '?').join(',');

        const activity = db.prepare('SELECT * FROM Activities WHERE Name = ?').get(queryNames[0]);

        const campers = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, c.Grade,
                   cwd.HomeGroupColor, cwd.BusRoute, cwd.ExtendedHours,
                   n.CounselorID, n.FirstName AS CounselorFirstName, n.LastName AS CounselorLastName,
                   s.ActivityName AS EnrolledActivity
            FROM Campers c
            JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
            LEFT JOIN Counselors n ON n.CounselorID = COALESCE(chg.CounselorID, c.HomeGroupCounselorID)
            WHERE s.PeriodNumber = ? AND s.ActivityName IN (${ph})
            ORDER BY cwd.HomeGroupColor, c.LastName
        `).all(activeWeek, activeWeek, activeWeek, period, ...queryNames);

        const colorGroups = [...new Set(campers.map(c => c.HomeGroupColor).filter(Boolean))];

        const locRow = db.prepare(`
            SELECT Location FROM Schedules
            WHERE PersonType = 'Instructor' AND ActivityName IN (${ph}) AND PeriodNumber = ?
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM StaffWeekSchedules
            WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName IN (${ph})
              AND Location IS NOT NULL AND Location != ''
            UNION
            SELECT Location FROM Activities
            WHERE Name IN (${ph})
              AND Location IS NOT NULL AND Location != ''
            LIMIT 1
        `).get(...queryNames, period, activeWeek, period, ...queryNames, ...queryNames);

        const staff = db.prepare(`
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
            WHERE s.PeriodNumber = ? AND s.ActivityName IN (${ph})
            UNION
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN StaffWeekSchedules sws ON sws.StaffID = st.CounselorID
            WHERE sws.WeekNumber = ? AND sws.PeriodNumber = ? AND sws.ActivityName IN (${ph})
            UNION
            SELECT st.CounselorID, st.FirstName, st.LastName, st.StaffRole AS StaffType
            FROM Counselors st JOIN CounselorScheduleAssignments csa ON csa.PersonID = st.CounselorID
            WHERE csa.WeekNumber = ? AND csa.PeriodNumber = ? AND csa.ActivityName IN (${ph})
              AND csa.PersonType IN ('Instructor', 'Staff')
        `).all(period, ...queryNames, activeWeek, period, ...queryNames, activeWeek, period, ...queryNames);

        const counselors = db.prepare(`
            SELECT DISTINCT c.CounselorID, c.FirstName, c.LastName,
                   COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID
              AND cws.WeekNumber = ? AND cws.PeriodNumber = ? AND cws.ActivityName IN (${ph})
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            ORDER BY HomeGroupColor, c.LastName
        `).all(activeWeek, period, ...queryNames, activeWeek);

        res.render('class-roster', {
            periodNumber:         period,
            activityName:         displayName,
            locationActivityName: queryNames[0],
            mergedNames,
            sideOfCamp:           activity ? activity.SideOfCamp  : null,
            maxCapacity:          activity ? activity.MaxCapacity : null,
            location:             locRow   ? locRow.Location      : null,
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

// --- SWIM LEVELS ---
const SWIM_ACTIVITY_NAMES = ['Rec Swim', 'Swim Lessons'];

// Campers enrolled in Rec Swim/Swim Lessons for a week, grouped by activity (Rec Swim
// first, then Swim Lessons), then by period ascending, alphabetical by last/first name
// within each group. A camper enrolled in swim during more than one period appears in
// each relevant group, sharing one cached level lookup so it's computed only once.
// Shared by the /swim-levels editing view and the /reports/swim-levels printable report.
function getSwimLevelGroups(week) {
    const ph = SWIM_ACTIVITY_NAMES.map(() => '?').join(',');
    const enrollments = db.prepare(`
        SELECT DISTINCT c.CamperID, c.FirstName, c.LastName, s.PeriodNumber, s.ActivityName
        FROM Campers c
        JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
        WHERE s.ActivityName IN (${ph})
    `).all(week, ...SWIM_ACTIVITY_NAMES);

    const levelCache = new Map();
    const rowFor = c => {
        if (!levelCache.has(c.CamperID)) {
            const effective = getEffectiveSwimLevel(c.CamperID, week);
            levelCache.set(c.CamperID, {
                CamperID: c.CamperID, FirstName: c.FirstName, LastName: c.LastName,
                level: formatSwimLevel(effective),
                levelNumber: effective ? effective.LevelNumber : null,
                subLevel: effective ? effective.SubLevel : null,
                testedThisWeek: !!effective && effective.WeekNumber === week
            });
        }
        return levelCache.get(c.CamperID);
    };

    const groups = [];
    for (const activityName of SWIM_ACTIVITY_NAMES) {
        const periods = [...new Set(
            enrollments.filter(e => e.ActivityName === activityName).map(e => e.PeriodNumber)
        )].sort((a, b) => a - b);
        for (const period of periods) {
            const campers = enrollments
                .filter(e => e.ActivityName === activityName && e.PeriodNumber === period)
                .map(rowFor)
                .sort((a, b) => a.LastName.localeCompare(b.LastName) || a.FirstName.localeCompare(b.FirstName));
            groups.push({ activityName, period, campers });
        }
    }
    return groups;
}

app.get('/swim-levels', (req, res) => {
    const isAdmin = req.cookies.adminAuth === 'true';
    const week = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
    const groups = getSwimLevelGroups(week);
    const weekLabel = db.prepare("SELECT label FROM Sessions WHERE weekNumber = ?").get(week)?.label || `Week ${week}`;
    res.render('swim-levels', { groups, week, weekLabel, message: req.query.message || null });
});

app.post('/swim-levels/update', (req, res) => {
    const camperId = parseInt(req.body.camperId, 10);
    const week = parseInt(req.body.weekNumber, 10);
    const levelNumber = parseInt(req.body.levelNumber, 10);
    const subLevel = ['Low', 'High'].includes(req.body.subLevel) ? req.body.subLevel : null;

    if (!camperId || !week || !levelNumber) return res.redirect('/swim-levels?message=Please+select+a+level.');

    db.prepare(`
        INSERT INTO CamperSwimLevels (CamperID, WeekNumber, LevelNumber, SubLevel, UpdatedAt)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (CamperID, WeekNumber) DO UPDATE SET
            LevelNumber = excluded.LevelNumber,
            SubLevel    = excluded.SubLevel,
            UpdatedAt   = CURRENT_TIMESTAMP
    `).run(camperId, week, levelNumber, subLevel);

    res.redirect('/swim-levels?message=Level+saved!');
});

// Printable roster: every camper enrolled in swim for a chosen session + their level.
// `/reports` is already admin-gated as a prefix (ADMIN_ONLY_PREFIXES).
app.get('/reports/swim-levels', (req, res) => {
    const sessions = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();
    const isAdmin = req.cookies.adminAuth === 'true';
    const defaultWeek = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
    const week = parseInt(req.query.week) || defaultWeek;
    const groups = getSwimLevelGroups(week);
    const weekLabel = db.prepare("SELECT label FROM Sessions WHERE weekNumber = ?").get(week)?.label || `Week ${week}`;
    res.render('swim-levels-report', { groups, week, weekLabel, sessions });
});

// --- SWIM SCHEDULING ---
// Independent of CounselorWeekSchedules/WeeklyOfferings for staffing — see the "Known
// limitation" note in wiki/Swim-Scheduling.md. Phase 3: manual assignment + auto-grouping,
// no solver yet (that's Phase 4's /swim-scheduling/auto-assign).

function getSwimSchedulingData(week) {
    const periods = [];
    for (let period = 1; period <= 6; period++) {
        const recOffered = !!db.prepare(
            "SELECT 1 FROM WeeklyOfferings WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = 'Rec Swim'"
        ).get(week, period);
        const lessonsOffered = !!db.prepare(
            "SELECT 1 FROM WeeklyOfferings WHERE WeekNumber = ? AND PeriodNumber = ? AND ActivityName = 'Swim Lessons'"
        ).get(week, period);
        if (!recOffered && !lessonsOffered) continue;

        let rec = null;
        if (recOffered) {
            const enrolledCount = db.prepare(`
                SELECT COUNT(DISTINCT s.PersonID) AS n FROM Schedules s
                WHERE s.PersonType = 'Camper' AND s.WeekNumber = ? AND s.PeriodNumber = ? AND s.ActivityName = 'Rec Swim'
            `).get(week, period).n;
            const guards = db.prepare(`
                SELECT ga.CounselorID, c.FirstName, c.LastName FROM SwimGuardAssignments ga
                JOIN Counselors c ON c.CounselorID = ga.CounselorID
                WHERE ga.WeekNumber = ? AND ga.PeriodNumber = ? AND ga.GuardRole = 'Rec'
                ORDER BY c.LastName, c.FirstName
            `).all(week, period);
            rec = { enrolledCount, requiredGuards: requiredRecGuards(enrolledCount), guards };
        }

        let lessons = null;
        if (lessonsOffered) {
            const enrolledCampers = db.prepare(`
                SELECT DISTINCT c.CamperID, c.FirstName, c.LastName
                FROM Campers c
                JOIN Schedules s ON s.PersonID = c.CamperID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
                WHERE s.PeriodNumber = ? AND s.ActivityName = 'Swim Lessons'
                ORDER BY c.LastName, c.FirstName
            `).all(week, period);

            const groupRows = db.prepare(`
                SELECT g.GroupID, g.LevelNumber, g.LevelRangeMax, g.SubLevel, g.CounselorID, g.Locked,
                       co.FirstName AS CounselorFirstName, co.LastName AS CounselorLastName, co.SwimMaxLevel
                FROM SwimLessonGroups g
                LEFT JOIN Counselors co ON co.CounselorID = g.CounselorID
                WHERE g.WeekNumber = ? AND g.PeriodNumber = ?
                ORDER BY g.LevelNumber, g.SubLevel, g.GroupID
            `).all(week, period);

            const memberStmt = db.prepare(`
                SELECT m.CamperID, c.FirstName, c.LastName
                FROM SwimLessonGroupMembers m JOIN Campers c ON c.CamperID = m.CamperID
                WHERE m.GroupID = ?
                ORDER BY c.LastName, c.FirstName
            `);
            const SUBLEVEL_SORT_ORDER = { Low: 0, High: 2 }; // plain (undefined) sorts to 1, between Low and High
            const groups = groupRows.map(g => {
                const effectiveMaxLevel = g.LevelRangeMax || g.LevelNumber;
                const isRanged = !!g.LevelRangeMax;
                const members = memberStmt.all(g.GroupID);

                // Composition is derived from each member's actual current level, not the
                // group's own LevelNumber/SubLevel — so it stays accurate after merges and
                // any manual add/remove, and always denotes Low/Nominal/High per sub-group.
                const compositionMap = new Map();
                for (const m of members) {
                    const eff = getEffectiveSwimLevel(m.CamperID, week);
                    const key = eff ? `${eff.LevelNumber}|${eff.SubLevel || 'none'}` : 'untested';
                    if (!compositionMap.has(key)) {
                        compositionMap.set(key, { levelNumber: eff?.LevelNumber ?? null, subLevel: eff?.SubLevel ?? null, count: 0 });
                    }
                    compositionMap.get(key).count++;
                }
                const composition = [...compositionMap.values()]
                    .sort((a, b) => {
                        if (a.levelNumber === null) return 1;
                        if (b.levelNumber === null) return -1;
                        if (a.levelNumber !== b.levelNumber) return a.levelNumber - b.levelNumber;
                        return (SUBLEVEL_SORT_ORDER[a.subLevel] ?? 1) - (SUBLEVEL_SORT_ORDER[b.subLevel] ?? 1);
                    })
                    .map(e => {
                        if (e.levelNumber === null) return { label: 'Not tested', count: e.count };
                        const subText = e.subLevel || 'Nominal';
                        // Only spell out "Level N" per tag when the group spans more than one
                        // level (merged) — otherwise the level is already the group header.
                        return { label: isRanged ? `Level ${e.levelNumber} (${subText})` : subText, count: e.count };
                    });

                return {
                    ...g,
                    effectiveMaxLevel,
                    levelLabel: `Level ${g.LevelNumber}${isRanged ? '–' + g.LevelRangeMax : ''}`,
                    members,
                    composition,
                    aboveLevel: !!g.CounselorID && (g.SwimMaxLevel ?? 3) < effectiveMaxLevel
                };
            });

            const groupedCamperIds = new Set(groups.flatMap(g => g.members.map(m => m.CamperID)));
            const ungrouped = enrolledCampers
                .filter(c => !groupedCamperIds.has(c.CamperID))
                .map(c => ({ ...c, level: formatSwimLevel(getEffectiveSwimLevel(c.CamperID, week)) }));

            const guards = db.prepare(`
                SELECT ga.CounselorID, c.FirstName, c.LastName FROM SwimGuardAssignments ga
                JOIN Counselors c ON c.CounselorID = ga.CounselorID
                WHERE ga.WeekNumber = ? AND ga.PeriodNumber = ? AND ga.GuardRole = 'Lessons'
                ORDER BY c.LastName, c.FirstName
            `).all(week, period);

            lessons = { groups, ungrouped, guards, requiredGuards: 2 };
        }

        periods.push({ period, rec, lessons });
    }
    return periods;
}

// Plain-language issues the swim director should look at: under-guarded periods, empty
// groups, a counselor teaching above their SwimMaxLevel, and any counselor double-booked
// (guarding and/or teaching more than one thing in the same period).
function getSwimWarnings(periods) {
    const warnings = [];
    const perPeriod = {}; // `${period}|${counselorId}` -> [labels]
    const bump = (period, counselorId, label) => {
        const key = `${period}|${counselorId}`;
        (perPeriod[key] ??= []).push(label);
    };

    for (const p of periods) {
        if (p.rec) {
            if (p.rec.guards.length < p.rec.requiredGuards) {
                warnings.push(`Period ${p.period}: Rec Swim needs ${p.rec.requiredGuards} guard(s), has ${p.rec.guards.length}`);
            }
            p.rec.guards.forEach(g => bump(p.period, g.CounselorID, `${g.FirstName} ${g.LastName} guarding Rec Swim`));
        }
        if (p.lessons) {
            if (p.lessons.guards.length < p.lessons.requiredGuards) {
                warnings.push(`Period ${p.period}: Swim Lessons needs ${p.lessons.requiredGuards} guard(s), has ${p.lessons.guards.length}`);
            }
            p.lessons.guards.forEach(g => bump(p.period, g.CounselorID, `${g.FirstName} ${g.LastName} guarding Swim Lessons`));
            p.lessons.groups.forEach(g => {
                if (g.members.length === 0) warnings.push(`Period ${p.period}: ${g.levelLabel} group is empty`);
                if (g.CounselorID) {
                    bump(p.period, g.CounselorID, `${g.CounselorFirstName} ${g.CounselorLastName} teaching ${g.levelLabel}`);
                    if (g.aboveLevel) {
                        warnings.push(`Period ${p.period}: ${g.CounselorFirstName} ${g.CounselorLastName} is teaching ${g.levelLabel}, above their max level`);
                    }
                }
            });
        }
    }

    for (const key in perPeriod) {
        if (perPeriod[key].length > 1) {
            const period = key.split('|')[0];
            warnings.push(`Period ${period}: double-booked — ${perPeriod[key].join(' AND ')}`);
        }
    }
    return warnings;
}

app.get('/swim-scheduling', (req, res) => {
    const isAdmin = req.cookies.adminAuth === 'true';
    const week = parseInt(req.query.week) || (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
    const sessions = db.prepare('SELECT * FROM Sessions ORDER BY weekNumber').all();
    const weekLabel = db.prepare("SELECT label FROM Sessions WHERE weekNumber = ?").get(week)?.label || `Week ${week}`;

    const periods = getSwimSchedulingData(week);
    const warnings = getSwimWarnings(periods);

    const tally = getCounselorWaterTally(week);
    const swimCounselors = db.prepare(
        "SELECT CounselorID, FirstName, LastName, SwimMaxLevel FROM Counselors WHERE StaffRole = 'Swim Counselor' ORDER BY LastName, FirstName"
    ).all().map(c => ({ ...c, inWater: tally[c.CounselorID]?.inWater || 0, outWater: tally[c.CounselorID]?.outWater || 0 }));

    res.render('swim-scheduling', {
        week, weekLabel, sessions, periods, warnings, swimCounselors,
        message: req.query.message || null
    });
});

app.post('/swim-scheduling/generate-groups', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
    const count = generateGroupsForWeek(week);
    res.redirect(`/swim-scheduling?week=${week}&message=Generated+${count}+lesson+groups`);
});

app.post('/swim-scheduling/create-group', (req, res) => {
    const week = parseInt(req.body.weekNumber);
    const period = parseInt(req.body.periodNumber);
    const levelNumber = parseInt(req.body.levelNumber);
    const subLevel = ['Low', 'High'].includes(req.body.subLevel) ? req.body.subLevel : null;
    if (week && period && levelNumber) {
        db.prepare('INSERT INTO SwimLessonGroups (WeekNumber, PeriodNumber, LevelNumber, SubLevel) VALUES (?, ?, ?, ?)')
            .run(week, period, levelNumber, subLevel);
    }
    res.redirect(`/swim-scheduling?week=${week}&message=Group+created`);
});

app.post('/swim-scheduling/delete-group', (req, res) => {
    const groupId = parseInt(req.body.groupId);
    const week = parseInt(req.body.weekNumber);
    db.prepare('DELETE FROM SwimLessonGroups WHERE GroupID = ?').run(groupId);
    res.redirect(`/swim-scheduling?week=${week}&message=Group+deleted`);
});

// Combines two groups in the same period into one — for small adjacent-level classes
// (e.g. 2 kids at Level 5, 1 at Level 6) that don't need separate instructors. The
// source group's campers move into the target group, the target's level widens to cover
// both (LevelNumber = min, LevelRangeMax = max), its SubLevel is cleared (no longer
// single-level), and it's locked so Generate Groups won't split it back apart. The
// source group is deleted. The target keeps whichever instructor it already had, if any.
app.post('/swim-scheduling/merge-group', (req, res) => {
    const week = parseInt(req.body.weekNumber);
    const sourceGroupId = parseInt(req.body.sourceGroupId);
    const targetGroupId = parseInt(req.body.targetGroupId);
    if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
        return res.redirect(`/swim-scheduling?week=${week}&message=Invalid+merge`);
    }

    const source = db.prepare('SELECT * FROM SwimLessonGroups WHERE GroupID = ?').get(sourceGroupId);
    const target = db.prepare('SELECT * FROM SwimLessonGroups WHERE GroupID = ?').get(targetGroupId);
    if (!source || !target || source.WeekNumber !== target.WeekNumber || source.PeriodNumber !== target.PeriodNumber) {
        return res.redirect(`/swim-scheduling?week=${week}&message=Groups+must+be+in+the+same+period`);
    }

    db.transaction(() => {
        const members = db.prepare('SELECT CamperID FROM SwimLessonGroupMembers WHERE GroupID = ?').all(sourceGroupId);
        const insMember = db.prepare('INSERT OR IGNORE INTO SwimLessonGroupMembers (GroupID, CamperID) VALUES (?, ?)');
        for (const m of members) insMember.run(targetGroupId, m.CamperID);

        const newMin = Math.min(source.LevelNumber, target.LevelNumber);
        const newMax = Math.max(source.LevelRangeMax || source.LevelNumber, target.LevelRangeMax || target.LevelNumber);
        db.prepare(`
            UPDATE SwimLessonGroups
            SET LevelNumber = ?, LevelRangeMax = ?, SubLevel = NULL, Locked = 1
            WHERE GroupID = ?
        `).run(newMin, newMax > newMin ? newMax : null, targetGroupId);

        db.prepare('DELETE FROM SwimLessonGroups WHERE GroupID = ?').run(sourceGroupId);
    })();

    res.redirect(`/swim-scheduling?week=${week}&message=Groups+merged`);
});

app.post('/swim-scheduling/toggle-group-lock', (req, res) => {
    const groupId = parseInt(req.body.groupId);
    const week = parseInt(req.body.weekNumber);
    db.prepare('UPDATE SwimLessonGroups SET Locked = 1 - Locked WHERE GroupID = ?').run(groupId);
    res.redirect(`/swim-scheduling?week=${week}&message=Lock+updated`);
});

app.post('/swim-scheduling/assign-instructor', (req, res) => {
    const groupId = parseInt(req.body.groupId);
    const week = parseInt(req.body.weekNumber);
    const counselorId = parseInt(req.body.counselorId) || null;
    db.prepare('UPDATE SwimLessonGroups SET CounselorID = ? WHERE GroupID = ?').run(counselorId, groupId);
    res.redirect(`/swim-scheduling?week=${week}&message=Instructor+updated`);
});

app.post('/swim-scheduling/assign-camper', (req, res) => {
    const groupId = parseInt(req.body.groupId);
    const camperId = parseInt(req.body.camperId);
    const week = parseInt(req.body.weekNumber);
    if (groupId && camperId) {
        db.prepare('INSERT OR IGNORE INTO SwimLessonGroupMembers (GroupID, CamperID) VALUES (?, ?)').run(groupId, camperId);
    }
    res.redirect(`/swim-scheduling?week=${week}&message=Camper+added`);
});

app.post('/swim-scheduling/remove-camper', (req, res) => {
    const groupId = parseInt(req.body.groupId);
    const camperId = parseInt(req.body.camperId);
    const week = parseInt(req.body.weekNumber);
    db.prepare('DELETE FROM SwimLessonGroupMembers WHERE GroupID = ? AND CamperID = ?').run(groupId, camperId);
    res.redirect(`/swim-scheduling?week=${week}&message=Camper+removed`);
});

app.post('/swim-scheduling/save-guards', (req, res) => {
    const week = parseInt(req.body.weekNumber);
    const period = parseInt(req.body.periodNumber);
    const guardRole = ['Rec', 'Lessons'].includes(req.body.guardRole) ? req.body.guardRole : null;
    if (!week || !period || !guardRole) return res.redirect(`/swim-scheduling?week=${week}&message=Invalid+guard+update`);

    const counselorIds = [].concat(req.body.counselorIds || []).map(Number).filter(Boolean);
    const ins = db.prepare('INSERT OR IGNORE INTO SwimGuardAssignments (WeekNumber, PeriodNumber, GuardRole, CounselorID) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
        db.prepare('DELETE FROM SwimGuardAssignments WHERE WeekNumber = ? AND PeriodNumber = ? AND GuardRole = ?').run(week, period, guardRole);
        for (const id of counselorIds) ins.run(week, period, guardRole, id);
    })();

    res.redirect(`/swim-scheduling?week=${week}&message=Guards+updated`);
});

// Bulk-edit SwimMaxLevel for every swim counselor at once from the "Edit Swim
// Certifications" panel — same field, same certification, as the counselor profile's
// Edit Profile form, just editable for everyone in one place.
app.post('/swim-scheduling/save-certifications', (req, res) => {
    const week = parseInt(req.body.weekNumber);
    const counselorIds = [].concat(req.body.counselorId || []).map(Number);
    const levels = [].concat(req.body.swimMaxLevel || []);

    const upd = db.prepare('UPDATE Counselors SET SwimMaxLevel = ? WHERE CounselorID = ?');
    db.transaction(() => {
        counselorIds.forEach((id, i) => {
            if (!id) return;
            const raw = parseInt(levels[i], 10);
            const level = (raw >= 1 && raw <= 6) ? raw : null;
            upd.run(level, id);
        });
    })();

    res.redirect(`/swim-scheduling?week=${week}&message=Certifications+updated`);
});

// Phase 4: full auto-solver. Fills every open guard slot and un-instructored lesson group
// for the week in one pass — see autoAssignWeek() for the eligibility/fairness rules. Locked
// groups, groups with an instructor already, and existing guard assignments are untouched.
app.post('/swim-scheduling/auto-assign', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
    const { filled, unfilled } = autoAssignWeek(week);
    const text = unfilled > 0
        ? `Auto-assigned ${filled} slots, ${unfilled} could not be filled`
        : `Auto-assigned ${filled} slots`;
    res.redirect(`/swim-scheduling?week=${week}&message=${text.replace(/ /g, '+')}`);
});

app.get('/search', (req, res) => {
    try {
        const query = req.query.name || '';
        const aw = getActiveWeek();
        const camperList = db.prepare(`
            SELECT
                c.*,
                COALESCE(cwd.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
                COALESCE(cwd.BusRoute,       c.BusRoute)       AS BusRoute,
                COALESCE(cwd.ExtendedHours,  c.ExtendedHours)  AS ExtendedHours,
                COALESCE(chg.CounselorID, c.HomeGroupCounselorID) AS HomeGroupCounselorIDResolved,
                n.FirstName || ' ' || n.LastName AS HomeCounselorName,
                s1.ActivityName AS P1,
                s2.ActivityName AS P2,
                s3.ActivityName AS P3,
                s4.ActivityName AS P4,
                s5.ActivityName AS P5,
                s6.ActivityName AS P6
            FROM Campers c
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
            LEFT JOIN Counselors n ON COALESCE(chg.CounselorID, c.HomeGroupCounselorID) = n.CounselorID
            LEFT JOIN Schedules s1 ON c.CamperID = s1.PersonID AND s1.PeriodNumber = 1 AND s1.PersonType = 'Camper' AND s1.WeekNumber = ?
            LEFT JOIN Schedules s2 ON c.CamperID = s2.PersonID AND s2.PeriodNumber = 2 AND s2.PersonType = 'Camper' AND s2.WeekNumber = ?
            LEFT JOIN Schedules s3 ON c.CamperID = s3.PersonID AND s3.PeriodNumber = 3 AND s3.PersonType = 'Camper' AND s3.WeekNumber = ?
            LEFT JOIN Schedules s4 ON c.CamperID = s4.PersonID AND s4.PeriodNumber = 4 AND s4.PersonType = 'Camper' AND s4.WeekNumber = ?
            LEFT JOIN Schedules s5 ON c.CamperID = s5.PersonID AND s5.PeriodNumber = 5 AND s5.PersonType = 'Camper' AND s5.WeekNumber = ?
            LEFT JOIN Schedules s6 ON c.CamperID = s6.PersonID AND s6.PeriodNumber = 6 AND s6.PersonType = 'Camper' AND s6.WeekNumber = ?
            WHERE (
                cwd.CamperID IS NOT NULL
                OR EXISTS (
                    SELECT 1 FROM Schedules sw
                    WHERE sw.PersonID = c.CamperID AND sw.PersonType = 'Camper' AND sw.WeekNumber = ?
                )
            )
            AND ((c.FirstName || ' ' || c.LastName LIKE ?) OR (? = ''))
            ORDER BY c.LastName ASC
        `).all(aw, aw, aw, aw, aw, aw, aw, aw, aw, `%${query}%`, query);

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
    const isAdmin = req.cookies.adminAuth === 'true';
    const aw = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
    const isPrepping = isAdmin && getPrepTargetWeek() === aw && aw !== getActiveWeek();
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
    const prepWeekLabel = isPrepping
        ? (db.prepare("SELECT label FROM Sessions WHERE weekNumber = ?").get(aw)?.label || `Week ${aw}`)
        : null;
    res.render('counselor-view', { counselor, schedule, instructorSchedule, campers, staffWeekSchedules, allActivities, message, prepWeekLabel });
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
            SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Age, c.Grade, c.ShirtSize,
                   c.HomeGroupCounselorID,
                   cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
                   cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM, cwd.BusStopAM, cwd.BusStopPM,
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
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            WHERE c.CamperID = ?
        `).get(aw, aw, aw, req.params.id);

        if (!camper) return res.status(404).send('Camper not found');

        const schedule = db.prepare(`
            SELECT s.PeriodNumber, s.ActivityName,
                COALESCE(
                    (SELECT loc.Location FROM Schedules loc
                     WHERE loc.PersonType = 'Instructor' AND loc.ActivityName = s.ActivityName
                       AND loc.PeriodNumber = s.PeriodNumber AND loc.WeekNumber = s.WeekNumber
                       AND loc.Location IS NOT NULL AND loc.Location != '' LIMIT 1),
                    (SELECT sws.Location FROM StaffWeekSchedules sws
                     WHERE sws.WeekNumber = s.WeekNumber AND sws.PeriodNumber = s.PeriodNumber
                       AND sws.ActivityName = s.ActivityName COLLATE NOCASE
                       AND sws.Location IS NOT NULL AND sws.Location != '' LIMIT 1),
                    (SELECT act.Location FROM Activities act WHERE act.Name = s.ActivityName LIMIT 1)
                ) AS Location,
                a.SideOfCamp
            FROM Schedules s
            LEFT JOIN Activities a ON s.ActivityName = a.Name
            WHERE s.PersonID = ? AND s.PersonType = 'Camper' AND s.WeekNumber = ?
            ORDER BY s.PeriodNumber ASC
        `).all(req.params.id, aw);

        // SPLIT campers have periods 1,2,5,6 — inject a display-only period 3 row
        if (camper.HomeGroupColor === 'SPLIT' && !schedule.some(s => s.PeriodNumber === 3)) {
            const insertAt = schedule.findIndex(s => s.PeriodNumber > 3);
            schedule.splice(insertAt === -1 ? schedule.length : insertAt, 0,
                { PeriodNumber: 3, ActivityName: 'SPLIT Sport', Location: null, SideOfCamp: 'Sports' });
        }

        const getStaff = db.prepare(`
            SELECT st.FirstName, st.LastName, st.StaffRole
            FROM Counselors st JOIN Schedules s ON st.CounselorID = s.PersonID AND s.PersonType = 'Instructor'
            WHERE s.PeriodNumber = ? AND s.ActivityName = ?
            UNION
            SELECT st.FirstName, st.LastName, st.StaffRole
            FROM Counselors st JOIN StaffWeekSchedules sws ON sws.StaffID = st.CounselorID
            WHERE sws.WeekNumber = ? AND sws.PeriodNumber = ? AND sws.ActivityName = ? COLLATE NOCASE
            UNION
            SELECT st.FirstName, st.LastName, st.StaffRole
            FROM Counselors st JOIN CounselorScheduleAssignments csa ON csa.PersonID = st.CounselorID
            WHERE csa.WeekNumber = ? AND csa.PeriodNumber = ? AND csa.ActivityName = ? COLLATE NOCASE
              AND csa.PersonType IN ('Instructor', 'Staff')
        `);
        const getCounselors = db.prepare(`
            SELECT c.FirstName, c.LastName, COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Counselors c
            JOIN CounselorWeekSchedules cws ON cws.CounselorID = c.CounselorID
                AND cws.WeekNumber = ? AND cws.PeriodNumber = ? AND cws.ActivityName = ? COLLATE NOCASE
            LEFT JOIN CounselorWeekAttributes cwa ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            ORDER BY HomeGroupColor, c.LastName
        `);
        for (const row of schedule) {
            if (row.ActivityName === 'SPLIT Sport') { row.staff = []; row.classCounselors = []; continue; }
            row.staff = getStaff.all(row.PeriodNumber, row.ActivityName, aw, row.PeriodNumber, row.ActivityName, aw, row.PeriodNumber, row.ActivityName);
            row.classCounselors = getCounselors.all(aw, row.PeriodNumber, row.ActivityName, aw);
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
        const { homeGroupCounselorID, busRoute, busRidesAM, busRidesPM, extendedHours, campLunch, preferredName } = req.body;
        const cleanRoute = busRoute ? busRoute.trim() : null;
        const cleanPreferred = (preferredName || '').trim() || null;
        const aw = getActiveWeek();
        db.prepare("UPDATE Campers SET HomeGroupCounselorID=?, PreferredName=? WHERE CamperID=?")
            .run(homeGroupCounselorID ? parseInt(homeGroupCounselorID) : null, cleanPreferred, req.params.id);
        db.prepare(`
            INSERT INTO CamperWeekData (CamperID, WeekNumber, BusRoute, BusRidesAM, BusRidesPM, ExtendedHours, CampLunch)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(CamperID, WeekNumber) DO UPDATE SET
                BusRoute      = excluded.BusRoute,
                BusRidesAM    = excluded.BusRidesAM,
                BusRidesPM    = excluded.BusRidesPM,
                ExtendedHours = excluded.ExtendedHours,
                CampLunch     = excluded.CampLunch
        `).run(
            req.params.id, aw,
            cleanRoute,
            cleanRoute ? (busRidesAM === '1' ? 1 : 0) : 0,
            cleanRoute ? (busRidesPM === '1' ? 1 : 0) : 0,
            extendedHours || null,
            campLunch || 'No'
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
    const aw = getActiveWeek();
    const activities = db.prepare('SELECT * FROM Activities ORDER BY SideOfCamp, Name').all();
    const activeActivityNames = new Set(
        db.prepare("SELECT DISTINCT ActivityName FROM Schedules WHERE PersonType='Camper' AND WeekNumber=?")
          .all(aw).map(r => r.ActivityName)
    );
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
    const prepTargetWeek = getPrepTargetWeek();
    const mapBuildings = db.prepare('SELECT id, name, map, x, y FROM BuildingCoordinates ORDER BY map, name').all();
    const mapUsedLocations = db.prepare(`
        SELECT DISTINCT Location FROM (
            SELECT Location FROM Schedules WHERE PersonType='Instructor' AND Location IS NOT NULL AND Location != ''
            UNION SELECT Location FROM StaffWeekSchedules WHERE Location IS NOT NULL AND Location != ''
            UNION SELECT Location FROM Activities WHERE Location IS NOT NULL AND Location != ''
        ) ORDER BY Location
    `).all().map(r => r.Location);
    res.render('settings', {
        activities, activeActivityNames, activeWeek: aw,
        periodOverrides, sessions, alertMessage: req.query.message,
        confirmWeek: req.query.confirmWeek || null, weekCount: req.query.weekCount || null,
        confirmOfferWeek: req.query.confirmOfferWeek || null, offerCount: req.query.offerCount || null,
        pdfExists, docs: PDF_DOCS, prepTargetWeek,
        buildings: mapBuildings, usedLocations: mapUsedLocations
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

    const weekNumber = parseInt(req.body.weekNumber) || getActiveWeek();

    try {
        const result = db.prepare(`
            INSERT INTO Campers (FirstName, LastName, Grade, Age, ShirtSize)
            VALUES (?, ?, ?, ?, ?)
        `).run(firstName, lastName, grade, grade, shirtSize);

        const newId = result.lastInsertRowid;
        db.prepare(`
            INSERT OR REPLACE INTO CamperWeekData (CamperID, WeekNumber, HomeGroupColor, BusRoute, ExtendedHours, CampLunch)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(newId, weekNumber, homeGroupColor, busRoute, extendedHours, campLunch);

        res.redirect(`/assign-camper-schedule/${newId}`);
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Error+adding+camper');
    }
});

// --- CREATE BLANK CLASS ---
app.post('/create-blank-class', (req, res) => {
    const activityName = (req.body.activityName || '').trim();
    const periodNumber = parseInt(req.body.periodNumber);
    const sideOfCamp   = (req.body.sideOfCamp || '').trim();

    if (!activityName || !periodNumber || !sideOfCamp) {
        return res.redirect('/settings?message=Class+name,+period,+and+side+are+required');
    }

    const weekNumber = parseInt(req.body.weekNumber) || getActiveWeek();
    try {
        db.prepare(`INSERT OR IGNORE INTO Activities (Name, SideOfCamp, MaxCapacity) VALUES (?, ?, 20)`)
            .run(activityName, sideOfCamp);
        db.prepare(`INSERT OR IGNORE INTO WeeklyOfferings (ActivityName, PeriodNumber, SideOfCamp, WeekNumber, PreliminaryEnrollment) VALUES (?, ?, ?, ?, 0)`)
            .run(activityName, periodNumber, sideOfCamp, weekNumber);
        res.redirect('/settings?message=Blank+class+created');
    } catch (err) {
        console.error(err);
        res.redirect('/settings?message=Error+creating+class');
    }
});

// --- ASSIGN CAMPER SCHEDULE (view) ---
app.get('/assign-camper-schedule/:id', (req, res) => {
    const id = req.params.id;
    const tw = getPrepTargetWeek() || getActiveWeek();
    const camper = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(tw, id);
    if (!camper) return res.redirect('/settings?message=Camper+not+found');

    const scheduleRows = db.prepare(`
        SELECT PeriodNumber, ActivityName FROM Schedules
        WHERE PersonID = ? AND PersonType = 'Camper' AND WeekNumber = ?
        ORDER BY PeriodNumber ASC
    `).all(id, tw);

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
    const week = getPrepTargetWeek() || getActiveWeek();

    const camper = db.prepare(`
        SELECT cwd.HomeGroupColor FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(week, camperId);
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
                    WHERE s.ActivityName = wo.ActivityName AND s.PeriodNumber = @period
                      AND s.PersonType = 'Camper' AND s.WeekNumber = @week
                      AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=@week AND HomeGroupColor='SPLIT')
                   ) AS CurrentEnrollment
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

    const tw = getPrepTargetWeek() || getActiveWeek();

    // Check capacity (use WeeklyOfferings capacity override if present)
    const offering = db.prepare(`
        SELECT COALESCE(wo.MaxCapacity, a.MaxCapacity) AS MaxCapacity
        FROM WeeklyOfferings wo
        JOIN Activities a ON a.Name = wo.ActivityName
        WHERE wo.ActivityName = ? AND wo.PeriodNumber = ? AND wo.WeekNumber = ?
    `).get(activity, period, tw);

    const maxCap = offering ? offering.MaxCapacity : act.MaxCapacity;

    const enrollment = db.prepare(`
        SELECT COUNT(*) as count FROM Schedules s
        WHERE s.ActivityName = ? AND s.PeriodNumber = ? AND s.PersonType = 'Camper' AND s.WeekNumber = ?
          AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor='SPLIT')
    `).get(activity, period, tw, tw).count;

    if (enrollment >= maxCap) {
        db.prepare(`
            INSERT INTO Waitlists (CamperID, PeriodNumber, RequestedActivity, WeekNumber)
            VALUES (?, ?, ?, ?)
        `).run(camperId, period, activity, tw);
        return res.redirect(`/assign-camper-schedule/${camperId}?message=Class+full+%E2%80%94+added+to+waitlist`);
    }

    // DELETE + INSERT in a transaction
    db.transaction(() => {
        db.prepare(`
            DELETE FROM Schedules WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?
        `).run(camperId, period, tw);
        db.prepare(`
            INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, WeekNumber)
            VALUES (?, 'Camper', ?, ?, ?)
        `).run(camperId, period, activity, tw);
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

app.post('/sync-activity-groups', (req, res) => {
    const aw = getActiveWeek();
    if (!aw) return res.redirect('/settings?message=No+active+week+set');
    const syncedCount = syncActivityGroups(aw);
    res.redirect(`/settings?message=Synced+group+assignments+for+${syncedCount}+activit${syncedCount !== 1 ? 'ies' : 'y'}+from+Week+${aw}`);
});

// --- WAITLIST & PROMOTIONS ---
app.get('/promotions', (req, res) => {
    const aw = getActiveWeek();
    const enrollmentSubq = `(SELECT COUNT(*) FROM Schedules s
        WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber
          AND s.PersonType = 'Camper' AND s.WeekNumber = ${aw}
          AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ${aw} AND HomeGroupColor = 'SPLIT'))`;
    const potentialPromotions = db.prepare(`
        SELECT w.*, c.FirstName, c.LastName, cwd.HomeGroupColor, a.MaxCapacity,
        ${enrollmentSubq} as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ${aw}
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE w.WeekNumber = ${aw} AND CurrentEnrollment < a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();
    const waitlistQueue = db.prepare(`
        SELECT w.*, c.FirstName, c.LastName, cwd.HomeGroupColor, a.MaxCapacity,
        ${enrollmentSubq} as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ${aw}
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE w.WeekNumber = ${aw} AND CurrentEnrollment >= a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();
    res.render('promotions', { potentialPromotions, waitlistQueue, alertMessage: req.query.message || null });
});

app.post('/promote-waitlist', (req, res) => {
    const aw = getActiveWeek();
    const entry = db.prepare('SELECT * FROM Waitlists WHERE WaitlistID = ?').get(req.body.WaitlistID);
    if (entry) {
        // Re-check capacity to guard against race conditions
        const activity = db.prepare('SELECT MaxCapacity FROM Activities WHERE Name = ?').get(entry.RequestedActivity);
        const currentCount = db.prepare(
            `SELECT COUNT(*) as count FROM Schedules s
             WHERE s.ActivityName = ? AND s.PeriodNumber = ? AND s.PersonType = 'Camper' AND s.WeekNumber = ?
               AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ? AND HomeGroupColor = 'SPLIT')`
        ).get(entry.RequestedActivity, entry.PeriodNumber, aw, aw);

        if (activity && currentCount.count >= activity.MaxCapacity) {
            return res.redirect('/promotions?message=Spot+was+already+filled+by+another+camper');
        }

        db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?`)
            .run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber, aw);
        db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(req.body.WaitlistID);
    }
    res.redirect('/promotions?message=Camper+Promoted');
});

app.post('/force-promote-waitlist', (req, res) => {
    const aw = getActiveWeek();
    const entry = db.prepare('SELECT * FROM Waitlists WHERE WaitlistID = ?').get(req.body.WaitlistID);
    if (entry) {
        db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?`)
            .run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber, aw);
        db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(entry.WaitlistID);
    }
    res.redirect('/promotions?message=Camper+force-promoted+(over+capacity)');
});

// Promote ALL eligible waitlisted campers at once
app.post('/promote-all', (req, res) => {
    const aw = getActiveWeek();
    const eligible = db.prepare(`
        SELECT w.*, a.MaxCapacity,
        (SELECT COUNT(*) FROM Schedules s
         WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber
           AND s.PersonType = 'Camper' AND s.WeekNumber = ${aw}
           AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ${aw} AND HomeGroupColor = 'SPLIT')) as CurrentEnrollment
        FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE w.WeekNumber = ${aw} AND CurrentEnrollment < a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();

    const promoteAll = db.transaction((entries) => {
        let promoted = 0;
        for (const entry of entries) {
            // Re-check live enrollment inside transaction to avoid double-filling
            const liveCount = db.prepare(
                `SELECT COUNT(*) as count FROM Schedules s
                 WHERE s.ActivityName = ? AND s.PeriodNumber = ? AND s.PersonType = 'Camper' AND s.WeekNumber = ?
                   AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ? AND HomeGroupColor = 'SPLIT')`
            ).get(entry.RequestedActivity, entry.PeriodNumber, aw, aw);
            if (liveCount.count < entry.MaxCapacity) {
                db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?`)
                    .run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber, aw);
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
    res.redirect('/promotions?message=Promotion+denied');
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

// ACR-005 roster upload: upserts campers with color, lunch, shirt size, and raw
// session codes (e.g. "SP01/SP02/SP03", used to compute shirt order quantity).
// Parses homegroup section headers to assign CamperHomeGroups for the active week.
// Does NOT touch bus data (BusRoute, BusRidesAM/PM, BusStopAM/PM) — those come from
// ACR-132/133. Does NOT touch Grade, ExtendedHours, or Schedules.
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

        // Column availability varies by export — only write what the page carries,
        // so re-imports never reset data the page doesn't contain. Ext hours also
        // require at least one populated cell: KP/LP exports have been seen with
        // the Ext AM/PM columns present but entirely blank while the ACR-003
        // report (the KP/LP ext-hours authority) had the real values — a blank
        // page must not wipe those.
        const heads = headerFields.map(h => h.trim());
        const hasLunchCol = heads.includes('Lunch');
        const cellVal = v => { const s = (v || '').trim(); return s.toLowerCase() === 'null' ? '' : s; };
        const hasExtData = (heads.includes('Ext AM') || heads.includes('Ext PM'))
            && dataRows.some(r => cellVal(r['Ext AM']) || cellVal(r['Ext PM']));
        sections.push({ counselorName, dataRows, hasLunchCol, hasExtData });
    }

    if (sections.length === 0) return res.redirect('/settings?message=Invalid+file+format+(ACR-005+expected)');

    const safeTrim = v => { const s = (v && typeof v === 'string') ? v.trim() : ''; return s.toLowerCase() === 'null' ? '' : s; };
    const findCamper    = db.prepare("SELECT CamperID FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const findCamperWd  = db.prepare("SELECT CampLunch FROM CamperWeekData WHERE CamperID=? AND WeekNumber=?");
    const insertCamper  = db.prepare("INSERT INTO Campers (FirstName, LastName, ShirtSize, SessionCodes) VALUES (?,?,?,?)");
    const updateCamper  = db.prepare("UPDATE Campers SET ShirtSize=?, SessionCodes=? WHERE CamperID=?");
    // Lunch and extended hours are only overwritten when the page actually has
    // those columns (@hasLunch / @hasExt). ACR-005 is the ExtendedHours source
    // for specialty campers — ACR-255 only covers Summer Place.
    const upsertWeekData = db.prepare(`
        INSERT INTO CamperWeekData (CamperID, WeekNumber, HomeGroupColor, CampLunch, ExtendedHours)
        VALUES (@id, @wk, @color, COALESCE(@lunch, 'No'), @ext)
        ON CONFLICT(CamperID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            CampLunch      = CASE WHEN @hasLunch THEN excluded.CampLunch      ELSE CamperWeekData.CampLunch      END,
            ExtendedHours  = CASE WHEN @hasExt   THEN excluded.ExtendedHours  ELSE CamperWeekData.ExtendedHours  END
    `);
    const findCounselor = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const upsertHg      = db.prepare("INSERT OR REPLACE INTO CamperHomeGroups (CamperID, WeekNumber, CounselorID) VALUES (?,?,?)");
    const aw = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();

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

                    const color        = mapColor(safeTrim(row['Color']));
                    const shirt        = safeTrim(row['T-Shirt']) || null;
                    const sessionCodes = safeTrim(row['Sessions']) || null;
                    const lunchRaw     = safeTrim(row['Lunch']);
                    const fullName = `${firstName} ${lastName}`;
                    const existing = findCamper.get(fullName);

                    let camperId;
                    if (existing) {
                        updateCamper.run(shirt, sessionCodes, existing.CamperID);
                        camperId = existing.CamperID;
                    } else {
                        const info = insertCamper.run(firstName, lastName, shirt, sessionCodes);
                        camperId = info.lastInsertRowid;
                    }

                    // Preserve Allergy lunch flag — never overwrite with a non-allergy value
                    const existingWd = findCamperWd.get(camperId, aw);
                    const lunch = existingWd?.CampLunch === 'Allergy' ? 'Allergy' : (lunchRaw || 'No');
                    const extAM = safeTrim(row['Ext AM']);
                    const extPM = safeTrim(row['Ext PM']);
                    const ext = (extAM && extPM) ? 'Both' : (extAM ? 'AM' : (extPM ? 'PM' : null));
                    upsertWeekData.run({
                        id: camperId, wk: aw, color, lunch, ext,
                        hasLunch: section.hasLunchCol ? 1 : 0,
                        hasExt:   section.hasExtData  ? 1 : 0
                    });

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

// --- BUS ATTENDANCE REPORTS (ACR-132 AM / ACR-133 PM) ---
// These reports list EVERY camper exactly once, grouped under explicit "Bus N" sections with the
// stop, plus a top "No Bus" group (non-riders) and per-bus "No Bus N AM/PM" groups (riders who skip
// that one direction). That makes them an unambiguous source for route number + per-direction ride
// flag — no stop-name guessing or audit needed. Parsed into [{ name, route, rides }] per camper.
function parseBusAttendanceReport(rawText) {
    const lines = rawText.split(/\r?\n/);
    const out = [];
    let route = null, rides = 0, started = false;
    const isCamperRow = f => f[0] && f[0].includes(',') && f[1] && f[1].trim() !== '' && f[0] !== 'Camper';
    for (const line of lines) {
        const fields = parseCsvLine(line);
        const f0 = (fields[0] || '').trim();
        // Skip everything before the first "No Bus" group header (title / filter preamble).
        if (!started) { if (f0 === 'No Bus') { started = true; route = null; rides = 0; } continue; }
        if (!f0) continue;                                   // blank first col: date rows, stop-total rows
        if (/Total:/i.test(line)) continue;                  // "Bus Stop Total: N", "Bus N ... Total: M"
        if (f0 === 'No Bus') { route = null; rides = 0; continue; }            // top no-bus group
        if (f0 === 'Unknown' || f0 === 'Camper' || f0.startsWith('To go') || f0.startsWith('ACR-13')) continue;
        let m = /^Bus\s+(\d+)\s*\(/i.exec(f0);
        if (m) { route = parseInt(m[1], 10); rides = 1; continue; }            // "Bus 4 (Blackberry) - ..."
        m = /^No Bus\s+(\d+)\s+(AM|PM)/i.exec(f0);
        if (m) { route = parseInt(m[1], 10); rides = 0; continue; }            // associated w/ bus, skips this dir
        if (isCamperRow(fields)) { out.push({ name: f0, route, rides }); continue; }
        // Anything else inside a bus is a stop header (e.g. "Wolcott Park - ... - 7:56") → riders follow.
        if (route !== null) rides = 1;
    }
    return out;
}

// Applies a parsed bus report to the given direction. Update-only by name (campers must already
// exist from the roster import). Sets BusRoute when the report knows it; always sets the ride flag.
function importBusReport(rawText, dir /* 'AM' | 'PM' */, weekNumber) {
    const ridesCol = dir === 'PM' ? 'BusRidesPM' : 'BusRidesAM';
    const rows = parseBusAttendanceReport(rawText);
    const findCamper = db.prepare("SELECT CamperID FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const upsertWd   = db.prepare(`
        INSERT INTO CamperWeekData (CamperID, WeekNumber, BusRoute, ${ridesCol})
        VALUES (?, ?, ?, ?)
        ON CONFLICT(CamperID, WeekNumber) DO UPDATE SET
            BusRoute  = CASE WHEN excluded.BusRoute IS NOT NULL THEN excluded.BusRoute ELSE BusRoute END,
            ${ridesCol} = excluded.${ridesCol}
    `);
    let matched = 0;
    db.transaction(() => {
        for (const r of rows) {
            const { firstName, lastName } = parseLastFirst(r.name);
            if (!firstName && !lastName) continue;
            const existing = findCamper.get(`${firstName} ${lastName}`);
            if (!existing) continue;
            upsertWd.run(existing.CamperID, weekNumber, r.route !== null ? String(r.route) : null, r.rides);
            matched++;
        }
    })();
    return { parsed: rows.length, matched };
}

// ACR-132 — AM Bus Attendance
app.post('/upload-bus-am', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
    if (!/AM Bus Attendance|ACR-132/i.test(rawText))
        return res.redirect('/settings?message=Invalid+file+format+(AM+Bus+Attendance+ACR-132+expected)');
    const wk = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
    try {
        const { matched } = importBusReport(rawText, 'AM', wk);
        res.redirect(`/settings?message=AM+Bus+Import+Success+(${matched}+campers)`);
    } catch (err) {
        console.error('ACR-132 AM bus upload error:', err);
        res.redirect('/settings?message=Database+Error+Check+Console');
    }
});

// ACR-133 — PM Bus Attendance
app.post('/upload-bus-pm', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
    if (!/PM Bus Attendance|ACR-133/i.test(rawText))
        return res.redirect('/settings?message=Invalid+file+format+(PM+Bus+Attendance+ACR-133+expected)');
    const wk = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
    try {
        const { matched } = importBusReport(rawText, 'PM', wk);
        res.redirect(`/settings?message=PM+Bus+Import+Success+(${matched}+campers)`);
    } catch (err) {
        console.error('ACR-133 PM bus upload error:', err);
        res.redirect('/settings?message=Database+Error+Check+Console');
    }
});

// --- KP/LP SCHEDULE TYPES (ACR-003 Group Attendance Sheet with KP/LP) ---
// Sets each Kinder Place / Li'l Place camper's per-week ScheduleType ('Full Day' /
// 'Half Day', from the report's Dismissal column) and ExtendedHours (from the
// Ext. Hrs. AM/PM column pair — ACR-255 only covers Summer Place campers, so this
// report is the extended-hours authority for KP/LP). Update-only — never inserts
// (ACR-005 is the roster authority).
app.post('/upload-kp-lp', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
    if (!/ACR-003 Group Attendance Sheet/i.test(rawText))
        return res.redirect('/settings?message=Invalid+file+format+(ACR-003+Group+Attendance+Sheet+expected)');

    const wk = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
    const safeTrim = v => { const s = (v && typeof v === 'string') ? v.trim() : ''; return s.toLowerCase() === 'null' ? '' : s; };
    const findCamper = db.prepare("SELECT CamperID FROM Campers WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?) LIMIT 1");
    const upsertWd = db.prepare(`
        INSERT INTO CamperWeekData (CamperID, WeekNumber, ScheduleType, ExtendedHours)
        VALUES (?,?,?,?)
        ON CONFLICT(CamperID, WeekNumber) DO UPDATE SET
            ScheduleType  = excluded.ScheduleType,
            ExtendedHours = excluded.ExtendedHours
    `);

    // The report repeats a "Camper,Grade,..." header on every page. Column layout
    // varies, so indices are read from each header row. "Ext. Hrs." spans two
    // unlabeled cells: AM under the header, PM in the following column.
    let updated = 0;
    const notFound = [];
    try {
        db.transaction(() => {
            let iDismissal = -1, iExt = -1;
            for (const line of rawText.split(/\r?\n/)) {
                const l = line.trim();
                if (!l) continue;
                const fields = parseCsvLine(l);
                if (fields[0].trim() === 'Camper') {
                    iDismissal = fields.findIndex(f => f.trim() === 'Dismissal');
                    iExt = fields.findIndex(f => f.trim().replace(/\.$/, '') === 'Ext. Hrs');
                    continue;
                }
                if (iDismissal === -1) continue;                       // before first header
                if (!fields[0].includes(',')) continue;                // not a "Last, First" camper row
                if (l.startsWith('ACR-003')) continue;                 // page footer

                const { firstName, lastName } = parseLastFirst(safeTrim(fields[0]));
                if (!firstName && !lastName) continue;
                const camper = findCamper.get(`${firstName} ${lastName}`);
                if (!camper) { notFound.push(`${firstName} ${lastName}`); continue; }

                const dismissalRaw = safeTrim(fields[iDismissal]);
                const scheduleType = /half/i.test(dismissalRaw) ? 'Half Day'
                                   : /full/i.test(dismissalRaw) ? 'Full Day' : null;
                const amExt = iExt !== -1 ? safeTrim(fields[iExt]) : '';
                const pmExt = iExt !== -1 ? safeTrim(fields[iExt + 1]) : '';
                const extHours = (amExt && pmExt) ? 'Both' : (amExt || pmExt || null);

                upsertWd.run(camper.CamperID, wk, scheduleType, extHours);
                updated++;
            }
        })();
        let msg = `KP/LP+Import+Success+(${updated}+campers,+W${wk})`;
        if (notFound.length) msg += `+—+${notFound.length}+not+found:+${encodeURIComponent(notFound.slice(0, 5).join(', '))}`;
        res.redirect(`/settings?message=${msg}`);
    } catch (err) {
        console.error('ACR-003 KP/LP upload error:', err);
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

    const targetWeek = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();

    const results = [];
    const Readable = require('stream').Readable;
    const s = new Readable(); s.push(csvSlice); s.push(null);
    s.pipe(csv())
     .on('data', d => results.push(d))
     .on('end', () => {
        const safeTrim = v => { const s = (v && typeof v === 'string') ? v.trim() : ''; return s.toLowerCase() === 'null' ? '' : s; };
        // Read HomeGroupColor from CamperWeekData for target week (falls back to Campers for legacy)
        const findCamper  = db.prepare(`
            SELECT c.CamperID, COALESCE(cwd.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor
            FROM Campers c
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            WHERE UPPER(c.FirstName || ' ' || c.LastName) = UPPER(?) LIMIT 1
        `);
        const updateGrade   = db.prepare("UPDATE Campers SET Grade=? WHERE CamperID=?");
        const upsertExtHours = db.prepare(`
            INSERT INTO CamperWeekData (CamperID, WeekNumber, ExtendedHours)
            VALUES (?,?,?)
            ON CONFLICT(CamperID, WeekNumber) DO UPDATE SET ExtendedHours = excluded.ExtendedHours
        `);
        const deleteSched  = db.prepare("DELETE FROM Schedules WHERE PersonID=? AND PersonType='Camper' AND WeekNumber=?");
        const insertSched  = db.prepare("INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, WeekNumber) VALUES (?, 'Camper', ?, ?, ?)");

        try {
            db.transaction((rows) => {
                for (const row of rows) {
                    const camperRaw = safeTrim(row['Camper']);
                    if (!camperRaw || camperRaw === 'Camper' || camperRaw.startsWith('Master') ||
                        camperRaw.startsWith('To go') || camperRaw.startsWith('SP Session') ||
                        camperRaw.startsWith('Filter') || camperRaw.startsWith('((')) continue;

                    const { firstName, lastName } = parseLastFirst(camperRaw);
                    if (!firstName && !lastName) continue;

                    const existing = findCamper.get(targetWeek, `${firstName} ${lastName}`);
                    if (!existing) continue; // update-only

                    const grade = parseInt(safeTrim(row['Grade'])) || 0;
                    const amExt = safeTrim(row['AM Ext']);
                    const pmExt = safeTrim(row['PM Ext']);
                    const extHours = (amExt && pmExt) ? 'Both' : (amExt || pmExt || null);

                    updateGrade.run(grade, existing.CamperID);
                    upsertExtHours.run(existing.CamperID, targetWeek, extHours);

                    // Re-import schedule for this week only
                    deleteSched.run(existing.CamperID, targetWeek);
                    const grpColor = existing.HomeGroupColor || '';
                    for (let i = 1; i <= 5; i++) {
                        const act = safeTrim(row[`Period ${i}`]);
                        if (act) insertSched.run(existing.CamperID, camperOrdinalToClockBlock(i, grpColor), act, targetWeek);
                    }
                }
            })(results);

            // Auto-sync offerings for the target week from newly imported schedule
            try { syncOfferingsForWeek(targetWeek); } catch(e) { console.error('[sync offerings]', e.message); }
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

// 1b. IMPORT STAFF CONTACT INFO — CSR-300: Staff Profile export from camp management.
// Format is one vertical block per staff member (Name line, then Gender:/Birthday:/
// phone/email label rows), not a normal tabular CSV, so it's parsed line-by-line
// rather than via csv-parser. Only updates the Phone column on existing Counselors
// rows matched by full name — never creates new staff.
function parseStaffContactBlocks(rawText) {
    const RESERVED_LABELS = new Set([
        'Gender:', 'Birthday:', 'SIN:', 'Home Address:', 'E-mail:',
        'School:', 'School Address:', 'Stage:', 'Status:', 'Period'
    ]);
    const isBlockStart = (label, nextLine) => {
        if (!label || RESERVED_LABELS.has(label) || /^(Week |LIT Week )/.test(label)) return false;
        const nextLabel = nextLine ? (nextLine[0] || '').trim() : '';
        return !nextLine || nextLabel === 'Gender:';
    };
    // Lower priority number wins when a block has multiple phone-like rows.
    const phoneLabelPriority = (label) => {
        const l = label.toLowerCase();
        if (/cell|mobile|cellular|iphone|apple|moblie|mobil|personal/.test(l)) return 1;
        if (/phone|tel/.test(l)) return 2;
        if (l === 'home') return 3;
        if (/work/.test(l)) return 4;
        if (l === 'parent') return 9;
        return 5;
    };
    const PHONE_VALUE_RE = /^\+?[\d\s\-().]{7,20}(?:\s*ext\.?\s*\d*)?$/i;

    const lines = rawText.split(/\r?\n/).map(parseCsvLine);
    const entries = [];
    let i = 0;
    while (i < lines.length) {
        const label = (lines[i][0] || '').trim();
        if (!isBlockStart(label, lines[i + 1])) { i++; continue; }

        let j = i + 1;
        let bestPhone = null, bestPriority = Infinity;
        while (j < lines.length) {
            const bLabel = (lines[j][0] || '').trim();
            if (isBlockStart(bLabel, lines[j + 1])) break;
            const val = (lines[j][2] || '').trim();
            if (bLabel && val && PHONE_VALUE_RE.test(val) && (val.match(/\d/g) || []).length >= 7) {
                const pr = phoneLabelPriority(bLabel);
                if (pr < bestPriority) { bestPriority = pr; bestPhone = val; }
            }
            j++;
        }

        entries.push({ fullName: label.replace(/\s*\([^)]*\)\s*$/, '').trim(), phone: bestPhone });
        i = j;
    }
    return entries;
}

app.post('/upload-staff-contacts', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }

    const entries = parseStaffContactBlocks(rawText);

    // The export lists each staff member once per program enrollment; last block
    // with a phone number wins so repeated entries don't need special-casing.
    const byName = new Map();
    for (const e of entries) {
        if (!e.fullName || !e.phone) continue;
        byName.set(e.fullName.toUpperCase(), e);
    }

    const findCounselors = db.prepare("SELECT CounselorID FROM Counselors WHERE UPPER(FirstName || ' ' || LastName) = UPPER(?)");
    const updPhone = db.prepare('UPDATE Counselors SET Phone = ? WHERE CounselorID = ?');

    let updated = 0;
    const unmatched = [], ambiguous = [];
    db.transaction(() => {
        for (const [, e] of byName) {
            const matches = findCounselors.all(e.fullName);
            if (matches.length === 1) { updPhone.run(e.phone, matches[0].CounselorID); updated++; }
            else if (matches.length === 0) unmatched.push(e.fullName);
            else ambiguous.push(e.fullName);
        }
    })();

    let msg = `Updated+phone+for+${updated}+staff`;
    if (unmatched.length) msg += `.+No+match:+${encodeURIComponent(unmatched.join(', '))}`;
    if (ambiguous.length) msg += `.+Multiple+matches+skipped:+${encodeURIComponent(ambiguous.join(', '))}`;
    res.redirect(`/settings?message=${msg}`);
});

// 1c. IMPORT SWIM LEVELS — "Group Attendance Sheet with Swim Level" export from camp
// management. Same paginated-report chrome as ACR-005 (repeating title/timestamp/header
// rows, "N/,12" page footers), so it's read as raw text rather than via csv-parser.
// Camper rows are always "Last, First" (quoted) — everything else (titles, footers, the
// multi-line filter-criteria block) is skipped by requiring a comma in the name field
// AND at least one letter in both the parsed first/last name (guards against the
// filter-criteria block's unterminated quote swallowing trailing commas into one field).
app.post('/upload-swim-levels', upload.single('file'), (req, res) => {
    if (!req.file) return res.redirect('/settings?message=No+file+uploaded');
    let rawText;
    try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) { return res.redirect('/settings?message=File+Read+Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }

    if (!/Group Attendance Sheet with Swim Level/i.test(rawText)) {
        return res.redirect('/settings?message=Invalid+file+format+(Group+Attendance+Sheet+with+Swim+Level+expected)');
    }

    const isAdmin = req.cookies.adminAuth === 'true';
    const week = parseInt(req.body.weekNumber) || (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();

    const NAME_HAS_LETTER = /[A-Za-z]/;
    const entries = [];
    for (const line of rawText.split(/\r?\n/)) {
        const fields = parseCsvLine(line.trim());
        const nameField = (fields[0] || '').trim();
        if (!nameField.includes(',')) continue;
        const { firstName, lastName } = parseLastFirst(nameField);
        if (!NAME_HAS_LETTER.test(firstName) || !NAME_HAS_LETTER.test(lastName)) continue;
        const parsed = parseSwimLevelValue(fields[2]);
        if (!parsed) continue; // blank / not yet tested
        entries.push({ firstName, lastName, ...parsed });
    }

    const findCamper = db.prepare("SELECT CamperID FROM Campers WHERE UPPER(FirstName) = UPPER(?) AND UPPER(LastName) = UPPER(?)");
    const upsert = db.prepare(`
        INSERT INTO CamperSwimLevels (CamperID, WeekNumber, LevelNumber, SubLevel, UpdatedAt)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (CamperID, WeekNumber) DO UPDATE SET
            LevelNumber = excluded.LevelNumber,
            SubLevel    = excluded.SubLevel,
            UpdatedAt   = CURRENT_TIMESTAMP
    `);

    let updated = 0;
    const unmatched = [], ambiguous = [];
    db.transaction(() => {
        for (const e of entries) {
            const matches = findCamper.all(e.firstName, e.lastName);
            if (matches.length === 1) { upsert.run(matches[0].CamperID, week, e.levelNumber, e.subLevel); updated++; }
            else if (matches.length === 0) unmatched.push(`${e.firstName} ${e.lastName}`);
            else ambiguous.push(`${e.firstName} ${e.lastName}`);
        }
    })();

    let msg = `Imported+${updated}+swim+levels`;
    if (unmatched.length) msg += `.+No+match:+${encodeURIComponent(unmatched.join(', '))}`;
    if (ambiguous.length) msg += `.+Multiple+matches+skipped:+${encodeURIComponent(ambiguous.join(', '))}`;
    res.redirect(`/settings?message=${msg}`);
});

// 2. IMPORT INSTRUCTORS — uploads to target week (prep target if set, else active week)
// CSV: FirstName, LastName, P1–P6, L1–L6. Unknown names are auto-inserted as Instructors.
app.post('/upload-instructors', upload.single('file'), (req, res) => {
    const weekNumber = parseInt(req.body.weekNumber) || getPrepTargetWeek() || getActiveWeek();
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
    const gender         = ['M', 'F'].includes(req.body.gender) ? req.body.gender : null;
    const swimMaxLevelRaw = parseInt(req.body.swimMaxLevel, 10);
    const swimMaxLevel   = (swimMaxLevelRaw >= 1 && swimMaxLevelRaw <= 6) ? swimMaxLevelRaw : null;
    db.prepare(`
        UPDATE Counselors
        SET FirstName = ?, LastName = ?, StaffRole = ?, HomeGroupColor = ?,
            ScheduleType = ?, BusRoute = ?, ExtendedHours = ?, Phone = ?, Email = ?, Gender = ?, SwimMaxLevel = ?
        WHERE CounselorID = ?
    `).run(firstName, lastName, staffRole, homeGroupColor, scheduleType, busRoute, extendedHours, phone, email, gender, swimMaxLevel, id);
    // Mirror week attributes into the same week the profile page displays
    // (prep target for admins, else active week)
    const isAdmin = req.cookies.adminAuth === 'true';
    const aw = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
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

// --- MASS EDIT STAFF ---
app.get('/mass-edit-staff', (req, res) => {
    const staff = db.prepare(`
        SELECT CounselorID, FirstName, LastName, StaffRole, Gender, HomeGroupColor,
               ScheduleType, BusRoute, ExtendedHours, Phone, Email
        FROM Counselors
        ORDER BY StaffRole, LastName, FirstName
    `).all();
    const roles = [...new Set(staff.map(s => s.StaffRole).filter(Boolean))].sort();
    res.render('mass-edit-staff', { staff, roles, message: req.query.message || null });
});

app.post('/mass-edit-staff/save', (req, res) => {
    const { staff } = req.body;
    if (!Array.isArray(staff)) return res.status(400).json({ error: 'Invalid payload' });
    const validRoles = ['Instructor','Unit Leader','Sports Leader','Counselor','Swim Counselor',
                        'Director','Office Staff','Nurse','Equipment Manager','CPR Instructor','Internship'];
    const aw = getActiveWeek();
    const upd = db.prepare(`
        UPDATE Counselors
        SET FirstName = ?, LastName = ?, StaffRole = ?, Gender = ?, HomeGroupColor = ?,
            ScheduleType = ?, BusRoute = ?, ExtendedHours = ?, Phone = ?, Email = ?
        WHERE CounselorID = ?
    `);
    const updWeek = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor,
            ScheduleType   = excluded.ScheduleType,
            BusRoute       = excluded.BusRoute,
            ExtendedHours  = excluded.ExtendedHours
    `);
    let saved = 0;
    try {
        db.transaction(() => {
            for (const s of staff) {
                const id = parseInt(s.counselorID);
                const firstName = (s.firstName || '').trim();
                const lastName  = (s.lastName  || '').trim();
                if (!id || !firstName || !lastName) continue;
                if (!validRoles.includes(s.staffRole)) continue;
                const gender         = ['M', 'F'].includes(s.gender) ? s.gender : null;
                const homeGroupColor = (s.homeGroupColor || '').trim() || null;
                const scheduleType   = (s.scheduleType   || '').trim() || null;
                const busRoute       = (s.busRoute       || '').trim() || null;
                const extendedHours  = (s.extendedHours  || '').trim() || null;
                const phone          = (s.phone          || '').trim() || null;
                const email          = (s.email          || '').trim() || null;
                upd.run(firstName, lastName, s.staffRole, gender, homeGroupColor,
                        scheduleType, busRoute, extendedHours, phone, email, id);
                updWeek.run(id, aw, homeGroupColor, scheduleType, busRoute, extendedHours);
                saved++;
            }
        })();
        res.json({ ok: true, saved });
    } catch (err) {
        console.error('[mass-edit-staff/save]', err.message);
        res.status(500).json({ error: err.message });
    }
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
    const queryId = parseInt(req.query.camperId) || null;
    const aw = getActiveWeek();
    let camper = null;
    let currentSchedule = [];

    if (queryId) {
        // Exact selection from the autocomplete — unambiguous even with duplicate names
        camper = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName,
                   cwd.HomeGroupColor
            FROM Campers c
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            WHERE c.CamperID = ?
        `).get(aw, queryId);
    } else if (query) {
        camper = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName,
                   cwd.HomeGroupColor
            FROM Campers c
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            WHERE (c.FirstName || ' ' || c.LastName) LIKE ?
            LIMIT 1
        `).get(aw, `%${query}%`);
    }

    if (camper) {
        currentSchedule = db.prepare(`
            SELECT * FROM Schedules
            WHERE PersonID = ? AND PersonType = 'Camper' AND WeekNumber = ?
            ORDER BY PeriodNumber ASC
        `).all(camper.CamperID, aw);
    }

    const allCampers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(aw);

    const activeSession = db.prepare("SELECT startDate FROM Sessions WHERE isActive=1 LIMIT 1").get();
    const weekStart = activeSession?.startDate || null;
    const swapCount = (camper && weekStart)
        ? db.prepare("SELECT COUNT(*) as n FROM ScheduleChanges WHERE CamperID = ? AND ChangedAt >= ?").get(camper.CamperID, weekStart)?.n || 0
        : 0;

    res.render('swap-tool', { camper, currentSchedule, query, allCampers, swapCount });
});

// Returns available activity options for a given camper's period
app.get('/get-options/:camperId/:period', (req, res) => {
    const { camperId, period } = req.params;
    const week = getActiveWeek();

    // Get the camper's home group color from CamperWeekData for the active week
    const camper = db.prepare(`
        SELECT cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(week, camperId);
    const color = camper ? camper.HomeGroupColor : null;

    // Determine the camper's current activity and its side of camp for this period
    const currentSlot = db.prepare(`
        SELECT a.SideOfCamp FROM Schedules sc
        JOIN Activities a ON a.Name = sc.ActivityName
        WHERE sc.PersonID = ? AND sc.PeriodNumber = ? AND sc.PersonType = 'Camper' AND sc.WeekNumber = ?
    `).get(camperId, period, week);
    const sideOfCamp = currentSlot ? currentSlot.SideOfCamp : null;

    // Only return activities that are actually offered this period (WeeklyOfferings),
    // on the same side of camp, accepting this camper's color.
    const options = db.prepare(`
        WITH effective AS (
            SELECT wo.ActivityName AS Name, wo.SideOfCamp,
                   a.MaxCapacity,
                   COALESCE(apg.AllowedGroups, a.AllowedGroups) AS EffectiveGroups,
                   (SELECT COUNT(*) FROM Schedules s
                    WHERE s.ActivityName = wo.ActivityName AND s.PeriodNumber = @period
                      AND s.PersonType = 'Camper' AND s.WeekNumber = @week
                      AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = @week AND HomeGroupColor = 'SPLIT')
                   ) AS CurrentEnrollment
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
    const aw = getActiveWeek();

    if (!camperId || !period || !newActivity) {
        return res.redirect('/swap-tool?error=Missing+parameters');
    }

    const activity = db.prepare('SELECT * FROM Activities WHERE Name = ?').get(newActivity);
    if (!activity) return res.redirect('/swap-tool?error=Activity+not+found');

    const currentEnrollment = db.prepare(`
        SELECT COUNT(*) as count FROM Schedules s
        WHERE s.ActivityName = ? AND s.PeriodNumber = ? AND s.PersonType = 'Camper' AND s.WeekNumber = ?
          AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ? AND HomeGroupColor = 'SPLIT')
    `).get(newActivity, period, aw, aw);

    const camper = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(aw, camperId);

    if (currentEnrollment.count >= activity.MaxCapacity) {
        // Activity is full — add to waitlist instead
        db.prepare(`
            INSERT INTO Waitlists (CamperID, PeriodNumber, RequestedActivity, WeekNumber)
            VALUES (?, ?, ?, ?)
        `).run(camperId, period, newActivity, aw);
    } else {
        // Capture current activity before overwriting it
        const currentSlot = db.prepare(`
            SELECT ActivityName FROM Schedules
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?
        `).get(camperId, period, aw);

        // Do the swap
        db.prepare(`
            UPDATE Schedules SET ActivityName = ?
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper' AND WeekNumber = ?
        `).run(newActivity, camperId, period, aw);

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
    const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    eastern.setDate(eastern.getDate() - 1);
    return `${eastern.getFullYear()}-${String(eastern.getMonth()+1).padStart(2,'0')}-${String(eastern.getDate()).padStart(2,'0')}`;
}
function getViewerName(req) {
    if (req.cookies.viewMode === 'admin') return req.cookies.adminName || 'Admin';
    const cid = parseInt(req.cookies.selectedCounselor) || 0;
    if (!cid) return 'Staff';
    const c = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID=?").get(cid);
    return c ? `${c.FirstName} ${c.LastName}` : 'Staff';
}

function getScheduledPickupMap(date) {
    const aw = getActiveWeek();
    const rows = db.prepare(`
        SELECT sp.CamperID, sp.PickupTime, sp.Notes, sp.PeriodNumber,
               s.ActivityName
        FROM ScheduledPickups sp
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber AND s.WeekNumber=?
        WHERE sp.Date = ?
    `).all(aw, date);
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
const SHOW_AM_INDICATOR = new Set(['class','homegroup_lunch','homegroup_pm','bus_pm','extended_pm','specialty_pm','specialty_halfday']);

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
        if (cRow) {
            // Find all CounselorIDs with the same name — dual-enrolled staff appear as multiple rows.
            // Schedule storage by role:
            //   Instructor        → StaffWeekSchedules
            //   Unit Leader / Sports Leader (sports slots) → CounselorScheduleAssignments (PersonType='Instructor')
            //   Unit Leader / Sports Leader (enrichment slots, placed as counselor) → CounselorWeekSchedules
            //   Counselor         → CounselorWeekSchedules
            const UL_SL_ROLES = new Set(['Unit Leader', 'Sports Leader']);
            const sameNameIds = db.prepare(
                'SELECT CounselorID, StaffRole FROM Counselors WHERE FirstName = ? AND LastName = ?'
            ).all(cRow.FirstName, cRow.LastName);
            for (const peer of sameNameIds) {
                if (peer.StaffRole === 'Instructor') {
                    const rows = db.prepare(
                        'SELECT PeriodNumber, ActivityName FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ?'
                    ).all(peer.CounselorID, getActiveWeek());
                    for (const a of rows) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
                } else if (UL_SL_ROLES.has(peer.StaffRole)) {
                    // Sports-side assignments saved via assignment tool as PersonType='Instructor'
                    const sportRows = db.prepare(
                        'SELECT PeriodNumber, ActivityName FROM CounselorScheduleAssignments WHERE PersonID = ? AND WeekNumber = ?'
                    ).all(peer.CounselorID, getActiveWeek());
                    for (const a of sportRows) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
                    // Enrichment-side assignments saved as counselor slots
                    const enrichRows = db.prepare(
                        'SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ?'
                    ).all(peer.CounselorID, getActiveWeek());
                    for (const a of enrichRows) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
                } else {
                    const rows = db.prepare(
                        'SELECT PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ?'
                    ).all(peer.CounselorID, getActiveWeek());
                    for (const a of rows) allowedClasses.add(`${a.PeriodNumber}|${a.ActivityName.toLowerCase()}`);
                }
            }
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
    const classAw = getActiveWeek();
    const classRows = db.prepare(`
        SELECT DISTINCT s.PeriodNumber, s.ActivityName
        FROM Schedules s
        WHERE s.PersonType = 'Camper' AND s.WeekNumber = ? AND s.ActivityName NOT LIKE '#REF%'
          AND s.ActivityName != 'PM Only - Hartt Chamber Program'
        ORDER BY s.PeriodNumber, s.ActivityName
    `).all(classAw);

    const checkClassTotal = db.prepare(`
        SELECT COUNT(*) as n FROM Schedules s
        WHERE s.PersonType='Camper' AND s.WeekNumber=? AND s.PeriodNumber=? AND s.ActivityName=?
          AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor='SPLIT')
    `);
    const checkClassHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PeriodNumber=? AND ActivityName=?)
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
        )
    `);

    const classSessions = [];
    for (const r of classRows) {
        const total = checkClassTotal.get(classAw, r.PeriodNumber, r.ActivityName, classAw)?.n || 0;
        const handled = checkClassHandled.get(date, r.PeriodNumber, r.ActivityName, classAw, date, classAw, r.PeriodNumber, r.ActivityName, classAw)?.n || 0;
        classSessions.push({
            label: `Block ${r.PeriodNumber} — ${r.ActivityName}`,
            periodNumber: r.PeriodNumber, periodKey: String(r.PeriodNumber), periodLabel: String(r.PeriodNumber),
            activityName: r.ActivityName, filterPeriod: r.PeriodNumber,
            link: `/attendance/class/${r.PeriodNumber}/${encodeURIComponent(r.ActivityName)}?date=${date}`,
            submitted: total === 0 || handled >= total
        });
    }

    // Bus sessions
    const busRoutes = db.prepare("SELECT DISTINCT BusRoute FROM CamperWeekData WHERE WeekNumber=? AND BusRoute IS NOT NULL AND BusRoute != '' AND LOWER(CAST(BusRoute AS TEXT)) != 'null' ORDER BY BusRoute").all(aw).map(r => r.BusRoute);
    const checkBusHandled = {
        am: db.prepare(`
            SELECT COUNT(*) as n FROM (
                SELECT CamperID FROM Attendance
                WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                  AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND BusRidesAM=1)
                UNION
                SELECT CamperID FROM EarlyDismissals WHERE Date=?
                  AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND BusRidesAM=1)
            )
        `),
        pm: db.prepare(`
            SELECT COUNT(*) as n FROM (
                SELECT CamperID FROM Attendance
                WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                  AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND BusRidesPM=1 AND HomeGroupColor NOT IN ('LilPlace','KinderPlace'))
                UNION
                SELECT CamperID FROM EarlyDismissals WHERE Date=?
                  AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND BusRidesPM=1 AND HomeGroupColor NOT IN ('LilPlace','KinderPlace'))
            )
        `)
    };
    const busSessions = [];
    for (const route of busRoutes) {
        for (const session of ['am', 'pm']) {
            const ridesCol = session === 'pm' ? 'BusRidesPM' : 'BusRidesAM';
            const sessionType = `bus_${session}`;
            const lpkp = session === 'pm' ? "AND HomeGroupColor NOT IN ('LilPlace','KinderPlace')" : '';
            const busTotal = db.prepare(`SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND BusRoute=? AND ${ridesCol}=1 ${lpkp}`).get(aw, route)?.n || 0;
            const handled = checkBusHandled[session].get(date, sessionType, aw, route, date, aw, route)?.n || 0;
            const displayRoute = String(parseFloat(route) % 1 === 0 ? Math.trunc(parseFloat(route)) : route);
            busSessions.push({
                label: `Bus ${displayRoute} — ${session.toUpperCase()}`,
                route,
                session: session,
                link: `/attendance/bus/${encodeURIComponent(route)}/${session}?date=${date}`,
                submitted: busTotal === 0 || handled >= busTotal
            });
        }
    }

    // Extended sessions
    const extSessions = [];
    for (const session of ['am', 'pm']) {
        const sessionType = `extended_${session}`;
        const col = session === 'am' ? "('AM','Both')" : "('PM','Both')";
        // Li'l Place and KinderPlace are picked up from a separate site for PM — exclude from completion check
        const lpkp = session === 'pm' ? "AND HomeGroupColor NOT IN ('LilPlace','KinderPlace')" : '';
        const extTotal = db.prepare(`SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp}`).get(aw)?.n || 0;
        if (extTotal > 0) {
            const handled = db.prepare(`
                SELECT COUNT(*) as n FROM (
                    SELECT CamperID FROM Attendance
                    WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
                      AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp})
                    UNION
                    SELECT CamperID FROM EarlyDismissals WHERE Date=?
                      AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND ExtendedHours IN ${col} ${lpkp})
                )
            `).get(date, sessionType, aw, date, aw)?.n || 0;
            extSessions.push({
                label: `Extended ${session.toUpperCase()}`,
                session: session,
                link: `/attendance/extended/${session}?date=${date}`,
                submitted: handled >= extTotal
            });
        }
    }

    // Specialty camp sessions — color-based shared view.
    // Half Day campers (KP/LP, from the ACR-003 import) leave midday: they get a
    // Specialty Half Day check-out session and are excluded from PM. SPRC is an
    // exclusively half-day program, so it appears in AM + Half Day but never PM.
    const specialtySessions = [];
    const halfDaySessions = [];
    const spTotalStmt = db.prepare("SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor=?");
    const spFullTotalStmt = db.prepare("SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor=? AND COALESCE(ScheduleType,'') != 'Half Day'");
    const spHalfTotalStmt = db.prepare("SELECT COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor=? AND ScheduleType='Half Day'");
    const mkSpHandled = (subset) => db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor=? ${subset})
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor=? ${subset})
        )
    `);
    const spHandledAll  = mkSpHandled('');
    const spHandledFull = mkSpHandled("AND COALESCE(ScheduleType,'') != 'Half Day'");
    const spHandledHalf = mkSpHandled("AND ScheduleType='Half Day'");
    for (const color of SPECIALTY_CAMP_COLORS) {
        const total = spTotalStmt.get(aw, color)?.n || 0;
        if (total === 0) continue;
        const camp = HOME_GROUP_LABELS[color] || color;

        // AM — every camper in the camp
        const amHandled = spHandledAll.get(date, 'specialty_am', aw, color, date, aw, color)?.n || 0;
        specialtySessions.push({
            label: `${camp} — AM`, color, session: 'am',
            link: `/attendance/specialty/${color}/am?date=${date}`,
            submitted: amHandled >= total
        });

        // PM — full-day campers only; SPRC has no PM
        if (color !== 'SPRC') {
            const pmTotal = spFullTotalStmt.get(aw, color)?.n || 0;
            if (pmTotal > 0) {
                const pmHandled = spHandledFull.get(date, 'specialty_pm', aw, color, date, aw, color)?.n || 0;
                specialtySessions.push({
                    label: `${camp} — PM`, color, session: 'pm',
                    link: `/attendance/specialty/${color}/pm?date=${date}`,
                    submitted: pmHandled >= pmTotal
                });
            }
        }

        // Specialty Half Day — KP/LP half-day campers; all of SPRC
        if (['LilPlace', 'KinderPlace', 'SPRC'].includes(color)) {
            const hdTotal = color === 'SPRC' ? total : (spHalfTotalStmt.get(aw, color)?.n || 0);
            if (hdTotal > 0) {
                const hdStmt = color === 'SPRC' ? spHandledAll : spHandledHalf;
                const hdHandled = hdStmt.get(date, 'specialty_halfday', aw, color, date, aw, color)?.n || 0;
                halfDaySessions.push({
                    label: `${camp} — Half Day`, color, session: 'halfday',
                    link: `/attendance/specialty-halfday/${color}?date=${date}`,
                    submitted: hdHandled >= hdTotal
                });
            }
        }
    }

    // Late arrivals count
    const lateCount = db.prepare(
        "SELECT COUNT(*) as n FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status IN ('absent','nurse')"
    ).get(date)?.n || 0;

    let filteredHomegroupSessions = homegroupSessions;
    let filteredClassSessions = classSessions;
    let filteredBusSessions = busSessions;
    let filteredExtSessions = extSessions;
    let filteredSpecialtySessions = specialtySessions;
    let filteredHalfDaySessions = halfDaySessions;
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
            filteredHalfDaySessions = [];
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
            filteredHalfDaySessions = SPECIALTY_CAMP_COLORS.includes(counselorGroupColor)
                ? halfDaySessions.filter(s => s.color === counselorGroupColor)
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
        halfDaySessions: filteredHalfDaySessions,
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

    const aw = getActiveWeek();
    const campers = getWeekCampersForCounselor(counselorId, aw);

    // Shirt size/quantity pills: AM homegroup attendance on Mondays only, main-camp colors only.
    const showShirtInfo = session === 'am' && isMonday(date);
    // Lunch pill: Lunch homegroup attendance only, Camp Lunch / Allergy Meal only (not the default packed lunch).
    const showLunchInfo = session === 'lunch';
    const weekDataMap = {};
    if (showShirtInfo || showLunchInfo) {
        db.prepare("SELECT CamperID, HomeGroupColor, CampLunch FROM CamperWeekData WHERE WeekNumber=?").all(aw)
            .forEach(r => { weekDataMap[r.CamperID] = r; });
    }

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
    const roster = campers.map(c => {
        const shirtInfo = showShirtInfo
            ? getShirtInfo({ HomeGroupColor: weekDataMap[c.CamperID]?.HomeGroupColor, SessionCodes: c.SessionCodes }, aw)
            : null;
        return {
            ...c,
            currentStatus: statusMap[c.CamperID] || null,
            absentAM: absentAMSet.has(c.CamperID),
            absentBusAM: absentBusAMSet.has(c.CamperID),
            nurseAM: nurseAMSet1.has(c.CamperID),
            caseLog: caseLogSet1.has(c.CamperID),
            dismissed: dismissedSet.has(c.CamperID),
            seenEarlier: seenEarlierSet.has(c.CamperID),
            scheduledPickup: pickupMap1[c.CamperID] || null,
            shirtQty: shirtInfo?.shirtQty ?? null,
            shirtsReceived: shirtInfo?.shirtsReceived ?? false,
            campLunch: showLunchInfo ? (weekDataMap[c.CamperID]?.CampLunch || 'No') : null
        };
    });

    res.render('attendance-form', {
        title: `${counselor.FirstName} ${counselor.LastName}'s Group — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        selfLink: `/attendance/homegroup/counselor/${counselorId}/${session}`,
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
    const aw = getActiveWeek();

    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize, c.SessionCodes,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.HomeGroupColor = ?
        ORDER BY c.LastName, c.FirstName
    `).all(aw, color);

    // Shirt size/quantity pills: AM homegroup attendance on Mondays only, main-camp colors only.
    const showShirtInfo = session === 'am' && isMonday(date);
    // Lunch pill: Lunch homegroup attendance only, Camp Lunch / Allergy Meal only (not the default packed lunch).
    const showLunchInfo = session === 'lunch';

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
    const roster = campers.map(c => {
        const shirtInfo = showShirtInfo ? getShirtInfo(c, aw) : null;
        return {
            ...c,
            currentStatus: statusMap[c.CamperID] || null,
            absentAM: absentAMSet.has(c.CamperID),
            nurseAM: nurseAMSet2.has(c.CamperID),
            caseLog: caseLogSet2.has(c.CamperID),
            dismissed: dismissedSet.has(c.CamperID),
            seenEarlier: seenEarlierSet.has(c.CamperID),
            scheduledPickup: pickupMap2[c.CamperID] || null,
            shirtQty: shirtInfo?.shirtQty ?? null,
            shirtsReceived: shirtInfo?.shirtsReceived ?? false,
            campLunch: showLunchInfo ? (c.CampLunch || 'No') : null
        };
    });

    res.render('attendance-form', {
        title: `${color} Group — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        selfLink: `/attendance/homegroup/${color}/${session}`,
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
    const aw = getActiveWeek();

    // PM excludes Half Day campers — they leave midday (Specialty Half Day session)
    const halfDayFilter = session === 'pm' ? "AND COALESCE(cwd.ScheduleType,'') != 'Half Day'" : '';
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM, cwd.ScheduleType
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.HomeGroupColor = ? ${halfDayFilter}
        ORDER BY c.LastName, c.FirstName
    `).all(aw, color);

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
        scheduledPickup: pickupMap3[c.CamperID] || null,
        halfDay: session === 'am' && c.ScheduleType === 'Half Day'
    }));

    const isSplitAM = color === 'SPLIT' && session === 'am';
    const fieldTripActive = isSplitAM
        ? !!db.prepare("SELECT 1 FROM SplitFieldTrip WHERE Date=?").get(date)
        : false;

    res.render('attendance-form', {
        title: `${HOME_GROUP_LABELS[color] || color} — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        selfLink: `/attendance/specialty/${color}/${session}`,
        backLink: `/attendance?date=${date}`,
        roster,
        isSplitAM, fieldTripActive,
        splitColor: color
    });
});

// --- ATTENDANCE FORM: SPECIALTY HALF DAY (midday check-out) ---
// KP/LP: only campers marked 'Half Day' (ACR-003 import). SPRC: the whole camp —
// that program is exclusively half day and has no PM session.
app.get('/attendance/specialty-halfday/:color', (req, res) => {
    const { color } = req.params;
    const date = req.query.date || todayStr();
    const sessionType = 'specialty_halfday';
    const aw = getActiveWeek();

    const subset = color === 'SPRC' ? '' : "AND cwd.ScheduleType = 'Half Day'";
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM, cwd.ScheduleType
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.HomeGroupColor = ? ${subset}
        ORDER BY c.LastName, c.FirstName
    `).all(aw, color);

    const absentAMSet = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType='specialty_am' AND Status='absent'")
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

    const nurseAMSetHd = getNurseAMSet(date);
    const caseLogSetHd = getCaseLogSet(date);
    const pickupMapHd = getScheduledPickupMap(date);
    const roster = campers.map(c => ({
        ...c,
        currentStatus: statusMap[c.CamperID] || null,
        absentAM: absentAMSet.has(c.CamperID),
        nurseAM: nurseAMSetHd.has(c.CamperID),
        caseLog: caseLogSetHd.has(c.CamperID),
        dismissed: dismissedSet.has(c.CamperID),
        seenEarlier: seenEarlierSet.has(c.CamperID),
        scheduledPickup: pickupMapHd[c.CamperID] || null
    }));

    res.render('attendance-form', {
        title: `${HOME_GROUP_LABELS[color] || color} — Half Day`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        selfLink: `/attendance/specialty-halfday/${color}`,
        backLink: `/attendance?date=${date}`,
        roster,
        isSplitAM: false, fieldTripActive: false,
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
    const aw = getActiveWeek();
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers c
        JOIN Schedules s ON c.CamperID = s.PersonID AND s.PersonType = 'Camper'
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE s.PeriodNumber = ? AND s.ActivityName = ? AND s.WeekNumber = ?
        ORDER BY cwd.HomeGroupColor, c.LastName, c.FirstName
    `).all(aw, period, activityName, aw);

    const absentAMSet = new Set(
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status IN ('absent','nurse')")
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
        selfLink: `/attendance/class/${period}/${encodeURIComponent(activityName)}`,
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

    const ridesCol = session === 'pm' ? 'BusRidesPM' : 'BusRidesAM';
    const aw = getActiveWeek();
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.BusRoute = ? AND cwd.${ridesCol} = 1
        ORDER BY c.LastName, c.FirstName
    `).all(aw, route);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status IN ('absent','nurse')")
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
        title: `Bus ${String(parseFloat(route) % 1 === 0 ? Math.trunc(parseFloat(route)) : route)} — ${session.toUpperCase()}`,
        sessionType, date,
        periodNumber: 0, activityName: '',
        selfLink: `/attendance/bus/${encodeURIComponent(route)}/${session}`,
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
    const aw = getActiveWeek();
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.ShirtSize,
               cwd.HomeGroupColor, cwd.CampLunch, cwd.ExtendedHours,
               cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.ExtendedHours IN ${col}
        ORDER BY c.LastName, c.FirstName
    `).all(aw);

    const absentAMSet = new Set();
    if (showAmIndicator) {
        db.prepare("SELECT CamperID FROM Attendance WHERE Date=? AND SessionType IN ('homegroup_am','specialty_am') AND Status IN ('absent','nurse')")
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
        selfLink: `/attendance/extended/${session}`,
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
    const _aw = getActiveWeek();
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, c.Grade, c.Age, c.ShirtSize,
               cwd.HomeGroupColor, cwd.BusRoute, cwd.ExtendedHours, cwd.CampLunch,
               a.Status AS AttendanceStatus, a.SessionType AS AttSessionType, a.MarkedAt AS CheckInTime
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        JOIN Attendance a ON c.CamperID = a.CamperID
        WHERE a.Date = ? AND a.SessionType IN ('homegroup_am','specialty_am') AND a.Status IN ('absent','late')
        ORDER BY a.Status ASC, cwd.HomeGroupColor, c.LastName, c.FirstName
    `).all(_aw, date);

    const roster = campers.map(c => {
        const schedule = db.prepare(
            "SELECT PeriodNumber, ActivityName FROM Schedules WHERE PersonID=? AND PersonType='Camper' AND WeekNumber=? ORDER BY PeriodNumber"
        ).all(c.CamperID, _aw);
        return { ...c, schedule };
    });

    const dismissed = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               ed.DismissalTime, ed.Notes, ed.MarkedBy, ed.CreatedAt
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE ed.Date = ?
        ORDER BY ed.CreatedAt
    `).all(_aw, date);

    res.render('attendance-late-arrivals', { date, roster, dismissed });
});

app.post('/attendance/check-in', (req, res) => {
    const { date, camperId } = req.body;
    const markedBy = getViewerName(req);
    const _aw = getActiveWeek();
    const camper = db.prepare(`
        SELECT cwd.HomeGroupColor FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(_aw, parseInt(camperId));
    const sessionType = camper && SPECIALTY_CAMP_COLORS.includes(camper.HomeGroupColor) ? 'specialty_am' : 'homegroup_am';
    db.prepare(`
        UPDATE Attendance SET Status = 'late', MarkedAt = CURRENT_TIMESTAMP, MarkedBy = ?
        WHERE Date = ? AND CamperID = ? AND SessionType = ?
    `).run(markedBy, date, camperId, sessionType);
    res.redirect(req.body.returnTo || `/attendance/late-arrivals?date=${date}`);
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

app.post('/attendance/dismissal-undo', (req, res) => {
    const { date, camperId } = req.body;
    if (!date || !camperId) return res.redirect('/attendance/late-arrivals');
    db.prepare("DELETE FROM EarlyDismissals WHERE Date=? AND CamperID=?").run(date, parseInt(camperId));
    res.redirect(`/attendance/late-arrivals?date=${date}`);
});

// --- DISMISSAL ARCHIVE ---
app.get('/attendance/dismissal-archive', (req, res) => {
    const date = req.query.date || todayStr();
    const _aw = getActiveWeek();
    const dismissals = db.prepare(`
        SELECT c.FirstName, c.LastName, cwd.HomeGroupColor,
               ed.DismissalTime, ed.Notes, ed.MarkedBy, ed.CreatedAt
        FROM EarlyDismissals ed JOIN Campers c ON c.CamperID = ed.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE ed.Date = ? ORDER BY ed.CreatedAt
    `).all(_aw, date);
    const checkIns = db.prepare(`
        SELECT c.FirstName, c.LastName, cwd.HomeGroupColor,
               a.MarkedAt, a.MarkedBy
        FROM Attendance a JOIN Campers c ON c.CamperID = a.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE a.Date = ? AND a.SessionType = 'homegroup_am' AND a.Status = 'late'
        ORDER BY a.MarkedAt
    `).all(_aw, date);
    const scheduledPickups = db.prepare(`
        SELECT sp.PickupTime, sp.Notes, sp.CreatedBy,
               c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM ScheduledPickups sp JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE sp.Date = ? ORDER BY sp.PickupTime
    `).all(_aw, date);
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
    const _naw = getActiveWeek();
    const visits = db.prepare(`
        SELECT n.VisitID, n.CheckInTime, n.CheckOutTime, n.Notes, n.Dismissed, n.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM NurseLog n JOIN Campers c ON c.CamperID = n.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE n.Date = ?
        ORDER BY n.CheckInTime DESC
    `).all(_naw, today);
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(_naw);
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
    const _naw = getActiveWeek();
    const rows = db.prepare(`
        SELECT n.VisitID, n.Date, n.CheckInTime, n.CheckOutTime, n.Notes, n.Dismissed, n.CreatedBy,
               c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM NurseLog n JOIN Campers c ON c.CamperID = n.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY n.Date DESC, n.CheckInTime DESC
    `).all(_naw);

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
    const _claw = getActiveWeek();
    const visits = db.prepare(`
        SELECT cl.VisitID, cl.CheckInTime, cl.CheckOutTime, cl.Notes, cl.Dismissed, cl.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM CaseLog cl JOIN Campers c ON c.CamperID = cl.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cl.Date = ?
        ORDER BY cl.CheckInTime DESC
    `).all(_claw, today);
    const campers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(_claw);
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
    const _claw = getActiveWeek();
    const rows = db.prepare(`
        SELECT cl.VisitID, cl.Date, cl.CheckInTime, cl.CheckOutTime, cl.Notes, cl.Dismissed, cl.CreatedBy,
               c.FirstName, c.LastName, cwd.HomeGroupColor
        FROM CaseLog cl JOIN Campers c ON c.CamperID = cl.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY cl.Date DESC, cl.CheckInTime DESC
    `).all(_claw);
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

    const _disaw = getActiveWeek();
    let searchResults = [];
    if (q.length >= 2) {
        searchResults = db.prepare(`
            SELECT c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor
            FROM Campers c
            LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
            WHERE c.FirstName LIKE ? OR c.LastName LIKE ?
               OR (c.FirstName || ' ' || c.LastName) LIKE ?
            ORDER BY c.LastName, c.FirstName LIMIT 20
        `).all(_disaw, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    let selectedCamper = null;
    let existingPickup = null;
    if (selectedId) {
        selectedCamper = db.prepare(`SELECT * FROM Campers WHERE CamperID = ?`).get(selectedId);
        existingPickup = db.prepare(`SELECT * FROM ScheduledPickups WHERE CamperID = ? AND Date = ?`).get(selectedId, today);
    }

    const _daw = getActiveWeek();
    // ed join marks pickups whose camper has already been dismissed today —
    // those rows move to the Completed section and lose the Quick Dismiss button
    const todayPickups = db.prepare(`
        SELECT sp.PickupID, sp.PickupTime, sp.PeriodNumber, sp.Notes, sp.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               s.ActivityName,
               CASE WHEN ed.CamperID IS NULL THEN 0 ELSE 1 END AS Dismissed,
               ed.DismissalTime, ed.CreatedAt AS DismissedAt
        FROM ScheduledPickups sp
        JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber AND s.WeekNumber=?
        LEFT JOIN EarlyDismissals ed ON ed.CamperID = sp.CamperID AND ed.Date = sp.Date
        WHERE sp.Date = ?
        ORDER BY sp.PickupTime
    `).all(_daw, _daw, today);

    const allCampers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor
        FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        ORDER BY c.LastName, c.FirstName
    `).all(_disaw);

    res.render('dismissals', { q, searchResults, selectedCamper, existingPickup, todayPickups, today, allCampers });
});

app.post('/dismissals/schedule', (req, res) => {
    const { camperId, date, pickupTime, notes } = req.body;
    const createdBy = getViewerName(req);
    const _aw = getActiveWeek();
    const camper = db.prepare(`
        SELECT cwd.HomeGroupColor FROM Campers c
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE c.CamperID = ?
    `).get(_aw, parseInt(camperId));
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
    const _daw = getActiveWeek();
    const pickups = db.prepare(`
        SELECT sp.PickupID, sp.Date, sp.PickupTime, sp.PeriodNumber, sp.Notes, sp.CreatedBy,
               c.CamperID, c.FirstName, c.LastName, cwd.HomeGroupColor,
               s.ActivityName
        FROM ScheduledPickups sp
        JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        LEFT JOIN Schedules s ON s.PersonType='Camper' AND s.PersonID=sp.CamperID
            AND s.PeriodNumber=sp.PeriodNumber AND s.WeekNumber=?
        ORDER BY sp.Date ASC, sp.PickupTime ASC
    `).all(_daw, _daw);
    const today = todayStr();
    res.render('dismissals-all', { pickups, today });
});

app.post('/dismissals/update', (req, res) => {
    const { pickupId, pickupTime, notes } = req.body;
    const id = parseInt(pickupId);
    const _aw = getActiveWeek();
    const row = db.prepare(`
        SELECT sp.PeriodNumber, cwd.HomeGroupColor
        FROM ScheduledPickups sp
        JOIN Campers c ON c.CamperID = sp.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE sp.PickupID = ?
    `).get(_aw, id);
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
    const planWeek   = Math.min(6, Math.max(1, parseInt(req.query.week) || getPrepTargetWeek() || getActiveWeek()));
    const alertMessage = req.query.message || null;

    // Offerings filtered to planning week, with per-week capacity/location overrides
    let offerings = db.prepare(`
        SELECT wo.*, COALESCE(wo.MaxCapacity, a.MaxCapacity) AS EffectiveCapacity,
               COALESCE(wo.Location, a.Location) AS EffectiveLocation
        FROM WeeklyOfferings wo
        LEFT JOIN Activities a ON a.Name = wo.ActivityName
        WHERE wo.WeekNumber = ?
        ORDER BY wo.SideOfCamp, wo.ActivityName
    `).all(planWeek);

    // Merge offerings that belong to the same MERGED_ACTIVITIES group in the same period
    {
        const absorbed = new Set();
        const merged = [];
        for (const off of offerings) {
            const key = `${off.PeriodNumber}:${off.ActivityName}`;
            if (absorbed.has(key)) continue;
            const group = getMergeGroup(off.ActivityName);
            if (group) {
                const others = group.filter(n => n !== off.ActivityName);
                const peers  = others.map(n => offerings.find(o => o.PeriodNumber === off.PeriodNumber && o.ActivityName === n)).filter(Boolean);
                if (peers.length === others.length) {
                    peers.forEach(p => absorbed.add(`${p.PeriodNumber}:${p.ActivityName}`));
                    merged.push({
                        ...off,
                        ActivityName:           group.join(' & '),
                        mergedNames:            group.slice(),
                        PreliminaryEnrollment:  [off, ...peers].reduce((s, o) => s + (o.PreliminaryEnrollment || 0), 0),
                    });
                    continue;
                }
            }
            merged.push(off);
        }
        offerings = merged;
    }

    // Counselors with week-specific attributes (fall back to Counselors table)
    // Only Counselor and Swim Counselor roles — not Instructors, Unit Leaders, etc.
    const allCounselors = db.prepare(`
        SELECT c.CounselorID, c.FirstName, c.LastName, c.StaffRole, c.Gender,
               COALESCE(cwa.HomeGroupColor, c.HomeGroupColor) AS HomeGroupColor,
               COALESCE(cwa.BusRoute,       c.BusRoute)       AS BusRoute,
               COALESCE(cwa.ScheduleType,   c.ScheduleType)   AS ScheduleType,
               COALESCE(cwa.ExtendedHours,  c.ExtendedHours)  AS ExtendedHours,
               cwa.SpecialtyGroup,
               COALESCE(cwa.isWorkingThisWeek, 1)             AS isWorkingThisWeek,
               COALESCE(cwa.ScheduleTypeManual, 0)            AS ScheduleTypeManual
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
        "SELECT HomeGroupColor, COUNT(*) as n FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor IN ('Red','Carolina','Green','Navy') GROUP BY HomeGroupColor"
    ).all(planWeek);
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

    // staffBusy: CounselorID → [periods] where they are assigned as staff/instructor.
    // Dual-enrolled staff have two separate Counselors rows (different IDs, same name).
    // Join through Counselors by first+last name so both IDs receive the busy periods.
    const staffBusyRows = db.prepare(`
        SELECT c2.CounselorID, csa.PeriodNumber
        FROM CounselorScheduleAssignments csa
        JOIN Counselors c1 ON c1.CounselorID = csa.PersonID
        JOIN Counselors c2 ON c2.FirstName = c1.FirstName AND c2.LastName = c1.LastName
        WHERE csa.PersonType = 'Instructor' AND csa.WeekNumber = ?
        UNION
        SELECT c2.CounselorID, s.PeriodNumber
        FROM Schedules s
        JOIN Counselors c1 ON c1.CounselorID = s.PersonID
        JOIN Counselors c2 ON c2.FirstName = c1.FirstName AND c2.LastName = c1.LastName
        WHERE s.PersonType = 'Instructor'
        UNION
        SELECT c2.CounselorID, sws.PeriodNumber
        FROM StaffWeekSchedules sws
        JOIN Counselors c1 ON c1.CounselorID = sws.StaffID
        JOIN Counselors c2 ON c2.FirstName = c1.FirstName AND c2.LastName = c1.LastName
        WHERE sws.WeekNumber = ?
    `).all(planWeek, planWeek);
    const staffBusy = {};
    for (const r of staffBusyRows) {
        if (!staffBusy[r.CounselorID]) staffBusy[r.CounselorID] = [];
        if (!staffBusy[r.CounselorID].includes(r.PeriodNumber)) staffBusy[r.CounselorID].push(r.PeriodNumber);
    }

    // Locked offerings for this planning week (server-persisted)
    const lockedOfferingsData = db.prepare(
        'SELECT PeriodNumber, ActivityName FROM LockedOfferings WHERE WeekNumber = ?'
    ).all(planWeek);

    res.render('counselor-scheduling', { offerings, counselors, mainCounselors, specialtyCounselors, availability, staffAvailability, existingAssignments, alertMessage, camperCounts, preferences, sessions, planWeek, staffMembers, staffBusy, lockedOfferingsData });
});

app.post('/auto-assign-homegroups', (req, res) => {
    const week = parseInt(req.body.weekNumber) || getActiveWeek();

    const camperRows = db.prepare(`
        SELECT HomeGroupColor, COUNT(*) as n FROM CamperWeekData
        WHERE WeekNumber = ? AND HomeGroupColor IN ('Red','Carolina','Green','Navy')
        GROUP BY HomeGroupColor
    `).all(week);
    const camperCounts = Object.fromEntries(camperRows.map(r => [r.HomeGroupColor, r.n]));
    const totalCampers = Object.values(camperCounts).reduce((a, b) => a + b, 0);

    // Determine which counselors already have campers assigned in CamperHomeGroups for this week.
    // A counselor's color is pinned to the dominant color of their assigned campers so that
    // the scheduler badge stays in sync with the actual attendance roster.
    const pinnedRows = db.prepare(`
        SELECT chg.CounselorID, cwd.HomeGroupColor
        FROM CamperHomeGroups chg
        JOIN CamperWeekData cwd ON cwd.CamperID = chg.CamperID AND cwd.WeekNumber = chg.WeekNumber
        WHERE chg.WeekNumber = ?
          AND cwd.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
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
        SELECT chg.CounselorID, cwd.HomeGroupColor
        FROM CamperHomeGroups chg
        JOIN CamperWeekData cwd ON cwd.CamperID = chg.CamperID AND cwd.WeekNumber = chg.WeekNumber
        WHERE chg.WeekNumber = ?
          AND cwd.HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')
        GROUP BY chg.CounselorID
    `).all(week);

    if (pinnedRows.length === 0) {
        return res.redirect(`/counselor-scheduling?week=${week}&message=No+homegroup+roster+data+found+for+this+week`);
    }

    const upsert = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor)
        VALUES (?, ?, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor = excluded.HomeGroupColor
    `);

    db.transaction(() => {
        for (const r of pinnedRows) {
            upsert.run(r.CounselorID, week, r.HomeGroupColor);
        }
    })();

    res.redirect(`/counselor-scheduling?week=${week}&message=Synced+${pinnedRows.length}+counselor+colors+from+roster`);
});

app.post('/save-counselor-group-assignments', (req, res) => {
    const { counselors, weekNumber } = req.body;
    if (!Array.isArray(counselors)) return res.status(400).json({ error: 'Invalid payload' });
    const week = parseInt(weekNumber) || getActiveWeek();
    const upsert = db.prepare(`
        INSERT INTO CounselorWeekAttributes (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours, SpecialtyGroup, isWorkingThisWeek, ScheduleTypeManual)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (CounselorID, WeekNumber) DO UPDATE SET
            HomeGroupColor     = excluded.HomeGroupColor,
            ScheduleType       = excluded.ScheduleType,
            BusRoute           = excluded.BusRoute,
            ExtendedHours      = excluded.ExtendedHours,
            SpecialtyGroup     = excluded.SpecialtyGroup,
            isWorkingThisWeek  = excluded.isWorkingThisWeek,
            ScheduleTypeManual = excluded.ScheduleTypeManual
    `);
    db.transaction(list => {
        for (const c of list) {
            if (!c.counselorID) continue;
            upsert.run(
                c.counselorID,
                week,
                c.homeGroupColor      || null,
                c.scheduleType        || null,
                c.busRoute            || null,
                c.extendedHours       || null,
                c.specialtyGroup      || null,
                c.isWorkingThisWeek   != null ? (c.isWorkingThisWeek ? 1 : 0) : 1,
                c.scheduleTypeManual  ? 1 : 0
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
               cwd.HomeGroupColor, COUNT(*) AS Enrollment
        FROM Schedules s
        JOIN CamperWeekData cwd ON cwd.CamperID = s.PersonID AND cwd.WeekNumber = s.WeekNumber
        WHERE s.PersonType = 'Camper' AND s.WeekNumber = ?
          AND cwd.HomeGroupColor IN ('Red','Carolina','Green','Navy')
        GROUP BY s.ActivityName, s.PeriodNumber, cwd.HomeGroupColor
    `).all(weekNumber);

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
    const aw = getPrepTargetWeek() || getActiveWeek();
    const rows = db.prepare(`
        SELECT
            s.PeriodNumber,
            s.ActivityName,
            a.SideOfCamp,
            (SELECT COUNT(*) FROM Schedules sc
             WHERE sc.PersonType = 'Camper' AND sc.WeekNumber = ${aw} AND sc.PeriodNumber = s.PeriodNumber AND sc.ActivityName = s.ActivityName
               AND sc.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ${aw} AND HomeGroupColor = 'SPLIT')
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
        FROM (SELECT DISTINCT PeriodNumber, ActivityName FROM Schedules WHERE PersonType='Camper' AND WeekNumber=${aw}) s
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

app.get('/api/attendance-nudge', (req, res) => {
    const counselorId = parseInt(req.cookies.selectedCounselor);
    if (!counselorId) return res.json({ notify: false });

    const estMins = getESTMins();
    const today   = getTodayEST();
    if (!isCampDay(today)) return res.json({ notify: false });

    // Returns the clockBlock if we're 15+ min into a period (but before the next one starts).
    function notifiableBlock(schedule) {
        for (let i = 0; i < schedule.length; i++) {
            const start = schedule[i].startH * 60 + schedule[i].startM;
            const next  = i + 1 < schedule.length
                ? schedule[i + 1].startH * 60 + schedule[i + 1].startM
                : CAMP_DAY_END_MINS;
            if (estMins >= start + 15 && estMins < next) return schedule[i].clockBlock;
        }
        return null;
    }

    const sportsBlock     = notifiableBlock(SPORTS_PERIODS);
    const enrichmentBlock = notifiableBlock(ENRICHMENT_PERIODS);
    const activeBlocks    = [...new Set([sportsBlock, enrichmentBlock].filter(Boolean))];
    if (activeBlocks.length === 0) return res.json({ notify: false });

    const weekNum = getActiveWeek();

    const checkTotal = db.prepare(`
        SELECT COUNT(*) as n FROM Schedules s
        WHERE s.PersonType='Camper' AND s.WeekNumber=? AND s.PeriodNumber=? AND s.ActivityName=?
          AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor='SPLIT')
    `);
    const checkHandled = db.prepare(`
        SELECT COUNT(*) as n FROM (
            SELECT CamperID FROM Attendance
            WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
            UNION
            SELECT CamperID FROM EarlyDismissals WHERE Date=?
              AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PeriodNumber=? AND ActivityName=?)
              AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
        )
    `);

    // Resolve all assigned activity names for this counselor across all relevant tables,
    // using the same multi-table, name-match logic as the attendance filter.
    const UL_SL_ROLES = new Set(['Unit Leader', 'Sports Leader']);
    const cRow = db.prepare("SELECT FirstName, LastName, StaffRole FROM Counselors WHERE CounselorID = ?").get(counselorId);
    const sameNameIds = cRow
        ? db.prepare("SELECT CounselorID, StaffRole FROM Counselors WHERE FirstName = ? AND LastName = ?").all(cRow.FirstName, cRow.LastName)
        : [];

    function getAssignedActivities(block) {
        const seen = new Set();
        const results = [];
        for (const peer of sameNameIds) {
            let rows = [];
            if (peer.StaffRole === 'Instructor') {
                rows = db.prepare("SELECT ActivityName FROM StaffWeekSchedules WHERE StaffID = ? AND WeekNumber = ? AND PeriodNumber = ?")
                    .all(peer.CounselorID, weekNum, block);
            } else if (UL_SL_ROLES.has(peer.StaffRole)) {
                rows = [
                    ...db.prepare("SELECT ActivityName FROM CounselorScheduleAssignments WHERE PersonID = ? AND PeriodNumber = ? AND WeekNumber = ?")
                        .all(peer.CounselorID, block, weekNum),
                    ...db.prepare("SELECT ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ? AND PeriodNumber = ?")
                        .all(peer.CounselorID, weekNum, block)
                ];
            } else {
                rows = db.prepare("SELECT ActivityName FROM CounselorWeekSchedules WHERE CounselorID = ? AND WeekNumber = ? AND PeriodNumber = ?")
                    .all(peer.CounselorID, weekNum, block);
            }
            for (const r of rows) {
                if (!seen.has(r.ActivityName)) { seen.add(r.ActivityName); results.push(r); }
            }
        }
        return results;
    }

    const unsubmitted = [];
    for (const block of activeBlocks) {
        for (const a of getAssignedActivities(block)) {
            const total   = checkTotal.get(weekNum, block, a.ActivityName, weekNum)?.n || 0;
            const handled = checkHandled.get(today, block, a.ActivityName, weekNum, today, weekNum, block, a.ActivityName, weekNum)?.n || 0;
            if (total === 0 || handled >= total) continue;
            unsubmitted.push(a.ActivityName);
        }
    }

    if (unsubmitted.length === 0) return res.json({ notify: false });
    res.json({ notify: true, classes: unsubmitted });
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push-subscribe', (req, res) => {
    const counselorId = parseInt(req.cookies.selectedCounselor);
    if (!counselorId) return res.status(401).json({ error: 'No counselor selected' });
    const sub = req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    db.prepare(`
        INSERT INTO PushSubscriptions (CounselorID, endpoint, subscription)
        VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET CounselorID=excluded.CounselorID, subscription=excluded.subscription
    `).run(counselorId, sub.endpoint, JSON.stringify(sub));
    res.json({ ok: true });
});

app.post('/api/push-unsubscribe', (req, res) => {
    const counselorId = parseInt(req.cookies.selectedCounselor);
    if (!counselorId) return res.status(401).json({ error: 'No counselor selected' });
    db.prepare("DELETE FROM PushSubscriptions WHERE CounselorID = ?").run(counselorId);
    res.json({ ok: true });
});

// --- INSTANT ALERTS ---

function resolveAlertCounselorIds(group) {
    const aw = getActiveWeek();
    const name = group.name;
    if (name === 'All Staff')
        return db.prepare("SELECT CounselorID FROM Counselors").all().map(r => r.CounselorID);
    if (name === 'All Counselors')
        return db.prepare("SELECT CounselorID FROM Counselors WHERE StaffRole IN ('Counselor','Swim Counselor')").all().map(r => r.CounselorID);
    if (name === 'All Unit Leaders')
        return db.prepare("SELECT CounselorID FROM Counselors WHERE StaffRole = 'Unit Leader'").all().map(r => r.CounselorID);
    if (name === 'All Admin') {
        return db.prepare("SELECT CounselorID FROM Counselors WHERE StaffRole = 'Director'").all().map(r => r.CounselorID);
    }
    const ST_AM_SPORTS     = ["'All Sports'","'AM Sports / PM Enrichment'","'AM Sports Only'"];
    const ST_PM_SPORTS     = ["'All Sports'","'AM Enrichment / PM Sports'","'PM Sports Only'"];
    const ST_AM_ENRICHMENT = ["'All Enrichment'","'AM Enrichment / PM Sports'","'AM Enrichment Only'"];
    const ST_PM_ENRICHMENT = ["'All Enrichment'","'AM Sports / PM Enrichment'","'PM Enrichment Only'"];
    const scheduleTypeMap = {
        'All AM Sports':     ST_AM_SPORTS,
        'All PM Sports':     ST_PM_SPORTS,
        'All AM Enrichment': ST_AM_ENRICHMENT,
        'All PM Enrichment': ST_PM_ENRICHMENT,
    };
    if (scheduleTypeMap[name]) {
        const inList = scheduleTypeMap[name].join(',');
        // Effective type = week-specific attribute falling back to the base record
        // (same COALESCE pattern as the scheduler). Non-working counselors excluded.
        return db.prepare(`
            SELECT DISTINCT c.CounselorID
            FROM Counselors c
            LEFT JOIN CounselorWeekAttributes cwa
                   ON cwa.CounselorID = c.CounselorID AND cwa.WeekNumber = ?
            WHERE COALESCE(cwa.ScheduleType, c.ScheduleType) IN (${inList})
              AND COALESCE(cwa.isWorkingThisWeek, 1) = 1
        `).all(aw).map(r => r.CounselorID);
    }
    // Custom group
    return db.prepare(`
        SELECT CounselorID FROM AlertGroupMembers WHERE GroupID = ?
    `).all(group.GroupID).map(r => r.CounselorID);
}

function resolveAlertTargets(targetType, targetId) {
    if (targetType === 'individual') {
        const subs = db.prepare("SELECT * FROM PushSubscriptions WHERE CounselorID = ?").all(targetId);
        return subs;
    }
    const group = db.prepare("SELECT * FROM AlertGroups WHERE GroupID = ?").get(targetId);
    if (!group) return [];
    const ids = resolveAlertCounselorIds(group);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM PushSubscriptions WHERE CounselorID IN (${placeholders})`).all(...ids);
}

function sendInstantAlert(message, targetLabel, targets, sentBy, showAdminBanner = 0, counselorIds = []) {
    const payload = JSON.stringify({ title: 'Camp Alert', body: message, url: '/staff', tag: 'instant-alert' });
    for (const row of targets) {
        try {
            const sub = JSON.parse(row.subscription);
            webPush.sendNotification(sub, payload).catch(err => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    db.prepare("DELETE FROM PushSubscriptions WHERE endpoint=?").run(row.endpoint);
                }
            });
        } catch (_) {}
    }
    const info = db.prepare("INSERT INTO AlertLog (message, targetLabel, sentBy, deliveryCount, showAdminBanner) VALUES (?,?,?,?,?)")
        .run(message, targetLabel, sentBy || null, targets.length, showAdminBanner ? 1 : 0);
    const alertId = info.lastInsertRowid;
    if (counselorIds.length > 0) {
        const insTarget = db.prepare("INSERT OR IGNORE INTO AlertTargets (AlertID, CounselorID) VALUES (?, ?)");
        for (const cid of counselorIds) insTarget.run(alertId, cid);
    }
}

app.get('/alerts', (req, res) => {
    const groups      = db.prepare("SELECT * FROM AlertGroups ORDER BY isSystem DESC, name").all();
    const counselors  = db.prepare("SELECT CounselorID, FirstName, LastName, StaffRole FROM Counselors ORDER BY LastName, FirstName").all();
    const log         = db.prepare("SELECT * FROM AlertLog ORDER BY sentAt DESC LIMIT 50").all();
    const memberRows  = db.prepare("SELECT GroupID, CounselorID FROM AlertGroupMembers").all();
    const memberMap   = {};
    for (const r of memberRows) {
        if (!memberMap[r.GroupID]) memberMap[r.GroupID] = new Set();
        memberMap[r.GroupID].add(r.CounselorID);
    }
    const flash = req.query.message || null;
    res.render('alerts', { groups, counselors, log, memberMap, flash, viewMode: 'admin' });
});

app.post('/alerts/send', (req, res) => {
    const message    = (req.body.message || '').trim().slice(0, 200);
    const targetType = req.body.targetType; // 'group' or 'individual'
    const targetId   = parseInt(req.body.targetId);
    if (!message || !targetType || !targetId) return res.redirect('/alerts?message=Missing+fields');

    let targetLabel;
    if (targetType === 'group') {
        const g = db.prepare("SELECT name FROM AlertGroups WHERE GroupID = ?").get(targetId);
        targetLabel = g ? g.name : `Group ${targetId}`;
    } else {
        const c = db.prepare("SELECT FirstName, LastName FROM Counselors WHERE CounselorID = ?").get(targetId);
        targetLabel = c ? `${c.FirstName} ${c.LastName}` : `Counselor ${targetId}`;
    }

    const targets         = resolveAlertTargets(targetType, targetId);
    const sentBy          = req.cookies.adminName || null;
    const showAdminBanner = (targetType === 'group' && targetLabel === 'All Admin') ? 1 : 0;
    let counselorIds;
    if (targetType === 'individual') {
        counselorIds = [targetId];
    } else {
        const group = db.prepare("SELECT * FROM AlertGroups WHERE GroupID = ?").get(targetId);
        counselorIds = group ? resolveAlertCounselorIds(group) : [];
    }
    sendInstantAlert(message, targetLabel, targets, sentBy, showAdminBanner, counselorIds);
    res.redirect(`/alerts?message=Alert+sent+to+${encodeURIComponent(targetLabel)}+(${targets.length}+subscriber${targets.length === 1 ? '' : 's'})`);
});

app.get('/api/alerts/preview', (req, res) => {
    const targetType = req.query.targetType;
    const targetId   = parseInt(req.query.targetId);
    if (!targetType || !targetId) return res.json({ count: 0, names: [] });

    let ids = [];
    if (targetType === 'individual') {
        ids = [targetId];
    } else {
        const group = db.prepare("SELECT * FROM AlertGroups WHERE GroupID = ?").get(targetId);
        if (group) ids = resolveAlertCounselorIds(group);
    }

    const names = ids.length
        ? db.prepare(`SELECT FirstName || ' ' || LastName AS name FROM Counselors WHERE CounselorID IN (${ids.map(() => '?').join(',')}) ORDER BY LastName`).all(...ids).map(r => r.name)
        : [];
    const subscriberCount = ids.length
        ? db.prepare(`SELECT COUNT(*) AS n FROM PushSubscriptions WHERE CounselorID IN (${ids.map(() => '?').join(',')})`).get(...ids)?.n || 0
        : 0;
    res.json({ count: names.length, names, subscriberCount });
});

app.get('/api/admin-alert-banner', (_req, res) => {
    const row = db.prepare("SELECT AlertID, message, sentBy, sentAt FROM AlertLog WHERE showAdminBanner=1 ORDER BY AlertID DESC LIMIT 1").get();
    if (!row) return res.json({ alert: null });
    res.json({ alert: row });
});

app.get('/api/staff-alert-banner', (req, res) => {
    const cid = parseInt(req.cookies.selectedCounselor) || null;
    if (!cid) return res.json({ alert: null });
    const row = db.prepare(`
        SELECT al.AlertID, al.message, al.sentBy, al.sentAt
        FROM AlertLog al
        JOIN AlertTargets at ON at.AlertID = al.AlertID
        WHERE at.CounselorID = ?
        ORDER BY al.AlertID DESC LIMIT 1
    `).get(cid);
    if (!row) return res.json({ alert: null });
    res.json({ alert: row });
});

app.post('/alerts/groups', (req, res) => {
    const name    = (req.body.name || '').trim();
    const members = [].concat(req.body.members || []).map(Number).filter(Boolean);
    if (!name) return res.redirect('/alerts?message=Group+name+required');
    try {
        const info = db.prepare("INSERT INTO AlertGroups (name, isSystem) VALUES (?, 0)").run(name);
        const gid  = info.lastInsertRowid;
        const ins  = db.prepare("INSERT OR IGNORE INTO AlertGroupMembers (GroupID, CounselorID) VALUES (?, ?)");
        db.transaction(() => { for (const cid of members) ins.run(gid, cid); })();
    } catch (e) {
        return res.redirect('/alerts?message=Group+name+already+exists');
    }
    res.redirect('/alerts?message=Group+created');
});

app.post('/alerts/groups/:id/delete', (req, res) => {
    const gid   = parseInt(req.params.id);
    const group = db.prepare("SELECT isSystem FROM AlertGroups WHERE GroupID = ?").get(gid);
    if (!group || group.isSystem) return res.redirect('/alerts?message=Cannot+delete+system+group');
    db.prepare("DELETE FROM AlertGroups WHERE GroupID = ?").run(gid);
    res.redirect('/alerts?message=Group+deleted');
});

app.post('/alerts/groups/:id/members', (req, res) => {
    const gid   = parseInt(req.params.id);
    const group = db.prepare("SELECT isSystem FROM AlertGroups WHERE GroupID = ?").get(gid);
    if (!group || group.isSystem) return res.redirect('/alerts?message=Cannot+edit+system+group');
    const members = [].concat(req.body.members || []).map(Number).filter(Boolean);
    const ins = db.prepare("INSERT OR IGNORE INTO AlertGroupMembers (GroupID, CounselorID) VALUES (?, ?)");
    db.transaction(() => {
        db.prepare("DELETE FROM AlertGroupMembers WHERE GroupID = ?").run(gid);
        for (const cid of members) ins.run(gid, cid);
    })();
    res.redirect('/alerts?message=Group+updated');
});

app.get('/counselor-preferences', (req, res) => {
    const counselors = db.prepare("SELECT CounselorID, FirstName, LastName, HomeGroupColor, StaffRole FROM Counselors ORDER BY LastName, FirstName").all();
    const activeWeek = getActiveWeek();
    // Preferences are for the upcoming week, so prefer next week's offerings
    // when they've been uploaded; otherwise show the current week's.
    const weekActivitiesStmt = db.prepare(
        "SELECT DISTINCT ActivityName AS Name, SideOfCamp FROM WeeklyOfferings WHERE WeekNumber = ? ORDER BY SideOfCamp, ActivityName"
    );
    let activitiesWeek = activeWeek + 1;
    let weekActivities = weekActivitiesStmt.all(activitiesWeek);
    if (!weekActivities.length) {
        activitiesWeek = activeWeek;
        weekActivities = weekActivitiesStmt.all(activitiesWeek);
    }
    const activities = weekActivities.length
        ? weekActivities
        : db.prepare("SELECT Name, SideOfCamp FROM Activities ORDER BY SideOfCamp, Name").all();
    const activitiesWeekLabel = weekActivities.length
        ? (db.prepare("SELECT label FROM Sessions WHERE weekNumber = ?").get(activitiesWeek)?.label || `Week ${activitiesWeek}`)
        : null;
    const alertMessage = req.query.message || null;
    const selectedCounselorId = parseInt(req.cookies.selectedCounselor) || null;
    const existingPrefs = selectedCounselorId
        ? db.prepare("SELECT HomeGroupPreference, SchedulePreference, ActivityPreferences FROM CounselorPreferences WHERE CounselorID = ?").get(selectedCounselorId)
        : null;
    const savedActivityPrefs = existingPrefs?.ActivityPreferences ? JSON.parse(existingPrefs.ActivityPreferences) : [];
    const selectedCounselorRole = counselors.find(c => c.CounselorID === selectedCounselorId)?.StaffRole || null;
    res.render('counselor-preferences', { counselors, activities, activitiesWeekLabel, alertMessage, selectedCounselorId, selectedCounselorRole, existingPrefs, savedActivityPrefs });
});

app.get('/counselor-preferences-summary', (_req, res) => {
    const activeWeek = getActiveWeek();
    const prepWeek   = getPrepTargetWeek();
    const displayWeek = prepWeek || activeWeek;
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
    `).all(displayWeek);

    const weekActivities = db.prepare(
        "SELECT DISTINCT ActivityName AS Name, SideOfCamp FROM WeeklyOfferings WHERE WeekNumber = ? ORDER BY SideOfCamp, ActivityName"
    ).all(displayWeek);
    const activityMap = {};
    weekActivities.forEach(a => { activityMap[a.Name] = a.SideOfCamp; });

    const assignmentRows = db.prepare(
        "SELECT CounselorID, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber = ?"
    ).all(displayWeek);
    const assignmentMap = {};
    for (const a of assignmentRows) {
        if (!assignmentMap[a.CounselorID]) assignmentMap[a.CounselorID] = [];
        assignmentMap[a.CounselorID].push(a.ActivityName);
    }

    const MAIN_COLORS    = new Set(['Red', 'Carolina', 'Green', 'Navy']);
    const SPECIALTY_COLORS = new Set(['LilPlace', 'KinderPlace', 'SPLIT', 'SPRC', 'Swim']);

    const subscribedIds = new Set(
        db.prepare("SELECT DISTINCT CounselorID FROM PushSubscriptions").all().map(r => r.CounselorID)
    );

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

        const hasPrefs = !!c.HomeGroupPreference || prefs.length > 0;
        return { ...c, sports, enrichment, unclassified, hasPrefs, excludeFromStats,
                 assignedCount, matchedCount, hgMatch, schedMatch,
                 hasNotifications: subscribedIds.has(c.CounselorID) };
    });

    res.render('counselor-preferences-summary', { rows, activeWeek, displayWeek, isPrepping: !!prepWeek });
});

app.post('/counselor-preferences', (req, res) => {
    const { counselorID, homeGroupPreference, schedulePreference } = req.body;
    const activityPreferences = Array.isArray(req.body.activityPreferences)
        ? req.body.activityPreferences
        : req.body.activityPreferences ? [req.body.activityPreferences] : [];

    const parsedId = parseInt(counselorID, 10);
    if (!parsedId) return res.redirect('/counselor-preferences?message=Please+select+a+counselor.');
    const counselor = db.prepare("SELECT StaffRole FROM Counselors WHERE CounselorID = ?").get(parsedId);
    if (!counselor) return res.redirect('/counselor-preferences?message=Counselor+not+found.+Please+re-select+your+name.');

    res.cookie('selectedCounselor', parsedId, { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 });

    // Swim Counselors only pick class (activity) preferences — no home group / schedule type.
    const isSwimCounselor = counselor.StaffRole === 'Swim Counselor';
    if (!homeGroupPreference && !(isSwimCounselor && activityPreferences.length)) {
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

app.get('/photo-gallery/all', (req, res) => {
    const sort = req.query.sort || 'date';
    const orderBy = sort === 'likes'
        ? 'votes DESC, p.date DESC, p.submittedAt ASC'
        : 'p.date DESC, votes DESC, p.submittedAt ASC';
    const photos = db.prepare(`
        SELECT p.id, p.counselorName, p.imageUrl, p.date, COUNT(v.id) as votes
        FROM PhotoSubmissions p
        LEFT JOIN PhotoVotes v ON v.photoId = p.id
        GROUP BY p.id
        ORDER BY ${orderBy}
    `).all();
    res.render('photo-gallery-all', { photos, sort });
});

app.get('/photo-download', async (req, res) => {
    const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).send('No photos selected');
    const idPlaceholders = ids.map(() => '?').join(',');
    const photos = db.prepare(
        `SELECT id, counselorName, imageUrl, date FROM PhotoSubmissions WHERE id IN (${idPlaceholders})`
    ).all(...ids);
    if (!photos.length) return res.status(404).send('Photos not found');

    const safeName = (s) => s.replace(/[^a-z0-9_\-]/gi, '-').replace(/-+/g, '-');

    const fetchBuf = (url) => new Promise((resolve, reject) => {
        const doGet = (targetUrl) => {
            const fetcher = targetUrl.startsWith('https') ? https : http;
            fetcher.get(targetUrl, (imgRes) => {
                if ((imgRes.statusCode === 301 || imgRes.statusCode === 302) && imgRes.headers.location) {
                    imgRes.resume();
                    return doGet(imgRes.headers.location);
                }
                if (imgRes.statusCode !== 200) {
                    imgRes.resume();
                    return reject(new Error(`HTTP ${imgRes.statusCode} fetching ${targetUrl}`));
                }
                const chunks = [];
                imgRes.on('data', c => chunks.push(c));
                imgRes.on('end', () => resolve(Buffer.concat(chunks)));
                imgRes.on('error', reject);
            }).on('error', reject);
        };
        doGet(url);
    });

    const getExt = (url) => (url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] || 'jpg';

    try {
        if (photos.length === 1) {
            const p = photos[0];
            const ext = getExt(p.imageUrl);
            const buf = await fetchBuf(p.imageUrl);
            res.setHeader('Content-Disposition', `attachment; filename="${p.date}-${safeName(p.counselorName)}.${ext}"`);
            res.setHeader('Content-Type', `image/${ext === 'jpg' ? 'jpeg' : ext}`);
            return res.end(buf);
        }

        // Fetch all images as buffers before writing any response headers,
        // so a mid-stream error can't corrupt the HTTP response.
        const entries = (await Promise.all(photos.map(async (p) => {
            try {
                const buf = await fetchBuf(p.imageUrl);
                const ext = getExt(p.imageUrl);
                return { name: `${p.date}-${safeName(p.counselorName)}-${p.id}.${ext}`, buf };
            } catch { return null; }
        }))).filter(Boolean);

        if (!entries.length) return res.status(502).send('Failed to fetch images');

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="camp-photos.zip"');
        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.on('error', err => {
            console.error('[photo-download] archiver error:', err);
            if (!res.headersSent) res.status(500).send('Download failed');
            else res.destroy();
        });
        archive.pipe(res);
        for (const e of entries) archive.append(e.buf, { name: e.name });
        await archive.finalize();
    } catch (e) {
        console.error('[photo-download] error:', e);
        if (!res.headersSent) res.status(500).send('Download failed');
        else res.destroy();
    }
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

app.post('/set-prep-week', (req, res) => {
    const w = parseInt(req.body.weekNumber);
    if (w < 1 || w > 6) return res.redirect('/settings?message=Invalid+week');
    const cur = db.prepare('SELECT isPrepTarget FROM Sessions WHERE weekNumber=?').get(w);
    db.exec('UPDATE Sessions SET isPrepTarget = 0');
    if (!cur?.isPrepTarget) db.prepare('UPDATE Sessions SET isPrepTarget = 1 WHERE weekNumber = ?').run(w);
    res.redirect('/settings?message=Prep+target+updated');
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
    // Preserve locked offerings — save their assignments, delete all, then restore
    const locked = db.prepare('SELECT PeriodNumber, ActivityName FROM LockedOfferings WHERE WeekNumber=?').all(w);
    if (locked.length === 0) {
        db.prepare('DELETE FROM CounselorWeekSchedules WHERE WeekNumber=?').run(w);
    } else {
        const keep = db.prepare(
            `SELECT CounselorID, PeriodNumber, ActivityName FROM CounselorWeekSchedules WHERE WeekNumber=? AND (${locked.map(() => '(PeriodNumber=? AND ActivityName=?)').join(' OR ')})`
        ).all(w, ...locked.flatMap(l => [l.PeriodNumber, l.ActivityName]));
        db.prepare('DELETE FROM CounselorWeekSchedules WHERE WeekNumber=?').run(w);
        const reinsert = db.prepare('INSERT OR IGNORE INTO CounselorWeekSchedules (CounselorID, WeekNumber, PeriodNumber, ActivityName) VALUES (?,?,?,?)');
        db.transaction(() => { keep.forEach(r => reinsert.run(r.CounselorID, w, r.PeriodNumber, r.ActivityName)); })();
    }
    if (mode === 'full') {
        db.prepare('DELETE FROM CounselorScheduleAssignments').run();
    }
    res.redirect(`/counselor-scheduling?week=${w}&message=Schedule+cleared`);
});

// ── Lock offering API ────────────────────────────────────────────────────────
app.get('/api/locked-offerings', (req, res) => {
    const w = parseInt(req.query.week);
    if (!w) return res.status(400).json({ error: 'Missing week' });
    const rows = db.prepare('SELECT PeriodNumber, ActivityName FROM LockedOfferings WHERE WeekNumber=?').all(w);
    res.json(rows);
});

app.post('/api/toggle-lock', (req, res) => {
    const { weekNumber, periodNumber, activityName, locked } = req.body;
    const w = parseInt(weekNumber), p = parseInt(periodNumber);
    if (!w || !p || !activityName) return res.status(400).json({ error: 'Missing fields' });
    if (locked) {
        db.prepare('INSERT OR IGNORE INTO LockedOfferings (WeekNumber, PeriodNumber, ActivityName) VALUES (?,?,?)').run(w, p, activityName);
    } else {
        db.prepare('DELETE FROM LockedOfferings WHERE WeekNumber=? AND PeriodNumber=? AND ActivityName=?').run(w, p, activityName);
    }
    res.json({ ok: true });
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

app.get('/api/week-staff-assignments/:week', (req, res) => {
    const w = parseInt(req.params.week);
    if (w < 1 || w > 6) return res.status(400).json({ error: 'Invalid week' });
    const rows = db.prepare("SELECT PersonID, PeriodNumber, ActivityName FROM CounselorScheduleAssignments WHERE PersonType='Instructor' AND WeekNumber=?").all(w);
    res.json(rows);
});

app.get('/api/counselor-week-pinned-types/:week', (req, res) => {
    const w = parseInt(req.params.week);
    if (w < 1 || w > 6) return res.status(400).json({ error: 'Invalid week' });
    const rows = db.prepare("SELECT CounselorID, ScheduleType FROM CounselorWeekAttributes WHERE WeekNumber=? AND ScheduleTypeManual=1 AND ScheduleType IS NOT NULL").all(w);
    res.json(rows);
});

app.post('/mirror-sports-location', (req, res) => {
    const fromWeek = parseInt(req.body.fromWeek);
    const toWeek   = parseInt(req.body.toWeek);
    if (fromWeek < 1 || fromWeek > 6 || toWeek < 1 || toWeek > 6) {
        return res.redirect(`/counselor-scheduling?week=${toWeek}&message=Invalid+week`);
    }
    const sources = db.prepare("SELECT PeriodNumber, ActivityName, Location FROM WeeklyOfferings WHERE WeekNumber=? AND SideOfCamp='Sports' AND Location IS NOT NULL").all(fromWeek);
    const upd = db.prepare("UPDATE WeeklyOfferings SET Location=? WHERE WeekNumber=? AND PeriodNumber=? AND ActivityName=? AND SideOfCamp='Sports'");
    db.transaction(() => { for (const s of sources) upd.run(s.Location, toWeek, s.PeriodNumber, s.ActivityName); })();
    res.redirect(`/counselor-scheduling?week=${toWeek}&message=Mirrored+location+for+${sources.length}+Sports+class${sources.length !== 1 ? 'es' : ''}+from+Week+${fromWeek}`);
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
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName, cwd.HomeGroupColor,
               chg.CounselorID AS AssignedCounselorID
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        LEFT JOIN CamperHomeGroups chg ON chg.CamperID = c.CamperID AND chg.WeekNumber = ?
        WHERE cwd.HomeGroupColor IN ('Red','Carolina','Green','Navy')
        ORDER BY cwd.HomeGroupColor, c.LastName, c.FirstName
    `).all(week, week);

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

    // RC-relevant offerings: Enrichment in blocks 1,2 and Sports in blocks 5,6; period 4 includes both sides
    const offerings = db.prepare(`
        SELECT ActivityName, PeriodNumber, SideOfCamp, PreliminaryEnrollment, Location
        FROM WeeklyOfferings
        WHERE WeekNumber = ?
          AND ((PeriodNumber IN (1,2) AND SideOfCamp = 'Enrichment')
            OR (PeriodNumber IN (4,5,6) AND SideOfCamp = 'Sports'))
        ORDER BY PeriodNumber, SideOfCamp, ActivityName
    `).all(aw);

    const splitCampers = db.prepare(`
        SELECT c.CamperID, c.FirstName, c.LastName, c.PreferredName
        FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.HomeGroupColor = 'SPLIT'
        ORDER BY c.LastName, c.FirstName
    `).all(aw);
    const splitIds = splitCampers.map(c => c.CamperID);

    // Enrollment per class (non-SPLIT campers currently in Schedules for active week)
    const enrollmentMap = {};
    for (const o of offerings) {
        const n = db.prepare(`
            SELECT COUNT(*) as n FROM Schedules
            WHERE PersonType='Camper' AND WeekNumber=? AND PeriodNumber=? AND ActivityName=?
              AND PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor='SPLIT')
        `).get(aw, o.PeriodNumber, o.ActivityName, aw)?.n || 0;
        enrollmentMap[`${o.PeriodNumber}|${o.ActivityName}`] = n;
    }

    // Existing SPLIT assignments keyed by "period|activity" → [camperID, ...]
    const assignedByKey = {};
    if (splitIds.length > 0) {
        const ph = splitIds.map(() => '?').join(',');
        db.prepare(`SELECT PersonID, PeriodNumber, ActivityName FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PersonID IN (${ph})`).all(aw, ...splitIds)
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

    const aw = getActiveWeek();
    const splitIds = db.prepare(`
        SELECT c.CamperID FROM Campers c
        JOIN CamperWeekData cwd ON cwd.CamperID = c.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.HomeGroupColor = 'SPLIT'
    `).all(aw).map(c => c.CamperID);
    if (splitIds.length === 0) return res.json({ ok: true });

    const ph = splitIds.map(() => '?').join(',');
    try {
        db.transaction(() => {
            db.prepare(`DELETE FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PersonID IN (${ph})`).run(aw, ...splitIds);
            const ins = db.prepare("INSERT OR IGNORE INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, WeekNumber) VALUES (?,?,?,?,?)");
            for (const a of assignments) {
                if (a.camperID && a.periodNumber && a.activityName) {
                    ins.run(a.camperID, 'Camper', a.periodNumber, a.activityName, aw);
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
            SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.PreferredName
            FROM Campers ca
            JOIN Schedules s ON s.PersonID = ca.CamperID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
            WHERE s.PeriodNumber = ? AND s.ActivityName = ? COLLATE NOCASE
              AND ca.CamperID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber = ? AND HomeGroupColor = 'SPLIT')
            ORDER BY ca.LastName, ca.FirstName
        `).all(aw, r.PeriodNumber, r.ActivityName, aw);

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
               ca.PreferredName AS CamperPreferred, cwd.HomeGroupColor AS CamperColor
        FROM CamperHomeGroups chg
        JOIN Counselors co ON co.CounselorID = chg.CounselorID
        LEFT JOIN CounselorWeekAttributes cwa
            ON cwa.CounselorID = co.CounselorID AND cwa.WeekNumber = ?
        JOIN Campers ca ON ca.CamperID = chg.CamperID
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = ca.CamperID AND cwd.WeekNumber = ?
        WHERE chg.WeekNumber = ?
        ORDER BY co.HomeGroupColor, co.LastName, co.FirstName, ca.LastName, ca.FirstName
    `).all(aw, aw, aw);

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
            PreferredName: r.CamperPreferred,
            HomeGroupColor: r.CamperColor
        });
    });
    const homegroupSheets = Object.values(hgMap);

    // ── Bus rosters ──────────────────────────────────────────────────────────
    const busRows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.PreferredName,
               cwd.HomeGroupColor, cwd.BusRoute, cwd.BusRidesAM, cwd.BusRidesPM
        FROM Campers ca
        JOIN CamperWeekData cwd ON cwd.CamperID = ca.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.BusRoute IS NOT NULL AND TRIM(cwd.BusRoute) != '' AND LOWER(TRIM(cwd.BusRoute)) != 'null'
        ORDER BY cwd.BusRoute, ca.LastName, ca.FirstName
    `).all(aw);

    const busMap = {};
    busRows.forEach(r => {
        const route = r.BusRoute;
        if (!busMap[route]) busMap[route] = { am: [], pm: [] };
        if (r.BusRidesAM !== 0) busMap[route].am.push(r);
        if (r.BusRidesPM !== 0) busMap[route].pm.push(r);
    });
    const busSheets = Object.entries(busMap).map(([route, { am, pm }]) => ({ route, campersAM: am, campersPM: pm }));
    const busSheetsByRoute = Object.fromEntries(busSheets.map(s => [s.route, s]));

    // ── Extended care rosters ────────────────────────────────────────────────
    const extRows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.PreferredName,
               cwd.HomeGroupColor, cwd.ExtendedHours
        FROM Campers ca
        JOIN CamperWeekData cwd ON cwd.CamperID = ca.CamperID AND cwd.WeekNumber = ?
        WHERE cwd.ExtendedHours IN ('AM', 'Both', 'PM')
        ORDER BY cwd.HomeGroupColor, ca.LastName, ca.FirstName
    `).all(aw);

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
    const aw = getActiveWeek();
    const rows = db.prepare(`
        SELECT ca.CamperID, ca.FirstName, ca.LastName, ca.PreferredName, cwd.HomeGroupColor,
               s.PeriodNumber, s.ActivityName,
               co.FirstName AS CounselorFirst, co.LastName AS CounselorLast
        FROM Campers ca
        LEFT JOIN CamperWeekData cwd ON cwd.CamperID = ca.CamperID AND cwd.WeekNumber = ?
        JOIN Schedules s ON s.PersonID = ca.CamperID AND s.PersonType = 'Camper' AND s.WeekNumber = ?
        LEFT JOIN CamperHomeGroups chg ON chg.CamperID = ca.CamperID AND chg.WeekNumber = ?
        LEFT JOIN Counselors co ON co.CounselorID = chg.CounselorID
        ORDER BY ca.LastName, ca.FirstName, s.PeriodNumber
    `).all(aw, aw, aw);

    const camperMap = {};
    rows.forEach(r => {
        if (!camperMap[r.CamperID]) {
            camperMap[r.CamperID] = {
                CamperID: r.CamperID,
                FirstName: r.FirstName,
                LastName: r.LastName,
                PreferredName: r.PreferredName,
                HomeGroupColor: r.HomeGroupColor || '',
                counselorName: r.CounselorFirst ? `${r.CounselorFirst} ${r.CounselorLast}` : null,
                classes: []
            };
        }
        camperMap[r.CamperID].classes.push(r.ActivityName);
    });

    const COLOR_ORDER = ['Red', 'Carolina', 'Green', 'Navy', 'SPLIT'];
    const sorted = Object.values(camperMap).sort((a, b) => {
        const ai = COLOR_ORDER.indexOf(a.HomeGroupColor);
        const bi = COLOR_ORDER.indexOf(b.HomeGroupColor);
        const aOrd = ai === -1 ? COLOR_ORDER.length : ai;
        const bOrd = bi === -1 ? COLOR_ORDER.length : bi;
        if (aOrd !== bOrd) return aOrd - bOrd;
        return a.LastName.localeCompare(b.LastName) || (a.PreferredName || a.FirstName).localeCompare(b.PreferredName || b.FirstName);
    });
    res.render('name-cards', { campers: sorted, sessionNumber: aw });
});

// ─── DOCUMENT PDF UPLOAD / SERVE ──────────────────────────────────────────────

const PDF_DOCS = [
    { slug: 'daily-schedule',             label: 'Daily Schedule',                     icon: '📅' },
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

// ── Push notification dispatcher ─────────────────────────────────────────────
// Runs every 60 s.
//   • Class nudge: fires per-counselor per-class when 15+ min into a period.
//   • Homegroup alerts: fires once at 9:00 AM (AM) and 4:00 PM (PM) for any
//     counselor who hasn't fully submitted that homegroup session.
const _pushNudgedToday   = new Map(); // date → Set<"counselorId:activityName">
const _hgAlertFiredDates = new Map(); // 'am_DATE' | 'pm_DATE' → true

const _pushCheckTotal = db.prepare(`
    SELECT COUNT(*) as n FROM Schedules s
    WHERE s.PersonType='Camper' AND s.WeekNumber=? AND s.PeriodNumber=? AND s.ActivityName=?
      AND s.PersonID NOT IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor='SPLIT')
`);
const _pushCheckHandled = db.prepare(`
    SELECT COUNT(*) as n FROM (
        SELECT CamperID FROM Attendance
        WHERE Date=? AND SessionType='class' AND PeriodNumber=? AND ActivityName=?
          AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
        UNION
        SELECT CamperID FROM EarlyDismissals WHERE Date=?
          AND CamperID IN (SELECT PersonID FROM Schedules WHERE PersonType='Camper' AND WeekNumber=? AND PeriodNumber=? AND ActivityName=?)
          AND CamperID IN (SELECT CamperID FROM CamperWeekData WHERE WeekNumber=? AND HomeGroupColor != 'SPLIT')
    )
`);
const _hgPushCamperCountWeek   = db.prepare("SELECT COUNT(*) as n FROM CamperHomeGroups WHERE CounselorID=? AND WeekNumber=?");
const _hgPushCamperCountLegacy = db.prepare("SELECT COUNT(*) as n FROM Campers WHERE HomeGroupCounselorID=?");
const _hgPushHandledWeek = db.prepare(`
    SELECT COUNT(*) as n FROM (
        SELECT CamperID FROM Attendance
        WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
          AND CamperID IN (SELECT CamperID FROM CamperHomeGroups WHERE CounselorID=? AND WeekNumber=?)
        UNION
        SELECT CamperID FROM EarlyDismissals WHERE Date=?
          AND CamperID IN (SELECT CamperID FROM CamperHomeGroups WHERE CounselorID=? AND WeekNumber=?)
    )
`);
const _hgPushHandledLegacy = db.prepare(`
    SELECT COUNT(*) as n FROM (
        SELECT CamperID FROM Attendance
        WHERE Date=? AND SessionType=? AND PeriodNumber=0 AND ActivityName=''
          AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupCounselorID=?)
        UNION
        SELECT CamperID FROM EarlyDismissals WHERE Date=?
          AND CamperID IN (SELECT CamperID FROM Campers WHERE HomeGroupCounselorID=?)
    )
`);

function _pushNotifiableBlock(schedule, estMins) {
    for (let i = 0; i < schedule.length; i++) {
        const start = schedule[i].startH * 60 + schedule[i].startM;
        const next  = i + 1 < schedule.length
            ? schedule[i + 1].startH * 60 + schedule[i + 1].startM
            : CAMP_DAY_END_MINS;
        if (estMins >= start + 15 && estMins < next) return schedule[i].clockBlock;
    }
    return null;
}

setInterval(() => {
    const estMins = getESTMins();
    const today   = getTodayEST();

    // Only send notifications on camp days
    if (!isCampDay(today)) return;

    // Prune stale date keys
    for (const [date] of _pushNudgedToday) {
        if (date !== today) _pushNudgedToday.delete(date);
    }
    if (!_pushNudgedToday.has(today)) _pushNudgedToday.set(today, new Set());
    const nudged = _pushNudgedToday.get(today);

    for (const [k] of _hgAlertFiredDates) {
        if (!k.endsWith(today)) _hgAlertFiredDates.delete(k);
    }

    const subscriptions = db.prepare("SELECT * FROM PushSubscriptions").all();
    if (subscriptions.length === 0) return;

    // ── Class period nudge ────────────────────────────────────────────────
    const sportsBlock     = _pushNotifiableBlock(SPORTS_PERIODS, estMins);
    const enrichmentBlock = _pushNotifiableBlock(ENRICHMENT_PERIODS, estMins);
    const activeBlocks    = [...new Set([sportsBlock, enrichmentBlock].filter(Boolean))];

    if (activeBlocks.length > 0) {
        const weekNum = getActiveWeek();
        const getAssignments = db.prepare(`
            SELECT ActivityName FROM CounselorScheduleAssignments
            WHERE PersonID = ? AND PeriodNumber = ? AND WeekNumber = ?
        `);

        for (const row of subscriptions) {
            const counselorId = row.CounselorID;
            const toSend = [];

            for (const block of activeBlocks) {
                const assignments = getAssignments.all(counselorId, block, weekNum);
                for (const a of assignments) {
                    const key     = `${counselorId}:${a.ActivityName}`;
                    if (nudged.has(key)) continue;
                    const total   = _pushCheckTotal.get(weekNum, block, a.ActivityName, weekNum)?.n || 0;
                    const handled = _pushCheckHandled.get(today, block, a.ActivityName, weekNum, today, weekNum, block, a.ActivityName, weekNum)?.n || 0;
                    if (total === 0 || handled >= total) continue;
                    toSend.push(a.ActivityName);
                    nudged.add(key);
                }
            }

            if (toSend.length === 0) continue;

            const payload = JSON.stringify({
                title: 'Attendance Reminder',
                body:  'Please submit attendance for: ' + toSend.join(', '),
                url:   '/staff'
            });

            try {
                const subscription = JSON.parse(row.subscription);
                webPush.sendNotification(subscription, payload).catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        db.prepare("DELETE FROM PushSubscriptions WHERE endpoint=?").run(row.endpoint);
                    }
                });
            } catch (_) {}
        }
    }

    // ── Homegroup one-shot alerts: 9:00 AM → AM, 4:00 PM → PM ───────────
    for (const [session, triggerMins] of [['am', 9 * 60], ['pm', 16 * 60]]) {
        const alertKey = `${session}_${today}`;
        if (_hgAlertFiredDates.has(alertKey)) continue;
        if (estMins < triggerMins || estMins >= triggerMins + 2) continue;

        _hgAlertFiredDates.set(alertKey, true);

        const sessionType = `homegroup_${session}`;
        const aw = getActiveWeek();
        const hasWeekHgData = aw && db.prepare("SELECT 1 FROM CamperHomeGroups WHERE WeekNumber=? LIMIT 1").get(aw);

        for (const row of subscriptions) {
            const cid = row.CounselorID;
            const camperCount = hasWeekHgData
                ? _hgPushCamperCountWeek.get(cid, aw)?.n || 0
                : _hgPushCamperCountLegacy.get(cid)?.n || 0;
            if (camperCount === 0) continue;

            const handled = hasWeekHgData
                ? _hgPushHandledWeek.get(today, sessionType, cid, aw, today, cid, aw)?.n || 0
                : _hgPushHandledLegacy.get(today, sessionType, cid, today, cid)?.n || 0;
            if (handled >= camperCount) continue;

            const payload = JSON.stringify({
                title: 'Attendance Reminder',
                body:  `Please submit ${session.toUpperCase()} homegroup attendance`,
                url:   '/staff'
            });

            try {
                const subscription = JSON.parse(row.subscription);
                webPush.sendNotification(subscription, payload).catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        db.prepare("DELETE FROM PushSubscriptions WHERE endpoint=?").run(row.endpoint);
                    }
                });
            } catch (_) {}
        }
    }
}, 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Camp Manager running on port ${PORT}`));