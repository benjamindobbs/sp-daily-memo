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

    const promoCount = db.prepare(`
        SELECT COUNT(*) as count FROM Waitlists w
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE (
            SELECT COUNT(*) FROM Schedules s 
            WHERE s.ActivityName = w.RequestedActivity 
            AND s.PeriodNumber = w.PeriodNumber 
            AND s.TimeOfDay = w.TimeOfDay 
            AND s.PersonType = 'Camper'
        ) < a.MaxCapacity
    `).get().count;

    res.render('index', { 
        campers, counselors, staffMembers, schedules, 
        allActivities, waitlistEntries,
        potentialPromotionsCount: promoCount,
        alertMessage: req.query.message || null 
    });
});

// --- MASTER SCHEDULE ---
app.get('/master-schedule', (req, res) => {
    try {
        const masterData = db.prepare(`
            SELECT 
                c.CamperID, c.FirstName, c.LastName, c.ColorGroup,
                s1.ActivityName AS P1, a1.SideOfCamp AS S1,
                s2.ActivityName AS P2, a2.SideOfCamp AS S2,
                s3.ActivityName AS P3, a3.SideOfCamp AS S3,
                s4.ActivityName AS P4, a4.SideOfCamp AS S4,
                s5.ActivityName AS P5, a5.SideOfCamp AS S5
            FROM Campers c
            LEFT JOIN Schedules s1 ON c.CamperID = s1.PersonID AND s1.PeriodNumber = 1 AND s1.PersonType = 'Camper'
            LEFT JOIN Activities a1 ON s1.ActivityName = a1.Name
            LEFT JOIN Schedules s2 ON c.CamperID = s2.PersonID AND s2.PeriodNumber = 2 AND s2.PersonType = 'Camper'
            LEFT JOIN Activities a2 ON s2.ActivityName = a2.Name
            LEFT JOIN Schedules s3 ON c.CamperID = s3.PersonID AND s3.PeriodNumber = 3 AND s3.PersonType = 'Camper'
            LEFT JOIN Activities a3 ON s3.ActivityName = a3.Name
            LEFT JOIN Schedules s4 ON c.CamperID = s4.PersonID AND s4.PeriodNumber = 4 AND s4.PersonType = 'Camper'
            LEFT JOIN Activities a4 ON s4.ActivityName = a4.Name
            LEFT JOIN Schedules s5 ON c.CamperID = s5.PersonID AND s5.PeriodNumber = 5 AND s5.PersonType = 'Camper'
            LEFT JOIN Activities a5 ON s5.ActivityName = a5.Name
            ORDER BY 
                CASE WHEN c.ColorGroup IN ('Red', 'Carolina') THEN 1 ELSE 2 END, 
                c.LastName ASC
        `).all();

        res.render('master-schedule', { data: masterData });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error generating rule-aware schedule");
    }
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
    
    const camperData = db.prepare(`
        SELECT c.FirstName, c.ColorGroup, s.TimeOfDay 
        FROM Campers c
        JOIN Schedules s ON c.CamperID = s.PersonID
        WHERE c.CamperID = ? AND s.PeriodNumber = ? AND s.PersonType = 'Camper'
    `).get(camperId, period);

    if (!camperData) return res.json({ side: 'Unknown', options: [] });

    const { ColorGroup, TimeOfDay } = camperData;
    let sideNeeded;

    // NEW LOGIC based on your specific split:
    if (ColorGroup === 'Red' || ColorGroup === 'Carolina') {
        // Reds/Carolinas: Period 3 is PM (Sports), Periods 1-2 are AM (Enrichment)
        sideNeeded = (TimeOfDay === 'AM') ? 'Enrichment' : 'Sports';
    } else {
        // Greens/Navys: Period 3 is AM (Enrichment), Periods 4-5 are PM (Sports)
        // This is the inverse of the Red logic
        sideNeeded = (TimeOfDay === 'AM') ? 'Enrichment' : 'Sports';
    }
    
    // Note: Since you've explicitly labeled P3-PM as Reds and P3-AM as Greens, 
    // the TimeOfDay itself effectively tells us the side if the Activities 
    // are set up correctly.

    const options = db.prepare(`
        SELECT a.Name, a.MaxCapacity, 
        (SELECT COUNT(*) FROM Schedules s2 WHERE s2.ActivityName = a.Name AND s2.PeriodNumber = ? AND s2.TimeOfDay = ? AND s2.PersonType = 'Camper') as CurrentEnrollment,
        CASE WHEN (SELECT COUNT(*) FROM Schedules s2 WHERE s2.ActivityName = a.Name AND s2.PeriodNumber = ? AND s2.TimeOfDay = ? AND s2.PersonType = 'Camper') >= a.MaxCapacity 
             THEN 1 ELSE 0 END as isFull
        FROM Activities a
        INNER JOIN (SELECT DISTINCT ActivityName FROM Schedules WHERE PeriodNumber = ? AND TimeOfDay = ?) running ON a.Name = running.ActivityName
        WHERE a.SideOfCamp = ?
        ORDER BY isFull ASC, a.Name ASC
    `).all(period, TimeOfDay, period, TimeOfDay, period, TimeOfDay, sideNeeded);
    
    res.json({ side: sideNeeded, options: options });
});

