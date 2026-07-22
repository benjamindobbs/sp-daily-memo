# Attendance & Health

Tables and routes for attendance tracking, dismissals, and health visits.

---

## Attendance

### Table: `Attendance`

One row per mark. The unique constraint `(Date, CamperID, SessionType, PeriodNumber, ActivityName)` ensures a camper can only be marked once per slot per day.

| `SessionType` | What it covers | `PeriodNumber` | `ActivityName` |
|---|---|---|---|
| `homegroup` | Morning or afternoon home group check-in | `0` | `''` |
| `class` | Class period attendance | `1`–`6` | Activity name |
| `bus_am` / `bus_pm` | Bus route AM or PM direction | `0` | `''` |
| `extended` | Extended hours AM/PM | `0` | `''` |
| `specialty` | LilPlace, KinderPlace, SPLIT AM | `0` | `''` |
| `specialty_halfday` | Midday check-out: KP/LP campers with `ScheduleType='Half Day'`, plus all of SPRC | `0` | `''` |
| `late-arrival` | Campers who arrive after normal start | `0` | `''` |

`Status` values: `'present'` or `'absent'`.

### Marking Route

`POST /attendance/mark` — accepts `{ date, camperId, sessionType, periodNumber, activityName, status }`. Uses `INSERT OR REPLACE` to upsert the mark.

### Roster Routes

| Route | View | Session |
|---|---|---|
| `GET /attendance` | Overview — links to all roster types | — |
| `GET /attendance/homegroup/counselor/:counselorId/:session` | One counselor's home group | `AM` or `PM` |
| `GET /attendance/homegroup/:color/:session` | All home groups in a color combined | `AM` or `PM` |
| `GET /attendance/specialty/:color/:session` | Specialty program roster. AM lists every camper in the camp (Half Day campers get a 🕑 Half Day pill); PM excludes `ScheduleType='Half Day'` campers. SPRC has no PM card on the overview (exclusively half day) | `AM` or `PM` |
| `GET /attendance/specialty-halfday/:color` | Specialty Half Day midday check-out roster. KP/LP: only `ScheduleType='Half Day'` campers (from the ACR-003 import); SPRC: the whole camp | — |
| `GET /attendance/class/:period/:activity` | One class period | clock block |
| `GET /attendance/bus/:route/:session` | One bus route | `AM` or `PM` |
| `GET /attendance/extended/:session` | Extended hours | `AM` or `PM` |
| `GET /attendance/late-arrivals` | Late arrivals check-in | — |
| `GET /attendance/dismissal-archive` | Historical dismissal log | — |

### Status Badges

Attendance rosters pull from multiple tables in one query to compute status badges shown next to each camper. At query time the server checks:

| Condition | Badge |
|---|---|
| Row in `NurseLog` (checked in today, no checkout) | 🏥 In Nurse |
| Row in `Attendance` (homegroup, absent) for today | ⚠️ Absent AM |
| Row in `Attendance` (bus AM, absent) for today | 🚌 Absent Bus AM |
| Active row in `CaseLog` (checked in, no checkout) | 📓 With Noël |
| Row in `EarlyDismissals` for today | 🚗 Dismissed |
| Row in `ScheduledPickups` for today | 🚗 Pickup [time] |
| Row in `Attendance` with `present` from another roster | ✓ Seen Earlier |
| Date in `SplitFieldTrip` | 🏕️ Field Trip |
| Row in `CamperNotes` (`NoteType='ICP'`) | ⚕ ICP (red) |
| Row in `CamperNotes` (`NoteType='General'`) | 📝 Note (purple) |

### ICP / Camper Notes

**Table**: `CamperNotes (CamperID, NoteType, NoteText, UpdatedAt)`, `PRIMARY KEY (CamperID, NoteType)`, `NoteType IN ('ICP','General')`. Not week-scoped — one row per camper per type, holding whatever the most recent import produced.

**Import routes**: `POST /upload-icp-notes` and `POST /upload-camper-notes` (Settings → CSV Data Imports), both parsed by a shared `parseCamperNotesCsv()` in `app.js`. Both source exports are paginated CampMinder-style reports where a `"Last, First"` name record is immediately followed by its note record, interleaved with repeating page chrome (title/timestamp/`# of records` rows, the filter-criteria block, and `N/,Total` page footers).

