# Database Schema

All tables in `camp.db`. Columns added via `ALTER TABLE` migrations are marked **[migrated]**.

---

## Campers

Primary record for every enrolled camper.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `CamperID` | INTEGER | PK, AUTOINCREMENT | |
| `FirstName` | TEXT | NOT NULL | Legal first name — populated from CSV imports |
| `LastName` | TEXT | NOT NULL | |
| `PreferredName` | TEXT | | **[migrated]** — nickname/preferred name; set manually via camper profile. Displayed in place of `FirstName` throughout the app when set. |
| `Age` | INTEGER | | Populated from ACR-005 import |
| `Grade` | INTEGER | | **[migrated]** — same source; copied from `Age` on migration |
| `HomeGroupColor` | TEXT | | `Red`, `Carolina`, `Green`, `Navy`, `LilPlace`, `KinderPlace`, `SPLIT`, `SPRC`, `Swim` |
| `HomeGroupCounselorID` | INTEGER | | FK → `Counselors.CounselorID` (soft reference, not enforced) |
| `BusRoute` | TEXT | | Stored as a string (e.g. `"3"`). Null = no bus. |
| `ExtendedHours` | TEXT | | `AM`, `PM`, `AM+PM`, or NULL |
| `CampLunch` | TEXT | DEFAULT `'No'` | `No – Packed`, `Yes`, `Allergy Meal` |
| `ShirtSize` | TEXT | | **[migrated]** — from ACR-005 import |
| `BusRidesAM` | INTEGER | DEFAULT `1` | **[migrated]** — `1` = rides the AM bus, `0` = does not. Set from ACR-005 `AM Bus` column. |
| `BusRidesPM` | INTEGER | DEFAULT `1` | **[migrated]** — `1` = rides the PM bus, `0` = does not. Set from ACR-005 `PM Bus` column. |
| `BusStopAM` | TEXT | | **[migrated]** — raw ACR-005 `AM Bus` cell text. Used by the Bus Route Audit to resolve ambiguous stops. |
| `BusStopPM` | TEXT | | **[migrated]** — raw ACR-005 `PM Bus` cell text. |
| `SessionCodes` | TEXT | | **[migrated]** — raw ACR-005 `Sessions` cell (e.g. `"SP01/SP02/SP03"`), one `SPnn` code per registered week. Used to compute the shirt-order quantity and "Shirts Received" flag on the Monday AM Home Group attendance sheet — see [Attendance-and-Health](./Attendance-and-Health.md). |

> **Bus route source:** Main camp (Red/Carolina/Green/Navy) gets `BusRoute` from ACR-255's `Bus Number`. Specialty campers (KinderPlace/LilPlace/SPLIT/SPRC/Robotics) get it from the ACR-005 stop name; ambiguous stops (West Hartford = Bus 2/5, Wolcott Park / Bishops Corner = Bus 3/4) are left NULL and resolved in the [Bus Route Audit](./Data-Import.md#bus-route-audit). See [Data-Import](./Data-Import.md).

**Normalizations applied at startup:**
- `BusRoute` values of `'null'`, `''`, or a color group name are cleared to NULL.
- Float bus routes (e.g. `"3.0"`) are cast to integer strings (`"3"`).

---

## CamperWeekData

Week-scoped camper attributes — the authoritative source for the active week; the same-named `Campers` columns are legacy fallbacks. One row per camper per week, PK `(CamperID, WeekNumber)`, FK → `Campers` with `ON DELETE CASCADE`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `CamperID` | INTEGER | NOT NULL, PK part | |
| `WeekNumber` | INTEGER | NOT NULL, PK part, CHECK 1–6 | |
| `HomeGroupColor` | TEXT | | Set by ACR-005 import |
| `CampLunch` | TEXT | DEFAULT `'No'` | Set by ACR-005 import (`Allergy` values are preserved across re-imports; pages without a Lunch column leave it untouched) |
| `ExtendedHours` | TEXT | | `AM`, `PM`, `Both`, or NULL. SP campers: from ACR-255. Specialty campers: from ACR-005's `Ext AM`/`Ext PM` columns when populated, or the ACR-003 KP/LP import |
| `BusRoute` / `BusRidesAM` / `BusRidesPM` / `BusStopAM` / `BusStopPM` | | | Set by ACR-132/133 bus imports |
| `ScheduleType` | TEXT | | **[migrated]** — `'Full Day'` / `'Half Day'` for KP/LP campers, from the ACR-003 import's Dismissal column. Drives the Specialty Half Day attendance session and PM roster exclusion. NULL for everyone else (treated as full day) |

