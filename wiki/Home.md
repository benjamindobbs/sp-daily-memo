# Camp Hub — Technical Wiki

Developer reference for the Camp Hub application. Covers the database schema, table relationships, route inventory, and system architecture.

---

## Wiki Pages

| Page | What it covers |
|---|---|
| [Database Schema](./Database-Schema.md) | Every table: columns, types, constraints, default values |
| [Data Model & Relationships](./Data-Model.md) | How tables reference each other; foreign keys; ER overview |
| [People & Roles](./People-and-Roles.md) | `Counselors`, `Campers`, `Staff` (legacy); `StaffRole` values; color groups; week-scoped attribute tables |
| [Scheduling System](./Scheduling-System.md) | `Activities`, `Schedules`, `WeeklyOfferings`, `CounselorScheduleAssignments`, `CounselorWeekSchedules`; how the auto-builder works |
| [Sessions & Weeks](./Sessions-and-Weeks.md) | `Sessions` table; active/released flags; week-scoped tables; multi-week design |
| [Attendance & Health](./Attendance-and-Health.md) | `Attendance`, `EarlyDismissals`, `ScheduledPickups`, `NurseLog`, `CaseLog`, `SplitFieldTrip` |
| [Routes Reference](./Routes-Reference.md) | All Express routes organized by domain; method, path, auth requirement, what it reads/writes |
| [Authentication & Authorization](./Auth.md) | Admin vs staff view; session cookie; `ADMIN_ONLY_PREFIXES`; `choose-view` flow |
| [Data Import Pipeline](./Data-Import.md) | CSV import order; column mappings; what each import creates or updates; migration history |
| [Instant Alerts](./Instant-Alerts.md) | Sending push notifications to staff groups or individuals; system groups; custom groups; admin hub banner; push subscription setup |

---

## Architecture at a Glance

**Stack:** Node.js + Express · EJS templates · SQLite via `better-sqlite3` · served on Fly.io

**Single file entry point:** `app.js` — schema initialization, all migrations, and all route handlers live here.

**Database file:** `camp.db` (SQLite). No ORM; queries are raw `better-sqlite3` prepared statements.

**Views:** `views/*.ejs` — server-rendered. No client-side routing. JavaScript in views is mostly progressive enhancement (filtering, drag-and-drop, live counters).

**Auth model:** Cookie-based. `viewMode` is stored in the session (`req.session.viewMode`) and exposed to every template via `res.locals`. Admin-only routes are guarded by a prefix list (`ADMIN_ONLY_PREFIXES`) checked in middleware.

**PDF uploads:** Files are stored as `uploads/<slug>.pdf`. Serving and uploading go through `/pdf/:type` and `/upload-pdf/:type`. The `PDF_DOCS` constant in `app.js` is the single source of truth for which files are valid.

---

## Key Domain Concepts

**Color groups** — every camper and main counselor belongs to one: `Red`, `Carolina`, `Green`, `Navy`, `LilPlace`, `KinderPlace`, `SPLIT`, `SPRC`, `Swim`. The first four are the "main" groups. The last five are specialty programs.

**Clock blocks** — periods are stored as integers 1–6 representing the day's six activity blocks. Red/Carolina and Green/Navy groups swap sides of camp at block 3/4, so "period 3" means different things for each side. See [Scheduling System](./Scheduling-System.md) for the mapping.

**Active week** — only one `Sessions` row has `isActive=1` at a time. Attendance, counselor scheduling, and offerings all operate against the active week. The admin can change which week is active from Settings.

**Counselors table is the unified people table** — what used to be split between `Counselors` and `Staff` was consolidated into `Counselors` with a `StaffRole` column. The legacy `Staff` table still exists but is no longer written to; a one-time migration moved all rows into `Counselors`.

---

## Files in This Wiki

```
wiki/
├── Home.md                    ← this file
├── Database-Schema.md         ← table-by-table column reference
├── Data-Model.md              ← relationships and ER overview
├── People-and-Roles.md        ← people tables and role system
├── Scheduling-System.md       ← scheduling pipeline end-to-end
├── Sessions-and-Weeks.md      ← multi-week design
├── Attendance-and-Health.md   ← attendance and health tables
├── Routes-Reference.md        ← full route inventory
├── Auth.md                    ← auth and view mode system
├── Data-Import.md             ← CSV imports and migrations
└── Instant-Alerts.md          ← push notifications and admin banner
```
