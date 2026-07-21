# Swim Scheduling

A dedicated feature for tracking camper swim levels and (in later phases) building the swim staffing schedule — lifeguards for Rec Swim, instructors for Swim Lessons grouped by skill level. Built independently of the main `/counselor-scheduling` builder; swim assignments live in their own tables and are not reflected in Master Schedule, Attendance, or the staff "Daily Assignments" card.

This page covers what's shipped so far and is expanded as later phases land.

---

## Phase 1 — Swim Level Tracking (shipped)

### `Counselors.SwimMaxLevel`

**[migrated]** `INTEGER CHECK(SwimMaxLevel BETWEEN 1 AND 6 OR SwimMaxLevel IS NULL)`, added to `Counselors` (`app.js`). The highest swim-lesson level a counselor is certified to teach. `NULL` means levels 1–3 only — every swim counselor's default floor; nothing needs to be set for staff who only teach the basics. Editable via the counselor profile's Edit Profile form (`/update-staff-info/:id`), alongside the other staff fields. See [Database Schema](./Database-Schema.md#counselors).

### `CamperSwimLevels`

One row per camper per week — a snapshot of their tested swim level, not a running log:

| Column | Type | Notes |
|---|---|---|
| `CamperID` | INTEGER | PK part, FK → `Campers` `ON DELETE CASCADE` |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 |
| `LevelNumber` | INTEGER | CHECK 1–6 |
| `SubLevel` | TEXT | `'Low'`, `'High'`, or NULL (plain level) |
| `UpdatedAt` | DATETIME | Defaults to `CURRENT_TIMESTAMP` |

A camper's **effective level as of week N** is their own week-N row if one exists, otherwise the most recent earlier week's row (levels persist until retested — a week is only written when the level actually changes). Computed by `getEffectiveSwimLevel(camperId, weekNumber)` in `app.js`; `formatSwimLevel()` renders it as `"Low 2"` / `"2"` / `"High 2"`.

### `getSwimLevelGroups(week)`

Shared helper in `app.js` used by both `/swim-levels` and `/reports/swim-levels`. Queries campers enrolled in `'Rec Swim'` or `'Swim Lessons'` for the given week (same `Campers JOIN Schedules` enrollment pattern as `/class-roster`), then groups into `{activityName, period, campers}` sections — `Rec Swim` first, then `Swim Lessons`, periods ascending, campers alphabetical by last/first name within each section. A camper enrolled in swim during more than one period (e.g. Rec Swim one period, Swim Lessons another) appears in each relevant group; their level is looked up once and cached (`levelCache`), so editing from either instance updates the same `CamperSwimLevels` row.

### `GET /swim-levels` / `POST /swim-levels/update`

Admin-only editing page: renders `getSwimLevelGroups()` for the target week (prep target if set, else active week) with an inline form on each camper row to set a new level + sub-level for that week. Each row shows the camper's current effective level or a "Not yet tested" badge. `POST /swim-levels/update` upserts one `CamperSwimLevels` row. `views/swim-levels.ejs`.

### `POST /upload-swim-levels`

CSV import for the **"Group Attendance Sheet with Swim Level"** camp-management export (Settings → CSV Data Imports → Swim Levels). This export has the same paginated-report chrome as ACR-005 (repeating title/timestamp/header rows, `"N/","12"` page footers, camper rows in `"Last, First"` format), so it's parsed as raw text with `parseCsvLine()`/`parseLastFirst()` rather than `csv-parser`.

- Any line whose first field lacks a comma is treated as page chrome and skipped.
- A letter-presence check on both the parsed first and last name additionally filters out the multi-line "Filter criteria used to generate this report" block, whose unterminated quote can swallow trailing commas into a single field and otherwise pass the comma check.
- Blank `Swim Level` cells (not yet tested) are skipped — nothing is written for them.
- `parseSwimLevelValue()` parses `"2"` / `"Low 2"` / `"High 3"` into `{levelNumber, subLevel}`.
- Campers are matched by exact `FirstName`/`LastName` against `Campers`; zero or multiple matches are skipped and listed in the redirect summary (same convention as the CSR-300 staff-contact importer — see [Data Import Pipeline](./Data-Import.md)).
- Writes go to whichever week is selected in the upload form (defaults to prep target / active week).

---

## Phase 2 — Printable Report (shipped)

### `GET /reports/swim-levels`

Admin-only printable roster (Settings → Print Reports → Swim Levels Report), following the same conventions as `views/attendance-rosters.ejs` — a `no-print` nav bar with a `window.print()` button, bordered roster tables, and an `@media print` block that hides chrome and resets container padding. Unlike `attendance-rosters.ejs`, groups don't force a page break per section (`page-break-inside: avoid` instead) since each group is small (name + level only).

Takes an optional `?week=N` query param via a session `<select>` in the nav bar (auto-submits on change) so any past or future session's roster can be printed, not just the active/prep week. Defaults to prep target / active week when no `week` param is given. Reuses `getSwimLevelGroups()` — same grouping, same campers, same levels as the `/swim-levels` editing view; `views/swim-levels-report.ejs`.

---

## Phase 3 — Swim Staffing Schedule (shipped, manual + auto-grouping)

Independent of `CounselorWeekSchedules`/`WeeklyOfferings` by design — see [Known limitation](#known-limitation). Admin-only tool at `/swim-scheduling`, `views/swim-scheduling.ejs`. Only applies to `StaffRole = 'Swim Counselor'`.

### Schema

```sql
CREATE TABLE SwimLessonGroups (
    GroupID      INTEGER PRIMARY KEY AUTOINCREMENT,
    WeekNumber   INTEGER NOT NULL CHECK(WeekNumber BETWEEN 1 AND 6),
    PeriodNumber INTEGER NOT NULL CHECK(PeriodNumber BETWEEN 1 AND 6),
    LevelNumber  INTEGER NOT NULL CHECK(LevelNumber BETWEEN 1 AND 6),
    SubLevel     TEXT CHECK(SubLevel IN ('Low','High') OR SubLevel IS NULL),
    CounselorID  INTEGER,           -- nullable until assigned
    Locked       INTEGER DEFAULT 0, -- protects from Generate Groups regeneration
    FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE SET NULL
);
CREATE TABLE SwimLessonGroupMembers (
    GroupID INTEGER, CamperID INTEGER,
    PRIMARY KEY (GroupID, CamperID),
    FOREIGN KEY (GroupID) REFERENCES SwimLessonGroups(GroupID) ON DELETE CASCADE,
    FOREIGN KEY (CamperID) REFERENCES Campers(CamperID) ON DELETE CASCADE
);
CREATE TABLE SwimGuardAssignments (
    WeekNumber INTEGER, PeriodNumber INTEGER,
    GuardRole  TEXT CHECK(GuardRole IN ('Rec','Lessons')),
    CounselorID INTEGER NOT NULL,
    PRIMARY KEY (WeekNumber, PeriodNumber, GuardRole, CounselorID),
    FOREIGN KEY (CounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE
);
```

`SwimGuardAssignments.GuardRole` distinguishes Rec Swim lifeguards from the always-2 Swim Lessons pool guards — the latter are separate people from the per-group lesson instructors.

### `generateGroupsForWeek(week)` — the auto-grouping algorithm

Runs per period offering `'Swim Lessons'` that week (checked against `WeeklyOfferings`):
1. Deletes all **unlocked** `SwimLessonGroups` for that week+period; campers already in a **Locked** group are excluded from re-bucketing entirely (their group and membership are untouched).
2. Everyone else currently enrolled in Swim Lessons that period is bucketed by `getEffectiveSwimLevel()` — campers with no recorded level are left out (they surface in the UI as "Not yet in a group" instead of being silently dropped).
3. Within a level, each sub-level (`Low`/`High`/plain) with **≥3** campers becomes its own pool; sub-levels with **<3** are merged into one mixed pool for that level.
4. Each pool is split into `isNew` (a `CamperSwimLevels` row written *this* week — i.e. freshly tested) vs `returning`, chunked separately via `chunkCampers()`: newly-tested campers at max size 4 (so they seed their own small group, 2-4 kids, rather than topping off an existing class), returning campers at max size 6. `chunkCampers()` splits as evenly as possible (11 campers at max 6 → `[6,5]`, not a lopsided `[6,6,-1]`).

A same-level pool can end up with more than one `SubLevel = NULL` group in one run (e.g. a ≥3 "plain" pool and a separate <3-sublevel mixed-leftover pool) — both are valid, correctly-sized groups; the UI doesn't currently disambiguate which is which beyond showing the actual camper names in each.

### `getCounselorWaterTally(week)`

Returns `{CounselorID: {inWater, outWater}}` for the roster panel: all guard duty (`SwimGuardAssignments`, either role) counts as in-water; teaching a lesson group counts as in-water for levels 1-3 (required in the water) and out-of-water for levels 4-6 (not required). Used for display only in Phase 3 — Phase 4's solver will use the same in/out classification to actually balance assignments.

### `getSwimWarnings(periods)`

Computed at render time, never stored. Flags: a period's Rec Swim or Swim Lessons guard count below the required threshold; an empty lesson group; a counselor assigned to teach a group above their `SwimMaxLevel`; and any counselor appearing in more than one guard/instructor slot in the same period (double-booked) — tracked via a `period|counselorId` map built while walking the same `periods` structure the page renders.

### Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/swim-scheduling` | Main page. `?week=N` to view a different session |
| POST | `/swim-scheduling/generate-groups` | Runs `generateGroupsForWeek()` |
| POST | `/swim-scheduling/create-group` | Manually add an empty group (period + level + sub-level) |
| POST | `/swim-scheduling/delete-group` | Deletes a group; members become "Not yet in a group" (CASCADE) |
| POST | `/swim-scheduling/toggle-group-lock` | Flips `Locked` |
| POST | `/swim-scheduling/assign-instructor` | Sets a group's `CounselorID` |
| POST | `/swim-scheduling/assign-camper` | Adds a camper to a group (`INSERT OR IGNORE`) |
| POST | `/swim-scheduling/remove-camper` | Removes a camper from a group (they become ungrouped, reassignable) |
| POST | `/swim-scheduling/save-guards` | Full replace of a `(week, period, guardRole)` guard set from a checkbox list |

"Move a camper between groups" and "merge/split a group" aren't dedicated actions — they're composed from `assign-camper`/`remove-camper`/`create-group`/`delete-group`, matching this codebase's convention of small single-purpose routes over one dispatcher endpoint.

---

## Known limitation

Swim staffing lives in its own tables (`SwimLessonGroups`, `SwimGuardAssignments`), independent of `CounselorWeekSchedules`/`WeeklyOfferings`. Master Schedule's Counselors column, the staff Daily Assignments card, and Attendance do **not** show swim duty assignments for Rec Swim / Swim Lessons periods — that data only exists in `/swim-scheduling` and the tables above. Rec Swim/Swim Lessons should be treated as off-limits in the main `/counselor-scheduling` builder to avoid double-booking swim staff across the two systems (not enforced automatically — a manual convention for now).