---

## Counselors

Unified people table for all staff. Replaced the legacy `Staff` table.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `CounselorID` | INTEGER | PK, AUTOINCREMENT | |
| `FirstName` | TEXT | NOT NULL | |
| `LastName` | TEXT | NOT NULL | |
| `HomeGroupColor` | TEXT | | Default/fallback color. Week-specific color lives in `CounselorWeekAttributes`. |
| `ScheduleType` | TEXT | | Default/fallback. Week-specific in `CounselorWeekAttributes`. |
| `BusRoute` | TEXT | | |
| `ExtendedHours` | TEXT | | |
| `StaffRole` | TEXT | DEFAULT `'Counselor'` | **[migrated]** — `Counselor`, `Swim Counselor`, `Unit Leader`, `Sports Leader`, `Instructor`, `Director`, etc. |
| `Phone` | TEXT | | **[migrated]** |
| `Email` | TEXT | | **[migrated]** |
| `IncludeInStaffDropdown` | INTEGER | DEFAULT `0` | **[migrated]** — `1` = appears in camper home counselor dropdowns |
| `Gender` | TEXT | CHECK `'M'`/`'F'` or NULL | **[migrated]** — feeds the scheduler's gender-split rules; NULL = unknown (exempt from enforcement) |
| `SwimMaxLevel` | INTEGER | CHECK 1–6 or NULL | **[migrated]** — highest swim-lesson level this counselor is certified to teach. NULL = levels 1–3 only (the default floor everyone can teach). Set via the counselor profile Edit Profile form. See [Swim Scheduling](./Swim-Scheduling.md). |

**Normalizations applied at startup:**
- `HomeGroupColor` values that aren't a recognized group name are set to NULL.

**StaffRole values in use:**
`Counselor` · `Swim Counselor` · `Unit Leader` · `Sports Leader` · `Instructor` · `Director`

The scheduler treats roles as two buckets: **main counselors** (`Counselor`, `Swim Counselor`) are eligible for class slot assignments; everyone else is specialty/leadership.

---

## Staff *(legacy — empty)*

The table still exists in the schema but is cleared on every server startup (`DELETE FROM Staff`). No routes read from or write to it. All data was migrated into `Counselors`; the startup migration that performed that copy has been removed.

| Column | Type | Notes |
|---|---|---|
| `StaffID` | INTEGER PK | |
| `FirstName` | TEXT | |
| `LastName` | TEXT | |
| `HomeGroupColor` | TEXT | |
| `StaffType` | TEXT | `Instructor` or `Unit Leader` |

---

## Activities

Master list of camp activities. Used by the swap tool, offerings sync, and scheduling.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `ActivityID` | INTEGER | PK, AUTOINCREMENT | |
| `Name` | TEXT | UNIQUE, NOT NULL | Referenced by name (not ID) throughout the system |
| `SideOfCamp` | TEXT | CHECK `Sports` or `Enrichment` | |
| `MaxCapacity` | INTEGER | DEFAULT `20` | |
| `Location` | TEXT | | Default location; can be overridden per class roster |
| `AllowedGroups` | TEXT | **[migrated]** | NULL = open to all. `Red`, `Carolina`, `Red-Carolina`, `Green-Navy` |

---

## ActivityPeriodGroups

Period-specific group overrides for an activity. Takes precedence over `Activities.AllowedGroups` for the given period.

