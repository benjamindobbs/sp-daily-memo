# Data Model & Relationships

How the tables relate to each other. See [Database Schema](./Database-Schema.md) for column-level detail.

---

## Entity Relationship Overview

```
Sessions (1) ──────────────────────────────────────────────────────────────────┐
                                                                               │ weekNumber
Counselors (1) ─┬──── CounselorWeekAttributes (N)  ← one row per counselor/week
                │
                ├──── CounselorWeekSchedules (N)   ← one row per counselor/week/period
                │
                ├──── StaffWeekSchedules (N)        ← faculty full-summer schedules
                │
                ├──── CounselorScheduleAssignments (N) ← saved class slot assignments
                │
                ├──── CounselorPreferences (1)
                │
                └──── CamperHomeGroups.CounselorID (N)


Campers (1) ────┬──── Schedules (N)                ← camper period assignments
                │
                ├──── CamperHomeGroups (N)          ← one row per camper/week
                │
                ├──── Attendance (N)
                │
                ├──── EarlyDismissals (N)
                │
                ├──── ScheduledPickups (N)
                │
                ├──── Waitlists (N)
                │
                ├──── NurseLog (N)
                │
                ├──── CaseLog (N)
                │
                ├──── ScheduleChanges (N)
                │
                └──── ScheduleChangesArchive (N)


Activities (1) ─┬──── ActivityPeriodGroups (N)
                │
                └──── (name referenced by Schedules, WeeklyOfferings,
                       CounselorWeekSchedules, CounselorScheduleAssignments)


PhotoSubmissions (1) ── PhotoVotes (N)
```

---

## Foreign Key Map

| Table | Column | References | On Delete |
|---|---|---|---|
| `Schedules` | `PersonID` | `Campers.CamperID` or `Counselors.CounselorID` | *(not enforced — polymorphic)* |
| `CounselorWeekAttributes` | `CounselorID` | `Counselors.CounselorID` | CASCADE |
| `CounselorWeekSchedules` | `CounselorID` | `Counselors.CounselorID` | CASCADE |
| `StaffWeekSchedules` | `StaffID` | `Counselors.CounselorID` | CASCADE |
| `CounselorScheduleAssignments` | `PersonID` | *(no FK enforced — PersonType determines table)* | — |
| `CounselorPreferences` | `CounselorID` | `Counselors.CounselorID` | CASCADE |
| `CamperHomeGroups` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `CamperHomeGroups` | `CounselorID` | `Counselors.CounselorID` | *(not enforced)* |
| `Attendance` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `EarlyDismissals` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `ScheduledPickups` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `Waitlists` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `NurseLog` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `CaseLog` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `ScheduleChanges` | `CamperID` | `Campers.CamperID` | *(not enforced)* |
| `ActivityPeriodGroups` | `ActivityName` | `Activities.Name` | CASCADE |
| `PhotoVotes` | `photoId` | `PhotoSubmissions.id` | *(REFERENCES, no action)* |

> Most FK relationships on `CamperID` are declared in the schema but SQLite does not enforce them at runtime unless `PRAGMA foreign_keys = ON` is set per connection. The app does not enable this pragma globally, so deleting a camper will not cascade to attendance records etc.

---

## Polymorphic References

Two tables use a `PersonType` discriminator instead of separate FK columns:

**`Schedules`**
- `PersonType = 'Camper'` → `PersonID` = `Campers.CamperID`
- `PersonType = 'Instructor'` → `PersonID` = `Counselors.CounselorID`
- `PersonType = 'Staff'` → legacy; maps to old `Staff.StaffID` (now migrated to Counselors)

**`CounselorScheduleAssignments`**
- `PersonType = 'Counselor'` → `PersonID` = `Counselors.CounselorID`
- `PersonType = 'Instructor'` → `PersonID` = `Counselors.CounselorID`
- `PersonType = 'Staff'` → legacy

---

## Activity Name as a Shared Key

`Activities.Name` is declared `UNIQUE` and acts as a natural key throughout the system. It is referenced by name (not by `ActivityID`) in:

- `Schedules.ActivityName`
- `WeeklyOfferings.ActivityName`
- `CounselorWeekSchedules.ActivityName`
- `CounselorScheduleAssignments.ActivityName`
- `StaffWeekSchedules.ActivityName`
- `ActivityPeriodGroups.ActivityName`
- `ScheduleChanges.OldActivity` / `NewActivity`

This means renaming an activity in `Activities` does **not** cascade to historical records — the old name will persist in schedule and attendance data.

---

## Week Scoping

Several tables store per-week data keyed by `WeekNumber (1–6)`. The active week (`Sessions.isActive = 1`) determines which slice all tools operate on:

| Table | Week-scoped columns |
|---|---|
| `Sessions` | `weekNumber` (PK) |
| `CounselorWeekAttributes` | `(CounselorID, WeekNumber)` PK |
| `CounselorWeekSchedules` | `(CounselorID, WeekNumber, PeriodNumber)` PK |
| `StaffWeekSchedules` | `(StaffID, WeekNumber, PeriodNumber)` PK |
| `WeeklyOfferings` | `WeekNumber` column |
| `CounselorScheduleAssignments` | `WeekNumber` column |
| `CamperHomeGroups` | `(CamperID, WeekNumber)` PK |

Tables that are **not** week-scoped (global across the summer):
- `Campers`, `Counselors`, `Activities`
- `Schedules` (camper class assignments are treated as fixed for the summer)
- `Attendance`, `EarlyDismissals`, `NurseLog`, `CaseLog` (keyed by date, not week)

---

## Denormalized Fields

Some tables store denormalized text to avoid joins in high-frequency queries:

| Table | Denormalized column | Source |
|---|---|---|
| `ScheduleChanges` | `CamperName` | `Campers.FirstName + LastName` |
| `ScheduleChanges` | `ColorGroup` | `Campers.HomeGroupColor` |
| `WeeklyOfferings` | `SideOfCamp` | `Activities.SideOfCamp` |
| `WeeklyOfferings` | `MaxCapacity` | `Activities.MaxCapacity` |
| `CounselorScheduleAssignments` | `ActivityName` | `WeeklyOfferings.ActivityName` |

These fields can drift from their source if the source record is later edited. The offerings sync (`/sync-offerings-from-schedule`) rebuilds `WeeklyOfferings` from live data to correct any drift.
