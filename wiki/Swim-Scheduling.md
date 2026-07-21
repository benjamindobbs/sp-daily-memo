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
    LevelRangeMax INTEGER CHECK(LevelRangeMax BETWEEN 1 AND 6 OR LevelRangeMax IS NULL), -- [migrated]
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

A same-level pool can end up with more than one `SubLevel = NULL` group in one run (e.g. a ≥3 "plain" pool and a separate <3-sublevel mixed-leftover pool) — both are valid, correctly-sized groups; merging them (below) is one way to consolidate that ambiguity by hand.

### Merging groups (`POST /swim-scheduling/merge-group`)

Combines two small adjacent-level groups in the **same period** so they share one instructor (e.g. 2 campers at Level 5 and 1 at Level 6, taught together by a Level-5/6-certified counselor instead of running two near-empty classes). Every group card has a "merge into" dropdown listing the other groups in that period.

On merge: the source group's campers move into the target group (`SwimLessonGroupMembers`, `INSERT OR IGNORE`); the target's `LevelNumber` becomes `min(source, target)` and `LevelRangeMax` becomes `max(source, target)` (left `NULL` if the merge didn't actually widen the range — e.g. merging two same-level groups just consolidates headcount without becoming a "range"); `SubLevel` is cleared (a multi-level group can't be single-sub-level); the target is **locked** so the next Generate Groups run won't split it back apart; and the source group is deleted (`ON DELETE CASCADE` handles its now-empty membership rows). The target keeps whatever instructor it already had — if that leaves them under-qualified for the new range, `getSwimWarnings()` catches it on the next render, same as any other above-max-level assignment.

`SwimLessonGroups.effectiveMaxLevel` (`LevelRangeMax || LevelNumber`) is computed in `getSwimSchedulingData()` and used everywhere a group's level needs to be checked against a counselor's `SwimMaxLevel` — including the instructor-eligibility filter, which compares against `effectiveMaxLevel` rather than the raw `LevelNumber`.

### Composition (Low / Nominal / High breakdown)

`levelLabel` (`"Level 3"`, or `"Level 5–6"` when ranged) is just the header — it no longer carries sub-level detail. That's now a separate `composition` array on each group, computed in `getSwimSchedulingData()` from each **member's actual current effective level** (`getEffectiveSwimLevel()`) rather than from the group's own stored `SubLevel`, so it stays correct after merges and any manual add/remove:

- Members are bucketed by `(LevelNumber, SubLevel)`, sorted Low → Nominal (plain) → High within a level, then by level ascending; anyone with no recorded level buckets separately as "Not tested."
- For a normal (non-ranged) group, each tag is just the sub-level word — `"Low ×2"`, `"Nominal ×8"` — since the level itself is already the header.
- For a **ranged (merged) group**, each tag is fully qualified — `"Level 5 (Nominal) ×2"`, `"Level 6 (High) ×1"` — since the header only shows the range and can't distinguish which original level+sub-level each camper came from.

Rendered as small pill tags under the group header in `views/swim-scheduling.ejs`, and reused as a compact `"N label, N label"` string in the "add to group" and "merge into" dropdown option text so two same-range groups with different makeups aren't indistinguishable in a `<select>`.

### `getCounselorWaterTally(week)`

Returns `{CounselorID: {inWater, outWater}}` for the roster panel: all guard duty (`SwimGuardAssignments`, either role) counts as in-water; teaching a lesson group counts as in-water for levels 1-3 (required in the water) and out-of-water for levels 4-6 (not required). Used for the roster panel display, and as the seed/live-updated state for `autoAssignWeek()`'s balancing (below).

### Full Auto Assign (`POST /swim-scheduling/auto-assign`)

Fills every open guard slot and un-instructored lesson group for the week in one pass, via `autoAssignWeek(week)`. It never removes or changes anything already set — Locked groups, groups that already have a `CounselorID`, and existing `SwimGuardAssignments` rows are left exactly as they are; the solver only fills gaps. Processed period by period, in this order within each period: **lesson groups, highest effective level to lowest, first**; then Rec Swim guards; then Swim Lessons pool guards. High-level groups have the smallest eligible pool (only counselors certified that high), so they get first pick before that pool is drawn down by guard duty or low-level groups that any swim counselor could just as easily fill — otherwise a Level 6-certified counselor could get soaked up guarding Period 5 while that period's Level 6 group goes unfilled.

