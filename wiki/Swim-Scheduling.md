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

## Known limitation

Swim staffing (Phases 3–4, not yet built) will live in its own tables, independent of `CounselorWeekSchedules`/`WeeklyOfferings`. Once that ships, Master Schedule's Counselors column, the staff Daily Assignments card, and Attendance will **not** show swim duty assignments for Rec Swim / Swim Lessons periods — that data only exists in the swim-specific tables and views.