| Column | Type | Constraints |
|---|---|---|
| `ActivityName` | TEXT | PK part, FK → `Activities.Name` ON DELETE CASCADE |
| `PeriodNumber` | INTEGER | PK part |
| `AllowedGroups` | TEXT | NOT NULL, CHECK `Red`, `Carolina`, `Red-Carolina`, `Green-Navy` |

---

## Schedules

Period assignments for campers and instructors.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `ScheduleID` | INTEGER | PK, AUTOINCREMENT | |
| `PersonID` | INTEGER | NOT NULL | `CamperID` or `CounselorID` depending on `PersonType` |
| `PersonType` | TEXT | CHECK `Camper`, `Counselor`, `Staff`, `Instructor` | `Staff` is legacy; `Instructor` is current |
| `PeriodNumber` | INTEGER | NOT NULL | Clock block 1–6 |
| `ActivityName` | TEXT | NOT NULL | |
| `Location` | TEXT | | |
| `WeekNumber` | INTEGER | | **[migrated]** — scopes camper rows (`PersonType='Camper'`) per week. Backfilled to the active week for existing rows on migration. Used by all camper schedule queries to filter to the correct week. |

**Period numbers** are clock blocks, not ordinal positions. Red/Carolina campers have blocks 4–6 for their enrichment periods; Green/Navy have blocks 1–3. See [Scheduling System](./Scheduling-System.md).

---

## Sessions

One row per camp week (6 total). Controls the active week for all tools.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `weekNumber` | INTEGER | PK, CHECK 1–6 | |
| `label` | TEXT | NOT NULL, DEFAULT `'Week N'` | Display name (editable) |
| `startDate` | TEXT | | ISO date string |
| `isActive` | INTEGER | NOT NULL, DEFAULT `0` | Only one row should be `1` at a time |
| `isReleased` | INTEGER | NOT NULL, DEFAULT `0` | `1` = counselor schedule visible to staff |
| `isPrepTarget` | INTEGER | DEFAULT `0` | **[migrated]** — `1` = this week is the upload target for ACR-005 and instructor imports. At most one row should be `1`; toggled via `POST /set-prep-week`. When set, the Master Schedule, Audit Roster, and exports also reflect this week. |

---

## CounselorWeekAttributes

Week-specific scheduling attributes for each counselor. The scheduler always reads from here, not from `Counselors`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `CounselorID` | INTEGER | PK part, FK → `Counselors` ON DELETE CASCADE | |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 | |
| `HomeGroupColor` | TEXT | | |
| `ScheduleType` | TEXT | | `All Sports`, `All Enrichment`, `AM Sports / PM Enrichment`, `AM Enrichment / PM Sports` |
| `BusRoute` | TEXT | | |
| `ExtendedHours` | TEXT | | |
| `SpecialtyGroup` | TEXT | **[migrated]** | Used for SPLIT/specialty counselor grouping |
| `isWorkingThisWeek` | INTEGER | DEFAULT `1` | **[migrated]** — `0` = counselor is not present this week; excluded from all scheduler dropdowns and auto-assignment passes. Defaults to `1` (working). Set via the **Working** checkbox in the Counselor Scheduling page. |
| `ScheduleTypeManual` | INTEGER | DEFAULT `0` | **[migrated]** — `1` = the schedule type was set by hand in the scheduler UI. Full Auto Build treats it as fixed and reshuffles everyone else around it. Cleared by blanking the schedule-type dropdown. |

---

## CounselorWeekSchedules

Week-specific period assignments for counselors (output of the counselor scheduler).

| Column | Type | Constraints |
|---|---|---|
| `CounselorID` | INTEGER | PK part, FK → `Counselors` ON DELETE CASCADE |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 |
| `PeriodNumber` | INTEGER | PK part, CHECK 1–6 |
| `ActivityName` | TEXT | NOT NULL |

---

## StaffWeekSchedules

