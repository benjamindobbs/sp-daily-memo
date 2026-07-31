# Scheduling System

How activities, camper schedules, weekly offerings, and counselor assignments fit together.

---

## Overview

The scheduling system has two distinct halves:

1. **Camper scheduling** — which camper goes to which class each period. Populated by CSV import; adjusted via the Swap Tool.
2. **Counselor scheduling** — which counselor covers which class each period. Built by the auto-scheduler on the `counselor-scheduling` page.

These two halves share the `Activities` table and the clock block period numbering system, but write to different tables.

---

## Clock Blocks (Period Numbering)

Periods are stored as integers 1–6 representing the day's six activity blocks in chronological order:

| Block | Time slot | Red/Carolina side | Green/Navy side |
|---|---|---|---|
| 1 | AM block 1 | Enrichment | Sports |
| 2 | AM block 2 | Enrichment | Sports |
| 3 | AM block 3 | N/A | Sports |
| 4 | PM block 1 | Sports | Enrichment |
| 5 | PM block 2 | Sports | Enrichment |
| 6 | PM block 3 | Sports | N/A |

This means "period 3" is the last AM enrichment period for Red/Carolina and the last AM sports period for Green/Navy — not an "ordinal position" within a group's enrichment run. All tables (`Schedules`, `CounselorWeekSchedules`, `WeeklyOfferings`, `CounselorScheduleAssignments`) use clock blocks.

> A startup migration converts any pre-migration data that used ordinal positions or the old `'3AM'`/`'3PM'` text labels to clock blocks.

---

## Activity Merging (`MERGED_ACTIVITIES`)

Some activities share a room and instructor and should appear as one class on display views. The `MERGED_ACTIVITIES` constant in `app.js` declares these groups:

```js
const MERGED_ACTIVITIES = [['Dance', 'Cheerleading']];
```

**How it works (display layer only — no database changes):**

- **Master Schedule** — after the `enriched` array is built from the DB, a post-processing pass detects when all activities in a merge group appear in the same period. They are collapsed into one row with a combined name (e.g. "Dance & Cheerleading"), summed enrollment, and unioned staff/counselors.
- **Class Roster** — the route detects the merge at query time. Camper and staff queries use `IN (...)` to pull both activities. A "Class" sub-column shows each camper's actual enrolled activity.
- **Counselor Scheduling** — `WeeklyOfferings` are post-processed the same way before being sent to the template. Assignments saved through the merged card are written to **both** component activity names in `CounselorWeekSchedules` and `CounselorScheduleAssignments`.

The merge only fires when **all** activities in the group exist in the **same period** for the current week. If they are in different periods (or only one is offered), they display separately as normal.

To add a new merge group, add a new inner array to `MERGED_ACTIVITIES`. The first entry in the array is used as the URL target for class roster links.

---

## Activities

`Activities` is the master list. Each activity has:
- `SideOfCamp` — `Sports` or `Enrichment`
- `MaxCapacity` — default enrollment cap
- `AllowedGroups` — which color groups can be placed here (NULL = open to all)

`ActivityPeriodGroups` adds per-period group overrides. If a row exists for `(ActivityName, PeriodNumber)`, it takes precedence over `Activities.AllowedGroups` for that specific period.

---

## Camper Schedules (`Schedules` table)

Camper period assignments are loaded via the **Master Schedule CSV import**. Each row in `Schedules` is one camper/period assignment:

```
PersonType = 'Camper', PersonID = CamperID, PeriodNumber = 1–6, ActivityName = ...
```

These are treated as fixed for the summer session. Changes go through the **Swap Tool** (`/swap-tool`), which:
1. Moves the camper from `OldActivity` to `NewActivity` in `Schedules`
2. Checks `Activities.MaxCapacity` and enrollment before allowing the swap
3. Logs the change to `ScheduleChanges`
4. Places the camper on `Waitlists` if the requested class is full

---

