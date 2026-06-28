# Camp Hub — Claude Instructions

## After every code change, update documentation if relevant

When a change affects user-facing behavior, routes, or the database schema, update the appropriate files before reporting the task complete:

### Admin User Guide (`README.md`)
Update when:
- A new page or feature is added or removed
- A workflow step changes (e.g. import order, scheduling steps)
- Attendance symbols, CSV formats, or profile editing behavior changes

### Technical Wiki (`wiki/*.md`)
Update the relevant page(s) when:
- A table is added, removed, or a column is added/changed
- A route is added, removed, or its behavior changes
- Auth or session logic changes
- A migration is added or removed
- The import pipeline changes

Relevant wiki pages by change type:
- Schema change → `wiki/Database-Schema.md` and `wiki/Data-Model.md`
- New/changed route → `wiki/Routes-Reference.md`
- Scheduling logic → `wiki/Scheduling-System.md`
- Sessions/weeks → `wiki/Sessions-and-Weeks.md`
- Attendance/health → `wiki/Attendance-and-Health.md`
- Auth/view mode → `wiki/Auth.md`
- Import/migration → `wiki/Data-Import.md`
- People/roles → `wiki/People-and-Roles.md`

### Push wiki changes to GitHub
After updating any `wiki/*.md` file, push to the wiki repo:

```powershell
cp "c:/Users/benja/Documents/GitHub/sp-daily-memo/wiki/*.md" "c:/Users/benja/Documents/GitHub/sp-daily-memo.wiki/"
cd "c:/Users/benja/Documents/GitHub/sp-daily-memo.wiki"
git add .
git commit -m "Update wiki: <brief description>"
git push
```