Two things make this parser different from every other CSV import in the app:
- **Multi-line quoted fields**: note text is real multi-paragraph content with literal newlines inside the CSV quotes (e.g. a multi-step seizure action plan). `splitCsvRecords()` joins physical lines back into logical records by tracking quote parity per line before handing off to the existing single-line `parseCsvLine()`.
- **Notes that get cut off by a page break**: a long note can be closed and re-quoted as a "fresh" field when the export crosses a page boundary mid-note — with no camper-name row of its own. The parser doesn't just pair "the next record" with a name; every record that is neither chrome nor a new name row (`isCamperNoteNameRecord()`, which requires a `Color Group:` field to disambiguate a genuine name row from note text that merely contains a comma) is appended to the *current* camper's note (`isCamperNoteChromeRecord()` for the explicit chrome patterns). This reassembles a page-split note correctly instead of either truncating it or misreading the continuation as a new fake camper.

Both importers match by exact `UPPER(FirstName)/UPPER(LastName)` (same convention as Swim Levels/CSR-300 — zero or multiple matches are skipped and reported, no disambiguation logic beyond that). Each import is a **full replace** for its `NoteType`: `DELETE FROM CamperNotes WHERE NoteType = ?` runs before the fresh insert, so a resolved ICP or removed note actually disappears on re-upload rather than lingering stale.

**Display**: `getCamperNotesMap()` (one query, `CamperID -> {ICP, General}`) and `attachCamperNotes(roster)` (merges `icpNote`/`generalNote` onto each roster row) in `app.js`, called from every roster-building attendance route and the class-roster route, plus directly in `GET /camper/:id`. On `views/attendance-form.ejs` and `views/class-roster.ejs`, a present note renders as a clickable badge (`.badge-note-icp` red / `.badge-note` purple) that opens a popup (reusing the existing `.dismiss-modal`/`.dismiss-box` CSS) via `openNote(name, label, text, camperId)`. The popup truncates at 400 characters client-side and shows a **Read More →** link to `/camper/:id` only when actually truncated — the camper profile's own **Notes** card (added between the Daily Schedule and Swap Schedule cards) always shows the full untruncated text.

**Visibility**: both note types show in admin *and* staff view — deliberately not restricted like the counselor phone number change (see [Auth](./Auth.md)), since the reason to flag these on attendance sheets at all is so whoever's taking attendance sees them in the moment.

### Shirt Order Pills