## Instructor Schedules (`Schedules` table)

Instructor period assignments also live in `Schedules`:

```
PersonType = 'Instructor', PersonID = CounselorID
```

Populated via the **Instructor Schedules CSV import** (`POST /upload-instructors`). These are per-week (uploads target the active week) and are used to display individual instructor schedule pages.

The **Faculty Full Summer** feature (`StaffWeekSchedules`) is a parallel store for all 6 weeks of instructor data, independent of the active week. This feeds the week-selector on staff profile pages.

---

## Weekly Offerings (`WeeklyOfferings` table)

`WeeklyOfferings` is the input to the counselor scheduler — one row per class offering per week:

```
(ActivityName, PeriodNumber, WeekNumber) → enrollment, capacity, side, allowedGroups
```

Populated two ways:
- **Sync from schedule** (`POST /sync-offerings-from-schedule`) — derives offerings from existing `Schedules` rows by counting enrolled campers per activity per period.
- **CSV upload** (`POST /upload-weekly-offerings`) — manual bulk load.

The sync rebuilds offerings for the active week. It is idempotent — running it again replaces the current week's data.

---

## Counselor Scheduler Pipeline

The full flow from build to save:

```
WeeklyOfferings  →  [auto-builder JS]  →  in-memory state
                                              ↓  (Save button)
                                    CounselorScheduleAssignments
                                              ↓
                                    CounselorWeekSchedules  (one row per counselor/period)
```

### Auto-builder (client-side JavaScript in `counselor-scheduling.ejs`)

Key constants available to the builder at page load:
- `OFFERINGS` — all `WeeklyOfferings` rows for the active week
- `COUNSELORS` — all counselors with their `CounselorWeekAttributes` for the active week
- `MAIN_COUNSELORS` — subset of `COUNSELORS` where `StaffRole` is `Counselor` or `Swim Counselor`
- `STAFF_BUSY` — `CounselorID → [periods]` where the person teaches under a dual-enrolled staff identity (same name, different `Counselors` row). Sourced from `CounselorScheduleAssignments` (PersonType `Instructor`), legacy `Schedules` instructor rows, and `StaffWeekSchedules` for the plan week. The builder skips busy counselors for those periods, and the per-block availability counter chips exclude them from the remaining count.

**Schedule Types** — controls which clock blocks a counselor is eligible for:

| ScheduleType | Eligible blocks (Red/Carolina) | Eligible blocks (Green/Navy) |
|---|---|---|
| `All Sports` | 4, 5, 6 | 1, 2, 3 |
| `All Enrichment` | 1, 2, 3 | 4, 5, 6 |
| `AM Sports / PM Enrichment` | AM=4,5,6 · PM=1,2,3 | AM=1,2,3 · PM=4,5,6 |
| `AM Enrichment / PM Sports` | reverse of above | reverse of above |
| *(blank)* | auto-detected from color group | auto-detected from color group |

