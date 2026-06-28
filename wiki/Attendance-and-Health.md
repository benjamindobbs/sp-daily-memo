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
| `bus` | Bus route AM/PM | `0` | `''` |
| `extended` | Extended hours AM/PM | `0` | `''` |
| `specialty` | LilPlace, KinderPlace, SPLIT AM | `0` | `''` |
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
| `GET /attendance/specialty/:color/:session` | Specialty program roster | `AM` or `PM` |
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

---

## Early Dismissals

### Table: `EarlyDismissals`

One row per camper per day. `UNIQUE (Date, CamperID)` prevents duplicate dismissal entries.

### Routes

| Route | Action |
|---|---|
| `POST /attendance/early-dismissal` | Create a new dismissal record for today |
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

## Late Arrivals

Campers who arrive after the normal start time are checked in via `GET /attendance/late-arrivals` and `POST /attendance/check-in`. This writes an `Attendance` record with `SessionType='late-arrival'` and `Status='present'`.

---

## Schedule Change Log

### Tables: `ScheduleChanges` and `ScheduleChangesArchive`

Every class swap (via the swap tool) appends a row to `ScheduleChanges`. Admins can view the log at `/schedule-history` and archive selected entries, which moves them to `ScheduleChangesArchive`. Both tables have identical columns; the archive adds `ArchivedAt`.

`POST /archive-schedule-changes` — moves checked entries from `ScheduleChanges` to the archive.
