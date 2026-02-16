const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const db = new Database('camp_manager.db');
const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// --- DASHBOARD ROUTE ---
app.get('/', (req, res) => {
    const campers = db.prepare(`
        SELECT c.*, n.FirstName AS CounselorFirst FROM Campers c
        LEFT JOIN Counselors n ON c.HomeGroupCounselorID = n.CounselorID
    `).all();
    
    const counselors = db.prepare('SELECT * FROM Counselors').all();
    const staffMembers = db.prepare('SELECT * FROM Staff').all();
    const schedules = db.prepare('SELECT * FROM Schedules').all();

    // Fetch Activities for Manager
    const allActivities = db.prepare(`
        SELECT DISTINCT s.ActivityName as Name, a.SideOfCamp, a.MaxCapacity
        FROM Schedules s
        LEFT JOIN Activities a ON s.ActivityName = a.Name
        WHERE s.PersonType = 'Camper'
    `).all();

    // Fetch Waitlist with Live Enrollment Checks
    const waitlistEntries = db.prepare(`
        SELECT w.*, c.FirstName, c.LastName, a.MaxCapacity,
        (SELECT COUNT(*) FROM Schedules s WHERE s.ActivityName = w.RequestedActivity AND s.PeriodNumber = w.PeriodNumber AND s.TimeOfDay = w.TimeOfDay AND s.PersonType = 'Camper') as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        JOIN Activities a ON w.RequestedActivity = a.Name
    `).all();

    res.render('index', { 
        campers, counselors, staffMembers, schedules, 
        allActivities, waitlistEntries,
        alertMessage: req.query.message || null 
    });
});

// --- MASTER SCHEDULE ---
app.get('/master-schedule', (req, res) => {
    const enrollmentSummary = db.prepare(`
        SELECT s.PeriodNumber, s.TimeOfDay, s.ActivityName, MAX(s.Location) as Location, 
        COUNT(CASE WHEN s.PersonType = 'Camper' THEN 1 END) as TotalEnrollment
        FROM Schedules s
        GROUP BY s.PeriodNumber, s.TimeOfDay, s.ActivityName
        HAVING TotalEnrollment > 0
        ORDER BY s.PeriodNumber, s.TimeOfDay
    `).all();

    const counselorAssignments = db.prepare(`
        SELECT s.PeriodNumber, s.TimeOfDay, s.ActivityName, c.FirstName, c.LastName
        FROM Schedules s JOIN Counselors c ON s.PersonID = c.CounselorID WHERE s.PersonType = 'Counselor'
    `).all();

    const staffAssignments = db.prepare(`
        SELECT s.PeriodNumber, s.TimeOfDay, s.ActivityName, st.FirstName, st.LastName, st.StaffType
        FROM Schedules s JOIN Staff st ON s.PersonID = st.StaffID WHERE s.PersonType = 'Staff'
    `).all();

    const camperDetails = db.prepare(`
        SELECT s.PeriodNumber, s.TimeOfDay, s.ActivityName, c.FirstName, c.LastName, c.ColorGroup
        FROM Schedules s JOIN Campers c ON s.PersonID = c.CamperID WHERE s.PersonType = 'Camper'
    `).all();

    const masterSchedule = enrollmentSummary.map(course => ({
        ...course,
        counselors: counselorAssignments.filter(ca => ca.PeriodNumber === course.PeriodNumber && ca.TimeOfDay === course.TimeOfDay && ca.ActivityName === course.ActivityName),
        staff: staffAssignments.filter(sa => sa.PeriodNumber === course.PeriodNumber && sa.TimeOfDay === course.TimeOfDay && sa.ActivityName === course.ActivityName),
        campers: camperDetails.filter(cp => cp.PeriodNumber === course.PeriodNumber && cp.TimeOfDay === course.TimeOfDay && cp.ActivityName === course.ActivityName)
    }));

    res.render('master-schedule', { masterSchedule });
});

// --- SWAP TOOL & WAITLIST LOGIC ---
app.get('/swap-tool', (req, res) => {
    const query = req.query.name;
    let camper = null, currentSchedule = [];
    if (query) {
        camper = db.prepare(`SELECT * FROM Campers WHERE FirstName || ' ' || LastName LIKE ?`).get(`%${query}%`);
        if (camper) currentSchedule = db.prepare(`SELECT s.*, a.SideOfCamp FROM Schedules s LEFT JOIN Activities a ON s.ActivityName = a.Name WHERE s.PersonID = ? AND s.PersonType = 'Camper'`).all(camper.CamperID);
    }
    res.render('swap-tool', { camper, currentSchedule, query });
});

app.get('/get-options/:camperId/:period', (req, res) => {
    const { camperId, period } = req.params;
    
    // 1. Get the TimeOfDay for this specific camper's period
    const sched = db.prepare(`
        SELECT TimeOfDay FROM Schedules 
        WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
    `).get(camperId, period);

    if (!sched) return res.json([]);

    // 2. Logic check: AM is always Enrichment, PM is always Sports
    const sideNeeded = (sched.TimeOfDay === 'AM') ? 'Enrichment' : 'Sports';

    // 3. Fetch ONLY activities that match that side
    // We also use a LEFT JOIN to ensure we catch activities even if they 
    // haven't had a capacity set yet, but we STRICTLY filter by SideOfCamp
    const options = db.prepare(`
        SELECT 
            a.Name, 
            a.MaxCapacity, 
            a.SideOfCamp,
            (SELECT COUNT(*) FROM Schedules s2 
             WHERE s2.ActivityName = a.Name 
             AND s2.PeriodNumber = ? 
             AND s2.TimeOfDay = ? 
             AND s2.PersonType = 'Camper') as CurrentEnrollment
        FROM Activities a 
        WHERE a.SideOfCamp = ?
    `).all(period, sched.TimeOfDay, sideNeeded);
    
    res.json(options);
});