**Build phases (Full Auto Build):**
0. *(Repair tool)* **Infer Types from Schedule** — fills **blank** schedule-type dropdowns by reading each counselor's current class assignments (dominant side per AM/PM block → full, split, or `…Only` type). Existing non-blank types are never touched. Fixes a type/schedule desync; save Group Assignments afterwards to persist.
0. *(Repair tool)* **Migrate Pinned Types** — under **Mirror from** (pick a source week), copies every manually-pinned (`ScheduleTypeManual=1`) schedule type from `GET /api/counselor-week-pinned-types/:week` onto counselors in the current build who share a `CounselorID`, setting the dropdown value and re-pinning it here (`manualTypeCids`). Counselors not present in the current week's main group are skipped. Like the other Mirror buttons, this only updates in-memory builder state — save Group Assignments afterwards to persist.
1. `autoAssignScheduleTypes()` — **Full Auto Build respects every existing schedule type** and only fills blanks demand-first. To reshuffle types, use the **Assign Schedule Types** button, which rescrambles every *unlocked* type from current enrollment demand; fixed under rescramble: partial `…Only` types (availability constraints) and **manually pinned types** (`ScheduleTypeManual`). Pinning happens automatically when an admin hand-edits a schedule-type dropdown, or explicitly via the 📌 toggle next to each select; pinned selects show an indigo border and a solid pin. Clicking the pin again unlocks the type (keeping its value). Demand uses `calcSlotCount()` — the same formula as the slot calculator — and supply counts main-camp *and* specialty counselors that are marked working this week.
2. `buildSchedule()` — computes slot counts via `calcSlotCount()`, then a greedy assignment loop: zero-counselor classes first, then highest enrollment-per-counselor ratio. Filters to counselors eligible by schedule type and not already booked.
3. `fillExtraCounselors()` — places all remaining available counselors: fills empty slots, then adds new slots trying classes neediest-first until one has room (caps: swim/archery 2, enrichment 3), then force-places anyone still unassigned (triple-period classes excluded so the re-sync can't evict them). Counselors who genuinely can't be placed anywhere are listed by name in the status line ("Unplaced counselors: …").
4. `rebalanceCounselors()` — equity pass: within each period+side, moves counselors from over-staffed to under-staffed classes until enrollment-per-counselor ratios can't improve. Locked and triple-period offerings are never touched.
5. Blank slots that no remaining counselor can legally fill are removed and reported in the status line instead of lingering.
6. `renderAllFromState()` — re-renders all dropdowns from in-memory state.

**Variety rule (day-level)** — `blockUsed[counselorID]` tracks activity names per AM/PM block; eligibility checks **both blocks**, so a counselor is never assigned the same activity name twice in one day (all swim variants count as one activity, as do known same-rotation name pairs in `SAME_CLASS_GROUPS`, e.g. `Volleyball/Net Games` and `Volleyball/Badminton`). The force-place fallback relaxes this only if nothing else is available.

**Preference fairness** — `prefWins[counselorID]` counts how many preferred classes each counselor has been given during the build. When multiple counselors who prefer the same class compete for a slot, the one with the fewest preferred wins so far goes first (random shuffle breaks remaining ties). If demand forces schedule-type overrides, the counselor whose activity preferences best align with the forced type is flipped first instead of choosing randomly. After overrides, a **mutual-swap pass** trades schedule types 1:1 between counselors who each hold the other's preferred type (opposite full-days, inverse splits, full↔split pairs) — both get their preference at zero supply cost.

**Preference color cues** —
- Slot dropdowns: counselors who listed the class in their activity preferences render with a light-green background — both as options in the open dropdown and on the closed input when they're the selected assignee.
- Group-assignment schedule-type selects: green = matches the counselor's `SchedulePreference`; yellow = wanted full-day but got a split (or vice versa — half right); red = opposite full day, or the inverse split. Inside the open dropdown their preferred value is highlighted green. Colors update live on change and after auto-assignment.

**Gender rules** — driven by `Counselors.Gender` (`M`/`F`/NULL, editable via Mass Edit Staff or the profile page):
- **Go Girl (female-only)**: any offering matching `/go.?girl/i` excludes male counselors from every placement path, including force-place fallbacks and side rebuilds. Unknown-gender counselors are allowed.
- **Gender split**: classes with 2+ counselors need at least one of each gender. The greedy fill prefers the missing gender on a class's last open slot; after the build, `enforceGenderSplit()` repairs single-gender classes by swapping counselors with other classes in the same period+side (never breaking the donor's split, variety, or Go Girl). Unknown genders count as neither, so all-unknown classes never flag.
- **Best effort**: if a violation can't be repaired, the class is listed in the status line ("Gender split unmet: …") and the build proceeds.
- **Card flags**: violating cards get a background — pink = all-female, blue = all-male, red = short on staff (fewer counselors than the slot formula requires). Flags are recomputed from current assignments on page load, after every build, and after manual slot/count edits, so they survive save/refresh and clear automatically once the conflict is resolved. Each flag has an Ignore button; ignores persist per week+class in `localStorage`. A week with no assignments at all shows no flags.

