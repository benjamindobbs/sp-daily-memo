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
1. `autoAssignScheduleTypes()` — **Full Auto Build respects every existing schedule type** and only fills blanks demand-first. To reshuffle types, use the **Assign Schedule Types** button, which rescrambles every *unlocked* type from current enrollment demand; fixed under rescramble: partial `…Only` types (availability constraints) and **manually pinned types** (`ScheduleTypeManual`). Pinning happens automatically when an admin hand-edits a schedule-type dropdown, or explicitly via the 📌 toggle next to each select; pinned selects show an indigo border and a solid pin. Clicking the pin again unlocks the type (keeping its value). Demand uses `calcSlotCount()` — the same formula as the slot calculator — and supply counts main-camp *and* specialty counselors that are marked working this week.
2. `buildSchedule()` — computes slot counts via `calcSlotCount()`, then a greedy assignment loop: zero-counselor classes first, then highest enrollment-per-counselor ratio. Filters to counselors eligible by schedule type and not already booked.
3. `fillExtraCounselors()` — places all remaining available counselors: fills empty slots, then adds new slots trying classes neediest-first until one has room (caps: swim/archery 2, enrichment 3), then force-places anyone still unassigned (triple-period classes excluded so the re-sync can't evict them). Counselors who genuinely can't be placed anywhere are listed by name in the status line ("Unplaced counselors: …").
4. `rebalanceCounselors()` — equity pass: within each period+side, moves counselors from over-staffed to under-staffed classes until enrollment-per-counselor ratios can't improve. Locked and triple-period offerings are never touched.
5. Blank slots that no remaining counselor can legally fill are removed and reported in the status line instead of lingering.
6. `renderAllFromState()` — re-renders all dropdowns from in-memory state.

**Variety rule (day-level)** — `blockUsed[counselorID]` tracks activity names per AM/PM block; eligibility checks **both blocks**, so a counselor is never assigned the same activity name twice in one day (all swim variants count as one activity). The force-place fallback relaxes this only if nothing else is available.

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

---

## Waitlist & Promotions

When a swap is attempted into a full class, the camper is added to `Waitlists`, tagged with the active week (`WeekNumber`). The `/promotions` page surfaces eligible campers (class has an open spot) and lets the admin promote one or all at once. Both the "Ready for Promotion" and "Waitlist Queue" lists are scoped to the current active week, so entries from a prior week stop appearing once the week rolls over (they are not deleted, just no longer shown).

A **Force Promote** button (`POST /force-promote-waitlist`) is also available on each waitlist card regardless of capacity. This bypasses the enrollment check and directly updates the camper's `Schedules` row to the requested activity. Use when the class is intentionally over-enrolled.

A **Deny** button (`POST /remove-waitlist/:id`) is available on both the "Ready for Promotion" and "Waitlist Queue" cards to reject a request outright, deleting the `Waitlists` row without touching the camper's schedule.

---

## Exports

| Export | Route | Source tables |
|---|---|---|
| Counselor Schedule CSV | `GET /export-counselor-schedule` | `CounselorScheduleAssignments` + `Counselors` |
| Staff Schedule CSV | `GET /export-staff-schedule` | `CounselorScheduleAssignments` + `Counselors` |
| Master Schedule CSV | `GET /export-master-schedule` | `WeeklyOfferings` + `CounselorScheduleAssignments` |