Rules:
- **Eligibility**: a lesson group needs `COALESCE(SwimMaxLevel, 3) >= effectiveMaxLevel`; anyone on the swim staff (`StaffRole = 'Swim Counselor'`) can guard.
- **No double-booking**: a counselor already used anywhere in a period (guard or group, including pre-existing manual assignments) is excluded from every other slot in that same period.
- **Cert reservation**: within a slot's eligible pool, each candidate is scored with a `CERT_RESERVE_WEIGHT` (10) penalty per level of unneeded certification headroom — `SwimMaxLevel` above what the slot actually requires (3 for guarding/level 1-3 groups, since that's the everyone-qualifies floor; the group's own effective level for level 4-6 groups). A Level 3-only counselor has zero penalty guarding or teaching Level 1-3; a Level 6-certified counselor picks up 30 points of penalty for the same slot, pushing them to the back of the line so they're saved for a level that actually needs their certification. Combined with the level-descending processing order above, this is the mechanism that keeps the solver from running out of highly-certified counselors for the classes that require them.
- **In-water slots** (guarding, or a level 1-3 group): after the cert-reservation penalty, in AM periods (1-3) the picker weights each candidate's historical AM in-water count from `getAmFairnessTally(week)` — every prior week's periods 1-3 — 100x over their running count *this* run, so whoever has done the least early-morning duty across the summer wins; only ties fall back to this-week balance. In PM periods (4-6), history is ignored entirely and the picker just takes whoever has the fewest in-water assignments so far this week, targeting roughly 2 per counselor.
- **Out-of-water slots** (level 4-6 groups): after the cert-reservation penalty, picked by fewest out-of-water assignments so far this week, targeting roughly 1 per counselor.
- This is a greedy heuristic, not an optimal solver — it targets the cert-reservation, ~2-in-water/~1-out-of-water PM balance, and AM fairness described above, but doesn't guarantee an exact optimum. If it still can't fill a slot (no eligible, not-yet-used counselor), that slot is left open and counted in the `unfilled` total shown in the result message; `getSwimWarnings()` will then flag the resulting under-guarded period or empty group on the next render.

`getAmFairnessTally(week)` is the same in/out classification as `getCounselorWaterTally()`, restricted to periods 1-3 and weeks strictly before the target week.

### Greyed-out names in the manual pickers

The Rec Swim guard checklist, Swim Lessons pool guard checklist, and each group's instructor `<select>` grey out (and label with what they're already doing) any counselor who's assigned to something else in that same period — computed inline per period card in `views/swim-scheduling.ejs` from `p.rec.guards`, `p.lessons.guards`, and `p.lessons.groups`. This is display-only: greyed names stay clickable/selectable, since the director may deliberately want to double-book someone (e.g. a brief overlap) — `getSwimWarnings()` still catches and flags any resulting double-booking on the next render.

### `getSwimWarnings(periods)`

Computed at render time, never stored. Flags: a period's Rec Swim or Swim Lessons guard count below the required threshold; an empty lesson group; a counselor assigned to teach a group above their `SwimMaxLevel`; and any counselor appearing in more than one guard/instructor slot in the same period (double-booked) — tracked via a `period|counselorId` map built while walking the same `periods` structure the page renders.

### Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/swim-scheduling` | Main page. `?week=N` to view a different session |
| POST | `/swim-scheduling/generate-groups` | Runs `generateGroupsForWeek()` |
| POST | `/swim-scheduling/create-group` | Manually add an empty group (period + level + sub-level) |
| POST | `/swim-scheduling/delete-group` | Deletes a group; members become "Not yet in a group" (CASCADE) |
| POST | `/swim-scheduling/merge-group` | Merges a source group into a target group in the same period; widens the target's level range, locks it, deletes the source |
| POST | `/swim-scheduling/toggle-group-lock` | Flips `Locked` |
| POST | `/swim-scheduling/assign-instructor` | Sets a group's `CounselorID` |
| POST | `/swim-scheduling/assign-camper` | Adds a camper to a group (`INSERT OR IGNORE`) |
| POST | `/swim-scheduling/remove-camper` | Removes a camper from a group (they become ungrouped, reassignable) |
| POST | `/swim-scheduling/save-guards` | Full replace of a `(week, period, guardRole)` guard set from a checkbox list |
| POST | `/swim-scheduling/save-certifications` | Bulk-updates every swim counselor's `Counselors.SwimMaxLevel` in one submit |
| POST | `/swim-scheduling/auto-assign` | Runs `autoAssignWeek()` — fills open guard slots and un-instructored groups, leaves everything already set untouched |

### Edit Swim Certifications panel

A collapsible (`<details>`/`<summary>`, closed by default) section on `/swim-scheduling` that bulk-edits `SwimMaxLevel` for every swim counselor at once, instead of going through each counselor's profile individually. One `<select>` per counselor, parallel hidden `counselorId` inputs matching by submission order (same repeated-name-array convention as the guard checkboxes — Express parses same-named fields into arrays in DOM order), one `POST /swim-scheduling/save-certifications` for the whole table.

"Move a camper between groups" and "merge/split a group" aren't dedicated actions — they're composed from `assign-camper`/`remove-camper`/`create-group`/`delete-group`, matching this codebase's convention of small single-purpose routes over one dispatcher endpoint.

---

## Known limitation

Swim staffing lives in its own tables (`SwimLessonGroups`, `SwimGuardAssignments`), independent of `CounselorWeekSchedules`/`WeeklyOfferings`. Master Schedule's Counselors column, the staff Daily Assignments card, and Attendance do **not** show swim duty assignments for Rec Swim / Swim Lessons periods — that data only exists in `/swim-scheduling` and the tables above. Rec Swim/Swim Lessons should be treated as off-limits in the main `/counselor-scheduling` builder to avoid double-booking swim staff across the two systems (not enforced automatically — a manual convention for now).