**Slot formula** — `calcSlotCount(act)` is the single source of truth: Hartt Chamber and Learning Zone → 0; Archery → 2; Sports → `min + ceil(max(0, enrollment − threshold) / per)` with swim capped at 2; Enrichment → configured per-AllowedGroups minimum, reduced to 1 for PM classes with ≤8 enrolled.

### Saving

`POST /save-counselor-assignments` receives the full assignment state as JSON and writes two tables:
- `CounselorScheduleAssignments` — one row per assignment (used by exports and the scheduler UI)
- `CounselorWeekSchedules` — one row per counselor per period (used by attendance and profile pages)

Both are replaced (DELETE + INSERT) for the active week on each save.

### Locked Offerings

Locking a class card on the counselor scheduling page excludes that offering from all auto-build and rebuild passes. Lock state is now persisted server-side in `LockedOfferings` via `POST /api/toggle-lock`, so locks survive page refreshes. On page load, `GET /api/locked-offerings?week=N` hydrates the client state from the database.

---

## Activity Group Sync

`POST /sync-activity-groups` analyzes the current camper enrollment in `Schedules` for the active week and derives the correct `AllowedGroups` value for each activity, including per-period exceptions in `ActivityPeriodGroups`.

**Logic:**

1. For each `(ActivityName, PeriodNumber)` pair that has camper rows, collect the distinct `HomeGroupColor` values from `CamperWeekData`.
2. Map those colors to the appropriate `AllowedGroups` label:
   - Green/Navy only → `Green-Navy`
   - Red/Carolina only → `Red-Carolina`, `Red`, or `Carolina` depending on which are present
   - Both camps mixed → `null` (open to all)
3. Compare against the "universal" group for that side+period (the combined set of colors attending any activity on that side during that period). If the activity's group matches the universal, no explicit restriction is needed.
4. When all periods of an activity share the same group, set it at the activity level. When periods differ, write per-period rows to `ActivityPeriodGroups` only where the activity deviates from the universal.

This runs automatically on week rollover (inside `checkWeekRollover`) and can be triggered manually from the Activity Manager in Settings.

---

## Counselor Schedule Backups

Before a major rebuild, the admin can create a named backup (`POST /backup-counselor-assignments`). Backups store the full `CounselorScheduleAssignments` state as a JSON blob in `CounselorScheduleBackups`. Restoring (`POST /restore-counselor-backup/:id`) replays the JSON into the live tables.

---

## Home Group Assignment

Separate from class scheduling. `CamperHomeGroups` stores which camper belongs to which counselor's home group each week. Managed at `/homegroup-assignment`. The page supports:
- Manual drag-and-drop assignment
- Auto-assign by color group
- Mirror: copy one week's assignments to another week

---

## SPLIT Scheduling

SPLIT campers have a non-standard schedule (AM specialty, PM standard classes). `/split-scheduling` manages their period assignments separately from the main `Schedules` table.

Covered periods: **1, 2, 4, 5, 6**. Periods 1 and 2 are Enrichment AM; period 4 shows both Sports and Enrichment sides; periods 5 and 6 are Sports PM. Period 3 is not included (AM block 3 is not part of the SPLIT assignment set).

### SPLIT Schedule (read-only view)

`/split-schedule` is a read-only companion to `/split-scheduling` — a period-by-period listing of where every SPLIT camper actually ended up, for staff to consult day-to-day (not gated to admin, same access as `/master-schedule`). It reads the same `Schedules` rows the assignment editor writes (`PersonType = 'Camper'`, joined to `CamperWeekData` for `HomeGroupColor = 'SPLIT'` in the active week), so it only shows the periods a SPLIT camper actually has a class assignment for — periods 1, 2, 4, 5, 6, matching the editor's scope.

