# Sessions & Weeks

How the multi-week design works and what "active week" means for the system.

---

## Sessions Table

Six rows, one per camp week, seeded at startup:

```sql
weekNumber  label     startDate  isActive  isReleased  isPrepTarget
1           Week 1    ...        0 or 1    0 or 1      0
2           Week 2    ...        0         0           0 or 1
...
6           Week 6    ...        0         0           0
```

- `weekNumber` — immutable PK (1–6).
- `label` — admin-editable display name (e.g. `"Session 1"`, `"July 4th Week"`).
- `startDate` — ISO date string; used for display and date math.
- `isActive` — exactly one row should be `1` at a time. All scheduling, attendance, and offering tools operate against the active week.
- `isReleased` — `1` = staff can see the counselor schedule for that week from their profile. A week can be released without being active (e.g. release future weeks early).
- `isPrepTarget` — `1` = this week is the current upload/prep target. At most one row is `1` at a time. When set, CSV imports (`/upload-campers`) and schedule-prep views (`/master-schedule`, `/audit`) target this week instead of the active week. Added via migration.

---

## Prep Target Week

An optional "prep target" week lets admins import and prepare a future week's roster while the current week remains active. At most one week has `isPrepTarget=1`.

```js
function getPrepTargetWeek() {
    return db.prepare("SELECT weekNumber FROM Sessions WHERE isPrepTarget=1 LIMIT 1")
             .get()?.weekNumber ?? null;
}
```

Routes that use the prep target (falling back to the active week if none is set):

```js
const targetWeek = getPrepTargetWeek() || getActiveWeek();
```

- `GET /master-schedule` — renders the schedule for the prep target week
- `GET /audit` — audits the prep target week
- `POST /upload-campers` — imports camper roster into the prep target week
- `GET /counselor-profile/:id` — admins see the prep week's schedule, campers, and week attributes (banner shows the prep week); staff always see the active week
- `POST /update-staff-info/:id` — mirrors week attributes into the prep week for admins (same week the profile displays)

**Prep preview requires actually being in admin view, not just having admin credentials.** `/master-schedule`, `/class-roster/:period/:activity`, and `/counselor-profile/:id` are reachable in both admin view and Staff View (the `viewMode` cookie toggle), and an admin who has switched to Staff View to check what staff see keeps their `adminAuth` cookie the whole time. So these three routes gate the prep-week check on both cookies together, not `adminAuth` alone:

```js
const isAdmin = req.cookies.adminAuth === 'true' && req.cookies.viewMode === 'admin';
const aw = (isAdmin ? getPrepTargetWeek() : null) || getActiveWeek();
```

This means toggling to Staff View always shows the active week's data on those three pages — identical to what a real, non-admin staff member sees — regardless of whether a prep target is set. Admin-only routes (`/audit`, `/swim-levels`, `/swim-scheduling`, the CSV upload/prep-writing routes, etc.) don't need this extra check: they're already blocked entirely for non-admins by `ADMIN_ONLY_PREFIXES`, so `viewMode` never comes into play for them.

**Toggling:** `POST /set-prep-week` accepts `{ weekNumber }`. It clears `isPrepTarget` on all rows, then sets it on the given week. Sending the same week number again unsets it (toggle behavior). Managed from the Settings page ("Set Prep" / "Unset Prep" buttons in Session Management).

---

## Active Week

The active week drives nearly every read query in the app. The helper function:

```js
function getActiveWeek() {
    return db.prepare("SELECT weekNumber FROM Sessions WHERE isActive=1 LIMIT 1")
             .get()?.weekNumber ?? 1;
}
```

Tables that always filter by active week:
- `WeeklyOfferings` — offerings sync and counselor scheduler
- `CounselorScheduleAssignments` — assignment saves and exports
- `CounselorWeekSchedules` — counselor schedule display and attendance filtering
- `CounselorWeekAttributes` — schedule type, color group, and bus info for the scheduler
- `CamperHomeGroups` — home group display and assignment