// --- PROCESS SWAP ROUTE ---
app.get('/process-swap', (req, res) => {
    const { camperId, period, newActivity, action } = req.query;

    try {
        const sched = db.prepare(`
            SELECT TimeOfDay FROM Schedules 
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
        `).get(camperId, period);

        if (!sched) return res.redirect('/?message=Error:+Schedule+not+found');

        // Check Capacity
        const stats = db.prepare(`
            SELECT 
                (SELECT MaxCapacity FROM Activities WHERE Name = ?) as MaxCap,
                (SELECT COUNT(*) FROM Schedules 
                 WHERE ActivityName = ? AND PeriodNumber = ? 
                 AND TimeOfDay = ? AND PersonType = 'Camper') as CurrentCount
        `).get(newActivity, newActivity, period, sched.TimeOfDay);

        const maxCapacity = stats.MaxCap || 20;

        // --- CAPACITY GATEKEEPER ---
        // If the class is full and no specific action (override or waitlist) has been chosen yet
        if (stats.CurrentCount >= maxCapacity && !action) {
            return res.send(`
                <script>
                    const choice = prompt(
                        "Class is FULL (${stats.CurrentCount}/${maxCapacity}).\\n\\n" +
                        "Type 'OVERRIDE' to force the camper in.\\n" +
                        "Type 'WAIT' to add to waitlist.\\n" +
                        "Or click Cancel to go back."
                    );

                    if (choice && choice.toUpperCase() === 'OVERRIDE') {
                        window.location.href = '/process-swap?camperId=${camperId}&period=${period}&newActivity=${encodeURIComponent(newActivity)}&action=override';
                    } else if (choice && choice.toUpperCase() === 'WAIT') {
                        window.location.href = '/process-swap?camperId=${camperId}&period=${period}&newActivity=${encodeURIComponent(newActivity)}&action=waitlist';
                    } else {
                        window.history.back();
                    }
                </script>
            `);
        }

        // --- EXECUTE BASED ON ACTION ---
        if (action === 'waitlist') {
            db.prepare(`
                INSERT INTO Waitlists (CamperID, PeriodNumber, RequestedActivity, TimeOfDay) 
                VALUES (?, ?, ?, ?)
            `).run(camperId, period, newActivity, sched.TimeOfDay);
            return res.redirect('/?message=Added+to+Waitlist');
        }

        // Both 'override' and standard moves end up here
        db.prepare(`
            UPDATE Schedules 
            SET ActivityName = ? 
            WHERE PersonID = ? AND PeriodNumber = ? AND PersonType = 'Camper'
        `).run(newActivity, camperId, period);

        const msg = (action === 'override') ? 'Override+Successful' : 'Schedule+Updated';
        res.redirect(`/?message=${msg}`);

    } catch (err) {
        console.error(err);
        res.redirect('/?message=Error+processing+swap');
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
app.get('/promotions', (req, res) => {
    // This query finds waitlist entries specifically where space has opened up
    const potentialPromotions = db.prepare(`
        SELECT 
            w.WaitlistID, w.PeriodNumber, w.RequestedActivity, w.TimeOfDay, w.Timestamp,
            c.FirstName, c.LastName, c.ColorGroup,
            a.MaxCapacity,
            (SELECT COUNT(*) FROM Schedules s 
             WHERE s.ActivityName = w.RequestedActivity 
             AND s.PeriodNumber = w.PeriodNumber 
             AND s.TimeOfDay = w.TimeOfDay 
             AND s.PersonType = 'Camper') as CurrentEnrollment
        FROM Waitlists w
        JOIN Campers c ON w.CamperID = c.CamperID
        JOIN Activities a ON w.RequestedActivity = a.Name
        WHERE CurrentEnrollment < a.MaxCapacity
        ORDER BY w.Timestamp ASC
    `).all();

    res.render('promotions', { potentialPromotions });
});
// Route to view the new Activity Management page
app.get('/activities', (req, res) => {
    const activities = db.prepare('SELECT * FROM Activities ORDER BY SideOfCamp, Name').all();
    res.render('activity-manager', { activities, alertMessage: req.query.message || null });
});
app.get('/search', (req, res) => {
    try {
        const searchQuery = req.query.name || '';

        const camperList = db.prepare(`
            SELECT 
                c.CamperID, c.FirstName, c.LastName, c.Age, c.ColorGroup, 
                st.FirstName || ' ' || st.LastName AS HomeCounselor, -- Joins Staff names
                c.BusRoute, c.ExtendedHours, c.CampLunch,
                s1.ActivityName AS P1,
                s2.ActivityName AS P2,
                s3.ActivityName AS P3,
                s4.ActivityName AS P4,
                s5.ActivityName AS P5
            FROM Campers c
            LEFT JOIN Staff st ON c.HomeGroupCounselorID = st.StaffID -- Match the ID to Staff table
            LEFT JOIN Schedules s1 ON c.CamperID = s1.PersonID AND s1.PeriodNumber = 1 AND s1.PersonType = 'Camper'
            LEFT JOIN Schedules s2 ON c.CamperID = s2.PersonID AND s2.PeriodNumber = 2 AND s2.PersonType = 'Camper'
            LEFT JOIN Schedules s3 ON c.CamperID = s3.PersonID AND s3.PeriodNumber = 3 AND s3.PersonType = 'Camper'
            LEFT JOIN Schedules s4 ON c.CamperID = s4.PersonID AND s4.PeriodNumber = 4 AND s4.PersonType = 'Camper'
            LEFT JOIN Schedules s5 ON c.CamperID = s5.PersonID AND s5.PeriodNumber = 5 AND s5.PersonType = 'Camper'
            ORDER BY c.LastName ASC
        `).all();

        res.render('search', { 
            camper: camperList, 
            query: searchQuery 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading search page");
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));