Each period section lists one row per camper: camper name, class (`ActivityName`), and the class's location. Rows within a period are sorted by location alphabetically (ties broken by camper name). Location is resolved with the same priority order as Master Schedule: `StaffWeekSchedules.Location` (week-scoped override) → legacy `Schedules` `PersonType='Instructor'` row → `Activities.Location` fallback.

---

## Waitlist & Promotions

When a swap is attempted into a full class, the camper is added to `Waitlists`, tagged with the active week (`WeekNumber`). The `/promotions` page surfaces eligible campers (class has an open spot) and lets the admin promote one or all at once. Both the "Ready for Promotion" and "Waitlist Queue" lists are scoped to the current active week, so entries from a prior week stop appearing once the week rolls over (they are not deleted, just no longer shown).

A **Force Promote** button (`POST /force-promote-waitlist`) is also available on each waitlist card regardless of capacity. This bypasses the enrollment check and directly updates the camper's `Schedules` row to the requested activity. Use when the class is intentionally over-enrolled.

A **Deny** button (`POST /remove-waitlist/:id`) is available on both the "Ready for Promotion" and "Waitlist Queue" cards to reject a request outright, deleting the `Waitlists` row without touching the camper's schedule.

---

## Audit Schedule Rule Checks

`GET /audit`'s **Duplicate / Swim Overload** card re-checks, against the actual saved `CounselorWeekSchedules` for the active/prep week, two of the rules the auto-builder is supposed to enforce at build time — so a violation introduced by a manual edit after the build (or by any other path that writes to the table) still gets caught, not just build-time mistakes.

For each counselor, periods are split into the AM block (`PeriodNumber <= 3`) and PM block (`PeriodNumber > 3`), same boundary used everywhere else in the app (`scheduleTypeBusy()`, `getCounselorWaterBreakdown()`, etc.). Within each block independently:

- **Duplicate class** — the same `ActivityName` appears more than once in that block, OR two names from the same `DUPLICATE_NAME_GROUPS` entry (`app.js`, e.g. `Volleyball/Net Games` and `Volleyball/Badminton`, which are really the same shared-rotation class under different labels) both appear in that block. Unlike the day-level variety rule below, this does not collapse swim variants into one key — an exact repeated name (or a same-group name pair) is what's flagged here. Any activity whose name contains "triple period" (case-insensitive, e.g. `Sports Pals (triple period)`) is excluded from this count — the auto-builder deliberately assigns the same counselor to all 3 periods of these activities (see `tripleGroups`/`tripleGroupsPre` in `views/counselor-scheduling.ejs`), so a repeat there is by design, not a scheduling mistake.
- **Swim overload** — more than 1 class whose `ActivityName` matches `/swim/i` (e.g. `Rec Swim`, `Swim Lessons`) appears in that block. This catches two *different* swim classes stacked in the same block (e.g. Rec Swim period 1 + Swim Lessons period 2), which the duplicate-name check above wouldn't flag since the names differ. Triple-period activities are not exempted from this one (none currently match `/swim/i`, but the exclusion is only applied to the duplicate-class count).

This mirrors, but is independent from, the auto-builder's own **variety rule** (`blockKey()`/`blockUsed`/`usedEitherBlock()` in `views/counselor-scheduling.ejs`, described under [Auto-builder](#counselor-scheduler-pipeline) above), which collapses all swim variants — and the same `SAME_CLASS_GROUPS` name pairs used by the audit's `DUPLICATE_NAME_GROUPS` — into one key and prevents a counselor from getting the same activity twice across the **whole day** (both blocks combined) during a fresh build. The audit check is narrower in scope (block-level, not whole-day) but reads the live data directly, so it's the source of truth for what's actually saved — including schedules built before the variety rule existed, edited by hand, or written by any path other than the auto-builder.