Tables that are date-keyed (not week-keyed) and do not use the active week:
- `Attendance` — keyed by `Date` (today's date)
- `EarlyDismissals` — keyed by `Date`
- `NurseLog` — keyed by `Date`
- `CaseLog` — keyed by `Date`

---

## Changing the Active Week

`POST /set-active-week` — sets `isActive=1` for the given week and `isActive=0` for all others. Single atomic update, no confirmation step.

After switching the active week, the admin typically needs to:
1. Sync offerings (`POST /sync-offerings-from-schedule`) to rebuild `WeeklyOfferings` for the new week.
2. Build the counselor schedule for the new week.

---

## Automatic Week Rollover

`checkWeekRollover()` (app.js) runs at server startup and every 60 seconds. Once it is past **23:59 Eastern on the Saturday** of the active session's start week, it:

1. Activates the session with `weekNumber + 1` (deactivating all others).
2. Closes talent show submissions (`TalentMeta.submissions_open = 0`).
3. Runs `syncActivityGroups()` for the new week.

Details:
- The Saturday is derived from the active session's `startDate` (day-of-week math uses noon-UTC anchors so it is stable across DST).
- Dates are compared as numeric `YYYYMMDD` values built from `Intl.formatToParts` — never as locale-formatted strings, whose lexicographic ordering is wrong when the runtime formats dates as `M/D/YYYY` (this previously caused mid-week rollovers, e.g. `"7/9" > "7/10"`).
- If there is no next session row (end of summer), nothing happens.
- The startup call catches any rollover missed while the server was down.

---

## Released vs Active

A week can be in any combination of these states:

| isActive | isReleased | Effect |
|---|---|---|
| 1 | 0 | Week is being worked on by admin; staff cannot see the counselor schedule |
| 1 | 1 | Active and published — staff can see their assignments |
| 0 | 1 | Inactive but published — staff can still view a past or future week's schedule |
| 0 | 0 | Neither active nor visible to staff |

`POST /set-released-week` toggles `isReleased` for a given week.

**"Your Upcoming Schedule" card** (`GET /staff`, `views/staff-hub.ejs`): shown when a week is released and the viewer has a selected counselor. The schedule source depends on role, since only main counselors have `CounselorWeekSchedules` rows:

| Role | Source(s) |
|---|---|
| Counselor / Swim Counselor | `CounselorWeekSchedules` |
| Unit Leader / Sports Leader | `CounselorScheduleAssignments` (PersonType `Instructor`, sports slots) ∪ `CounselorWeekSchedules` (enrichment slots placed as counselor) ∪ `StaffWeekSchedules` |
| Instructor | legacy `Schedules` (PersonType `Instructor`) ∪ `StaffWeekSchedules` |

For Unit Leaders, Sports Leaders, and Instructors the card also shows each period's **location**, resolved the same way as the Master Schedule: the week-scoped `StaffWeekSchedules` row wins, then the legacy `Schedules` row (only when the released week is also the active week — that table has no `WeekNumber` and would otherwise leak stale locations into other weeks), then `Activities.Location` as a last resort.

---

## Week-Scoped Tables

These tables store data per week. Switching the active week does not delete or overwrite any other week's data — all six weeks can have simultaneous data.

| Table | PK / key |
|---|---|
| `CounselorWeekAttributes` | `(CounselorID, WeekNumber)` |
| `CounselorWeekSchedules` | `(CounselorID, WeekNumber, PeriodNumber)` |
| `StaffWeekSchedules` | `(StaffID, WeekNumber, PeriodNumber)` |
| `WeeklyOfferings` | `WeekNumber` column |
| `CounselorScheduleAssignments` | `WeekNumber` column |
| `CamperHomeGroups` | `(CamperID, WeekNumber)` |
| `CamperWeekData` | `(CamperID, WeekNumber)` — camper attributes per week (color, shirt, home group, etc.) |
| `Schedules` | `WeekNumber` column added via migration — scopes camper period assignments per week (camper rows only; counselor/instructor rows still lack WeekNumber) |

---

## Clearing a Week

`POST /clear-counselor-week` — deletes all `CounselorScheduleAssignments` and `CounselorWeekSchedules` for the given week. Does not touch `WeeklyOfferings` or `CounselorWeekAttributes`.

Additional clear actions available from Settings:
- `POST /clear-weekly-offerings` — removes all offerings for the active week.
- `POST /clear-counselor-homegroups` — removes all `CamperHomeGroups` for the active week.

---

## Faculty Full Summer (StaffWeekSchedules)

Independent of the active-week concept. The Faculty Full Summer page (`/faculty-summer`) allows uploading instructor and unit leader schedules for all 6 weeks at once. Each upload completely replaces that week's data in `StaffWeekSchedules`.

This table is used to power the "week selector" dropdown on instructor/unit leader profile pages so staff can see their schedule for any uploaded week without the admin needing to change the active week.

`StaffWeekSchedules` is separate from `CounselorWeekSchedules` — the latter is for main counselors (class slot assignments); the former is for instructors/leaders (their own class teaching schedule).

---

## Startup Seeding

At server start, `Sessions` rows 1–6 are created if they don't already exist:

```js
for (let w = 1; w <= 6; w++) {
    db.prepare("INSERT OR IGNORE INTO Sessions (weekNumber, label, isActive) VALUES (?, ?, ?)")
      .run(w, `Week ${w}`, w === 1 ? 1 : 0);
}
```

Week 1 starts as active on first boot. Any existing active week is preserved by `INSERT OR IGNORE`.

---

## Migration: Seeding CounselorWeekAttributes from Counselors

On first boot with the multi-week schema, existing `Counselors` rows are seeded into `CounselorWeekAttributes` for week 1:

```sql
INSERT OR IGNORE INTO CounselorWeekAttributes
    (CounselorID, WeekNumber, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours)
SELECT CounselorID, 1, HomeGroupColor, ScheduleType, BusRoute, ExtendedHours
FROM Counselors;
```

Similarly, existing `Schedules` rows for counselors are seeded into `CounselorWeekSchedules` for week 1. This is safe to re-run because `INSERT OR IGNORE` skips rows that already exist.