Full-summer period assignments for instructors and unit leaders. Populated via the Faculty Full Summer upload.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `StaffID` | INTEGER | PK part, FK → `Counselors.CounselorID` ON DELETE CASCADE | Name is legacy; references Counselors |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 | |
| `PeriodNumber` | INTEGER | PK part, CHECK 1–6 | |
| `ActivityName` | TEXT | NOT NULL | |
| `Location` | TEXT | | |

---

## WeeklyOfferings

Per-week list of class offerings used to populate the counselor scheduler.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `OfferingID` | INTEGER | PK, AUTOINCREMENT | |
| `ActivityName` | TEXT | NOT NULL | |
| `PreliminaryEnrollment` | INTEGER | DEFAULT `0` | Used to calculate slot counts |
| `SideOfCamp` | TEXT | | |
| `PeriodNumber` | INTEGER | **[migrated]** | Clock block 1–6 |
| `WeekNumber` | INTEGER | **[migrated]**, DEFAULT `1` | |
| `MaxCapacity` | INTEGER | **[migrated]** | |
| `Location` | TEXT | **[migrated]** | |
| `AllowedGroups` | TEXT | **[migrated]** | |

---

## CounselorScheduleAssignments

Final counselor-to-class slot assignments. Written by the scheduler save action.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `AssignmentID` | INTEGER | PK, AUTOINCREMENT | |
| `WeekNumber` | INTEGER | NOT NULL, DEFAULT `1` | **[migrated]** |
| `PeriodNumber` | INTEGER | NOT NULL | |
| `ActivityName` | TEXT | NOT NULL | |
| `PersonID` | INTEGER | NOT NULL | `CounselorID` or `StaffID` |
| `PersonType` | TEXT | CHECK `Counselor`, `Staff`, `Instructor` | |
| UNIQUE | | `(WeekNumber, PeriodNumber, PersonID, PersonType)` | |

---

## CounselorScheduleBackups

Named JSON snapshots of the counselor assignment state.

| Column | Type | Notes |
|---|---|---|
| `BackupID` | INTEGER PK | |
| `WeekNumber` | INTEGER | |
| `Label` | TEXT | Admin-provided name |
| `CreatedAt` | DATETIME | |
| `AssignmentsJSON` | TEXT | Full serialized assignment state |

---

## CounselorPreferences

Counselor activity preferences, used by the auto-scheduler to influence assignments.

| Column | Type | Notes |
|---|---|---|
| `CounselorID` | INTEGER PK, FK → `Counselors` ON DELETE CASCADE | |
| `HomeGroupPreference` | TEXT | |
| `SchedulePreference` | TEXT | |
| `ActivityPreferences` | TEXT | JSON array of preferred activity names |
| `SubmittedAt` | DATETIME | |

---

## CamperHomeGroups

Week-specific assignment of a camper to a counselor's home group.

| Column | Type | Constraints |
|---|---|---|
| `CamperID` | INTEGER | PK part, FK → `Campers` |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 |
| `CounselorID` | INTEGER | FK → `Counselors` |

---

## Attendance

Attendance marks across all roster types.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `AttendanceID` | INTEGER | PK, AUTOINCREMENT | |
| `Date` | TEXT | NOT NULL | ISO date string |
| `CamperID` | INTEGER | NOT NULL, FK → `Campers` | |
| `SessionType` | TEXT | NOT NULL | `homegroup`, `class`, `bus`, `extended`, `specialty`, `late-arrival` |
| `PeriodNumber` | INTEGER | NOT NULL, DEFAULT `0` | `0` for non-class sessions |
| `ActivityName` | TEXT | NOT NULL, DEFAULT `''` | Empty for non-class sessions |
| `Status` | TEXT | NOT NULL, DEFAULT `'present'` | `present` or `absent` |
| `Notes` | TEXT | | |
| `MarkedAt` | DATETIME | | |
| `MarkedBy` | TEXT | **[migrated]** | |
| UNIQUE | | `(Date, CamperID, SessionType, PeriodNumber, ActivityName)` | |

---

## EarlyDismissals