Each violation row shows the counselor, which block (AM/PM), and the specific issue(s) found, with a link to their profile. No auto-fix — this is a report, not a repair tool; resolve violations by hand in Counselor Scheduling.

### Unit Leader Repeat Classes

A second, separate card runs the same **duplicate class** check (same `ActivityName` more than once in the AM or PM block, or a same-group name pair, with the same triple-period exclusion described above) for Unit Leaders. It exists because Unit Leaders aren't scheduled through `CounselorWeekSchedules` at all — they're scheduled through `StaffWeekSchedules` ∪ `CounselorScheduleAssignments` (`PersonType IN ('Instructor','Staff')`), the same tables Instructors and Sports Leaders use, so the Duplicate/Swim Overload check above never sees their rows.

The query joins those two tables to `Counselors` and filters to `StaffRole = 'Unit Leader'` — **Sports Leaders are intentionally excluded**, including a Unit Leader's own dual-enrolled Sports Leader identity (a separate `Counselors` row, same person, different `CounselorID` — see [Counselor Scheduling](#counselor-scheduling)): that row's `StaffRole` is `'Sports Leader'`, so it simply doesn't match the filter and its periods never enter this check. No swim-overload equivalent is checked here, only repeated class names.

---

## Exports

| Export | Route | Source tables |
|---|---|---|
| Counselor Schedule CSV | `GET /export-counselor-schedule` | `CounselorScheduleAssignments` + `Counselors` |
| Staff Schedule CSV | `GET /export-staff-schedule` | `CounselorScheduleAssignments` + `Counselors` |
| Master Schedule CSV | `GET /export-master-schedule` | `WeeklyOfferings` + `CounselorScheduleAssignments` |

CSV exports and the printable `/reports/attendance-rosters` roster are **not** patched by Coverage (below) — they reflect the static weekly plan, not a specific calendar day.

---

## Coverage

Day-specific substitute assignment (`/coverage`, `views/coverage.ejs`) for when a counselor or staff member is out for the day. Unlike everything else on this page, Coverage is scoped to one calendar date, not a week — it never edits `CounselorWeekSchedules`/`CounselorScheduleAssignments`, it's a pure overlay resolved at render time, so it reverts automatically once the covered day passes.

### `CounselorCoverage` table

```sql
CREATE TABLE CounselorCoverage (
    CoverageID          INTEGER PRIMARY KEY AUTOINCREMENT,
    Date                TEXT    NOT NULL,
    WeekNumber          INTEGER NOT NULL,
    OutCounselorID      INTEGER NOT NULL,
    PeriodNumber        INTEGER NOT NULL,
    ActivityName        TEXT    NOT NULL,       -- snapshot of the out counselor's original class
    CoveringCounselorID INTEGER,                -- NULL when Skipped
    Skipped             INTEGER NOT NULL DEFAULT 0,  -- explicit "no coverage needed" for this period
    CreatedAt           DATETIME DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt           DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (Date, OutCounselorID, PeriodNumber),
    FOREIGN KEY (OutCounselorID) REFERENCES Counselors(CounselorID) ON DELETE CASCADE,
    FOREIGN KEY (CoveringCounselorID) REFERENCES Counselors(CounselorID) ON DELETE SET NULL
);
```

### Workflow (`GET /coverage`)

