# Data Import Pipeline

How data gets into the system via CSV uploads, what each import does, and the required order.

---

## Import Order

Imports have dependencies. Always follow this sequence for a fresh setup:

```
1. Activities (optional CSV bulk, or add individually)
2. All Staff Roster
3. Camper Roster (ACR-005)
4. Master Schedule
5. Instructor Schedules (can be done any time after staff)
```

- **Camper Roster** depends on staff already existing (it may link counselors).
- **Master Schedule** depends on campers existing (it enriches existing camper rows with grade, bus, extended hours, and schedule data).
- Importing in the wrong order will result in missing relationships or failed lookups.

---

## All Staff Roster

**Route:** `POST /upload-counselors`
**File:** `views/settings.ejs`
**Multer field:** `file`

**Required CSV columns:**

| Column | Notes |
|---|---|
| `Name` | Format: `Last, First` |
| `Positions` | Used to determine `StaffRole` |
| `Camp` | Filter — only rows where `Camp` matches expected value are imported |

**What it does:**
- For each row, parses `LastName` and `FirstName` from the `Name` column.
- Maps `Positions` to a `StaffRole` value (`Counselor`, `Instructor`, `Unit Leader`, etc.).
- Upserts into `Counselors` (INSERT OR IGNORE by name — existing records are not overwritten).
- Also seeds `CounselorWeekAttributes` for the active week for any new counselors.

**Does not set:** `HomeGroupColor`, `ScheduleType`, `BusRoute`, `ExtendedHours` — these are set later in the Schedule Builder or via profile editing.

---

## Camper Roster (ACR-005)

**Route:** `POST /upload-campers`
**Source:** ACR-005 export from camp management system

**What it does:**
- Creates or updates camper records in `Campers`.
- Sets: `FirstName`, `LastName`, `HomeGroupColor`, `CampLunch`, `ShirtSize`, `Age`.
- Does **not** set schedule data — that comes from the Master Schedule import.

---

## Master Schedule

**Route:** `POST /upload-campers-schedule`
**Source:** Master Schedule export from camp management system

**What it does:**
- Looks up each camper by name in `Campers` (must already exist from ACR-005 import).
- Updates: `Grade`, `BusRoute`, `ExtendedHours`.
- Writes activity assignments to `Schedules` (`PersonType='Camper'`), one row per period per camper (clock blocks 1–6).

**Period mapping:** Red/Carolina group ordinal periods are remapped to clock blocks during import (ordinal 3→block 4, 4→5, 5→6). Green/Navy ordinals already equal clock blocks.

---

## Instructor Schedules

**Route:** `POST /upload-instructors`
**Targets:** Active week

**Required CSV columns:**

| Column | Notes |
|---|---|
| `FirstName` | |
| `LastName` | |
| `P1`–`P6` | Activity name for each period |
| `L1`–`L6` | Location for each period (optional) |

**What it does:**
- Looks up each person by name in `Counselors`.
- If not found, creates a new `Counselors` row with `StaffRole='Instructor'`.
- Writes to `Schedules` (`PersonType='Instructor'`) for the active week.
- Also writes to `CounselorScheduleAssignments` for the active week.

---

## Faculty Full Summer

**Route:** `POST /upload-staff-week/:weekNumber`
**Targets:** Specific week (not just the active week)

**Same CSV format as Instructor Schedules.**

**What it does:**
- Completely replaces all `StaffWeekSchedules` rows for the given week.
- Looks up each person by name in `Counselors`; creates if not found.
- Safe to re-upload — previous data for the week is deleted before inserting.

`POST /clear-staff-week/:weekNumber` — removes all rows for a given week without uploading a replacement.

---

## Activities (Bulk CSV)

**Route:** `POST /upload-activity-rules`

**Required CSV columns:**

| Column | Notes |
|---|---|
| `Name` | Unique activity name |
| `SideOfCamp` | `Sports` or `Enrichment` |
| `MaxCapacity` | Integer |
| `AllowedGroups` | `Red`, `Carolina`, `Red-Carolina`, `Green-Navy`, or blank (all groups) |