Records a camper being dismissed early on a given date.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `DismissalID` | INTEGER | PK, AUTOINCREMENT | |
| `Date` | TEXT | NOT NULL | |
| `CamperID` | INTEGER | NOT NULL, FK → `Campers` | |
| `DismissalTime` | TEXT | | |
| `Notes` | TEXT | | |
| `CreatedAt` | DATETIME | | |
| `MarkedBy` | TEXT | **[migrated]** | |
| UNIQUE | | `(Date, CamperID)` | One dismissal per camper per day |

---

## ScheduledPickups

Pre-scheduled pickup times entered before the dismissal occurs.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `PickupID` | INTEGER | PK, AUTOINCREMENT | |
| `Date` | TEXT | NOT NULL | |
| `CamperID` | INTEGER | NOT NULL, FK → `Campers` | |
| `PickupTime` | TEXT | NOT NULL | |
| `Notes` | TEXT | | |
| `CreatedBy` | TEXT | | |
| `CreatedAt` | DATETIME | | |
| `PeriodNumber` | INTEGER | **[migrated]** | Which period the pickup falls during |
| UNIQUE | | `(Date, CamperID)` | |

---

## NurseLog

Nurse station visit records.

| Column | Type | Notes |
|---|---|---|
| `VisitID` | INTEGER PK | |
| `Date` | TEXT | |
| `CamperID` | INTEGER, FK → `Campers` | |
| `CheckInTime` | TEXT | |
| `CheckOutTime` | TEXT | NULL = still checked in |
| `Notes` | TEXT | |
| `Dismissed` | INTEGER | `1` = camper was sent home from nurse |
| `CreatedBy` | TEXT | |

---

## CaseLog

Detailed incident case tracking. Same structure as `NurseLog` but for more significant cases requiring documentation.

| Column | Type | Notes |
|---|---|---|
| `VisitID` | INTEGER PK | |
| `Date` | TEXT | |
| `CamperID` | INTEGER, FK → `Campers` | |
| `CheckInTime` | TEXT | |
| `CheckOutTime` | TEXT | |
| `Notes` | TEXT | |
| `Dismissed` | INTEGER | |
| `CreatedBy` | TEXT | |

---

## ScheduleChanges

Log of camper class swaps (swap tool activity). Cleared to archive periodically.

| Column | Type | Notes |
|---|---|---|
| `ChangeID` | INTEGER PK | |
| `CamperID` | INTEGER, FK → `Campers` | |
| `CamperName` | TEXT | Denormalized for display without join |
| `ColorGroup` | TEXT | |
| `PeriodNumber` | INTEGER | |
| `OldActivity` | TEXT | |
| `NewActivity` | TEXT | |
| `ChangedAt` | DATETIME | |

---

## ScheduleChangesArchive

Archived swap log entries. Same schema as `ScheduleChanges` plus `ArchivedAt`.

| Column | Type | Notes |
|---|---|---|
| `ChangeID` | INTEGER PK | |
| `CamperID` | INTEGER | |
| `CamperName` | TEXT | |
| `ColorGroup` | TEXT | |
| `PeriodNumber` | INTEGER | |
| `OldActivity` | TEXT | |
| `NewActivity` | TEXT | |
| `ChangedAt` | DATETIME | |
| `ArchivedAt` | DATETIME | |

---

## Waitlists

Campers waiting to be placed into a full activity.

| Column | Type | Notes |
|---|---|---|
| `WaitlistID` | INTEGER PK | |
| `CamperID` | INTEGER, FK → `Campers` | |
| `PeriodNumber` | INTEGER | |
| `RequestedActivity` | TEXT | |
| `TimeOfDay` | TEXT | `AM` or `PM` |
| `Timestamp` | DATETIME | |
| `WeekNumber` | INTEGER | Week the request was made in. The Promotions page only shows entries where this matches the active week, so requests from a finished week stop appearing once the week rolls over. |

---

## SplitFieldTrip

Flags a date as a SPLIT field trip day. Single-column truth table.

| Column | Type | Notes |
|---|---|---|
| `Date` | TEXT PK | ISO date |
| `MarkedAt` | DATETIME | |

---

## HubContent