1. Pick a date (defaults to today) and the counselor/staff member who's out.
2. Their period assignments for the active/prep week are pulled the same way their own Daily Assignments card does — `CounselorWeekSchedules` for `Counselor`/`Swim Counselor` roles, `StaffWeekSchedules` ∪ `CounselorScheduleAssignments` for `Instructor`/`Unit Leader`/`Sports Leader` (`getCounselorPeriodsForWeek()`). One card is rendered per period, each showing everyone currently assigned to that class and its `WeeklyOfferings.PreliminaryEnrollment` camper count. This "who's on the class" line is itself run through `applyCoverageOverlay()` against the date's coverage map, so an out counselor who has already been assigned a substitute (whether for this class or, if visiting a second/third out-counselor the same day, saved earlier in the session) is shown replaced by their sub rather than still listed as if nothing had changed.
3. Each card has a **"Skip this period"** checkbox (no coverage needed that period) and a covering-counselor `<select>`, built by `buildCoverageCandidates(period, side, week, excludeCounselorId)` plus, for leadership/instructor roles, `buildLeadershipCandidates(role, period, week, excludeCounselorId, requireScheduledThisWeek)`:
   - **Unit Leaders** — shown first, and only when the out person's own `StaffRole` is `Unit Leader`: every other `StaffRole='Unit Leader'`, via `buildLeadershipCandidates('Unit Leader', ...)`.
   - **Sports Leaders** — shown directly below Unit Leaders, under the same condition (out person is a `Unit Leader`): every `StaffRole='Sports Leader'`, via `buildLeadershipCandidates('Sports Leader', ...)`.
   - **Instructors** — shown first, and only when the out person's own `StaffRole` is `Instructor`: every other `StaffRole='Instructor'` **who has at least one period on the schedule this week** (`buildLeadershipCandidates('Instructor', ..., true)` — the trailing `true` adds an `EXISTS` filter against `StaffWeekSchedules`/`CounselorScheduleAssignments` for the week, so idle/roster-only instructors with zero classes aren't offered as candidates).

     None of these three roles are scheduled through `CounselorWeekSchedules`, so `buildLeadershipCandidates()` looks up their current assignment the same way `getCounselorPeriodsForWeek()` does for non-Counselor roles (`StaffWeekSchedules` ∪ `CounselorScheduleAssignments`).
   - **Correct side** — `StaffRole='Counselor'`, scheduled somewhere this week (has at least one `CounselorWeekSchedules` row for `WeekNumber`), whose effective `ScheduleType` (`COALESCE(CounselorWeekAttributes.ScheduleType, Counselors.ScheduleType)`) is eligible for the class's `Activities.SideOfCamp` during that period, per `isCounselorAvailableForSide()` — a server-side port of `isCounselorAvailableFor()` from `views/counselor-scheduling.ejs`.
   - **Swim** — every `StaffRole='Swim Counselor'`, green-highlighted when they're in that week/period's Send to Sports list (`getSendToSportsSets()` reuses `getSwimSchedulingData()` + `attachSendToSports()` from [Swim Scheduling](./Swim-Scheduling.md#send-to-sports) as-is).
   - **Opposite side** — `StaffRole='Counselor'`, also scheduled somewhere this week, who fail the eligibility check above.
   - **Specialty Camp Counselors (No Schedule)** — shown last: `StaffRole='Counselor'` with **zero** `CounselorWeekSchedules` rows for the week — almost always KP/LP/SPLIT/SPRC specialty-camp counselors who were never part of the main-camp schedule builder. Excluded from Correct/Opposite Side rather than defaulting into "Correct Side" (a counselor with no `ScheduleType` at all otherwise passes `isCounselorAvailableForSide()` unconditionally, which isn't a meaningful signal for someone who was never scheduled). Always shows "Currently: Free" since there's no `CounselorWeekSchedules` row to look up.

   Every candidate (in any bucket, never filtered out) is annotated with **their own current assignment that period** — activity name, how many counselors are already on it, and its enrollment — so the admin can judge the cost of pulling them off it. The out counselor themself is excluded from every bucket. The Unit Leaders/Sports Leaders/Instructors buckets are additive — covering one of those roles still also shows the normal correct-side/swim/opposite-side buckets after them, unchanged. Unit Leaders+Sports Leaders and Instructors are mutually exclusive (keyed off the out person's own `StaffRole`), so a card only ever shows one of the two special-role bucket sets.

   **Multi-counselor headcount accuracy:** when covering more than one counselor on the same date, `buildCoverageCards()` builds `getCoverageForDate(date)` and `buildCoverageHeadcountDeltas(coverageMap, week)` once per page load (across *every* out-counselor on that date, not just the one currently being planned) and threads the resulting deltas into `buildCoverageCandidates()`/`buildLeadershipCandidates()`. Each candidate's `currentHeadcount` is the static `CounselorWeekSchedules` count adjusted by `+1` for every substitute who has already joined that class via an earlier coverage save that date, and `-1` for every substitute who has already left it to cover someone else (`getCounselorActivityForPeriod()` looks up where a covering counselor's own normal seat is, so the delta knows which class to subtract from). Without this, assigning coverage for a second or third counselor on the same day would show stale headcounts that ignore moves already saved earlier in the session.
4. **Save** (`POST /coverage/save`) upserts one `CounselorCoverage` row per period (parallel arrays, same convention as the swim-scheduling guard checklists); a period with neither a covering counselor nor Skip checked has its row cleared instead. Re-visiting the same date/counselor pre-fills every card from the existing rows.
5. A per-date summary card lists every `CounselorCoverage` row for the selected date across all out counselors, each with a **Remove** button (`POST /coverage/clear-row`).

### Rendering the overlay elsewhere

`getCoverageForDate(date)` returns a `OutCounselorID|PeriodNumber → substitute` map (non-skipped, assigned rows only). `applyCoverageOverlay(rows, coverageMap, period)` takes a list of counselor rows for one class/period (each needing a `CounselorID` field) and swaps the out counselor for their substitute, tagging the sub with `covering: true` / `coveringForName` for display. Applied in:

- **Class Roster, Master Schedule, Camper Profile** — none of these take a `date` param; they implicitly render "right now," so the overlay is always resolved against `todayStr()`.
- **Attendance class sheet** (`/attendance/class/:period/:activity`) — already carries `?date=`, so the overlay is resolved against that exact date, not just today.
- **Daily Assignments card** (`/counselor-profile/:id`) — the out counselor's own period card shows "Covered by X" or "no coverage needed" for today; the covering counselor's own profile gets an additive banner listing what they're covering, since they still keep their own normal assignment too (an intentional double-booking that day).
- **Attendance overview, staff self-filtered view** (`/attendance` with a `selectedCounselor` cookie set and `showAll` not `1`) — `allowedClasses` (the set of `period|activityName` the filter shows) additionally includes any class the covering counselor is covering that date, alongside their real `CounselorWeekSchedules`/`StaffWeekSchedules`/`CounselorScheduleAssignments`-sourced classes, so the covered class isn't invisible to them when checking their own day. The flat session list then annotates each class card:
  - A class the viewer is covering gets a green "Covering" badge.
  - A class the viewer is out of (they're the `OutCounselorID` on a non-skipped `CounselorCoverage` row) is greyed out (`att-flat-covered-away`) and tagged "Covered by X", or "No coverage needed" when `Skipped=1`.
  - If the viewer is covering a *different* class that same period, their own normal class card for that period is also greyed out and tagged "Covering `<ActivityName>` this period" — so only one card per period ever looks actionable, avoiding the ambiguity of two live-looking cards for the same clock block (`coveringByPeriod` lookup, keyed by period only, catches this alongside the exact-match `coveringByKey`).
  - **Same-class edge case:** if the class the viewer is covering is the *exact same* period+activity as their own normal class (e.g. covering a Unit Leader's leadership slot in a class they're already a counselor in themselves), the "Covering" badge wins over any own-row status — including a `Skipped=1` row for their own seat that period — so the card never gets incorrectly greyed out as covered-away. It's the one attendance sheet they actually still need. The exact-match `coveringByKey` check runs before the own-row `outCoverageByKey` check for this reason.

  This annotation only applies to the filtered flat view — the unfiltered "Show All Sessions" admin view is untouched.

A substitute can be picked even if they already have their own class that period — nothing blocks it, matching how an intentional Send to Sports overlap already can happen; they'll simply show up assigned to both classes for that day.