Shown only on the AM Home Group attendance sheet (`/attendance/homegroup/counselor/:counselorId/am` and `/attendance/homegroup/:color/am`), only when the viewed `date` falls on a Monday, and only for main-camp campers (`HomeGroupColor` in `Red`/`Carolina`/`Green`/`Navy`). Computed from `Campers.SessionCodes` (see [Data-Import](./Data-Import.md#camper-roster-acr-005)) — not stored, recalculated on every page load:

- **Quantity** = number of `SPnn` codes in `SessionCodes`, `+1`, capped at `5` (max days in a camp week).
- **Shirts Received** replaces the size/quantity pills when the camper's earliest registered week is before the current active week (i.e. they already picked up shirts during an earlier, completed week). Clicking the "Shirts Received" pill toggles it to show the size and quantity that were computed, for reference.

### Lunch Pills

Shown only on the Lunch Home Group attendance sheet (`/attendance/homegroup/counselor/:counselorId/lunch` and `/attendance/homegroup/:color/lunch`), for every color (not restricted to main camp). Reads `CamperWeekData.CampLunch` for the active week:

| `CampLunch` | Badge |
|---|---|
| `Yes` | 🍱 Camp Lunch |
| `Allergy` | ⚠️ Allergy Meal |
| `No` (packed lunch) | *(no badge)* |

---

## Early Dismissals

### Table: `EarlyDismissals`

One row per camper per day. `UNIQUE (Date, CamperID)` prevents duplicate dismissal entries.

### Routes

| Route | Action |
|---|---|
| `POST /attendance/early-dismissal` | Create a new dismissal record for today |
| `POST /attendance/dismissal-undo` | Remove today's dismissal record for a camper (Back In) |
| `GET /dismissals` | View and manage today's pending dismissals |
| `POST /dismissals/schedule` | Add a scheduled pickup (writes `ScheduledPickups`) |
| `POST /dismissals/cancel` | Cancel a scheduled pickup |
| `POST /dismissals/update` | Mark a dismissal as completed |
| `GET /dismissals/all` | Full dismissal list across all dates |
| `GET /attendance/dismissal-archive` | Historical dismissal records |

### Scheduled Pickups (`ScheduledPickups`)

Distinct from `EarlyDismissals`. A scheduled pickup is entered in advance (e.g. "bus pickup at 2pm"). It appears as a yellow badge on attendance sheets. When the actual dismissal happens, it's recorded in `EarlyDismissals`.

`ScheduledPickups.PeriodNumber` indicates which class period the pickup falls during (used to display the badge on the correct class roster).

---

## Nurse Station

### Table: `NurseLog`

Each visit is one row. `CheckOutTime = NULL` means the camper is currently in the nurse station — this is what triggers the 🏥 badge on attendance sheets.

### Routes

| Route | Action |
|---|---|
| `GET /nurse` | Active visits (checked in, no checkout) |
| `POST /nurse/checkin` | Create a new visit (writes to `NurseLog`) |
| `POST /nurse/checkout/:visitId` | Set `CheckOutTime` for a visit |
| `POST /nurse/dismiss/:visitId` | Mark `Dismissed=1` and optionally create an `EarlyDismissals` record |
| `POST /nurse/update-notes/:visitId` | Update notes on an existing visit |
| `GET /nurse/archive` | Historical visits, grouped by date |

---

## Case Log

### Table: `CaseLog`

Identical structure to `NurseLog`. Used for more significant incidents requiring fuller documentation. An active `CaseLog` visit (checked in, no checkout) triggers the 📓 With Noël badge.

### Routes

| Route | Action |
|---|---|
| `GET /case-log` | Active cases |
| `POST /case-log/checkin` | Create a new case |
| `POST /case-log/checkout/:visitId` | Close a case |
| `POST /case-log/dismiss/:visitId` | Dismiss from case log (+ optional early dismissal) |
| `POST /case-log/update-notes/:visitId` | Update case notes |
| `GET /case-log/archive` | Historical cases, grouped by date |

---

## SPLIT Field Trip

### Table: `SplitFieldTrip`

Single-column truth table keyed by date. If today's date is in this table, SPLIT specialty attendance sheets show a 🏕️ field trip indicator and individual SPLIT campers on class rosters show a bus icon.

### Routes

| Route | Action |
|---|---|
| `POST /split-field-trip/mark` | Insert today's date |
| `POST /split-field-trip/clear` | Delete today's date |

---

## Bus Attendance (AM/PM Split)

Bus routes now have separate AM and PM attendance sheets. Whether a camper appears on a bus sheet is controlled by `Campers.BusRidesAM` and `Campers.BusRidesPM` (set during the ACR-005 import). A camper with `BusRidesPM=0` will not appear on the PM bus sheet even if they have a bus route assigned.

The attendance overview progress counter for bus routes similarly tracks only AM riders for the AM count and PM riders for the PM count.

---

## Late Arrivals

Campers who arrive after the normal start time are checked in via `GET /attendance/late-arrivals` and `POST /attendance/check-in`. This includes campers marked absent on both `homegroup_am` and `specialty_am` session types, so specialty camp (SPRC, KinderPlace, LilPlace) absences appear alongside main camp absences. Checking a camper in updates the correct session type based on their `HomeGroupColor`.

### Check-in behavior

When a camper is checked in (`Status` updated from `absent` → `late`), the late arrivals grid continues to show them with:
- Strikethrough name text and dimmed row
- A green **✓ Arrived** label instead of the Check In button

Arrived rows are automatically hidden by a client-side timer once the period they were checked into has ended. Period end cutoffs (EDT):

| Checked in before | Row hidden after |
|---|---|
| 10:35 AM | 10:35 AM (block 1 over for all groups) |
| 1:00 PM | 1:00 PM (blocks 2/3 over for all groups) |
| 2:40 PM | 2:40 PM (block 4 over for all groups) |
| 4:05 PM | 4:05 PM (end of camp day) |

The empty state ("No late arrivals") is shown automatically once all rows are either hidden or absent rows have been cleared.

### Back In (undo early dismissal)

The late arrivals page also shows any camper who has been given an early dismissal today. A **Back In** button appears next to each dismissed camper; pressing it calls `POST /attendance/dismissal-undo`, which deletes their `EarlyDismissals` record and removes the 🚗 Dismissed badge from attendance sheets.

---

## Schedule Change Log

### Tables: `ScheduleChanges` and `ScheduleChangesArchive`

Every class swap (via the swap tool) appends a row to `ScheduleChanges`. Admins can view the log at `/schedule-history` and archive selected entries, which moves them to `ScheduleChangesArchive`. Both tables have identical columns; the archive adds `ArchivedAt`.

`POST /archive-schedule-changes` — moves checked entries from `ScheduleChanges` to the archive.