Key/value store for editable hub page text blocks.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `'announcement'` or `'director_notes'` |
| `content` | TEXT | Markdown/plain text |
| `updatedAt` | DATETIME | |

---

## DirectorNotes

Timestamped director note entries shown on the admin hub.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `body` | TEXT | |
| `author` | TEXT | DEFAULT `'Admin'` |
| `category` | TEXT | **[migrated]** — `director` (default), `camper`, `staff`, `timesheet` |
| `createdAt` | DATETIME | |

---

## PhotoSubmissions

Photo of the Day uploads.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `date` | TEXT | |
| `counselorName` | TEXT | |
| `imageUrl` | TEXT | |
| `submittedAt` | DATETIME | |

---

## PhotoVotes

Staff votes on Photo of the Day submissions.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `photoId` | INTEGER, FK → `PhotoSubmissions.id` | |
| `voterName` | TEXT | **[migrated]** |
| `voteDate` | TEXT | **[migrated]** |
| `votedAt` | DATETIME | |

---

## AdminUsers

Allowlist of admin user names. Checked against the login form.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | UNIQUE |

---

## PdfDocuments

Stores uploaded PDF files as BLOBs so they persist across server restarts without relying on the filesystem.

| Column | Type | Notes |
|---|---|---|
| `slug` | TEXT PK | Identifies the document type (e.g. `camper-notes`, `enrichment-map`) |
| `filename` | TEXT | Original filename at upload time |
| `data` | BLOB | Raw PDF bytes |
| `uploadedAt` | DATETIME | |

On first startup after this table was added, any existing PDFs in `uploads/` are automatically migrated into this table and removed from disk.

---

## AppConfig

General key/value store for persistent server configuration. Currently used to store VAPID keys for web push notifications so they survive redeploys.

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | Configuration key (e.g. `vapidPublicKey`, `vapidPrivateKey`) |
| `value` | TEXT | Configuration value |

VAPID keys are auto-generated on first startup and stored here. They are reloaded on subsequent startups so push subscriptions remain valid.

---

## PushSubscriptions

Web Push API subscriptions for counselor attendance nudge notifications.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `CounselorID` | INTEGER | FK → `Counselors.CounselorID` |
| `endpoint` | TEXT | UNIQUE — push service endpoint URL |
| `subscription` | TEXT | Full serialized push subscription object (JSON) |
| `CreatedAt` | DATETIME | |

One row per browser/device. If a push send fails with 410 or 404 (subscription expired/unsubscribed), the row is automatically deleted.

---

## AlertGroups

Named targeting groups for Instant Alerts. System groups (`isSystem=1`) are seeded at startup and resolved dynamically at send-time; they cannot be deleted. Custom groups (`isSystem=0`) have explicit member lists stored in `AlertGroupMembers`.

| Column | Type | Notes |
|---|---|---|
| `GroupID` | INTEGER PK | |
| `name` | TEXT | UNIQUE |
| `isSystem` | INTEGER | `1` = built-in system group, `0` = admin-created custom group |
| `createdAt` | DATETIME | |

**System groups:** All Counselors · All Unit Leaders · All Admin · All AM Sports · All PM Sports · All AM Enrichment · All PM Enrichment

---

## AlertGroupMembers

Junction table linking custom `AlertGroups` to their member `Counselors`. Not used for system groups (those are resolved from live data at send time).

| Column | Type | Notes |
|---|---|---|
| `GroupID` | INTEGER PK | FK → `AlertGroups.GroupID` ON DELETE CASCADE |
| `CounselorID` | INTEGER PK | FK → `Counselors.CounselorID` ON DELETE CASCADE |

---

## AlertLog

Audit log of every sent Instant Alert.

| Column | Type | Notes |
|---|---|---|
| `AlertID` | INTEGER PK | |
| `message` | TEXT | The alert text (max 200 chars) |
| `targetLabel` | TEXT | Human-readable target: group name or counselor full name |
| `sentBy` | TEXT | `adminName` cookie value at time of send |
| `sentAt` | DATETIME | |
| `deliveryCount` | INTEGER | Number of push subscription endpoints the message was dispatched to |
| `showAdminBanner` | INTEGER | `1` = also show a persistent banner on the admin hub for all admins currently logged in |