app.get('/process-swap', (req, res) => {
    const { camperId, period, newActivity, forceWaitlist } = req.query;

    // ... Logic to check MaxCapacity vs CurrentEnrollment ...

    if (forceWaitlist === 'true') {
        // Adds to Waitlists table
    } else {
        // Updates Schedules table
    }
});

app.post('/promote-waitlist', (req, res) => {
    const entry = db.prepare('SELECT * FROM Waitlists WHERE WaitlistID = ?').get(req.body.WaitlistID);
    if (entry) {
        db.prepare(`UPDATE Schedules SET ActivityName = ? WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'`).run(entry.RequestedActivity, entry.CamperID, entry.PeriodNumber);
        db.prepare('DELETE FROM Waitlists WHERE WaitlistID = ?').run(req.body.WaitlistID);
    }
    res.redirect('/?message=Promoted');
});

// --- ACTIVITY MANAGER ---
app.post('/update-activity', (req, res) => {
    const { ActivityName, SideOfCamp, MaxCapacity } = req.body;
    db.prepare(`INSERT INTO Activities (Name, SideOfCamp, MaxCapacity) VALUES (?, ?, ?) ON CONFLICT(Name) DO UPDATE SET SideOfCamp=excluded.SideOfCamp, MaxCapacity=excluded.MaxCapacity`).run(ActivityName, SideOfCamp, MaxCapacity);
    res.redirect('/?message=Activity+Updated');
});

// --- CSV UPLOADS ---
app.post('/upload-staff', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => results.push(data)).on('end', () => {
        const insertStaff = db.prepare(`INSERT INTO Staff (FirstName, LastName, StaffType, ColorGroup) VALUES (@FirstName, @LastName, @StaffType, @ColorGroup)`);
        const insertSched = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, Location, TimeOfDay) VALUES (?, 'Staff', ?, ?, ?, ?)`);
        db.transaction((dataArray) => {
            for (const row of dataArray) {
                const sid = insertStaff.run(row).lastInsertRowid;
                const maxP = row.StaffType === 'Unit Leader' ? 6 : 4;
                for (let i = 1; i <= maxP; i++) {
                    if (row[`P${i}`]) insertSched.run(sid, i, row[`P${i}`], row[`L${i}`] || null, i <= 3 ? 'AM' : 'PM');
                }
            }
        })(results);
        fs.unlinkSync(req.file.path);
        res.redirect('/?message=Staff+Imported');
    });
});

app.post('/upload-campers', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => results.push(data)).on('end', () => {
        const insCamper = db.prepare(`INSERT INTO Campers (FirstName, LastName, Age, ColorGroup, BusRoute, ExtendedHours, CampLunch) VALUES (@FirstName, @LastName, @Age, @ColorGroup, @BusRoute, @ExtendedHours, @CampLunch)`);
        const insSched = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, Location, TimeOfDay) VALUES (?, 'Camper', ?, ?, ?, ?)`);
        db.transaction((dataArray) => {
            for (const row of dataArray) {
                const cid = insCamper.run(row).lastInsertRowid;
                const amCut = (row.ColorGroup === 'Red' || row.ColorGroup === 'Carolina') ? 2 : 3;
                for (let i = 1; i <= 5; i++) {
                    if (row[`P${i}`]) insSched.run(cid, i, row[`P${i}`], null, i <= amCut ? 'AM' : 'PM');
                }
            }
        })(results);
        fs.unlinkSync(req.file.path);
        res.redirect('/?message=Campers+Imported');
    });
});

app.post('/upload-counselors', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => results.push(data)).on('end', () => {
        const insCouns = db.prepare(`INSERT INTO Counselors (FirstName, LastName, HomeGroupColor, ScheduleType) VALUES (@FirstName, @LastName, @HomeGroupColor, @ScheduleType)`);
        const insSched = db.prepare(`INSERT INTO Schedules (PersonID, PersonType, PeriodNumber, ActivityName, Location, TimeOfDay) VALUES (?, 'Counselor', ?, ?, ?, ?)`);
        db.transaction((dataArray) => {
            for (const row of dataArray) {
                const sid = insCouns.run(row).lastInsertRowid;
                let amLimit = row.ScheduleType.includes('Sports AM') ? 3 : 2;
                for (let i = 1; i <= 6; i++) {
                    if (row[`P${i}`]) insSched.run(sid, i, row[`P${i}`], null, i <= amLimit ? 'AM' : 'PM');
                }
            }
        })(results);
        fs.unlinkSync(req.file.path);
        res.redirect('/?message=Counselors+Imported');
    });
});
app.post('/upload-activity-rules', upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const upsertActivity = db.prepare(`
                INSERT INTO Activities (Name, SideOfCamp, MaxCapacity)
                VALUES (@Name, @SideOfCamp, @MaxCapacity)
                ON CONFLICT(Name) DO UPDATE SET
                    SideOfCamp = excluded.SideOfCamp,
                    MaxCapacity = excluded.MaxCapacity
            `);

            db.transaction((dataArray) => {
                for (const row of dataArray) {
                    upsertActivity.run(row);
                }
            })(results);

            fs.unlinkSync(req.file.path);
            res.redirect('/activities?message=Rules+Imported');
        });
});

// Route to view the new Activity Management page
app.get('/activities', (req, res) => {
    const activities = db.prepare('SELECT * FROM Activities ORDER BY SideOfCamp, Name').all();
    res.render('activity-manager', { activities, alertMessage: req.query.message || null });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));