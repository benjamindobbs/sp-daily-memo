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
| GET | `/staff` | | Staff hub — daily schedule, home group roster, attendance links |
| POST | `/admin-set-name` | ✓ | Set logged-in admin name in session |
| POST | `/director-notes` | ✓ | Add a director note (writes `DirectorNotes`) |
| POST | `/director-notes/delete/:id` | ✓ | Delete a director note |
| POST | `/hub-content/:id` | ✓ | Update `HubContent` (announcement or director_notes blob) |

---

## Schedule & Lookup

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/master-schedule` | | All classes by period. Filterable by period, side, group. |
| GET | `/class-roster/:period/:activity` | | Camper list for one class/period |
| POST | `/update-class-location` | ✓ | Update location on a class roster |
| GET | `/search` | | Camper search by name |
| GET | `/counselor-directory` | | Staff directory grouped by role |
| GET | `/staff-lookup` | | Redirect → `/counselor-directory` |
| GET | `/counselor-profile/:id` | | Individual staff profile |
| POST | `/delete-counselor/:id` | ✓ | Delete a counselor record |
| POST | `/update-staff-info/:id` | ✓ | Edit all 9 counselor profile fields (base record + active week attributes) |
| POST | `/update-staff-period` | ✓ | Add/update one period on an instructor's weekly schedule |
| POST | `/remove-staff-period` | ✓ | Remove one period from an instructor's weekly schedule |
| GET | `/camper/:id` | | Individual camper profile |
| POST | `/camper/:id/update` | ✓ | Edit camper fields (counselor, bus, extended hours, lunch) |
| POST | `/camper/:id/delete` | ✓ | Remove a camper from the roster |
| GET | `/faculty-summer` | | Full-summer instructor schedule view |

---

## Scheduling Tools

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/swap-tool` | | Class swap interface |
| GET | `/get-options/:camperId/:period` | | Ajax: available classes for a camper/period swap |
| GET | `/process-swap` | ✓ | Execute a class swap; writes `Schedules` and `ScheduleChanges` |
| GET | `/schedule-history` | ✓ | Swap log viewer |
| POST | `/archive-schedule-changes` | ✓ | Move selected log entries to archive |
| GET | `/promotions` | ✓ | Waitlist promotion page |
| POST | `/promote-waitlist` | ✓ | Promote one camper off waitlist |
| POST | `/promote-all` | ✓ | Promote all eligible waitlist entries |
| POST | `/remove-waitlist/:id` | ✓ | Remove a waitlist entry |
| GET | `/counselor-scheduling` | ✓ | Counselor schedule builder |
| POST | `/save-counselor-assignments` | ✓ | Persist assignment state → `CounselorScheduleAssignments` + `CounselorWeekSchedules` |
| POST | `/backup-counselor-assignments` | ✓ | Create a named backup snapshot |
| GET | `/counselor-schedule-backups` | ✓ | View and manage backups |
| POST | `/restore-counselor-backup/:id` | ✓ | Restore a backup to the live tables |
| POST | `/delete-counselor-backup/:id` | ✓ | Delete a backup |
| POST | `/auto-assign-homegroups` | ✓ | Auto-assign campers to counselor home groups |
| POST | `/save-counselor-group-assignments` | ✓ | Save home group color assignments for counselors |
| GET | `/homegroup-assignment` | ✓ | Home group assignment manager |
| POST | `/homegroup-assignment/save` | ✓ | Save camper → counselor home group assignments |
| POST | `/homegroup-assignment/mirror` | ✓ | Copy one week's home group assignments to another |
| GET | `/split-scheduling` | ✓ | SPLIT camper AM period assignment manager |
| POST | `/save-split-assignments` | ✓ | Save SPLIT period assignments |
| POST | `/split-field-trip/mark` | ✓ | Flag today as a SPLIT field trip |
| POST | `/split-field-trip/clear` | ✓ | Remove today's SPLIT field trip flag |
| GET | `/audit` | ✓ | Audit page — flags scheduling issues |
| GET | `/counselor-week-assignments/:week` | ✓ | Ajax: get all assignments for a given week |

---

## Offerings & Sync

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| POST | `/upload-weekly-offerings` | ✓ | CSV upload for weekly offerings |
| POST | `/clear-weekly-offerings` | ✓ | Remove offerings for the active week |
| POST | `/api/sync-offerings` | ✓ | Alias for sync (JSON response) |
| POST | `/sync-offerings-from-schedule` | ✓ | Rebuild `WeeklyOfferings` from `Schedules` for the active week |

---

## Counselor Preferences

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/counselor-preferences` | ✓ | View all counselor preferences |
| POST | `/counselor-preferences` | ✓ | Save preferences for one counselor |
| GET | `/api/counselor-preferences/:id` | ✓ | Ajax: get preferences for one counselor |

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
| GET | `/attendance` | | Attendance overview |
| GET | `/attendance/homegroup/counselor/:counselorId/:session` | | Home group roster by counselor |
| GET | `/attendance/homegroup/:color/:session` | | Home group roster by color |
| GET | `/attendance/specialty/:color/:session` | | Specialty program roster |
| GET | `/attendance/class/:period/:activity` | | Class attendance sheet |
| GET | `/attendance/bus/:route/:session` | | Bus route attendance |
| GET | `/attendance/extended/:session` | | Extended care attendance |
| GET | `/attendance/late-arrivals` | | Late arrival check-in |
| POST | `/attendance/check-in` | | Mark a late arrival as present |
| POST | `/attendance/mark` | | Mark a camper present or absent on any roster |
| POST | `/attendance/early-dismissal` | | Log an early dismissal for today |
| GET | `/attendance/dismissal-archive` | | Historical dismissal log |

---

## Dismissals

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/dismissals` | | Today's pending dismissals |
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
| POST | `/update-session-label` | ✓ | Edit week label and start date |
| POST | `/clear-counselor-week` | ✓ | Clear assignments for a week |
| POST | `/clear-counselor-schedule` | ✓ | Clear the full counselor schedule |
| POST | `/clear-counselor-homegroups` | ✓ | Clear home group assignments for the active week |
| POST | `/create-staff` | ✓ | Add a new staff member |
| POST | `/create-camper` | ✓ | Add a new camper |
| GET | `/assign-camper-schedule/:id` | ✓ | Assign class schedule to a new camper |
| GET | `/get-new-camper-options/:camperId/:period` | ✓ | Ajax: available classes for new camper scheduling |
| GET | `/assign-camper-class` | ✓ | Ajax: assign a class to a new camper |
| POST | `/upload-activity-rules` | ✓ | CSV bulk import for activities |
| POST | `/add-activity` | ✓ | Add a single activity |
| POST | `/delete-activity/:name` | ✓ | Delete an activity |
| POST | `/update-activity` | ✓ | Update activity fields |
| POST | `/add-activity-period-group` | ✓ | Add a per-period group override for an activity |
| POST | `/delete-activity-period-group` | ✓ | Remove a per-period group override |
| POST | `/upload-campers` | ✓ | CSV import for camper roster (ACR-005) |
| POST | `/upload-campers-schedule` | ✓ | CSV import for master schedule |
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

---

## Photos

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/photo-day` | | Photo of the Day upload page |
| POST | `/photo-day` | | Upload a photo |
| GET | `/photo-gallery` | | Browse photos; staff can vote |
| POST | `/photo-vote/:id` | | Cast or remove a vote |

---

## Debug

| Method | Path | Admin only | Description |
|---|---|:---:|---|
| GET | `/debug-hg` | ✓ | Debug endpoint: dump home group assignment data |