---

## AlertTargets

Junction table recording which individual counselors were targeted by each alert. Used to route the admin hub banner only to the counselors the alert was sent to.

| Column | Type | Notes |
|---|---|---|
| `AlertID` | INTEGER PK | FK → `AlertLog.AlertID` ON DELETE CASCADE |
| `CounselorID` | INTEGER PK | FK → `Counselors.CounselorID` ON DELETE CASCADE |

---

## BuildingCoordinates

Pixel coordinates for building pins on the interactive camp map. Two maps are supported (`enrichment` and `sports`). Coordinates are in natural image pixels with origin at the top-left corner.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `name` | TEXT | NOT NULL | Must match a `Location` value used in the schedule |
| `map` | TEXT | NOT NULL, DEFAULT `'enrichment'` | `enrichment` or `sports` |
| `x` | INTEGER | NOT NULL | Horizontal position in image pixels |
| `y` | INTEGER | NOT NULL | Vertical position in image pixels |
| UNIQUE | | `(name, map)` | |

Default coordinates for both maps are seeded (and re-applied via upsert) on every server start, so coordinate corrections in code take effect on next deploy. Managed via `POST /admin/building-coord` (upsert) and `POST /admin/delete-building-coord`.

---

## LockedOfferings

Server-side persistence for locked class offerings in the counselor scheduler. A locked offering is excluded from auto-build and rebuild passes. Previously lock state lived only in client-side JavaScript; this table makes locks survive page refreshes.

| Column | Type | Constraints |
|---|---|---|
| `WeekNumber` | INTEGER | PK part |
| `PeriodNumber` | INTEGER | PK part |
| `ActivityName` | TEXT | PK part |

Managed via `POST /api/toggle-lock`; read on page load via `GET /api/locked-offerings?week=N`.

---

## Swim Scheduling Tables

See [Swim Scheduling](./Swim-Scheduling.md) for the full feature. Independent of `CounselorWeekSchedules`/`WeeklyOfferings` by design.

### CamperSwimLevels

One row per camper per week — a snapshot of their tested swim level (`"Low 2"` / `"2"` / `"High 3"`), not a running log. A missing week means "unchanged since their last recorded level" (`getEffectiveSwimLevel()` walks backward to find it).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `CamperID` | INTEGER | PK part | FK → `Campers`, `ON DELETE CASCADE` |
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 | |
| `LevelNumber` | INTEGER | CHECK 1–6 | |
| `SubLevel` | TEXT | CHECK `'Low'`/`'High'` or NULL | NULL = plain level |
| `UpdatedAt` | DATETIME | DEFAULT `CURRENT_TIMESTAMP` | |

### SwimLessonGroups / SwimLessonGroupMembers

One `SwimLessonGroups` row per skill-level lesson group per period per week, auto-formed by `generateGroupsForWeek()` and hand-editable. Membership is a separate join table so campers can move between groups without recreating the group row.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `GroupID` | INTEGER | PK, AUTOINCREMENT | |
| `WeekNumber` | INTEGER | NOT NULL, CHECK 1–6 | |
| `PeriodNumber` | INTEGER | NOT NULL, CHECK 1–6 | |
| `LevelNumber` | INTEGER | NOT NULL, CHECK 1–6 | |
| `SubLevel` | TEXT | CHECK `'Low'`/`'High'` or NULL | Set only when this group is sub-level-specific (≥3 campers at that sub-level) |
| `CounselorID` | INTEGER | | Nullable until assigned. FK → `Counselors`, `ON DELETE SET NULL` |
| `Locked` | INTEGER | DEFAULT `0` | Protects the group from being rebuilt by Generate Groups |

`SwimLessonGroupMembers`: `(GroupID, CamperID)` composite PK, both FKs `ON DELETE CASCADE`.