Upserts into `Activities`. Existing activities with the same name are updated.

---

## Weekly Offerings (CSV)

**Route:** `POST /upload-weekly-offerings`

Alternative to the offerings sync. Allows manually specifying which classes run each period for the active week.

Expected columns: `ActivityName`, `PeriodNumber`, `PreliminaryEnrollment`, `SideOfCamp`.

---

## Clear Routes

These remove all data from a table (typically used before a fresh re-import):

| Route | What it clears |
|---|---|
| `POST /clear-activities` | All `Activities` rows |
| `POST /clear-counselors` | All `Counselors` rows (and cascades to week-scoped tables) |
| `POST /clear-staff` | Legacy `Staff` table |
| `POST /clear-campers` | All `Campers` rows |
| `POST /clear-weekly-offerings` | `WeeklyOfferings` for the active week |
| `POST /clear-counselor-week` | `CounselorScheduleAssignments` + `CounselorWeekSchedules` for a week |
| `POST /clear-counselor-homegroups` | `CamperHomeGroups` for the active week |
| `POST /clear-staff-week/:weekNumber` | `StaffWeekSchedules` for a week |

---

## Migration History

Schema migrations run automatically at server startup. They are additive-only (`ALTER TABLE ... ADD COLUMN` or `CREATE TABLE IF NOT EXISTS`) except where a table needed to be recreated to change a constraint or FK. All migrations are guarded so re-running on an already-migrated database is safe.

Notable migrations in order:

| Migration | What changed |
|---|---|
| `Campers.ExtendedHours` CHECK removed | Original schema had a CHECK constraint; early data violated it. Table was dropped and recreated. |
| `WeeklyOfferings.PeriodNumber` added | Column didn't exist in original schema. |
| `Activities.AllowedGroups` added | Column didn't exist in original schema. |
| `ActivityPeriodGroups` created | New table for per-period group overrides. |
| `StaffWeekSchedules` FK fixed | Was referencing `Staff(StaffID)`; corrected to `Counselors(CounselorID)`. |
| `CounselorScheduleAssignments.WeekNumber` added | Original schema had no week scoping; backfilled as week 1. Unique constraint updated. |
| `CounselorWeekSchedules.PeriodNumber` TEXT→INTEGER | Early data used text labels (`'3AM'`, `'3PM'`) and ordinal offsets. Remapped to clock blocks. |
| `WeeklyOfferings` period migration | Same clock block remapping for offerings data. |
| `Camper Schedules` clock block migration | Red/Carolina ordinal → clock block for all camper `Schedules` rows. |
| `PhotoVotes.voterName` / `voteDate` added | Added voter tracking columns. |
| `Attendance.MarkedBy` added | Added who marked attendance. |
| `EarlyDismissals.MarkedBy` added | Same. |
| `ScheduledPickups` created | New table. |
| `ScheduledPickups.PeriodNumber` added | Added after initial table creation. |
| `WeeklyOfferings.AllowedGroups` added | Added for group-restricted offerings. |
| `Campers.Grade` / `ShirtSize` added | Separated grade from age; added shirt size. |
| `Counselors.StaffRole` added | Default `'Counselor'`; migration from `Staff` table. |
| `CounselorWeekAttributes.SpecialtyGroup` added | For SPLIT specialty grouping. |
| `Counselors.Phone` / `Email` / `IncludeInStaffDropdown` added | Contact info and dropdown gating. |
| `NurseLog` created | Health visit tracking. |
| `CaseLog` created | Incident case tracking. |
| `Staff → Counselors` migration | All `Staff` rows copied into `Counselors`; `Schedules` PersonType retypes. |
| Sessions seeded | Rows 1–6 inserted if not present; week 1 defaults to active. |
| `CounselorWeekAttributes` seeded from `Counselors` | One-time backfill for existing data into week-scoped table. |
| Counselor home group color inference | Auto-fills `CounselorWeekAttributes.HomeGroupColor` from `CamperHomeGroups` data when no colors are set for a week. |
| `SplitFieldTrip` created | SPLIT field trip flag table. |
| `CounselorScheduleBackups` created | Snapshot backup table. |
