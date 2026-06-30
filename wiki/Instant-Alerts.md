# Instant Alerts

Admins can send real-time push notifications to staff groups or individuals from the **Alerts** page (`/alerts`). All alerts are logged for review.

---

## Sending an Alert

1. Navigate to **Alerts** from the admin nav bar.
2. Type a message (max 200 characters).
3. Choose a target:
   - **Group** — select from the system groups or any custom group you have created.
   - **Individual** — select a single counselor by name.
4. The preview beneath the selector shows:
   - **Group members (N):** the names of everyone in the group.
   - **Push subscribers:** how many of those members have an active push subscription and will receive the notification immediately.
5. Click **Send Alert**.

Counselors without a push subscription will not receive the push notification but will still appear in the member count. Use the [Counselor Preferences Summary](Routes-Reference.md) page (`/counselor-preferences-summary`) to see which counselors have subscribed — the 🔔 Alerts column shows a ✓ for each subscribed counselor.

---

## System Groups

Seven groups are seeded automatically at startup. They cannot be deleted or renamed. Each is resolved dynamically at send-time against live data for the active week.

| Group | Who it targets |
|---|---|
| All Counselors | `Counselors` where `StaffRole IN ('Counselor', 'Swim Counselor')` |
| All Unit Leaders | `Counselors` where `StaffRole = 'Unit Leader'` |
| All Admin | Names in `AdminUsers` matched to a `Counselors` row by full name |
| All AM Sports | Active-week `CounselorWeekAttributes` with `ScheduleType` in `All Sports`, `AM Sports / PM Enrichment`, `AM Sports Only` |
| All PM Sports | …`All Sports`, `AM Enrichment / PM Sports`, `PM Sports Only` |
| All AM Enrichment | …`All Enrichment`, `AM Enrichment / PM Sports`, `AM Enrichment Only` |
| All PM Enrichment | …`All Enrichment`, `AM Sports / PM Enrichment`, `PM Enrichment Only` |

---

## Custom Groups

Admins can create named groups with any selection of counselors as members.

- **Create:** Use the *New Custom Group* form at the bottom of the Custom Groups card. Enter a name and check the counselors to include.
- **Edit members:** Expand an existing custom group and update the checkboxes, then click **Save Members**.
- **Delete:** Click the **Delete** button on a custom group. System groups cannot be deleted.

Custom group membership is stored in `AlertGroupMembers` and is not week-scoped — the same member list applies across all weeks.

---

## Admin Hub Banner

When an alert is sent to the **All Admin** group, a red banner appears at the top of the admin hub (`/admin`) for every admin currently logged in — regardless of whether they have push notifications enabled. The banner is updated every 30 seconds via polling.

- **Dismiss:** Click the Dismiss button on the banner. The banner will not reappear for that alert in the current browser session.
- The banner will reappear in a new browser session or if a newer All Admin alert is sent.

---

## Alert History

The bottom of the Alerts page shows the 50 most recent sent alerts with:

| Column | Description |
|---|---|
| Message | The alert text |
| Target | Group name or individual counselor name |
| Sent by | Admin name at time of send |
| Time | Timestamp in Eastern time |
| Delivered | Number of push subscription endpoints the notification was dispatched to |

---

## Push Subscription Setup

Staff subscribe automatically when they first open any page in **staff view** on a browser that supports Web Push (Chrome, Edge, Firefox, Safari 16.4+). They are prompted to allow notifications. Once allowed, the browser registers a subscription and it is stored in `PushSubscriptions` linked to their `selectedCounselor` cookie.

Subscriptions are per-browser, per-device. A counselor who uses two devices will appear twice in the subscriber count. Stale subscriptions (returned 410/404 by the push service) are automatically removed.
