# Sessions & Weeks

How the multi-week design works and what "active week" means for the system.

---

## Sessions Table

Six rows, one per camp week, seeded at startup:

```sql
weekNumber  label     startDate  isActive  isReleased
1           Week 1    ...        0 or 1    0 or 1
2           Week 2    ...        0         0
...
6           Week 6    ...        0         0
```

- `weekNumber` — immutable PK (1–6).
- `label` — admin-editable display name (e.g. `"Session 1"`, `"July 4th Week"`).
- `startDate` — ISO date string; used for display and date math.
- `isActive` — exactly one row should be `1` at a time. All scheduling, attendance, and offering tools operate against the active week.
- `isReleased` — `1` = staff can see the counselor schedule for that week from their profile. A week can be released without being active (e.g. release future weeks early).

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

## Released vs Active

A week can be in any combination of these states:

| isActive | isReleased | Effect |
|---|---|---|
| 1 | 0 | Week is being worked on by admin; staff cannot see the counselor schedule |
| 1 | 1 | Active and published — staff can see their assignments |
| 0 | 1 | Inactive but published — staff can still view a past or future week's schedule |
| 0 | 0 | Neither active nor visible to staff |

`POST /set-released-week` toggles `isReleased` for a given week.

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