### SwimGuardAssignments

Rec Swim lifeguards and the always-2 Swim Lessons pool guards — one row per counselor per period per week per role.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `WeekNumber` | INTEGER | PK part, CHECK 1–6 | |
| `PeriodNumber` | INTEGER | PK part, CHECK 1–6 | |
| `GuardRole` | TEXT | PK part, CHECK `'Rec'`/`'Lessons'` | |
| `CounselorID` | INTEGER | PK part, NOT NULL | FK → `Counselors`, `ON DELETE CASCADE` |

---

## SpartanEvents

Definitions of events in the annual Spartan Games counselor competition. 12 events are seeded on first startup (when the table is empty); editable by admin.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `name` | TEXT | NOT NULL | |
| `date` | TEXT | NOT NULL | Display date string, e.g. `7/23` |
| `block` | TEXT | NOT NULL | Block name, e.g. `Lunch`, `Big Game`, `Dismissal` |
| `participant_count` | INTEGER | NOT NULL, DEFAULT `1` | `1` = solo event; `>1` = group event requiring partner selection |
| `subtext` | TEXT | | **[migrated]** — optional description shown below the event name on the signup form |
| `enforce_gender_ratio` | INTEGER | NOT NULL, DEFAULT `0` | **[migrated]** — `1` = groups signed up for this event are validated against `min_male`/`min_female` |
| `min_male` | INTEGER | NOT NULL, DEFAULT `0` | **[migrated]** — minimum male counselors required per group when `enforce_gender_ratio` is `1` |
| `min_female` | INTEGER | NOT NULL, DEFAULT `0` | **[migrated]** — minimum female counselors required per group when `enforce_gender_ratio` is `1` |

---

## SpartanSignups

Records of counselor registrations for Spartan Games events.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `event_id` | INTEGER | NOT NULL, FK → `SpartanEvents.id` ON DELETE CASCADE | |
| `participants` | TEXT | NOT NULL | JSON array of participant full names, sorted alphabetically (e.g. `["Alice Smith","Bob Jones"]`). Sorting makes order-insensitive group comparison possible with a simple string equality check. |

Signups are not blocked at submission time for failing gender-ratio requirements. Instead, on every page load each group is checked against its event's `enforce_gender_ratio`/`min_male`/`min_female` (using `Counselors.Gender`) and flagged invalid if the minimums aren't met — this flag drives the warning badges shown to admins and the registered counselor, but does not remove the signup.

---

## SpartanGamesMeta

Single-row configuration table for Spartan Games global settings.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, CHECK(`id = 1`) | Always exactly one row |
| `submissions_open` | INTEGER | NOT NULL, DEFAULT `1` | `1` = signups are open; `0` = closed. When closed, counselors can view the form and existing registrations but cannot submit new entries. |

Toggled via `POST /admin/spartan-games/toggle-submissions`.

---

## TalentSubmissions

One row per counselor talent show submission per week. Resets visually when the week rolls over (old rows are retained but filtered out by `week_number`).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `counselor_id` | INTEGER | | FK → `Counselors.CounselorID` (soft reference) |
| `counselor_name` | TEXT | NOT NULL | Name snapshot at time of submission |
| `description` | TEXT | NOT NULL | Brief act description (max 200 chars) |
| `week_number` | INTEGER | NOT NULL | Active week at submission time |
| `status` | TEXT | NOT NULL, DEFAULT `'pending'` | `pending`, `approved`, or `denied` |
| `submitted_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | |

Counselors may re-submit to update their description (status resets to `pending`). Managed via `POST /talent-show/submit`, `POST /admin/talent-show/review`, and `POST /admin/talent-show/delete`.

---

## TalentMeta

Single-row config table for the Counselor Talent Show submissions state.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PK, CHECK(`id = 1`) | Always exactly one row |
| `submissions_open` | INTEGER | NOT NULL, DEFAULT `0` | `1` = open, `0` = closed |

Toggled via `POST /admin/talent-show/toggle-submissions`. Automatically reset to `0` on week rollover.
