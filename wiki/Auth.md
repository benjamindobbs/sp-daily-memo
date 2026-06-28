# Authentication & Authorization

How the app distinguishes admin users from staff users, and how routes are protected.

---

## Two-Layer Access Model

The app has two independent concepts that are often confused:

| Concept | Cookie | What it controls |
|---|---|---|
| **View mode** | `viewMode` | Which UI the user sees (`admin` or `staff`). Anyone can switch with a form button. |
| **Admin auth** | `adminAuth` | Whether the user can access admin-only routes. Requires the login form. |

---

## View Mode (`viewMode` cookie)

Set by `POST /choose-view`. Value is either `'admin'` or `'staff'`.

- Does **not** protect routes — it only controls what the template renders.
- Available in every EJS template as `viewMode` (set via `res.locals` in middleware at line 231 of `app.js`).
- Default when the cookie is absent: `'staff'`.

Templates use `viewMode` to show or hide admin-only UI elements (edit forms, delete buttons, admin nav links) without a separate database lookup. A user in staff view visiting an admin URL directly would be stopped by route-level auth (below), not by `viewMode`.

---

## Admin Authentication (`adminAuth` cookie)

Set to `'true'` by `POST /admin-login` after the submitted name is found in `AdminUsers`.

`AdminUsers` is a simple allowlist table:
```sql
AdminUsers (id INTEGER PK, name TEXT UNIQUE)
```
There are no passwords. The login form accepts a name and checks it against this table. If the name matches, `adminAuth=true` is set as a cookie.

`GET /logout` clears `adminAuth` (and `viewMode`) and redirects to the splash page.

---

## Route Protection Middleware

After the cookie is set, every request passes through this middleware (app.js ~line 283):

```js
const UNPROTECTED = new Set(['/admin-login', '/logout', '/choose-view', '/']);

app.use((req, res, next) => {
    if (UNPROTECTED.has(req.path)) return next();
    const isAdminPath = ADMIN_ONLY_PREFIXES.some(
        p => req.path === p || req.path.startsWith(p + '/')
    );
    if (isAdminPath && req.cookies.adminAuth !== 'true') {
        return res.redirect('/admin-login');
    }
    next();
});
```

If a request path matches any entry in `ADMIN_ONLY_PREFIXES` and `adminAuth` is not `'true'`, the user is redirected to `/admin-login`.

The check is prefix-based: `/admin` in the list protects `/admin`, `/admin/anything`, etc.

---

## ADMIN_ONLY_PREFIXES

The full list (from `app.js` lines 255–281):

```
/admin                    /settings               /swap-tool
/process-swap             /get-options            /schedule-history
/archive-schedule-changes /staff-lookup           /faculty-summer
/upload-staff-week        /clear-staff-week       /counselor-directory
/counselor-view           /promotions             /promote-waitlist
/promote-all              /remove-waitlist        /upload-campers
/upload-campers-schedule  /upload-counselors      /upload-staff
/upload-instructors       /upload-activity-rules  /add-activity
/delete-activity          /update-activity        /add-activity-period-group
/delete-activity-period-group
/counselor-scheduling     /upload-weekly-offerings /clear-weekly-offerings
/sync-offerings-from-schedule /api/sync-offerings
/save-counselor-assignments   /backup-counselor-assignments
/counselor-schedule-backups   /restore-counselor-backup
/delete-counselor-backup      /export-counselor-schedule
/export-staff-schedule        /export-master-schedule
/save-counselor-group-assignments /auto-assign-homegroups
/hub-content              /director-notes         /photo-gallery
/photo-vote               /set-active-week        /set-released-week
/update-session-label     /clear-counselor-week   /counselor-week-assignments
/clear-counselor-schedule /clear-counselor-homegroups
/audit                    /merge-class            /set-activity-side
/delete-counselor         /update-staff-info      /update-staff-period
/remove-staff-period      /homegroup-assignment
/attendance/dismissal-archive
/dismissals               /nurse                  /nurse/archive
/case-log                 /case-log/archive
/split-scheduling         /save-split-assignments
/reports                  /upload-pdf
/create-staff             /create-camper          /assign-camper-schedule
/get-new-camper-options   /assign-camper-class
```

---

## Routes Open to Staff (No Auth Required)

Routes not in `ADMIN_ONLY_PREFIXES` and not in `UNPROTECTED` are accessible to all users:

| Path | What it serves |
|---|---|
| `/staff` | Staff hub |
| `/master-schedule` | Master schedule (read-only filter view) |
| `/class-roster/:period/:activity` | Class roster (read-only) |
| `/search` | Camper lookup |
| `/camper/:id` | Camper profile (read-only in staff view) |
| `/counselor-profile/:id` | Staff profile (read-only in staff view) |
| `/attendance` | Attendance overview |
| `/attendance/homegroup/*` | Home group attendance |
| `/attendance/specialty/*` | Specialty attendance |
| `/attendance/class/*` | Class attendance |
| `/attendance/bus/*` | Bus attendance |
| `/attendance/extended/*` | Extended care attendance |
| `/attendance/late-arrivals` | Late arrivals check-in |
| `/attendance/mark` | Mark attendance (available to all logged-in staff) |
| `/attendance/early-dismissal` | Log dismissal from any roster |
| `/docs` | Document hub |
| `/pdf/:type` | View a PDF |
| `/photo-day` | Photo of the Day upload (staff can submit) |
| `/split-field-trip/mark` and `/clear` | SPLIT field trip flag |

---

## Template Helpers

Set in the `res.locals` middleware and available in every EJS template:

| Helper | Purpose |
|---|---|
| `viewMode` | `'admin'` or `'staff'` — drives conditional UI rendering |
| `fmtTime(s, dateOnly)` | Format a SQLite datetime string to Eastern Time |
| `fmtTimeOnly(s)` | Format a SQLite datetime to time-only (Eastern) |
| `fmtPickupTime(t)` | Format a `HH:MM` string to `12:00 PM` format |
