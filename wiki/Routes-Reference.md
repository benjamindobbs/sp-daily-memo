# Routes Reference

All Express routes in `app.js`. Admin-only routes require `viewMode === 'admin'` (enforced by the `ADMIN_ONLY_PREFIXES` middleware). See [Auth](./Auth.md) for details.

---

## Auth & Navigation

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/` | | Splash / redirect to hub |
| POST | `/choose-view` | | Set `viewMode` cookie to `admin` or `staff` |
| GET | `/admin-login` | | Login form |
| POST | `/admin-login` | | Validate name against `AdminUsers`; set session |
| GET | `/logout` | | Clear session; redirect to splash |

---

## Hubs

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/admin` | ✓ | Admin dashboard — announcements, director notes, counts |
| GET | `/staff` | | Staff hub — daily schedule, home group roster, attendance links. When a week is released, shows a "Your Upcoming Schedule" card pulling from the correct table(s) per role (see [Sessions-and-Weeks](Sessions-and-Weeks.md#released-vs-active)); Unit Leaders, Sports Leaders, and Instructors also see each period's location |
| POST | `/admin-set-name` | ✓ | Set logged-in admin name in session |
| POST | `/director-notes` | ✓ | Add a director note (writes `DirectorNotes`) |
| POST | `/director-notes/delete/:id` | ✓ | Delete a director note |
| POST | `/director-notes/edit/:id` | ✓ | Edit an existing director note (author-gated — only the original author can edit) |
| GET | `/api/director-notes` | ✓ | Ajax: `?offset=N` → `{ notes[], hasMore }`, 100 notes per page ordered newest-first; powers the **Load More** button on the admin hub notes feed (initial page render still ships the first 200 via `/admin`) |
| POST | `/hub-content/:id` | ✓ | Update `HubContent` (announcement or director_notes blob) |

---

## Schedule & Lookup

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/master-schedule` | | All classes by period. Filterable by period, side, group. Searchable by class name or camper name. Uses the prep target week if one is set, otherwise the active week. Week-agnostic legacy `Schedules` instructor rows (staff names + locations) are only included when viewing the active week — in prep mode, staff/locations come solely from the week-scoped `StaffWeekSchedules`/`CounselorScheduleAssignments`. Counselors without a color group render as a neutral gray chip. Today's `CounselorCoverage` substitutions are swapped in automatically — see [Coverage](./Scheduling-System.md#coverage). |
| GET | `/class-roster/:period/:activity` | | Camper list for one class/period. Respects prep mode (uses prep target week when admin is in prep mode). Dance & Cheerleading merge detected at query time — both activities served under one roster when they share a period. Camper names link to camper profiles. Today's `CounselorCoverage` substitutions are swapped in automatically. |
| GET | `/swim-levels` | ✓ | Roster of campers enrolled in Rec Swim/Swim Lessons for the target week, with inline swim-level editing. See [Swim Scheduling](./Swim-Scheduling.md) |
| POST | `/swim-levels/update` | ✓ | Upsert one camper's `CamperSwimLevels` row for a given week |
| POST | `/upload-swim-levels` | ✓ | CSV import: "Group Attendance Sheet with Swim Level" export |
| POST | `/upload-icp-notes` | ✓ | CSV import: ICP Notes (Health Care Need/Plan for Care) export. Full replace per `NoteType='ICP'`. See [Attendance & Health](./Attendance-and-Health.md#icp--camper-notes) |
| POST | `/upload-camper-notes` | ✓ | CSV import: Camper Notes (behavioral/social) export. Full replace per `NoteType='General'`. Same page as above |
| GET | `/swim-scheduling` | ✓ | Swim staffing schedule — Rec Swim guards, Swim Lessons pool guards, auto-generated skill-level lesson groups. Independent of the main counselor schedule. `?week=N` to view a different session. See [Swim Scheduling](./Swim-Scheduling.md) |
| GET | `/reports/swim-schedule` | ✓ | Printable AM/PM swim staffing schedule — 2 pages, 3 columns (one per period). `?week=N` to print a different session. See [Swim Scheduling](./Swim-Scheduling.md) |
| POST | `/swim-scheduling/generate-groups` | ✓ | Auto-forms lesson groups for the week from current swim levels; skips `Locked` groups |
| POST | `/swim-scheduling/create-group` | ✓ | Manually add an empty lesson group |
| POST | `/swim-scheduling/delete-group` | ✓ | Delete a group; members become ungrouped |
| POST | `/swim-scheduling/merge-group` | ✓ | Merge a source group into a target group in the same period (widens level range, locks the result). Rejected if either group is an active auto-merge target |
| POST | `/swim-scheduling/undo-merge` | ✓ | Reverse a merge via its history row — recreates the source group, moves back still-present members, restores the target's pre-merge state |
| POST | `/swim-scheduling/split-group` | ✓ | Split a group over 5 campers into groups of 5 or fewer; original keeps the first chunk, rest are new unlocked/uninstructed groups |
| POST | `/swim-scheduling/toggle-group-lock` | ✓ | Flip a group's `Locked` flag |
| POST | `/swim-scheduling/assign-instructor` | ✓ | Set a group's instructor |
| POST | `/swim-scheduling/assign-camper` | ✓ | Add a camper to a group |
| POST | `/swim-scheduling/remove-camper` | ✓ | Remove a camper from a group |
| POST | `/swim-scheduling/save-guards` | ✓ | Replace the guard set for a `(week, period, guardRole)` |
| POST | `/swim-scheduling/save-certifications` | ✓ | Bulk-update every swim counselor's `SwimMaxLevel` from the Edit Swim Certifications panel |
| POST | `/swim-scheduling/auto-assign` | ✓ | Full auto-solver — fills open guard slots and un-instructored lesson groups, balancing water time; leaves existing picks untouched |
| POST | `/swim-scheduling/clear-assignments` | ✓ | Unassigns every counselor for the week — deletes all guard assignments, clears both instructor slots on every group (including Locked) |
| GET | `/map` | | Interactive camp map. Two maps (enrichment/sports) with building pins; toggles for My Class / This Period / All / period selector. "My Class" periods by role: Counselors → `CounselorWeekSchedules`; Instructors → `Schedules`; UL/SL → union of `CounselorScheduleAssignments` + `CounselorWeekSchedules` + `StaffWeekSchedules`. Activity matching is case-insensitive. |
| POST | `/update-class-location` | ✓ | Update location on a class roster |
| GET | `/search` | | Camper search by name. Lists every camper enrolled in the active week (a `CamperWeekData` row **or** any `Schedules` row) — so schedule-less campers (KP/LP, some SPLIT) are included. Group/bus/extended filter values are week-scoped via `COALESCE(cwd.*, c.*)` |
| GET | `/counselor-directory` | | Staff directory grouped by role |
| GET | `/staff-lookup` | | Redirect → `/counselor-directory` |
| GET | `/counselor-profile/:id` | | Individual staff profile. For admins, schedule/campers/week attributes reflect the prep target week when one is set (with a banner noting the prep week); staff always see the active week. The Daily Assignments card shows today's `CounselorCoverage` overlay: a "Covered by X" / "no coverage needed" tag on the out counselor's own periods, and a banner on the covering counselor's profile listing what they're covering |
| POST | `/delete-counselor/:id` | ✓ | Delete a counselor record |
| POST | `/update-staff-info/:id` | ✓ | Edit all counselor profile fields incl. `gender` (base record + week attributes for the same week the profile displays: prep target for admins, else active week) |
| GET | `/mass-edit-staff` | ✓ | Spreadsheet-style editor: one row per staff member with all profile fields plus Gender; filter by name/role/gender |
| POST | `/mass-edit-staff/save` | ✓ | JSON bulk save of every row (transaction); mirrors group/schedule/bus/extended into `CounselorWeekAttributes` for the active week |
| POST | `/update-staff-period` | ✓ | Add/update one period on an instructor's weekly schedule |
| POST | `/remove-staff-period` | ✓ | Remove one period from an instructor's weekly schedule |
| GET | `/camper/:id` | | Individual camper profile. Each period's class counselor(s) reflect today's `CounselorCoverage` substitutions. Parent/guardian contact card is admin-view only |
| POST | `/camper/:id/update` | ✓ | Edit camper fields: `preferredName`, `homeGroupCounselorID`, `busRoute`, `busRidesAM` (checkbox → `1`/`0`), `busRidesPM` (checkbox → `1`/`0`), `extendedHours`, `campLunch`. If `busRoute` is cleared, both ride flags are forced to `0`. |
| POST | `/camper/:id/delete` | ✓ | Remove a camper from the roster |
| GET | `/faculty-summer` | | Full-summer instructor schedule view |

---

## Scheduling Tools

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/swap-tool` | | Class swap interface; accepts `?camperId=` (exact, from autocomplete) or `?name=` (LIKE search) |
| GET | `/get-options/:camperId/:period` | | Ajax: available classes for a camper/period swap |
| GET | `/process-swap` | ✓ | Execute a class swap; writes `Schedules` and `ScheduleChanges` |
| GET | `/schedule-history` | ✓ | Swap log viewer |
| POST | `/archive-schedule-changes` | ✓ | Move selected log entries to archive |
| GET | `/promotions` | ✓ | Waitlist promotion page |
| POST | `/promote-waitlist` | ✓ | Promote one camper off waitlist |
| POST | `/force-promote-waitlist` | ✓ | Force-promote one camper into a full class (bypasses capacity check) |
| POST | `/promote-all` | ✓ | Promote all eligible waitlist entries |
| POST | `/remove-waitlist/:id` | ✓ | Remove a waitlist entry |
| GET | `/counselor-scheduling` | ✓ | Counselor schedule builder |
| GET | `/api/locked-offerings` | ✓ | Ajax: `?week=N` → array of locked `{PeriodNumber, ActivityName}` rows from `LockedOfferings` |
| POST | `/api/toggle-lock` | ✓ | Body `{weekNumber, periodNumber, activityName, locked}` — insert or delete a row in `LockedOfferings` |
| POST | `/save-counselor-assignments` | ✓ | Persist assignment state → `CounselorScheduleAssignments` + `CounselorWeekSchedules` |
| POST | `/backup-counselor-assignments` | ✓ | Create a named backup snapshot |
| GET | `/counselor-schedule-backups` | ✓ | View and manage backups |
| POST | `/restore-counselor-backup/:id` | ✓ | Restore a backup to the live tables |
| POST | `/delete-counselor-backup/:id` | ✓ | Delete a backup |
| POST | `/auto-assign-homegroups` | ✓ | Proportionally assign homegroup colors to all counselors (preserves counselors with existing roster assignments) |
| POST | `/sync-homegroup-colors` | ✓ | Sync scheduler homegroup colors from `CamperHomeGroups` roster — only updates `HomeGroupColor` in `CounselorWeekAttributes`; does not touch `ScheduleType` or any other field |
| POST | `/save-counselor-group-assignments` | ✓ | Save home group color, schedule type, specialty group, and `isWorkingThisWeek` flag for counselors |
| GET | `/homegroup-assignment` | ✓ | Home group assignment manager |
| POST | `/homegroup-assignment/save` | ✓ | Save camper → counselor home group assignments |
| POST | `/homegroup-assignment/mirror` | ✓ | Copy one week's home group assignments to another |
| GET | `/split-scheduling` | ✓ | SPLIT camper AM period assignment manager |
| POST | `/save-split-assignments` | ✓ | Save SPLIT period assignments |
| POST | `/split-field-trip/mark` | ✓ | Flag today as a SPLIT field trip |
| POST | `/split-field-trip/clear` | ✓ | Remove today's SPLIT field trip flag |
| GET | `/split-schedule` |  | Read-only period-by-period schedule for all SPLIT campers, grouped by period and sorted by location within each period. Not admin-gated (same access as `/master-schedule`). Linked from the `/split-scheduling` nav bar. |
| GET | `/audit` | ✓ | Audit page — flags scheduling issues. Uses the prep target week if one is set, otherwise the active week. Counselor class-count check credits periods covered under a dual-enrolled staff identity (same name, e.g. Sports Leader/Counselor), so dual staff aren't falsely flagged short. **Duplicate / Swim Overload** card flags, per counselor per AM/PM block, a duplicate `ActivityName` within that block or more than 1 swim-variant (`/swim/i`) class within that block — checked against `CounselorWeekSchedules` directly, independent of how the schedule was built. See [Scheduling System](./Scheduling-System.md#audit-schedule-rule-checks). |
| GET | `/counselor-week-assignments/:week` | ✓ | Ajax: get all assignments for a given week |
| GET | `/api/counselor-week-pinned-types/:week` | ✓ | Ajax: `{CounselorID, ScheduleType}` rows for counselors with a manually-pinned (`ScheduleTypeManual=1`) schedule type in the given week; used by **Migrate Pinned Types** on the schedule builder |

---

## Coverage

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/coverage` | ✓ | Day-specific substitute assignment tool. `?date=&counselorId=` picks the out counselor; renders one card per period they're assigned that week with a 3-bucket covering-counselor dropdown (correct side / swim / opposite side), plus leadership buckets where applicable. Candidates already covering a different out-counselor's period this exact date+period are excluded from the dropdown entirely (can't be double-booked); remaining candidates are tagged "✅ Extra" when pulling them keeps their current class at/under a 1:12 ratio. See [Scheduling System](./Scheduling-System.md#coverage) |
| POST | `/coverage/save` | ✓ | Upserts one `CounselorCoverage` row per submitted period (parallel arrays: `periodNumber[]`, `activityName[]`, `coveringCounselorId[]`, `skipped[]`); clears a period's row if neither a covering counselor nor skip was chosen. Sends a push alert to a counselor when they're newly assigned or reassigned to cover a period (not on unchanged re-saves or skips) |
| POST | `/coverage/clear-row` | ✓ | Deletes a single `CounselorCoverage` row by `coverageId` |

---

## Offerings & Sync

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| POST | `/upload-weekly-offerings` | ✓ | CSV upload for weekly offerings |
| POST | `/clear-weekly-offerings` | ✓ | Remove offerings for the active week |
| POST | `/api/sync-offerings` | ✓ | Alias for sync (JSON response) |
| POST | `/sync-offerings-from-schedule` | ✓ | Rebuild `WeeklyOfferings` from `Schedules` for the active week |
| POST | `/sync-activity-groups` | ✓ | Analyze actual camper enrollment to derive correct `AllowedGroups` values (and per-period exceptions) for all activities in the active week. Also runs automatically on week rollover. |

---

## Push Notifications

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/api/vapid-public-key` | | Returns the server's VAPID public key for push subscription setup |
| POST | `/api/push-subscribe` | | Register or update a browser push subscription for the current counselor (reads `selectedCounselor` cookie) |
| POST | `/api/push-unsubscribe` | | Remove the push subscription for the current counselor |
| GET | `/api/attendance-nudge` | | Polled by the client; returns `{ notify: true, classes: [...] }` if the current counselor has unsubmitted class attendance 15+ min into an active period |

---

## Instant Alerts

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/alerts` | ✓ | Alerts page — compose form, custom group manager, alert history |
| POST | `/alerts/send` | ✓ | Send an alert: `{ message, targetType: 'group'\|'individual', targetId }` |
| GET | `/api/alerts/preview` | ✓ | AJAX: `?targetType=&targetId=` → `{ count, names[] }` — how many subscribers would receive |
| POST | `/alerts/groups` | ✓ | Create a custom group: `{ name, members[] }` |
| POST | `/alerts/groups/:id/delete` | ✓ | Delete a custom group (system groups cannot be deleted) |
| POST | `/alerts/groups/:id/members` | ✓ | Replace the member list for a custom group |

---

## Counselor Preferences

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/counselor-preferences` |  | Preferences form. Activity list shows next week's `WeeklyOfferings` if uploaded, else the current week's, else the full `Activities` catalog; the form notes which week is shown. Counselors get Home Group, Schedule Type, and Activity sections; Swim Counselors only get the Activity (class) preferences section |
| POST | `/counselor-preferences` |  | Save preferences for one counselor. For Swim Counselors, `HomeGroupPreference`/`SchedulePreference` are not required — an activity-only submission still saves |
| GET | `/api/counselor-preferences/:id` |  | Ajax: get preferences for one counselor |
| GET | `/counselor-preferences-summary` | ✓ | Admin summary table: all main counselors with home group, schedule, and activity preferences; activity prefs split by Sports/Enrichment; pref-match count shows how many assigned classes appear in the counselor's preferences |

---

## Exports

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/export-counselor-schedule` | ✓ | CSV download: counselor period assignments |
| GET | `/export-staff-schedule` | ✓ | CSV download: instructor/leader assignments |
| GET | `/export-master-schedule` | ✓ | CSV download: full class-by-period master |

---

## Attendance

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/attendance` | | Attendance overview. When a staff viewer is filtered to their own classes (`selectedCounselor` cookie, not `showAll=1`), `allowedClasses` also includes any class they're covering via `CounselorCoverage` for the viewed `date` (`Skipped=0`), so a covering counselor sees the covered class alongside their own normal ones, tagged with a green "Covering" badge. Conversely, a period the viewer is out of (has a `CounselorCoverage` row as `OutCounselorID`) is greyed out on their own filtered view and tagged "Covered by X" / "No coverage needed" |
| GET | `/attendance/homegroup/counselor/:counselorId/:session` | | Home group roster by counselor |
| GET | `/attendance/homegroup/:color/:session` | | Home group roster by color |
| GET | `/attendance/specialty/:color/:session` | | Specialty program roster. AM: all campers, with a 🕑 Half Day pill on `ScheduleType='Half Day'` campers; PM: Half Day campers excluded |
| GET | `/attendance/specialty-halfday/:color` | | Specialty Half Day midday check-out roster (`specialty_halfday` session). KP/LP: half-day campers only; SPRC: whole camp (no PM session exists for SPRC) |
| GET | `/attendance/class/:period/:activity` | | Class attendance sheet. `?date=` selects the day, defaults to today; the "Counselors:" line reflects that date's `CounselorCoverage` substitutions, tagged "(covering for X)" |
| GET | `/attendance/bus/:route/:session` | | Bus route attendance |
| GET | `/attendance/extended/:session` | | Extended care attendance |
| GET | `/attendance/late-arrivals` | | Late arrival check-in |
| POST | `/attendance/check-in` | | Mark a late arrival as present |
| POST | `/attendance/mark` | | Mark a camper present or absent on any roster |
| POST | `/attendance/early-dismissal` | | Log an early dismissal for today |
| POST | `/attendance/dismissal-undo` | | Undo an early dismissal — clears the `EarlyDismissals` record so the camper's dismissed badge is removed |
| GET | `/attendance/dismissal-archive` | | Historical dismissal log |

---

## Dismissals

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/dismissals` | | Today's pending dismissals; camper picked via client-side autocomplete (`?camperId=`), `?q=` server search kept as fallback |
| POST | `/dismissals/schedule` | | Create a scheduled pickup |
| POST | `/dismissals/cancel` | | Cancel a scheduled pickup |
| POST | `/dismissals/update` | | Mark a dismissal as completed |
| GET | `/dismissals/all` | | All dismissals across all dates |

---

## Health

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/nurse` | | Active nurse visits |
| POST | `/nurse/checkin` | | Check a camper into the nurse station |
| POST | `/nurse/checkout/:visitId` | | Check a camper out |
| POST | `/nurse/dismiss/:visitId` | | Dismiss a camper from nurse (creates early dismissal) |
| POST | `/nurse/update-notes/:visitId` | | Update nurse visit notes |
| GET | `/nurse/archive` | | Historical nurse visits |
| GET | `/case-log` | | Active case log entries |
| POST | `/case-log/checkin` | | Open a new case |
| POST | `/case-log/checkout/:visitId` | | Close a case |
| POST | `/case-log/dismiss/:visitId` | | Dismiss from case (creates early dismissal) |
| POST | `/case-log/update-notes/:visitId` | | Update case notes |
| GET | `/case-log/archive` | | Historical cases |

---

## Settings & Data Management

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/settings` | ✓ | Settings page |
| POST | `/set-active-week` | ✓ | Set the active week |
| POST | `/set-released-week` | ✓ | Toggle released status for a week |
| POST | `/set-prep-week` | ✓ | Toggle the prep target week (`isPrepTarget`). Accepts `weekNumber`. Clears all other rows first; clicking the same week again unsets it. |
| POST | `/update-session-label` | ✓ | Edit week label and start date |
| POST | `/clear-counselor-week` | ✓ | Clear assignments for a week |
| POST | `/clear-counselor-schedule` | ✓ | Clear the full counselor schedule |
| POST | `/clear-counselor-homegroups` | ✓ | Clear home group assignments for the active week |
| POST | `/create-staff` | ✓ | Add a new staff member |
| POST | `/create-camper` | ✓ | Add a new camper |
| POST | `/create-blank-class` | ✓ | Create a class offering for the active week with no enrolled campers |
| GET | `/assign-camper-schedule/:id` | ✓ | Assign class schedule to a new camper |
| GET | `/get-new-camper-options/:camperId/:period` | ✓ | Ajax: available classes for new camper scheduling |
| GET | `/assign-camper-class` | ✓ | Ajax: assign a class to a new camper |
| POST | `/upload-activity-rules` | ✓ | CSV bulk import for activities |
| POST | `/add-activity` | ✓ | Add a single activity |
| POST | `/delete-activity/:name` | ✓ | Delete an activity |
| POST | `/update-activity` | ✓ | Update activity fields |
| POST | `/add-activity-period-group` | ✓ | Add a per-period group override for an activity |
| POST | `/delete-activity-period-group` | ✓ | Remove a per-period group override |
| POST | `/admin/building-coord` | ✓ | Upsert a building pin: body `{name, map, x, y}`. `map` must be `enrichment` or `sports`. Redirects to `/settings#map`. |
| POST | `/admin/delete-building-coord` | ✓ | Delete a building pin by `id`. Redirects to `/settings#map`. |
| POST | `/upload-campers` | ✓ | CSV import for camper roster (ACR-005). Sets color, shirt, lunch, and home group — does not touch bus data. Targets the prep target week if set, otherwise the active week. |
| POST | `/upload-camper-contacts` | ✓ | CSV import of the Person and Parent Contacts export. Matches campers by name and sets Parent 1/2 name + phone numbers. Update-only, not week-scoped. Shown on `/camper/:id`, admin view only. |
| POST | `/upload-campers-schedule` | ✓ | CSV import for master schedule (ACR-255). Sets grade, extended hours, and class schedule — does not touch bus data |
| POST | `/upload-bus-am` | ✓ | CSV import of ACR-132 (AM Bus Attendance). Sets `BusRoute` + `BusRidesAM` per camper from the report's bus sections |
| POST | `/upload-bus-pm` | ✓ | CSV import of ACR-133 (PM Bus Attendance). Sets `BusRoute` + `BusRidesPM` |
| POST | `/upload-kp-lp` | ✓ | CSV import of ACR-003 (Group Attendance Sheet with KP/LP). Sets `CamperWeekData.ScheduleType` (Full/Half Day) and `ExtendedHours` for KP/LP campers for the selected week. Update-only |
| POST | `/upload-counselors` | ✓ | CSV import for all staff roster |
| POST | `/upload-instructors` | ✓ | CSV import for instructor schedules |
| POST | `/upload-staff-week/:weekNumber` | ✓ | Faculty full summer CSV upload for one week |
| POST | `/clear-staff-week/:weekNumber` | ✓ | Clear faculty full summer data for one week |
| POST | `/clear-activities` | ✓ | Remove all activities |
| POST | `/clear-counselors` | ✓ | Remove all counselors |
| POST | `/clear-staff` | ✓ | Remove all staff |
| POST | `/clear-campers` | ✓ | Remove all campers |
| POST | `/set-activity-side` | ✓ | Update `SideOfCamp` on an activity |
| POST | `/merge-class` | ✓ | Merge two class offerings |

---

## Documents & PDFs

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/docs` | | Document hub — all PDF cards |
| GET | `/pdf/:type` | | Serve an uploaded PDF file |
| POST | `/upload-pdf/:type` | ✓ | Upload or replace a PDF (`type` must be in `PDF_DOCS`) |

---

## Reports

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/reports/attendance-rosters` | ✓ | Printable attendance roster sheets |
| GET | `/reports/name-cards` | ✓ | Printable camper name cards |
| GET | `/reports/swim-levels` | ✓ | Printable swim levels roster, grouped by class/period via `getSwimLevelGroups()`. Optional `?week=N` to print any session, not just active/prep |

---

## Photos

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/photo-day` | | Photo of the Day upload page |
| POST | `/photo-day` | | Upload a photo |
| GET | `/photo-gallery` | | Browse photos; staff can vote |
| POST | `/photo-vote/:id` | | Cast or remove a vote |
| GET | `/photo-gallery/all` | ✓ | All photos across all dates; sortable by `?sort=date` (default) or `?sort=likes` |
| GET | `/photo-download` | ✓ | Download photos by ID: `?ids=1,2,3`. Single photo → image file; multiple → `camp-photos.zip` fetched from Cloudinary |

---

## Spartan Games

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/spartan-games` | | Spartan Games signup page. Counselors see event cards (checkbox for solo, checkbox + partner panel for group events). Admin panel (admin view only) shows event management and all signups. Each signup group is checked against its event's gender-ratio minimums (if enforced); groups that don't meet the minimums are flagged `valid: false` and shown a warning badge/notice to both admins and the registered counselor. |
| POST | `/spartan-games/signup` | | JSON body `{entries: [{eventId, partners:[]}]}`. Returns `{results:[{eventId, success, error?, conflictName?, eventName?}]}`. Returns 403 if submissions are closed. Gender-ratio minimums are not enforced at submission time — only flagged afterward on page load. |
| POST | `/admin/spartan-games/toggle-submissions` | ✓ | Flip the `submissions_open` flag in `SpartanGamesMeta`. Redirects to `/spartan-games`. |
| POST | `/admin/spartan-games/add-event` | ✓ | Create a new event. Body: `name, date, block, participant_count, subtext, enforce_gender_ratio, min_male, min_female`. `min_male`/`min_female` are only stored when `enforce_gender_ratio` is checked (otherwise saved as `0`). |
| POST | `/admin/spartan-games/update-event` | ✓ | Edit an existing event. Body: `id, name, date, block, participant_count, subtext, enforce_gender_ratio, min_male, min_female`. |
| POST | `/admin/spartan-games/delete-event` | ✓ | Delete an event and all its signups. Body: `id`. |
| POST | `/admin/spartan-games/delete-signup` | ✓ | Delete a single signup entry. Body: `id`. |

---

## Counselor Talent Show

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/talent-show` | | Counselor submission form; shows existing submission and status |
| POST | `/talent-show/submit` | | Submit or update an act description. Redirects with error if submissions are closed or no counselor is selected. Re-submission resets status to `pending`. |
| POST | `/admin/talent-show/toggle-submissions` | ✓ | Toggle `TalentMeta.submissions_open`; redirects to `/admin#talent-show` |
| POST | `/admin/talent-show/review` | ✓ | Approve or deny a submission (`action=approve` or `action=deny`); redirects to `/admin#talent-show` |
| POST | `/admin/talent-show/delete` | ✓ | Delete a submission permanently; redirects to `/admin#talent-show` |

---

## Camper Attendance History

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/camper-attendance` | ✓ | Render the attendance history page. Query params: `camperId` (integer) selects a camper; `weeks` (comma-separated week numbers, e.g. `1,3,5`) filters which sessions to display. When `weeks` is omitted all sessions are shown. |

---

## Debug

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/debug-hg` | ✓ | Debug endpoint: dump home group assignment data |
