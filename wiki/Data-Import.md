# Data Import Pipeline

How data gets into the system via CSV uploads, what each import does, and the required order.

---

## Import Order

Imports have dependencies. Always follow this sequence for a fresh setup:

```
1. Activities (optional CSV bulk, or add individually)
2. All Staff Roster
3. Camper Roster (ACR-005)
4. Master Camper Schedule (ACR-255)
5. AM Bus Attendance (ACR-132)
6. PM Bus Attendance (ACR-133)
7. Instructor Schedules (can be done any time after staff)
```

- **Camper Roster** depends on staff already existing (it may link counselors).
- **Master Camper Schedule (ACR-255)** depends on campers existing (enriches rows with grade, extended hours, and schedule data).
- **Bus reports (ACR-132/133)** depend on campers existing (update-only by name).
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
**Report:** ACR-005: Attendance Roster by Cabin

**How to run in CB:** Select All Seasons → add Session filter → select relevant weeks for all specialty camps (Robotics & Coding, KP, LP, LIT) and main camp (SP Week 1–6) → Run report as CSV.

**What it does:**
- Creates or updates camper records in `Campers`.
- Sets: `FirstName`, `LastName`, `HomeGroupColor`, `CampLunch`, `ShirtSize`, `SessionCodes` (raw `Sessions` cell, e.g. `"SP01/SP02/SP03"`).
- Does **not** touch bus data (`BusRoute`, `BusRidesAM`, `BusRidesPM`) — all bus data comes from ACR-132/133.
- Does **not** set schedule data — that comes from the Master Camper Schedule (ACR-255) import.

`SessionCodes` drives the shirt-order pills on the Monday AM Home Group attendance sheet (main camp colors only) — see [Attendance-and-Health](./Attendance-and-Health.md#shirt-order-pills).

---

## Bus Attendance Reports (ACR-132 AM / ACR-133 PM)

**Routes:** `POST /upload-bus-am` (ACR-132) · `POST /upload-bus-pm` (ACR-133)
**Reports:** ACR-132 (AM Bus Attendance) · ACR-133 (PM Bus Attendance)

These are the **authoritative source for all bus data**. Each report groups every camper under an explicit `Bus N (Color) - ...` section with the stop, so the route number and per-direction ride flag are read directly — no stop-name guessing, no audit. Neither ACR-005 nor ACR-255 writes bus fields; ACR-132/133 are the only imports that set `BusRoute`, `BusRidesAM`, and `BusRidesPM`.

**Parser (`parseBusAttendanceReport`)** walks the report and tracks two pieces of state:

| Report section | Route | Ride flag (that direction) |
|---|---|---|
| Top `No Bus` / `Unknown` group | none (left unchanged) | `0` |
| `Bus N (Color) - ...` → a stop sub-header | `N` | `1` |
| `No Bus N AM/PM` sub-group (on bus N, skips this direction) | `N` | `0` |

So a camper riding Bus 2 in the AM but not PM appears under `Bus 2 → Northwest Catholic` in ACR-132 (route 2, rides) and under `No Bus 2 PM` in ACR-133 (route 2, doesn't ride). Both reports agree on the route.

**Application:** update-only by name (campers must already exist). The route is written only when the report knows it (so a top-`No Bus` camper keeps any existing route); the direction's ride flag is always written. AM report → `BusRidesAM`; PM report → `BusRidesPM`.

> West Hartford (2/5) and Wolcott Park/Bishops Corner (3/4) riders are listed under their actual `Bus N` section in these reports, so no manual audit is needed.

---

## Master Schedule (ACR-255)

**Route:** `POST /upload-campers-schedule`
**Report:** ACR-255: Master Camper Schedule

**How to run in CB:** Select All Seasons → add Session filter → select all SP W[X] - Period sessions (Periods 1–5 for the target week) → Run report as CSV.

**What it does:**
- Looks up each camper by name in `Campers` (must already exist from ACR-005 import).
- Updates: `Grade`, `ExtendedHours`. Does **not** set `BusRoute` — bus data comes from ACR-132/133.
- Writes activity assignments to `Schedules` (`PersonType='Camper'`), one row per period per camper (clock blocks 1–6).

**Period mapping:** Red/Carolina group ordinal periods are remapped to clock blocks during import (ordinal 3→block 4, 4→5, 5→6). Green/Navy ordinals already equal clock blocks.

**Page-break handling:** CampBrain's CSV export repeats header blocks at each page boundary, and occasionally splits a camper's row across two pages (first name, shirt size, and some activity names land on the next page). The parser automatically strips repeated header blocks and merges split rows by concatenating the continuation fields back into the correct column positions. No manual CSV editing is needed.

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
- Writes to `StaffWeekSchedules` for the active week (same destination as Faculty Full Summer).

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
| `Staff → Counselors` migration | ~~All `Staff` rows copied into `Counselors`; `Schedules` PersonType retypes.~~ **Removed.** This migration was causing deleted counselors to reappear on restart. All data was already in `Counselors`; startup now runs `DELETE FROM Staff` to keep the table permanently empty. |
| Sessions seeded | Rows 1–6 inserted if not present; week 1 defaults to active. |
| `CounselorWeekAttributes` seeded from `Counselors` | One-time backfill for existing data into week-scoped table. |
| Counselor home group color inference | Auto-fills `CounselorWeekAttributes.HomeGroupColor` from `CamperHomeGroups` data when no colors are set for a week. |
| `SplitFieldTrip` created | SPLIT field trip flag table. |
| `CounselorScheduleBackups` created | Snapshot backup table. |
| `PdfDocuments` created | PDF files stored as BLOBs in the database instead of the filesystem, so they survive server restarts. Any PDFs already in `uploads/` are migrated in automatically on first boot. |
| `DirectorNotes.category` added | **[migrated]** — Adds tab-based categorization. Values: `director`, `camper`, `staff`, `timesheet`. Existing notes default to `director`. |
| `Campers.BusRidesAM` / `BusRidesPM` added | **[migrated]** — Per-direction bus ride flags. Default `1` (rides). Set from the ACR-005 `AM Bus` / `PM Bus` columns (see the bus model in the ACR-005 section). |
| `Campers.BusStopAM` / `BusStopPM` added | **[migrated]** — Raw ACR-005 stop text, retained so the Bus Route Audit can resolve ambiguous stops (West Hartford 2/5, Wolcott Park / Bishops Corner 3/4). |
| `Campers.SessionCodes` added | **[migrated]** — Raw ACR-005 `Sessions` cell text (e.g. `"SP01/SP02/SP03"`). Drives the shirt-order pills on the Monday AM Home Group attendance sheet. |
| `AppConfig` created | Key/value store for persistent server config (currently VAPID keys for web push). Auto-generates VAPID keys on first startup. |
| `PushSubscriptions` created | Stores web push subscriptions for counselor attendance nudge notifications. One row per browser endpoint. |
