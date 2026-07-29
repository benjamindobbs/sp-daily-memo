# Camp Hub — Admin User Manual

## Table of Contents

- [Quick Reference](#quick-reference)
  - [Importing Data](#importing-data)
  - [Faculty Full Summer — Multi-Week Setup](#faculty-full-summer--multi-week-setup)
  - [Session Management & Active Weeks](#session-management--active-weeks)
  - [Counselor Scheduling](#counselor-scheduling)
  - [Swim Scheduling](#swim-scheduling)
  - [Coverage](#coverage)
  - [Editing Campers & Staff Profiles](#editing-campers--staff-profiles)
  - [Attendance Sheet Symbols](#attendance-sheet-symbols)
- [Feature Map](#feature-map)
  - [Hub](#hub)
  - [Schedule & Lookup](#schedule--lookup)
  - [Scheduling Tools](#scheduling-tools)
  - [Attendance](#attendance)
  - [Dismissals](#dismissals)
  - [Health](#health)
  - [Settings & Data Management](#settings--data-management)
  - [Other Admin Tools](#other-admin-tools)
- [Staff: Setting Up Notifications](#staff-setting-up-notifications)

---

## Quick Reference

### Importing Data

All imports happen on the **Settings** page (`/settings`).

> **Import order is required.** Camper data depends on staff existing first, and the Master Camper Schedule import depends on the Camper Roster existing first. Always follow this sequence:
>
> **All Staff → Camper Roster → Master Camper Schedule (ACR-255)**
>
> Instructor Schedules can be uploaded any time after staff are imported.

**Full setup sequence for a new session:**

1. Import Activities (CSV bulk upload or add individually in the Activity Manager)
2. **Import All Staff Roster**
3. **Import Camper Roster** (ACR-005 report)
4. **Import Master Camper Schedule (ACR-255)** (enriches campers with grade, bus, extended hours, activity schedule)
5. Set the target week as **Active**
6. **Sync** offerings from the imported schedule (or upload a Weekly Offerings CSV)
7. Build the counselor schedule
8. Import Instructor Schedules when ready (uploads to the active week)

**CSV formats:**

| Upload | Required Columns | Notes |
|---|---|---|
| Activities | `Name`, `SideOfCamp`, `MaxCapacity`, `AllowedGroups` | `AllowedGroups`: `Red`, `Carolina`, `Red-Carolina`, `Green-Navy`, or blank for all |
| All Staff | `Name` (Last, First), `Positions`, `Camp` | Handles all roles. Home group color is set in the Schedule Builder, not here. |
| Staff Contact Info (CSR-300) | CSR-300: Staff Profile export from camp management | Not a normal tabular CSV — one vertical block per staff member. Matches each block to an existing staff member by full name and fills in their phone number (prefers Cell/Mobile over Home/Work when a person lists more than one). Only updates staff who already exist; never creates new records, so run **after** All Staff import. |
| Camper Roster (ACR-005) | ACR-005 export from camp management | Creates/updates: name, color group, lunch, shirt size, extended hours (when the export's Ext AM/PM columns are populated — the source for specialty campers, who aren't on ACR-255), registered session codes (drives the Monday shirt-order pills). Must run **after** staff import. **In CB:** Select All Seasons → add Session filter → select relevant weeks for all specialty camps and main camp → Run report as CSV. If a **Prep Target** week is set in Session Management, the upload goes to that week instead of the active week. |
| Master Camper Schedule (ACR-255) | ACR-255 export from camp management | Enriches existing campers with: grade, bus route, extended hours, activity schedule. Must run **after** camper roster import. **In CB:** Select All Seasons → add Session filter → select all SP W[X] - Period sessions (Periods 1–5) → Run report as CSV. Covers Summer Place campers only — KP/LP extended hours come from the ACR-003 import below. |
| KP/LP Schedule Types (ACR-003) | ACR-003 Group Attendance Sheet with KP/LP | Sets each Kinder Place / Li'l Place camper's **Full Day / Half Day** schedule type and extended hours for the selected week. Half Day campers get their own Specialty Half Day attendance sheet and are excluded from PM specialty rosters. Must run **after** camper roster import. **In CB:** filter Session to the KP and LP weeks for the target week → Run report as CSV. |
| Swim Levels | Group Attendance Sheet with Swim Level export from camp management | Matches campers by name and records their swim level (e.g. `2`, `Low 2`, `High 3`) for the selected week. Blank levels (not yet tested) are skipped. Only updates campers who already exist, so run **after** camper roster import. Levels can also be edited by hand at `/swim-levels`. |
| ICP Notes | ICP Notes (Health Care Need / Plan for Care) export from camp management | Matches campers by name; shows a red &#9877; ICP flag on their attendance rows and profile. Not week-scoped — each import **fully replaces** the previous set, so a resolved note disappears rather than lingering. |
| Camper Notes | Camper Notes (behavioral/social) export from camp management | Same matching and full-replace behavior as ICP Notes, shown as a separate purple &#128221; Note flag. A camper can have both an ICP note and a Camper Note at once. |
| Instructor Schedules | `FirstName`, `LastName`, `P1`–`P6`, `L1`–`L6` | Locations (`L1`–`L6`) are optional. Unknown names are auto-created as Instructors. Uploads to the **Prep Target** week if one is set, otherwise to the active week. |

#### Bus routes & the Bus Route Audit

Bus assignment is read from two reports:

- **Main camp** (Red/Carolina/Green/Navy) carries its real bus number on **ACR-255** — that's the source of truth for their route. (Even if their ACR-005 shows "No Bus Selected," they still ride; only an explicit "No Bus N AM/PM" takes them off that direction.)
- **Specialty camp** (KinderPlace, Li'l Place, SPLIT, SPRC, Robotics) isn't on ACR-255, so their route comes from the ACR-005 bus **stop name**.

Most specialty stops map cleanly to a bus, but two are ambiguous: **West Hartford** (Bus 2 or 5) and **Wolcott Park / Bishops Corner** (Bus 3 or 4). Those campers are parked with no route until you resolve them in **Settings → Bus Route Audit** (`/bus-audit`), which lists them in two sections with a dropdown to pick the bus. Run the audit after each ACR-005 re-import.

**New: AM/PM Bus Attendance imports (ACR-132 / ACR-133).** These reports list every camper under their actual **Bus N** section, so the route and ride direction are unambiguous — no audit needed. Import **ACR-132 (AM Bus)** and **ACR-133 (PM Bus)** from Settings after the roster import; each sets every camper's route plus that direction's ride flag. This is a newer path being trialed alongside the ACR-005/255 bus handling.

---

### Faculty Full Summer — Multi-Week Setup

The **Faculty Full Summer** view (`/faculty-summer`) is used to load instructor and unit leader schedules for every week of camp in one place, independent of the active-week setting.

**When to use it:** Upload all six weeks of instructor/faculty assignments at the start of the summer so staff can view their schedule week-by-week from their profile page. The per-week data stored here is separate from the active-week instructor data used by Counselor Scheduling.

**CSV format:**

```
FirstName, LastName, P1, L1, P2, L2, P3, L3, P4, L4, P5, L5, P6, L6
```

- `P1`–`P6` = activity name for each period
- `L1`–`L6` = location for each period (optional)
- Uploading a week **replaces all existing data** for that week — uploading the same week twice is safe and will overwrite, not duplicate

**Workflow:**

1. Go to **Full Summer** (`/faculty-summer`) from the nav bar in Settings
2. Upload a CSV for each week (W1–W6) using the upload cards at the top of the page
3. Each card shows a count badge of how many staff records are loaded for that week
4. Staff schedules appear in the table below; use the **week selector dropdown** on each row to view that person's schedule for any uploaded week
5. To fix a mistake, re-upload the corrected CSV for that week, or use **Clear Week** to remove a week's data entirely

---

### Session Management & Active Weeks

Managed in **Settings → Session Management** (`/settings`).

The **Active Week** is the session all scheduling, attendance, and reporting tools operate against. Only one week is active at a time.

**Released** marks a week's counselor schedule as visible to staff.

| Action | What it does |
|---|---|
| **Set Active** | Makes this the current working week for all tools |
| **Release / Unrelease** | Toggles staff visibility of the week's counselor schedule |
| **Set Prep / Unset Prep** | Marks this week as the upload target for future ACR-005 and instructor imports. Only one week can be a prep target at a time; clicking again unsets it. The Master Schedule, Audit Roster, and CSV export also reflect this week when a prep target is set. |
| **Save** (floppy icon) | Saves the week label and start date |
| **Clear** | Removes all counselor scheduling data for that week |
| **Sync** | Rebuilds weekly offerings from the imported camper schedule data |

**Typical weekly workflow:**

```
Upload camper data → Set target week as Active → Sync offerings
→ Build counselor schedule → Save → Release
```

---

### Counselor Scheduling

The Schedule Builder is at `/counselor-scheduling`.

#### Key Concepts

**Sides of camp** — each period, camp splits into Sports and Enrichment:
- Red / Carolina groups: Periods 1–2 = Enrichment, Periods 3–6 = Sports
- Green / Navy groups: Periods 1–3 = Sports, Periods 4–6 = Enrichment

**Schedule Types** — controls which periods and side of camp a counselor is eligible for:

| Type | Assigned to |
|---|---|
| All Sports | All sports periods for their group |
| All Enrichment | All enrichment periods for their group |
| AM Sports / PM Enrichment | AM block = sports, PM block = enrichment |
| AM Enrichment / PM Sports | Reverse of above |
| AM Sports Only | Sports periods in the AM block only; unavailable in the PM |
| PM Sports Only | Sports periods in the PM block only; unavailable in the AM |
| AM Enrichment Only | Enrichment periods in the AM block only; unavailable in the PM |
| PM Enrichment Only | Enrichment periods in the PM block only; unavailable in the AM |
| *(blank)* | Auto-detected from group color (Red/Carolina → AM Enrichment/PM Sports, Green/Navy → AM Sports/PM Enrichment) |

**Build mode** — a **Preference Only / Full Auto** toggle above the build buttons controls how every build/rebuild/fill pass resolves an open slot: **Preference Only** fills it only with a counselor who listed that activity as a preference, leaving the slot empty if no one did; **Full Auto** falls back to any eligible counselor (preferred first) so every slot gets filled.

**Slots** — each offering has a slot count that auto-calculates from enrollment, using the **Slot Calculation Rules** panel above the build buttons: Sports slots start at a Min, add one more past an enrollment Threshold, then one more per additional block of campers (all three numbers are editable); Enrichment slots use a separate configurable minimum per home group color (Red, Carolina, RC, GN).

**Locked offerings** — lock (🔒) an offering to exclude it from every rebuild/auto-build/fill pass. Locks are saved to the server as you click them, so they survive a page refresh and are shared across anyone viewing the same week — not just a local, per-browser setting.

**Pinned schedule types** — click the 📌 next to a counselor's Schedule Type dropdown (or hand-edit the dropdown) to pin it against auto-build reshuffling; a pinned type is left alone by **Assign Schedule Types** and by Full Auto Build's automatic type pass. Under **Mirror from** (pick a source week), the **Migrate Pinned Types** button copies every pinned schedule type from that week onto counselors present in the current build who share a `CounselorID`, pinning them here too. Like the other Mirror buttons, this only updates the on-screen builder — click **Save Group Assignments** to persist it.

#### Build Workflow

1. Upload or Sync **Weekly Offerings** to populate the offerings list.
2. Adjust the **Slot Calculation Rules** panel if this week's defaults (Sports Min/Threshold/Per, per-color Enrichment minimums) don't fit.
3. Uncheck **Working** on any counselor row for staff who are out this week — they're excluded from every dropdown and auto-assignment pass.
4. Set **Schedule Types** — by hand in the counselor grid, with **Assign Schedule Types** (rescrambles every unpinned, non-"Only" type to match demand), or with **Infer Types from Schedule** (a repair tool that only fills *blank* dropdowns, read from each counselor's current class assignments). Pin (📌) or hand-edit any dropdown you want protected from being rescrambled.
5. Choose **Preference Only** or **Full Auto** in the Build mode toggle.
6. Click **Build Schedule** to run one assignment pass, or **⚡ Full Auto Build** to run the whole pipeline in one click: sync offerings, sync home group colors from the roster, fill any blank schedule types, build, run Fill Extras, and auto-save Group Assignments. Either way, **you still need to click Save Assignments afterward** — Full Auto Build only auto-saves the Group Assignments panel (home group/schedule type/bus/extended hours), not the per-class rosters.
7. Optionally use **Re-Build Sports** / **Re-Build Enrichment** to re-roll only one side.
8. **Lock** (🔒) individual offerings before a partial rebuild to preserve their assignments.
9. If other weeks exist, use the **Mirror from** tools to copy that week's data into this one: **Mirror Sports** / **Mirror Enrichment** (offering assignments), **Mirror UL/SL** (Unit Leader/Sports Leader assignments), **Migrate Pinned Types** (pinned schedule types), or **Mirror Locations (Sports)** (Sports class locations — saves to the database immediately, unlike the other Mirror buttons).
10. In the Counselor Group Assignments panel, **Auto Assign Homegroups** reshuffles home group color for counselors already marked Red/Carolina/Green/Navy, and **Sync Colors from Roster** updates each counselor's home group color to match who's actually on their camper roster.
11. Click **Save Assignments** to commit offering-level counselor/staff assignments, and **Save Group Assignments** to commit home group, schedule type, bus route, and extended hours — these are two separate saves covering different data.
12. Use **Clear All** or **Clear Counselors Only** (keeps Unit Leader/Sports Leader slots) to reset the week and start over.
13. **Backup** to create a named snapshot before making major changes.

#### Backups

Backups are managed at `/counselor-schedule-backups`. Each backup stores the full counselor assignment state for its week. Restoring overwrites the live schedule for that week.

#### Exports

**Counselor CSV** and **Staff CSV** buttons are on `/counselor-scheduling` itself; **Master Schedule CSV** is not linked from this page — it's under [Other Admin Tools](#other-admin-tools).

| Export | What's included | Notes |
|---|---|---|
| Counselor Schedule CSV | Per-counselor period assignments | Always exports the **Active** week, not whichever week you're currently editing on this page |
| Staff Schedule CSV | Instructor and unit leader assignments | Not week-scoped — pulls every saved instructor/UL assignment across all weeks |
| Master Schedule CSV | Full class-by-period view | Exports the Prep Target week if one is set, else Active |

---

### Swim Scheduling

Swim Counselors are staffed and tracked through two connected tools that are independent of the main Counselor Scheduling builder: **Swim Levels** (`/swim-levels`) records what each camper can swim, and **Swim Scheduling** (`/swim-scheduling`) staffs Rec Swim guards, Swim Lessons pool guards, and skill-level lesson groups. Neither shows up in Master Schedule, Attendance, or the staff Daily Assignments card — it's a fully separate schedule that only affects Swim Counselors.

#### Views

| Page | URL | Description |
|---|---|---|
| Swim Levels | `/swim-levels` | Editing page for camper swim levels. Campers currently enrolled in Rec Swim or Swim Lessons for the target week, grouped by period (each with its own show/hide section, Rec Swim then Swim Lessons within it), alphabetical within each group. Inline form to update each camper's level. Has a name filter that auto-expands the period containing a match. |
| Swim Levels Report | `/reports/swim-levels` | Printable version of the same roster (Settings → Print Reports), with a session picker so you can print any week's roster. |
| Swim Scheduling | `/swim-scheduling` | The staffing tool — lesson groups, guards, certifications, auto-assign, warnings. Reached from the **🏊 Swim Scheduling** nav link on `/counselor-scheduling`. See Major Functions below. |
| Swim Schedule Report | `/reports/swim-schedule` | Printable 2-page (AM/PM) staffing sheet, 3 columns (one per period): Rec Swim's full numbered camper list (flagging anyone not yet tested) and guards, each Lessons group's campers with their levels and instructor(s), and who's free to send to Sports that period. |

#### Key Concepts

**Swim level** — each camper's recorded ability (`Low`/`High` + Level 1–6), recorded per week. If a week has no update on file, the camper's level carries forward from the last week it was recorded.

**Swim certification** — each Swim Counselor's **Highest Swim Level Able to Teach** (1–6). Blank means levels 1–3 only, the default everyone can teach. Edit one counselor at a time on their profile, or bulk-edit every swim counselor at once with the collapsible **Edit Swim Certifications** panel on `/swim-scheduling`.

**Lesson groups** — skill-level groups capped at 5 campers each. A group of exactly 5 gets a second instructor slot. Groups can be **locked** to protect them from the next Generate Groups run, **split** if they grow past 5 (manual adds, a merge), or **merged** with an adjacent-level group to share one instructor (e.g. 2 kids at Level 5 + 1 at Level 6 taught together).

**Guards** — two separate roles per period, distinct from lesson-group instructors: Rec Swim lifeguards, and Swim Lessons pool guards (always needs 2).

**Also Scheduled / conflicts** — the water-time roster table's **Also Scheduled** column shows any Sports/Enrichment Schedule Type a swim counselor has been given on the main Counselor Scheduling page. A counselor with a schedule type like "AM Sports Only" is automatically treated as unavailable for swim during that half of the day: Full Auto Assign skips them for those periods, manual guard checklists and instructor dropdowns grey them out (dropdowns block picking them at all, same as being under-certified), and the warnings panel flags it if they're already assigned to swim duty during a period their schedule type says they shouldn't be.

**Send to Sports** — once a period's guards are met and every lesson group is instructed, leftover swim counselors surface in a **Send to Sports** box so they can be loaned out. Nobody's listed until the period's actual needs are covered.

#### Major Functions (`/swim-scheduling`)

| Function | What it does |
|---|---|
| **Generate Groups** | Auto-forms lesson groups from current effective swim levels, capped at 5 each. Locked groups are preserved; campers with no recorded level surface as "not yet in a group" instead of being silently dropped. |
| **Split** | Breaks a group that's grown past 5 back into groups of 5 or fewer. |
| **Merge** | Combines two small adjacent-level groups to share one instructor; the merged group is auto-locked so it survives the next Generate Groups run. A group that Full Auto Assign merged on its own (to free up a guard) can't be merged again in either direction — that was an automated last-resort decision, not something to build on further; groups merged by hand stay merge-able. |
| **Recent Merges / Undo** | A collapsible panel lists every merge (manual or automatic) not yet undone. **Undo** recreates the original group and moves back whichever campers are still in the merged group — instructor assignments aren't restored, since that person may have since been reassigned elsewhere. |
| **Assign instructor / camper** | Hand-edit any group's instructor slot(s) or membership directly. |
| **Save Guards** | Hand-edit the Rec Swim and Lessons pool guard checklists per period. |
| **Edit Swim Certifications** | Collapsible panel to bulk-edit every swim counselor's highest teachable level in one form. |
| **Full Auto Assign** | Fills every open guard slot and un-instructored group slot in one click — respecting each counselor's certified level, avoiding double-booking, balancing time between guarding (out-of-water) and teaching (in-water), fairly rotating early-morning guard duty week to week, honoring Also Scheduled conflicts, and staffing the hardest-to-fill high-level classes first so a highly-certified counselor doesn't get soaked up guarding while a high-level class goes unstaffed. If a guard slot still can't be filled, it'll try merging two small same-period classes (closest skill level first, only when the combined class stays small enough to still need one instructor) as a genuine last resort. Never touches anything already set by hand. |
| **Clear All Assignments** | Unassigns everyone for the week in one click (guards and both instructor slots on every group, including locked ones). Groups and campers aren't touched — just a clean slate to re-run Full Auto Assign or reassign by hand. |
| **Warnings panel** | Flags under-guarded periods, empty groups, oversized/under-instructed groups, a counselor teaching above their max level, Also Scheduled conflicts, and anyone double-booked. |
| **Print** | Opens the 2-page AM/PM printable staffing sheet (`/reports/swim-schedule`). |

Each period is its own show/hide section (click "Period N" to collapse/expand).

#### Workflow & Weekly Lifecycle

Every swim table is keyed by week number, same as `Sessions` — all six weeks' groups, guards, and levels coexist independently, so switching the app's active week elsewhere doesn't touch swim data. `/swim-scheduling` and both print reports have their own `?week=` session picker (defaulting to the Prep Target week if set, else the Active week); `/swim-levels` itself always shows the Prep Target-or-Active week only, with no separate selector.

For a given week:

1. **Import campers & staff** as usual (All Staff → Camper Roster → Master Camper Schedule) — Rec Swim/Swim Lessons enrollment comes from the same schedule import as any other class.
2. **Import or hand-enter swim levels** — Settings → CSV Data Imports → Swim Levels (must run after Camper Roster), or edit inline at `/swim-levels`.
3. **Set swim certifications** — per-profile, or in bulk via the Edit Swim Certifications panel on `/swim-scheduling`.
4. **Generate Groups** on `/swim-scheduling`.
5. **Hand-adjust** — merge, split, lock, or manually move campers as needed.
6. **Full Auto Assign** to fill guard and instructor slots.
7. **Manual touch-up** — guard checklists and instructor dropdowns stay hand-editable at any point (subject to the certification/Also Scheduled gates on instructor dropdowns).
8. **Review the warnings panel** and resolve anything flagged.
9. **Print** (`/reports/swim-schedule`, `/reports/swim-levels`) for distribution.
10. **Clear All Assignments** before re-running Full Auto Assign or reassigning by hand, if staffing changes mid-week.

Repeat steps 4–9 independently for each week — nothing carries forward automatically except swim levels themselves, which persist until a newer week's level is recorded.

---

### Coverage

The Coverage tool is at `/coverage` — use it when a counselor or staff member is out for the day and their classes need a temporary substitute. It never edits the underlying week schedule, so it reverts automatically once the covered day passes.

#### Workflow

1. Pick the **date** (defaults to today) and the **counselor/staff member who is out**.
2. One card appears per period they're assigned that week, showing their original class, everyone currently assigned to it (including the out counselor themself), and how many campers are enrolled.
3. For each period, either:
   - Check **"Skip this period"** if no coverage is needed, or
   - Pick a **covering counselor** from the dropdown. When covering a **Unit Leader**, the first two groups are **Unit Leaders** (every other Unit Leader) and, directly below, **Sports Leaders** — both listed ahead of the usual groups below. When covering an **Instructor**, the first group is **Instructors** — every other instructor who has at least one class scheduled this week (instructors with no classes at all this week aren't offered). The dropdown is then split into:
     - **Correct Side** — counselors already eligible for that class's Sports/Enrichment side that period
     - **Swim Counselors** — highlighted green if the Swim Scheduling page currently has them free ("Send to Sports")
     - **Opposite Side** — everyone else
   
   Every name in the dropdown shows what that counselor is **currently** assigned that period — their class name, how many other counselors are already on it, and how many campers are enrolled — so you can judge the cost of pulling them off it before picking them.
4. Click **Save Coverage**. A summary of the day's coverage (across every counselor who's out) appears above the form, with a **Remove** button on each entry.

#### Where the substitute shows up

Once saved, the covering counselor's name replaces the out counselor's for that specific date (tagged "covering for X") on: Class Roster, Master Schedule, the camper's own schedule, that day's Attendance sheet, and both counselors' Daily Assignments cards. It also appears in the covering counselor's own filtered Attendance view (Staff view, filtered to "my classes") alongside their normal classes, tagged with a green **Covering** badge — and if they also have their own normal class in that same period, that card is greyed out too and tagged **"Covering [class] this period"**, so there's only ever one obvious card to act on per period. On the out counselor's own filtered Attendance view, that same period's original class is greyed out and tagged **"Covered by X"** (or **"No coverage needed"** if the period was skipped instead of assigned). CSV exports and printable rosters are not affected — they reflect the static weekly plan.

---

### Editing Campers & Staff Profiles

All profile editing requires **admin view**. Staff view shows the same pages read-only.

#### Editing a Camper

1. Go to **Camper Lookup** (`/search`) and search by name
2. Click the camper's name to open their profile (`/camper/:id`)
3. The left column in admin view shows an editable **Camper Details** form with:
   - Preferred Name (optional nickname — shown in place of first name throughout the app when set). Changing, setting, or clearing it shows a confirmation popup before **Save Changes** submits; the rest of the form saves normally without one
   - Home Counselor (dropdown, grouped by color)
   - Bus Route (text field) + **Rides AM Bus** / **Rides PM Bus** checkboxes — controls which direction bus sheets the camper appears on; clearing the route field automatically zeros both flags
   - Extended Hours (No / AM Only / PM Only / AM + PM)
   - Camp Lunch (No – Packed / Yes / Allergy Meal)
4. Click **Save Changes** to commit
5. To remove the camper from the roster entirely, use the **Remove Camper** button at the bottom of the form (confirmation required, cannot be undone)

> Camper schedule changes (swapping classes) are done through the **Swap Tool** (`/swap-tool`), not the profile page.

#### Editing a Staff Member

1. Go to **Staff Directory** (`/counselor-directory`) and click the staff member's name
2. Their profile page (`/counselor-profile/:id`) opens with an **Edit Profile** section in admin view containing:
   - First Name, Last Name
   - Role (Counselor, Swim Counselor, Unit Leader, Sports Leader, Instructor, Director, etc.)
   - Home Group Color
   - Schedule Type (controls which periods they're placed in by the auto-scheduler)
   - Bus Route
   - Extended Hours
   - Phone, Email
   - Highest Swim Level Able to Teach (1–6; leave blank if they only teach levels 1–3, the default everyone can teach). To edit this for every swim counselor at once instead of one profile at a time, use the **Edit Swim Certifications** panel on `/swim-scheduling`.
3. Click **Save** to commit — this updates both the staff record and the active week's scheduling attributes
4. **Instructors and Unit Leaders** also have a **Weekly Schedule** section below the profile form where you can add, edit, or remove period assignments week by week
5. To permanently delete the staff member, use the **Delete** button in the page header (confirmation required, cannot be undone)

> Newly created staff members (added via **Settings → Add Staff Member**) can also be edited the same way through their profile immediately after creation.

---

### Attendance Sheet Symbols

Every attendance roster (home group, class, bus, extended care) shows status badges next to camper names. These reflect information from across the system and update automatically.

| Badge | Meaning |
|---|---|
| 🏥 **In Nurse** | Camper was checked into the Nurse Station this morning and has not been checked out |
| ⚠️ **Absent AM** | Camper was marked absent on their morning home group sheet |
| 🚌 **Absent Bus AM** | Camper was marked absent on their bus route's AM sheet |
| 📓 **With Noël** | Camper has an active visit logged in the Case Log |
| 🚗 **Dismissed** | Camper has been given an early dismissal during today's session |
| 🚗 **Pickup [time]** | A scheduled pickup has been entered for this camper (yellow badge, clickable to see pickup time and notes) |
| ✓ **Seen Earlier** | Camper was marked present on a different roster earlier in the same session |
| 🏕️ **Field Trip** | Shown on SPLIT AM specialty sheets when the group has been marked as on a field trip; individual SPLIT campers appearing on class sheets show a bus icon next to their name |
| 👕 **Shirt Size / ×Quantity** | Monday AM sheets only (Home Group sheets for main camp, specialty sheets for KP/LP/SPLIT/SPRC/Swim). Shows the camper's shirt size and how many shirts to hand out (registered weeks + 1, capped at 5) |
| 👕 **Shirts Received** | Replaces the size/quantity pills once the camper already picked up shirts during an earlier, completed week. Click it to reveal the size and quantity again |
| 🍱 **Camp Lunch** | Lunch Home Group sheets only. Shown when the camper is signed up for a camp-provided lunch |
| ⚠️ **Allergy Meal** | Lunch Home Group sheets only. Shown when the camper needs an allergy meal |

**Home group AM/PM sheets** also show a **🚌 Bus [route]** chip and an **⏰ Extended** chip next to camper names so staff can quickly see who needs bus or extended care pickup without switching to another roster.

**SPLIT campers** appearing on a class roster show a read-only status pulled from the Specialty AM sheet — they cannot be marked from the class roster directly.

**Marking attendance:**
- **Present** and **Absent** buttons save immediately (no submit button needed)
- The counter at the top of each roster updates in real time
- Use **Dismiss** to log an early dismissal directly from any attendance sheet

---

## Feature Map

### Hub

| Page | URL | Admin Only | Description |
|---|---|:---:|---|
| Admin Hub | `/admin` | ✓ | Dashboard: director notes, announcements, camper/staff counts, links to all admin tools. Admins can edit their own notes inline using the pencil button next to each note. Includes a **day schedule bar** showing all periods and non-class blocks (lunch, big game, popsicle break, dismissal) for both sides of camp. Click a period to jump to that class's attendance. |
| Staff Hub | `/staff` | | Counselor-facing dashboard: day schedule bar, home group roster, attendance links. Auto-refreshes silently every 15 minutes. The schedule bar defaults to the counselor's own side of camp (sports or enrichment); Unit Leaders and Sports Leaders default to the sports schedule. Hovering a period block shows start and end times. **Attendance at a Glance** shows all camp absences, nurse check-ins, and active case log entries. **Today's Memo** includes a section for campers absent from your home group specifically. When a future week is released (Settings → Session Management), a **Your Upcoming Schedule** card shows that week's periods; Unit Leaders, Sports Leaders, and Instructors also see the class location for each period. |

---

### Schedule & Lookup

| Page | URL | Description |
|---|---|---|
| Master Schedule | `/master-schedule` | All classes by period. Search bar filters by class name or camper name. Filter by period, side, and color group. Click a class name to open its roster. Counselor, Instructor, Unit Leader, and Sports Leader names are all clickable links to their staff profile for all users. |
| Class Roster | `/class-roster/:period/:activity` | Full camper list for one class period. Admin can update the location. In prep mode, shows data for the prep target week. If Dance and Cheerleading share a period, they appear merged as "Dance & Cheerleading" with a Class column showing each camper's actual enrollment. Camper names link directly to the camper profile. |
| Camp Map | `/map` | Interactive map with building pins for the enrichment and sports sides of camp. Toggle between **My Class** (just the building(s) where you're assigned in the current period), **This Period** (all buildings with a class in the active block), or **All** (every building in use this week). Select a specific period from the dropdown to view any block. Hovering or tapping a pin shows which classes meet there. The map auto-defaults to the counselor's side of camp (sports or enrichment) based on their schedule. |
| Camper Lookup | `/search` | Search campers by name. Shows full schedule, bus route, and extended hours. |
| Camper Profile | `/camper/:id` | Full detail for one camper: schedule with location, staff, and counselors shown per period; contacts; notes. Admin can edit all fields or delete the record. Schedule entries link directly to class rosters. If the camper has an imported ICP or Camper Note, a **Notes** card shows the full text (visible in both admin and staff view — see Attendance below). A **Quick Dismiss** card on the profile lets admin log an early dismissal without going through the attendance or dismissals page; a confirmation popup shows the dismissal time (the entered time, or the current time if left blank) before it's logged. |
| Staff Directory | `/counselor-directory` | All staff listed by role. Available to both admin and staff view (linked from the Staff Hub nav bar); names always link to individual profile pages, which stay read-only outside admin view — the directory itself has no edit or delete actions. |
| Staff Profile | `/counselor-profile/:id` | Individual staff detail: schedule, home group roster, contact info. Admin can edit all profile fields. |
| Full Summer (Instructors) | `/faculty-summer` | Week-by-week instructor schedule view. Upload or clear assignments per week. |
| Document Hub | `/docs` | All uploaded PDFs in one place. Available to all staff. Cards link directly to each PDF; unavailable documents are dimmed. Admin view includes a link to Settings to upload replacements. |

---

### Scheduling Tools

| Page | URL | Description |
|---|---|---|
| Swap Tool | `/swap-tool` | Move a camper from one class to another. Shows capacity and waitlist status for all available options. Displays a count of how many swaps have been made for the selected camper during the current week. |
| Schedule History | `/schedule-history` | Log of recent swap and assignment changes. Admin can archive entries. |
| Waitlist / Promotions | `/promotions` | Lists campers eligible to be promoted off the waitlist into an open spot. Promote individually, all at once, force-promote into an over-capacity class, or deny a request outright. Only shows requests made during the current active week — older requests stop appearing once the week rolls over. |
| Counselor Scheduling | `/counselor-scheduling` | Full counselor assignment builder — see [Counselor Scheduling](#counselor-scheduling) above. If Dance and Cheerleading are offered in the same period, they appear as a single merged "Dance & Cheerleading" card; assignments save to both activities. **Locked offerings** are now server-persistent — locking a class survives a page refresh. |
| Counselor Schedule Backups | `/counselor-schedule-backups` | Named snapshots of saved counselor assignments. Restore or delete from here. |
| Home Group Assignment | `/homegroup-assignment` | Assign counselors to color-group home groups by week. Can mirror assignments from one week to another. |
| SPLIT Scheduling | `/split-scheduling` | Dedicated view for managing SPLIT camper period assignments (periods 1, 2, 4, 5, 6). |
| Audit Roster | `/audit` | Flags scheduling issues: missing grades, duplicate assignments, unassigned campers, classes with no counselor. Each section has a Show/Hide toggle; collapsed sections are remembered per browser. |
| Swim Levels | `/swim-levels` | Camper swim level tracking. Printable version at `/reports/swim-levels` (Settings → Print Reports). See [Swim Scheduling](#swim-scheduling) above for full detail. |
| Swim Scheduling | `/swim-scheduling` | Staffing schedule for Rec Swim lifeguards, Swim Lessons pool guards, and skill-level lesson groups — separate from the main Counselor Scheduling builder and only applies to Swim Counselors. See [Swim Scheduling](#swim-scheduling) above for full detail. |
| Coverage | `/coverage` | Temporarily reassign a counselor/staff member's classes for a single day when they're out. See [Coverage](#coverage) above for full detail. |

---

### Attendance

| Page | URL | Description |
|---|---|---|
| Attendance Overview | `/attendance` | Entry point. Links to all attendance roster types for the active session. |
| ICP / Camper Note Flags | (every attendance roster + class roster) | A camper with an imported ICP Note (health care plan) or Camper Note (behavioral/social) shows a small clickable flag next to their name — red &#9877; ICP, purple &#128221; Note. Tapping it pops up the full text; if it's long, the popup truncates with a **Read More →** link to the camper's profile. Visible in both admin and staff view, since the point is for whoever's taking attendance to see it. Import both via Settings → CSV Data Imports. |
| Class Attendance | `/attendance/class/:period/:activity` | Mark present/absent for a specific class period. |
| Home Group (by counselor) | `/attendance/homegroup/counselor/:id/:session` | Morning or afternoon home group roster for one counselor. |
| Home Group (by color) | `/attendance/homegroup/:color/:session` | All home groups in a color, combined. |
| Specialty Attendance | `/attendance/specialty/:color/:session` | Attendance for specialty programs (LilPlace, KinderPlace, etc.). AM sheets list every camper, with a 🕑 **Half Day** pill on half-day KP/LP campers. PM sheets exclude half-day campers; SPRC has no PM sheet (exclusively half day). |
| Specialty Half Day | `/attendance/specialty-halfday/:color` | Midday check-out roster: KP/LP campers marked Half Day (from the ACR-003 import) plus the entire SPRC program. Appears as its own section on the attendance overview. |
| Bus Attendance | `/attendance/bus/:route/:session` | Riders grouped by bus route. |
| Extended Care | `/attendance/extended/:session` | AM and PM extended hours roster. |
| Late Arrivals | `/attendance/late-arrivals` | Check in campers who arrive after the normal start time. Includes a **Back In** button to undo an early dismissal if a dismissed camper returns. |
| Dismissal Archive | `/attendance/dismissal-archive` | Historical log of early dismissal records. |

---

### Dismissals

| Page | URL | Description |
|---|---|---|
| Dismissals | `/dismissals` | Schedule an early pickup, view all pending dismissals, and mark them complete. Today's Scheduled Pickups has a name filter; each pending pickup row has a **Quick Dismiss** button (confirmation shows the current time, notes carry over) above **Remove** (deletes the scheduled pickup) — both ask for confirmation. Once a camper is dismissed, their pickup moves to a **Dismissed Today** section showing the dismissal time, with Quick Dismiss removed. |
| All Dismissals | `/dismissals/all` | Full dismissal list across all sessions. |

---

### Health

| Page | URL | Description |
|---|---|---|
| Nurse Station | `/nurse` | Log camper health visits: check-in, check-out, notes, and dismissal. Separate tabs for active and completed visits. |
| Nurse Archive | `/nurse/archive` | Historical visit log organized by date. |
| Case Log | `/case-log` | Detailed case tracking for incidents requiring fuller documentation. |
| Case Log Archive | `/case-log/archive` | Historical case entries organized by date. |

---

### Settings & Data Management

All at `/settings`.

| Section | Description |
|---|---|
| **Session Management** | Set active/released weeks; edit labels and start dates; clear week data; sync offerings from imported schedule |
| **Activity Manager** | Add, edit, and delete activities; configure side of camp, max capacity, and allowed groups; set period-specific group overrides; bulk CSV import. **Sync Activity Groups** button analyzes actual camper enrollment to automatically derive the correct color-group restrictions for each activity; also runs automatically on week rollover. |
| **Camp Map Buildings** | Manage building pin positions for the interactive camp map. Two maps are available (`enrichment` and `sports`). Enter a building name (must match the `Location` value used in the schedule), choose the map, and provide X/Y pixel coordinates from the map image. The settings page lists all distinct location names currently in the schedule as a reference. |
| **CSV Data Imports** | Import all staff, instructor schedules, camper roster (ACR-005), and camper master schedule |
| **Documents** | Upload up to 7 PDF documents in a 3×3 grid. Current documents: 📄 Camper Notes, 📄 ICP Notes, 🗺️ AM Enrichment Meeting Locations, 🗺️ Snack Break Meeting Locations, 🗺️ Lunch Enrichment Meeting Locations, 🗺️ Popsicle Break Meeting Locations, 🗺️ Enrichment Locations Map. Each card shows upload status and a form to replace the file. All uploaded documents are viewable by all staff from the **Document Hub** (`/docs`). |
| **Print Reports** | Printable attendance rosters, camper name cards, a swim levels report, and a 2-page AM/PM swim staffing schedule |
| **Add Staff Member** | Create an individual staff record with all profile fields (name, role, group color, schedule type, bus, extended hours, phone, email) |
| **Add Camper** | Create an individual camper record and immediately assign classes through the class assignment tool |
| **Create Blank Class** | Add a class offering to the active week's schedule without any enrolled campers — useful for adding ad-hoc classes (e.g. Free Swim) that weren't in the original import |

---

### Other Admin Tools

| Tool | URL | Description |
|---|---|---|
| Counselor Preferences | `/counselor-preferences` | View and edit each counselor's activity preferences, used by the auto-scheduler to influence assignments. The activity list reflects next week's offerings when they've been uploaded (falling back to the current week), and the form notes which week is shown. Counselors submit Home Group, Schedule Type, and Activity preferences; Swim Counselors submit Activity (class) preferences only — the Home Group and Schedule Type sections don't apply to them and are hidden |
| Photo of the Day | `/photo-day` | Upload a photo for the day. Accessible to all staff (not admin-only). |
| Attendance Nudge Notifications | — | Push notifications sent to subscribed counselors reminding them to submit attendance 15+ minutes into a class period. Staff subscribe via the **Enable notifications** button in My Preferences. One notification per class per day; no notification if attendance is already submitted. See [Staff: Setting Up Notifications](#staff-setting-up-notifications). |
| Instant Alerts | `/alerts` | Send a push notification to a named group or individual counselor. Seven built-in system groups are available (All Counselors, All Unit Leaders, All Admin, and the four AM/PM Sports/Enrichment splits). Admins can also create custom named groups with a hand-picked member list. Alerts sent to **All Admin** additionally display a red banner at the top of the admin hub for any admin currently logged in, regardless of whether they have push notifications enabled. All sent alerts are logged with recipient group, sender, timestamp, and delivery count. |
| Spartan Games | `/spartan-games` | Annual counselor signup event. Counselors select events they want to participate in. Solo events are a single checkbox; group events reveal a partner selector once checked. The partner list includes both Counselors and Swim Counselors. The group always includes the logged-in counselor — they cannot be unchecked. Conflict detection prevents any name from appearing on two separate groups for the same event. **Admin view** (admin hub only): edit event definitions (name, date, block, participant count, subtext), add new events, view all signups with delete buttons, and toggle whether submissions are open or closed. When closed, counselors can still view the form and their existing registrations but cannot submit new ones. Each event's add/edit form also has an **Enforce Gender Ratio** checkbox; checking it reveals **Min Male** and **Min Female** fields. Any signed-up group that doesn't meet those minimums (based on each counselor's Gender in their profile) is flagged invalid — a warning badge appears next to the group on the admin Signups list, and the counselor sees a warning below their registration on the signup page. |
| Photo Gallery | `/photo-gallery` | Browse uploaded photos; staff can vote. Photos display in a polaroid-style card; click any photo (including the winner) to open it full-size, uncropped, in a lightbox. |
| All Photos (Admin) | `/photo-gallery/all` | Admin-only view of every submitted photo across all dates. Sort by date or by likes. Select one or multiple photos and download — single photos download directly, multiple photos download as a `.zip` file. |
| Export Counselor Schedule | `/export-counselor-schedule` | Download current counselor assignments as CSV |
| Export Staff Schedule | `/export-staff-schedule` | Download instructor/unit leader assignments as CSV |
| Export Master Schedule | `/export-master-schedule` | Download the full class-by-period master schedule as CSV |
| Spartan Games | `/spartan-games` | Counselor sign-up sheet for Spartan Games events. Admin can add/edit/delete events, view all sign-ups, and toggle submissions open or closed. When closed, counselors can still view the page and see their existing registrations but cannot submit new entries. Events can optionally enforce a minimum male/female count per group; groups that don't meet it are flagged with a warning. |
| Counselor Talent Show | `/talent-show` (staff) · `/admin#talent-show` (admin hub) | Counselors submit a one-line description of their act. Submissions are weekly (reset on week rollover). The admin hub shows all submissions for the current week with Approve / Deny / Delete actions and an Open/Close toggle. When submissions are closed the card does not appear in the Staff Hub. |
| Camper Attendance History | `/camper-attendance` | Admin-only report. Select a camper via searchable dropdown and view a calendar grid of their attendance across all weeks (or a filtered subset). Each day shows a colored dot: **green** = present (at least one class marked present), **red** = absent all day, **yellow** = late arrival or early dismissal, **gray** = no data. Each week section includes a present and absent day count. |
| Mass Edit Staff | `/mass-edit-staff` | Admin-only spreadsheet-style editor: one row per staff member with the same fields as the profile page (name, role, group, schedule type, bus, extended hours, phone, email) plus **Gender**. Filter by name, role, or gender; edited rows highlight yellow; one Save All button writes everything. Gender feeds the scheduler's gender-split rules. |

---

## Staff: Setting Up Notifications

Camp Hub can send push notifications to remind staff to submit attendance and to deliver instant alerts from admin. Setup is a one-time step on each device.

> **You will need to enable notifications on each device you use.** Notifications are linked to the specific browser and device, not your account.

---

### iPhone / iPad (Safari)

Push notifications on iPhone and iPad require the site to be saved to your Home Screen first. Safari's regular browser tab does not support them.

**Step 1 — Add to Home Screen**

1. Open Camp Hub in **Safari** (not Chrome or another app).
2. Tap the **Share** button at the bottom of the screen (the box with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

A Camp Hub icon will appear on your Home Screen like any other app.

**Step 2 — Enable notifications**

1. Open Camp Hub by tapping the **Home Screen icon** (not by opening Safari directly).
2. Tap **My Preferences** in the navigation bar.
3. Scroll to the **Notifications** section at the bottom of the page.
4. Tap **Enable notifications**.
5. When your device asks "Allow Camp Hub to send you notifications?", tap **Allow**.

You're done. Notifications will now appear on your device even when Camp Hub is not open.

> **Requirements:** iOS 16.4 or later. If you don't see the Enable notifications button, check that you opened Camp Hub from the Home Screen icon, not from Safari.

> **If you accidentally tapped "Don't Allow":** Go to **Settings → Camp Hub → Notifications** and turn notifications on, then return to My Preferences and tap Enable notifications again.

---

### Android / Chrome (desktop or mobile)

**Step 1 — Open My Preferences**

1. Log into Camp Hub in staff view and tap **My Preferences** in the navigation bar.

**Step 2 — Enable notifications**

1. Scroll to the **Notifications** section at the bottom of the page.
2. Click or tap **Enable notifications**.
3. When the browser asks for permission, click or tap **Allow**.

That's it. No home screen setup required on Android or desktop Chrome.

> **Optional — Add to Home Screen on Android:** Tap the three-dot menu in Chrome and select **Add to Home Screen**. This makes Camp Hub open full-screen like an app, but it is not required for notifications to work.

> **If you accidentally clicked "Block":** Click the lock icon in the address bar, find Notifications, and change it to Allow. Then return to My Preferences and tap Enable notifications.

---

### Disabling notifications

To turn off notifications on any device, go to **My Preferences** and tap **Disable notifications**. This removes the subscription immediately. You can re-enable at any time by tapping Enable notifications again.
