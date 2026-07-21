# People & Roles

How people are stored, categorized, and used across the system.

---

## The Counselors Table is the Unified People Table

All staff — counselors, instructors, unit leaders, directors — live in `Counselors`. The legacy `Staff` table still exists in the schema but is no longer written to. A one-time startup migration copied all `Staff` rows into `Counselors` and retypes any `Schedules` rows from `PersonType='Staff'` to `PersonType='Instructor'`.

---

## StaffRole Values

The `Counselors.StaffRole` column determines how a person is classified. The system treats these as two buckets:

**Main counselors** — eligible for class slot assignments in the scheduler:
- `Counselor`
- `Swim Counselor`

**Specialty / leadership** — not placed into class slots by the auto-scheduler:
- `Unit Leader`
- `Sports Leader`
- `Instructor`
- `Director`

> The page-level JavaScript constant `MAIN_COUNSELORS` in `counselor-scheduling.ejs` is filtered to exclude specialty roles. See [Scheduling System](./Scheduling-System.md).

---

## Color Groups

Every camper and main counselor is assigned to a color group. There are two tiers:

**Main groups** — standard activity rotation:

| Group | Side rotation |
|---|---|
| `Red` | Periods 1–3 Enrichment, Periods 4–6 Sports |
| `Carolina` | Same as Red |
| `Green` | Periods 1–3 Sports, Periods 4–6 Enrichment |
| `Navy` | Same as Green |

**Specialty groups** — separate programs, not on the main rotation:

| Group | Program |
|---|---|
| `LilPlace` | Li'l Place early childhood program |
| `KinderPlace` | KinderPlace kindergarten program |
| `SPLIT` | SPLIT specialty schedule |
| `SPRC` | SPRC specialty group |
| `Swim` | Swim team / specialist |

---

## Camper Records

Each camper has one row in `Campers`. Key fields:

- **`HomeGroupColor`** — determines which activity rotation the camper follows and which attendance sheets they appear on.
- **`HomeGroupCounselorID`** — soft reference to their home group counselor (not a hard FK; can be NULL). This is the default assigned counselor but may not reflect the current week's assignment — `CamperHomeGroups` is the authoritative week-specific assignment.
- **`BusRoute`** — string route identifier (e.g. `"3"`, `"12A"`). NULL = no bus.
- **`ExtendedHours`** — `AM`, `PM`, `AM+PM`, or NULL.
- **`CampLunch`** — `No – Packed`, `Yes`, `Allergy Meal`.

---

## Week-Scoped Counselor Attributes

Counselor attributes that can change week to week are stored in `CounselorWeekAttributes`, not on the `Counselors` row. This table is the authoritative source for the scheduler and all display logic:

| Attribute | What it controls |
|---|---|
| `HomeGroupColor` | Which group's activities the counselor is assigned to |
| `ScheduleType` | Which periods are eligible (see [Scheduling System](./Scheduling-System.md)) |
| `BusRoute` | Counselor's bus assignment for the week |
| `ExtendedHours` | Extended care duty |
| `SpecialtyGroup` | SPLIT/specialty grouping when applicable |

When a counselor profile is edited (`POST /update-staff-info/:id`), both `Counselors` (base record) and `CounselorWeekAttributes` are updated. The week-attributes row targets the same week the profile page displays: the prep target week for admins when one is set, otherwise the active week.

---

## Home Group Assignment

A camper is linked to a counselor for a given week via `CamperHomeGroups`:

```
CamperHomeGroups (CamperID, WeekNumber) → CounselorID
```

This is separate from `Campers.HomeGroupCounselorID`. The `HomeGroupAssignment` page (`/homegroup-assignment`) manages these records and can mirror one week's assignments to another.

---

## IncludeInStaffDropdown

`Counselors.IncludeInStaffDropdown` (default `0`) gates whether a counselor appears in the home counselor dropdown on camper profile pages. Setting this to `1` makes the counselor selectable as a camper's home group leader.

---

## Counselor Preferences

`CounselorPreferences` stores one row per counselor with:
- `HomeGroupPreference` — text
- `SchedulePreference` — text
- `ActivityPreferences` — JSON array of activity name strings (e.g. `["Soccer","Basketball"]`)

The auto-scheduler uses `ActivityPreferences` as a tiebreaker when two eligible counselors have equal assignment counts: preferred activities are deprioritized from the opposite-block exclusion check.

`Swim Counselor`s only submit `ActivityPreferences` (class preferences) via `/counselor-preferences` — the Home Group and Schedule Type sections are hidden for that role since swim staff don't have a home group or a Sports/Enrichment schedule type. `HomeGroupPreference`/`SchedulePreference` stay `NULL` for their row.

---

## Staff Directory vs Counselor Profiles

`/counselor-directory` — lists all counselors grouped by role; names always link to individual profile pages. Open to both admin and staff view (linked from the Staff Hub nav as **Staff Directory**); the page itself has no write actions, and edit/delete routes stay behind `ADMIN_ONLY_PREFIXES` regardless of who can browse the directory.

`/counselor-profile/:id` — shows full detail for one counselor:
- In **staff view**: read-only profile, schedule, and home group roster.
- In **admin view**: adds the Edit Profile form (all 9 fields) and, for Instructors/Unit Leaders, a Weekly Schedule editor.

Deleting a counselor (`POST /delete-counselor/:id`) removes the `Counselors` row; CASCADE deletes propagate to `CounselorWeekAttributes`, `CounselorWeekSchedules`, `StaffWeekSchedules`, and `CounselorPreferences`.
