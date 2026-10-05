# Schedule — session plan

Nineteen sessions. Scope, data model and reasoning live in `SCHEDULE_SCOPE.md`; read that first if anything here seems arbitrary. Conventions come from `CLAUDE.md`, which Claude Code loads automatically.

**Outstanding follow-up:** session 13 shipped recurrence with no UI — the rules, table and spawning logic all work, but there is no way to create a recurring task. Run the follow-up prompt before relying on it.

**Status: sessions 1–9 complete, plus 6b. Next up: 9a (timetable detail) → 9b (schedule shell) → 9c (drafting language) → session 10.**

The working-hours gap noted after session 4 is closed — `static/schedule/hours-editor.js` and the draggable bands in `calendar.js` both landed in session 9. Keep the distinction in mind regardless: `location_hours` is when a *place* is open, `working_hours` is when *you* are willing to work, and a later session will try to merge them.

**Built beyond the plan, all sensible:** `schedule/settings.js` and `bedtime-watch.js`; the calendar extended through 12am–4am so late events render; a scoped schedule reset (`test_schedule_reset.py`) for clearing test data without touching the archive.

---

## How to run a session

Same loop as `DEVELOPMENT_PLAN.md`: commit any doc changes on `test-widget-dock` first, `/clear`, set the model and level, paste **only that session's prompt**, check the exit criteria before merging, then delete the worktree and branch so the next session cuts a fresh one.

Do not give Claude Code this file or the scope document. The prompts are self-contained and name what to read.

### Models and levels

Two different levers. **Thinking level buys care** — working through edge cases rather than rushing. **A stronger model buys the ability to hold many interacting constraints in mind at once** and get the shape right in one pass. Most sessions below have their shape fixed by the prompt, so the level does the useful work and Sonnet is right.

| Model | Sessions | Why |
|---|---|---|
| Opus | 5, 6, 9c, 9d, 11b | The scheduler and its constraints, and the visual work. Several dimensions interacting at once, where a structural mistake is expensive downstream and a spec cannot fully pre-empt a bad interaction. |
| Sonnet | everything else | Shape already fixed by the prompt; the level does the work. |

| Level | Sessions |
|---|---|
| `medium` | 3, 10, 11, 12, 13, 14, 19 |
| `high` | 1, 2, 4, 6b, 7, 8, 9, 9a, 9b, 15, 16, 16b, 17, 18 |
| `max` | 5, 6, 9c, 9d, 9e, 11b |
| `ultracode` | none — reserve for a debugging emergency |

**Opus earns its cost more on debugging than on building.** Against a detailed prompt, Sonnet builds well. When a session's output misbehaves in a way you cannot immediately explain — the scheduler placing things oddly, a replan that is not idempotent, a constraint firing when it should not — that is when to switch models and re-open the problem. Reaching for it by default spends budget on work the prompt has already de-risked.

---

## Phase 1 — Foundations

### Session 1 — Schema and task API

**Delivers:** every table, its `db.py` functions, its routes, and tests. No UI.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read db.py in full, app.py's route style, config.py and tests/conftest.py
before writing anything. Follow the existing conventions exactly: schema string
constants at the top of db.py, registered in init_db(), raw sqlite3 through
get_conn(), no ORM, comments that explain why rather than what.

Add the schedule data layer. Tables:

  deliverables       id TEXT PK, project_id TEXT NOT NULL, title TEXT NOT NULL,
                     description TEXT, due_at TEXT, weighting REAL,
                     spec TEXT, position INTEGER NOT NULL DEFAULT 0
  tasks              id TEXT PK, project_id TEXT, deliverable_id TEXT,
                     title TEXT NOT NULL, description TEXT, measurable_goal TEXT,
                     deadline TEXT, required_location_id TEXT,
                     support_level TEXT NOT NULL DEFAULT 'independent',
                     est_minutes INTEGER, importance INTEGER, difficulty INTEGER,
                     is_finishing INTEGER NOT NULL DEFAULT 0,
                     status TEXT NOT NULL DEFAULT 'pending',
                     recurrence_id TEXT, continues_task_id TEXT,
                     slip_count INTEGER NOT NULL DEFAULT 0,
                     est_minutes_source TEXT, importance_source TEXT,
                     difficulty_source TEXT, created_at TEXT NOT NULL
  task_dependencies  task_id TEXT, depends_on_task_id TEXT   PK (both)
  task_actuals       task_id TEXT PK, actual_minutes INTEGER,
                     actual_difficulty INTEGER, actual_importance INTEGER,
                     completed_at TEXT NOT NULL, notes TEXT
  scheduled_blocks   id TEXT PK, task_id TEXT NOT NULL, start TEXT NOT NULL,
                     end TEXT NOT NULL, is_locked INTEGER NOT NULL DEFAULT 0,
                     kind TEXT NOT NULL DEFAULT 'task', generated_at TEXT NOT NULL
  commitments        id TEXT PK, title TEXT NOT NULL, start TEXT NOT NULL,
                     end TEXT NOT NULL, kind TEXT, location_id TEXT,
                     support_level TEXT NOT NULL DEFAULT 'none',
                     source TEXT, external_uid TEXT, energy_cost INTEGER
  locations          id TEXT PK, name TEXT NOT NULL, address TEXT,
                     travel_minutes_from_home INTEGER, notes TEXT
  location_hours     location_id TEXT, weekday INTEGER, opens TEXT, closes TEXT
                     PK (location_id, weekday)
  location_overrides id TEXT PK, location_id TEXT NOT NULL, date TEXT NOT NULL,
                     opens TEXT, closes TEXT, closed INTEGER NOT NULL DEFAULT 0
  location_travel    from_location_id TEXT, to_location_id TEXT,
                     minutes INTEGER NOT NULL  PK (from_location_id, to_location_id)
  recurrence_rules   id TEXT PK, interval_days INTEGER NOT NULL,
                     window_days INTEGER NOT NULL DEFAULT 1,
                     preferred_time TEXT, active INTEGER NOT NULL DEFAULT 1
  resources          id TEXT PK, name TEXT NOT NULL, location_id TEXT,
                     url TEXT, notes TEXT, date_added TEXT NOT NULL
  resource_items     resource_id TEXT, item TEXT, tags TEXT
                     PK (resource_id, item)
  briefs             id TEXT PK, project_id TEXT NOT NULL, filepath TEXT,
                     extracted TEXT, imported_at TEXT NOT NULL
  daily_capacity     date TEXT PK, inferred_energy INTEGER, manual_energy INTEGER,
                     available_minutes INTEGER

Indexes on tasks(project_id), tasks(deliverable_id), tasks(status),
scheduled_blocks(task_id), scheduled_blocks(start), commitments(start),
deliverables(project_id), location_hours(location_id).

Semantics the comments must state, because each is easy to "fix" wrongly:

- tasks.project_id is NULLABLE. A task without a project is normal, and competes
  for the same hours as project work. Do not make it required.
- Every estimated field records its SOURCE ('user' or 'generated'). A duration
  you set and one Claude guessed must be distinguishable, or the estimator will
  later train on its own output.
- task_actuals is a separate table, not columns on tasks. It is derived data
  with its own lifecycle -- the same reasoning that keeps colour_analysis out of
  reference_items.
- scheduled_blocks is the scheduler's OUTPUT, regenerated wholesale on every
  replan. A replan must never mutate a task row. kind distinguishes 'task' from
  'travel' blocks.
- status is exactly: pending | scheduled | done | partial | abandoned.
- continues_task_id chains a remainder task back to the partial it continues.
- support_level on a commitment is priority | ambient | none; on a task it is
  needs | prefers | independent. They are different vocabularies on purpose --
  one describes a window, the other a requirement.
- deliverables.spec is JSON, not columns, because brief formats change yearly.

Cascades: deleting a project deletes its deliverables and briefs, and NULLs
project_id on its tasks rather than deleting them (the work may still matter).
Deleting a task deletes its dependencies, actuals and scheduled blocks. Deleting
a deliverable NULLs deliverable_id on its tasks. Deleting a location NULLs
required_location_id and removes its hours, overrides and travel rows.

Routes in app.py, matching the existing thin-wrapper style:
  GET/POST         /api/tasks                    (list supports filters)
  GET/PUT/DELETE   /api/tasks/<id>
  POST/DELETE      /api/tasks/<id>/dependencies
  GET/POST         /api/projects/<pid>/deliverables
  PUT/DELETE       /api/deliverables/<id>
  GET/POST         /api/locations   PUT/DELETE /api/locations/<id>
  GET/PUT          /api/locations/<id>/hours
  POST/DELETE      /api/locations/<id>/overrides
  GET/PUT          /api/travel
  GET/POST         /api/commitments   PUT/DELETE /api/commitments/<id>
  GET/POST         /api/resources   PUT/DELETE /api/resources/<id>
  POST/DELETE      /api/resources/<id>/items

Reject a dependency that would create a cycle, with a 400 naming the tasks
involved. Write the cycle check in db.py so the scheduler can reuse it.

Tests in tests/test_schedule.py using the existing archive and client fixtures:
cycles are rejected; a task survives its project's deletion with a null
project_id; deleting a task removes its dependencies, actuals and blocks;
source flags round-trip; status rejects an unknown value.

Run the whole pytest suite.
````

**Exit criteria:** `pytest` green, every table present, cycle rejection works, no cascade leaves orphans.

---

### Session 2 — Task entry and completion

**Delivers:** the one-field entry flow, generated chips, and one-tap completion with the three outcomes stubbed to `done` only.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read the task routes from session 1, static/index.html, static/app.js,
static/shared/cards.js, tagging.py (for the Claude call pattern) and
static/style.css first.

Build task entry and completion. A new tab in index.html, alongside Add /
Archive / Projects / Settings.

1. Entry has exactly ONE required field: a sentence describing the task.
   Everything else -- deadline, project, deliverable, location, importance,
   difficulty, estimate, measurable goal, support level -- is optional.

   This is the core interaction and the thing most likely to be built wrong.
   Do NOT build a form with many fields where most are blank. Build a single
   text input that accepts a sentence and a Save button. Optional fields sit
   behind a disclosure that is closed by default.

2. On save, anything left blank is generated by Claude from the description, in
   a new module task_ai.py following tagging.py's pattern -- same client, same
   config.CLAUDE_MODEL, same error handling. It returns est_minutes, importance,
   difficulty, a suggested title, and a measurable goal.

   Every generated field is stored with its *_source set to 'generated'.
   Anything the user supplied is 'user'. This distinction is load-bearing later;
   do not collapse it.

3. Generated values appear as editable CHIPS on the saved task -- a row of small
   controls showing "2h", "importance 3", "difficulty 4" -- visually marked as
   generated, each editable in place. Editing one flips its source to 'user'.
   They are never presented as a form to fill in before saving.

4. Completion must be ONE TAP. A Done control on a task records:
     actual_minutes    defaulting to the scheduled block's length, or the
                       estimate if unscheduled
     actual_difficulty defaulting to the task's difficulty
     actual_importance defaulting to the task's importance
   with an inline way to correct any of the three. If recording actuals is a
   chore it will not happen, and the estimator never improves. One tap must be
   sufficient; correction is optional.

   Session 7 adds partial and not-completed. For now Done is the only outcome.

5. A task list showing what exists, filterable by project and status. Plain and
   fast -- the calendar views come later and are where browsing really happens.

Use the existing neumorphic custom properties. Follow CLAUDE.md's rules: no
build step, relative fetch paths, nothing in localStorage.
````

**Exit criteria:** a task can be created from one sentence, generated fields are visibly generated and editable, completion is one tap, sources are recorded correctly.

---

### Session 3 — Locations, hours and travel

**Delivers:** locations with opening patterns, date overrides, and pairwise travel.

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.6 window

````
Read the location routes from session 1 and static/style.css first.

1. A locations UI: name, address, travel minutes from home, notes. Reachable
   from the schedule tab.

2. Weekly opening hours per location -- a row per weekday with open and close
   times, or closed. The studio is roughly 10:00-18:00 most days; the library
   differs; home is always open.

3. Date overrides: a specific date closing early or closed entirely. These are
   exceptions to the weekly pattern and must win over it. Keep entry fast --
   this gets used when an email says the studio shuts at 16:00 on Thursday.

4. Pairwise travel. travel_minutes_from_home covers home->X and X->home, which
   is the first and last leg of any day. It cannot express studio->fabric shop.
   Add a small editor for the handful of pairs actually travelled.

   A pair with no row falls back to via-home (from + to). State in a comment
   that this is deliberately pessimistic: if it produces a silly number, the fix
   is to add the pair, not to invent a distance model. There are no coordinates
   in this system and there is no routing API.

   Treat travel as symmetric unless a row says otherwise -- store one row per
   ordered pair but offer to write both directions when adding.

5. A helper in a new module scheduling.py: travel_minutes(from_id, to_id)
   applying the rules above, returning 0 for the same location and for a null
   on either side. The scheduler will lean on this heavily.

Tests: overrides beat weekly hours; via-home fallback works; same-location
travel is zero; a missing location does not raise.
````

**Exit criteria:** hours and overrides resolve correctly for any date, and `travel_minutes` is right for direct pairs, fallbacks and edge cases.

---

### Session 4 — Commitments, ICS import and capacity

**Delivers:** the university timetable in, support levels on sessions, and daily energy.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read the commitments routes from session 1, config.py, requirements.txt and
scheduling.py first.

1. ICS import. Accept an uploaded .ics file or a feed URL, parse it into
   commitments, and re-sync without duplicating -- match on the event UID
   (stored in external_uid) and update rather than insert. Deleting an event
   upstream should remove it locally on re-sync.

   Add the ICS library to requirements.txt. Keep it small; do not pull a
   calendar framework.

   Timezones matter and are easy to get wrong. Store times in a single
   consistent form and say in a comment which. A lecture at 09:00 local must
   not drift by an hour when the clocks change.

2. Support level on commitments. A timetabled studio session is not just busy
   time -- it is a window where a tutor is present and you have priority for
   their attention. Classify each imported commitment as:
     priority  your timetabled session at that location
     ambient   staff usually around but you are deprioritised
     none      ordinary busy time
   Import cannot know this reliably from a title, so default to 'none' and give
   a fast way to reclassify in bulk -- selecting several sessions and setting
   their level and location together. Reclassification must survive re-sync.

3. Manual commitments for anything not in the feed, with the same fields.

4. Daily capacity. For each day compute available_minutes from working hours
   minus commitments, and an inferred energy level.

   Energy inference must stay SIMPLE AND LEGIBLE. A commitment carries an
   energy_cost; a high-cost commitment ending late reduces the following
   morning's energy. That is the whole rule. A scheduler that guesses subtly is
   worse than one that guesses obviously, because you can correct the obvious
   one. Do not add a model here.

5. Manual override per day, which always wins over the inferred value, with an
   obvious control and an equally obvious way to clear it back to inferred.

Tests: re-syncing the same ICS twice produces no duplicates; an upstream
deletion is removed; a manual reclassification survives re-sync; a manual energy
override wins; capacity subtracts commitments correctly.
````

**Exit criteria:** a real timetable imports and re-syncs cleanly, support levels stick, and each day has a capacity and an energy value.


---

## Phase 2 — The scheduler

### Session 5 — Scheduler core

The session everything else rests on. If placement feels wrong, no amount of UI rescues it.

**Model:** Opus 5, `max` · 4–5 h · 350–500k tokens · 1–1.5 windows
**Sonnet fallback:** Sonnet 5 at `max` is viable — the algorithm is specified in full below. Split as 5a/5b if it overruns.
**If it overruns:** stop at a working state and commit. 5a = topological sort, scoring, day walk and placement; 5b = detail decay, at-risk and the API.

````
Read scheduling.py, db.py's task and commitment functions, and
SCHEDULE_SCOPE.md's scheduler section before writing code. Think carefully about
the algorithm before typing.

Build the scheduler in scheduling.py. Pure Python and numpy if useful, no new
dependency, no solver library. It must be deterministic and testable offline
exactly like the existing suite.

Input: incomplete tasks, deliverables, commitments, location hours, daily
capacity, and a horizon running to the FURTHEST project deadline -- not a fixed
window. Projects here run five to six weeks.

Algorithm:

1. Topologically sort tasks by dependency. Reuse the cycle check from session 1;
   a cycle is an error naming the tasks, never a silent reorder.

2. Score each task as urgency x importance. Urgency is a function of SLACK --
   time until deadline minus estimated duration -- not raw deadline. A task due
   Friday needing four days is more urgent than one due Thursday needing an
   hour. Getting this backwards is the most common way a scheduler feels wrong,
   so write the slack formula deliberately and comment why.

3. Walk days forward from today. For each day: subtract commitments from
   available minutes, read the day's energy, and build the eligible set --
   tasks whose dependencies are already placed earlier and whose difficulty the
   day's energy admits.

4. Place the highest-scoring eligible task into the first slot that fits.
   Repeat until the day is full or nothing is eligible.

5. Anything that cannot be placed before its deadline goes on the AT-RISK list,
   reported per task and aggregated per deliverable.

Three properties that are requirements, not niceties:

DETERMINISM. The same inputs must always produce the same schedule. Iterate
tasks in a stable id-sorted order and break every tie by id. State this in a
comment. Without it the schedule shuffles between replans and stops feeling
trustworthy.

DETAIL DECAYS WITH DISTANCE. Days in the near term are placed to the slot;
beyond roughly a week, tasks are allocated to a day without a specific time.
Precision five weeks out is false and rewriting it daily wastes effort. Make
the threshold a named constant.

AT-RISK IS THE POINT. Being told in week three that Part 2 is unreachable is
worth more than any amount of clever packing. It is a first-class return value,
not a warning tucked in a corner.

Energy gates difficulty: a low-energy day admits only low-difficulty work. Use
a simple, legible mapping from energy level to maximum admissible difficulty
and put it in one place so it can be tuned.

Route: POST /api/schedule/plan runs the scheduler and replaces scheduled_blocks
wholesale. GET /api/schedule returns blocks in a date range plus the at-risk
list. The scheduler must never mutate a task row -- blocks are its only output.

Tests in tests/test_scheduling.py, all offline: a dependency is never scheduled
before what it depends on; the same input twice gives byte-identical output; a
task with no slack lands on the at-risk list; a low-energy day refuses a
high-difficulty task; an empty task set returns an empty schedule rather than
raising; a task longer than any available day is flagged rather than silently
dropped.
````

**Exit criteria:** dependencies always respected, output reproducible, at-risk correct, and a hand-check of a realistic six-week project produces a schedule you would actually follow.

---

### Session 6 — Location, support, travel and finishing constraints

**Delivers:** the constraints that make the schedule fit your actual working life.

**Model:** Opus 5, `max` · 3–4 h · 250–350k tokens · ~1 window
**Why Opus:** four constraints layered onto one day walk. The failure mode is a bad *interaction* between two of them rather than any single one being wrong, which is what a spec cannot fully pre-empt.

````
Read scheduling.py as session 5 left it, plus the location and support sections
of SCHEDULE_SCOPE.md.

Add four constraints to the day walk. Each changes eligibility or placement;
none should require restructuring the algorithm.

1. REQUIRED LOCATION is a hard constraint, distinct from travel cost. A task
   with required_location_id can only be placed inside that location's open
   hours for that date, honouring overrides. Pattern cutting cannot happen at
   home, so a task requiring the studio is never placed at 22:00.

2. SUPPORT MATCHING. A window's support level and a task's requirement are
   different vocabularies and must be matched, not compared:
     task 'needs'       -> only inside a commitment with support 'priority'
     task 'prefers'     -> 'priority' or 'ambient', preferring priority
     task 'independent' -> any open hours
   A 'needs' task with no priority window before its deadline goes on the
   at-risk list with that as the stated reason -- this is a distinct failure
   from "no time", and saying which matters.

3. TRAVEL. When consecutive blocks sit at different locations, insert a travel
   block using scheduling.travel_minutes(). Travel blocks are real rows in
   scheduled_blocks with kind='travel', visible in the calendar -- not time
   deducted invisibly. A day that is full because of three trips should look
   full and explain itself.

   The first leg of a day comes from home and the last returns to it.

   Travel consumes capacity but is NOT work. Never fold travel minutes into a
   task's duration: the estimator learns from task durations, and padding them
   with travel would poison it.

4. SAME-LOCATION TIE-BREAK. Among eligible tasks of comparable score, prefer
   one at the location you are already at. Without this, a greedy urgency-first
   walk sends you studio -> shop -> studio in a day, and splits two fabric-shop
   visits across two days when they could be one trip. Define "comparable"
   as a named tolerance constant rather than exact equality, or the tie-break
   almost never fires.

   Do not implement pulling an already-placed task forward to join a trip. That
   needs the walk to reconsider its own output and is out of scope here.

5. PROTECTED FINISHING TIME. A configurable buffer before each deadline is
   available ONLY to tasks flagged is_finishing. Ordinary work cannot occupy it
   however far behind you are -- being behind is exactly when it would
   otherwise be taken, and that is precisely how finishing work gets squeezed.

   If the buffer is empty and finishing tasks exist elsewhere, pull them in. If
   finishing tasks overflow the buffer, that is an at-risk condition.

Tests: a studio task never lands outside studio hours; an override closing the
studio early moves it; a 'needs' task refuses an ambient window; travel appears
as its own block and is excluded from task actuals; the tie-break groups two
same-location tasks that would otherwise be split; ordinary work cannot enter
the finishing buffer even when everything is late.
````

**Exit criteria:** a realistic week places studio work in studio hours, groups trips sensibly, shows travel, and reserves the run-up to a deadline.

---

### Session 6b — Personal events, home-first chains and domestic work

**Delivers:** commitments you add yourself, the travel-and-prep chain before going out, domestic tasks, the domestic hours band, and work breaks.

**Why after 6:** it builds directly on session 6's travel insertion and band handling. Doing it before means writing travel logic twice.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read scheduling.py as sessions 5 and 6 left it, the commitments routes and
schema, static/calendar-import.js, static/tasks.js, and SCHEDULE_SCOPE.md's
"Time bands, personal events and domestic work" section first.

1. PERSONAL EVENTS. A commitment you add by hand -- going out, a haircut, a
   train. Schema additions: commitments gains home_first INTEGER and
   prep_minutes INTEGER.

   The entry form is PLAIN: title, start, end, optional location, home_first,
   prep_minutes. No estimation, no generated chips, NO CLAUDE CALL. These have
   no difficulty, importance or deliverable and nothing about them needs
   labelling. Do not route this through task_ai.py, and do not reuse the task
   entry flow -- they are different things that happen to both occupy time.

   They are immovable and may sit ANYWHERE, including outside working hours.
   Setting or narrowing working hours later must never dislodge an evening
   already committed to. Test that specifically.

2. HOME-FIRST CHAINS. When home_first is set, the scheduler inserts immovable
   blocks working BACKWARDS from the event's start time -- the time entered is
   the start of the event itself, not of the preparation:

     [ travel to home ] -> [ get ready, prep_minutes ] -> [ travel home to venue ] -> event

   The entered time is ALWAYS when you need to BE there, never when you leave.
   The chain is sized so the last leg lands you at the venue at that time.

   - the leading travel block is OMITTED if the schedule already has you at
     home when the chain begins -- there is nothing to travel
   - the venue leg needs a location to size it. When home_first is set, PROMPT
     for a location rather than silently omitting the leg -- an event with no
     location produces a chain that is short by exactly the journey, which is
     the one error you would not notice until you were late. If the user
     declines, omit the leg but keep the entered time meaning arrival, and mark
     the chain as incomplete in the UI.
   - use scheduling.travel_minutes() from session 3; do not compute travel a
     second way
   - these blocks are as immovable as the event itself. scheduled_blocks.kind
     gains 'prep'; travel blocks keep kind 'travel'
   - if the chain would start before the previous work block ends, that work
     block must be shortened or moved -- the chain wins. A work block ending at
     19:00 when you are due out at 19:30 having not been home is exactly the
     failure this exists to prevent.

3. DOMESTIC HOURS. A second weekly band beside working hours:
     domestic_hours   weekday, opens, closes    PK (weekday)
     hours_overrides  id, date, band, opens, closes, off
   hours_overrides is a per-date resize of EITHER band -- band is 'working' or
   'domestic'. Session 9 builds the UI for both; this session is the data and
   the placement rules.

4. DOMESTIC TASKS. tasks gains is_domestic INTEGER. Domestic tasks are ordinary
   tasks in every other respect -- estimate, actuals, dependencies all apply --
   but they are placed differently:
     - normally into domestic hours
     - into working hours ONLY when the schedule already has you at home, or
       there is no remaining away-from-home work that day
   The second rule is the point: it stops a food shop being wedged between two
   studio blocks. Domestic work fills gaps working time cannot usefully use,
   rather than competing with project work for the same hours.

   Non-domestic tasks are never placed in domestic hours.

5. BREAKS. Insert a 30-minute break after every 2 hours of UNINTERRUPTED work.
   Make both numbers named constants.

   "Uninterrupted" means consecutive task blocks only. Anything that is not
   task work -- travel, prep, a commitment, an existing break, or a gap --
   resets the counter. Commitments are excluded because they are fixed and
   cannot have a break inserted into them.

   Breaks are real rows with kind='break', visible in the calendar, and they
   consume capacity like anything else.

   A break is skipped ONLY when keeping it would cause a deadline to be missed.
   That is a two-pass placement: plan the day WITH breaks, and if that puts a
   task on the at-risk list, retry that day without them and keep the second
   result only if it clears the risk. Do not drop breaks pre-emptively because
   the day looks tight -- tight is normal, missing a deadline is not. When
   breaks are dropped, say so on the day rather than silently removing them.

Tests: a personal event outside working hours survives working hours being
narrowed afterwards; a home-first chain inserts travel then prep in that order
and ends at the event start; the leading travel block is omitted when already
at home; a venue-less event omits the final leg but still treats the entered time as arrival; work is displaced rather than
overlapping a chain; a domestic task lands in domestic hours by default; a
domestic task may use working hours when the day has no away-from-home work
left; a non-domestic task is never placed in domestic hours; a break appears
after two hours of consecutive task blocks; travel between two work blocks
resets the break counter; breaks are dropped only when keeping them would
miss a deadline, and the day says so when they are.
````

**Exit criteria:** an evening out blocks correctly with its run-up, work never runs into it, and domestic tasks fill gaps rather than competing.

---

### Session 7 — Replan, outcomes, at-risk and pinning

**Delivers:** the daily rewire and the three ways a block resolves.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read scheduling.py, the task routes, and SCHEDULE_SCOPE.md's "three outcomes"
section first.

1. THREE OUTCOMES on a scheduled block, replacing session 2's Done-only:

   COMPLETED -- record actuals as now. A clean data point.

   PARTIALLY COMPLETED -- record the time actually spent, close the original as
   status 'partial', and spawn a remainder task prefilled from it: title,
   description, project, deliverable, location, support level, importance,
   difficulty, is_finishing all inherited and editable, with a fresh estimate
   for what remains. The remainder carries continues_task_id back to the
   original. It enters the schedule like any new task.

   NOT COMPLETED -- the task returns to the pool unchanged and is replanned.
   Increment slip_count. Record NO actual: never starting a task says nothing
   about how long it takes, and writing one would teach the estimator from a
   number that never happened.

2. DEPENDENCIES MUST REPOINT TO THE REMAINDER. If B depends on A and A goes
   partial spawning A', then B now depends on A'. Leave it pointed at A and the
   scheduler treats the work as finished and places B too early. This is the
   single most likely bug in this session -- write the test first.

3. Replan. POST /api/schedule/plan already exists; make it safe to run
   repeatedly. Blocks with is_locked=1 are immovable and everything schedules
   around them. Run it automatically on first load each day, on demand, and
   whenever working or domestic hours change -- narrowing today's band is
   pointless if the schedule does not immediately reflow into it.

   PAST BLOCKS NEED CARE. A block whose time has passed is not automatically
   history: waking late and moving the working day to start at 11:00 leaves
   this morning's 09:00 blocks in the past having never happened. Freezing them
   as though they did is wrong, and silently re-placing something you actually
   did is worse.
     - a past block that was RESOLVED (done, partial, not completed) is history
       and is never rewritten
     - a past block that was never resolved is treated as NOT COMPLETED and
       returns to the pool, incrementing slip_count like any other slip
   Do not ask the user to adjudicate every stale block on load; apply the rule
   and let them correct any they had in fact done.

4. Pinning: a control to lock a block to its slot, and to unlock it.

5. At-risk surface: a prominent list of what cannot fit, grouped by deliverable,
   each with a stated reason -- no time before deadline, no supported window, or
   blocked by an unfinished dependency. A reason the user can act on beats a
   red badge.

6. A task that has slipped three or more times says so on the at-risk surface.
   Repeated slipping usually means it is underestimated, blocked, or being
   placed on days whose energy cannot carry it. Quietly rescheduling forever is
   the failure mode to avoid.

Tests: a partial spawns a remainder with inherited fields; dependents repoint to
the remainder; not-completed writes no actual and increments slip_count; locked
blocks survive a replan; past blocks are untouched; replanning twice with no
changes produces identical output.
````

**Exit criteria:** all three outcomes behave correctly, dependents follow the remainder, and replanning is safe to run repeatedly.

---

### Session 8 — The estimator

**Delivers:** three layers of estimation, honest about which answered.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read task_ai.py from session 2, embeddings.py (particularly embed_text and
query_index), db.py's task_actuals functions, and SCHEDULE_SCOPE.md's estimator
section first.

Build estimation.py with three layers, used in order of available evidence.

1. GLOBAL CALIBRATION. Track the ratio of actual to estimated minutes across all
   completed work. Most people run consistently over, and this single number
   removes most of the error long before per-category data exists. Apply it as a
   correction to any duration estimate.

   Compute it from tasks whose est_minutes_source is 'user' OR 'generated' but
   record the two separately -- if generated estimates are systematically worse,
   that is worth seeing.

   CHAINS. A task completed across several partials must be evaluated as a
   whole: follow continues_task_id, sum actual_minutes across every link, and
   compare that total to the ORIGINAL task's estimate. Evaluating a partial's
   2h against its 3h estimate would teach the model that work is faster than
   estimated, which is backwards.

2. NEAREST NEIGHBOURS. Embed task descriptions through embeddings.embed_text --
   the CLIP text path already exists, so this needs no new dependency or model.
   Store vectors in the existing Chroma collection under a distinct id prefix or
   a separate collection so task vectors never pollute reference search. Find
   the k most similar COMPLETED tasks and use their actuals.

3. CLAUDE. For work unlike anything completed, task_ai.py already estimates from
   the description. This is the fallback, not the default.

Return an estimate WITH its provenance: which layer answered, how many similar
tasks informed it, and a confidence band. The UI shows "about 2h -- low
confidence, 3 similar tasks", never "2h 15m". False precision here is worse than
an honest range, because you will plan around it.

Apply the same three layers to difficulty and importance where unset.

Never train on generated values. A task whose est_minutes_source is 'generated'
and which has no actual contributes nothing -- otherwise the estimator converges
on its own guesses.

Tests: a chain's summed actuals are compared to the original estimate; the
calibration ratio is right on a known set; a task with no neighbours falls
through to Claude; generated-but-uncompleted tasks are excluded from training;
task vectors do not appear in reference search results.
````

**Exit criteria:** estimates improve as actuals accumulate, chains are handled correctly, and the UI never implies more precision than exists.


---

## Phase 3 — Views and the rest of v1

### Session 9 — Week view

Builds the calendar component the next two sessions reuse, so it costs more than they will.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read the schedule routes, static/style.css, static/shared/cards.js and
static/project/grid.js (for its pointer-drag technique) first.

Build the week view as the primary planning surface, and build it as a REUSABLE
COMPONENT -- static/schedule/calendar.js -- that the day and month views will
mount with different configuration. Do not write a week-specific layout that
sessions 10 and 11 then copy.

- Seven day columns, time down the side, commitments and scheduled blocks drawn
  in place. Travel blocks are visually distinct from task blocks and clearly not
  work.
- Blocks beyond the detail horizon (session 5) have no specific time. Show them
  as a day-level list at the top of that column rather than inventing a slot --
  the schedule does not know when, and should not pretend.
- Colour by deliverable where a task has one, using the existing ramps. Do not
  introduce new colours.
- Show the at-risk list alongside, not buried.

Also build the WORKING HOURS editor, which the plan referenced in session 4 but
never specified, so it was never built. This is why an unconfigured schedule
returns nothing: with no working_hours rows every weekday has zero available
minutes and every task lands on the at-risk list.

  - a weekly pattern — start and end per weekday, or "not working"
  - the DOMESTIC hours band too, edited the same way (session 6b adds the
    table). Both bands are drawn on the week and month grids as visible
    background ranges, so you can see at a glance when you are meant to be
    working and when chores get done
  - each band resizable per day and per week directly on the grid, writing to
    hours_overrides — drag the edge of a day's working band to extend it
  - a one-gesture "start my day at…" control on the day and week views. Waking
    late and pushing today's working band from 09:00 to 11:00 must be a single
    action, not a form. Changing it replans immediately, so the day reflows
    into the narrower window and whatever no longer fits moves or goes at-risk.
    This is the most-used control in the whole app; treat it accordingly.

Also show the SUGGESTED BEDTIME. It is not a block and not a task — it is a
marker on the calendar, derived from the first commitment or scheduled block of
the following day:

    bedtime = first thing tomorrow − travel − morning routine − sleep target

  - sleep target and morning routine are user settings with sensible defaults
  - it occupies no time and constrains nothing; it never displaces work and is
    never something you complete
  - draw it as a line or marker on the evening, not a filled block — it is
    advice, and a block would imply the scheduler owns that time
  - if the app is open when it arrives, fire a browser notification. Request
    permission the first time the setting is enabled, never on page load.
    Be honest in the copy that this only fires while the app is running —
    there is no background delivery, and implying otherwise would be worse
    than not offering it
  - the same shape as the location hours editor from session 3, but a
    different concept: location_hours is when a PLACE is open, working_hours is
    when YOU are willing to work. Both constrain placement and neither
    substitutes for the other. Say so in a comment; they will otherwise be
    merged by a later session.
  - the table and GET/PUT /api/working-hours already exist from session 4
  - when a week shows no placed work, say why — "no working hours set" is a
    fixable message, an empty grid is not
- Click a block to open the task; complete from there with the three outcomes.
- Drag a block to move it, which pins it (is_locked) and triggers a replan of
  everything unlocked around it.

Follow the neumorphic rules: no fills, no borders, depth from the existing
shadow variables. A calendar is exactly where a stray 1px border creeps in.
````

**Exit criteria:** a real week reads clearly, drag-to-pin works, and the component takes configuration rather than assuming seven columns.

---

### Session 9a — Timetable detail and location grouping

**Delivers:** the structured fields the feed already carries, and a location hierarchy that separates *where you are going* from *how long it takes to get there*.

**Why before 9b:** 9b restyles the schedule surface. Styling it against the current single-title block and then adding five fields afterwards means doing that work twice.

**Model:** Sonnet 5, `high` · 3–4 h · 280–380k tokens · ~1 window

````
Read ics_import.py (particularly parse_events and sync_feed), db.py's
COMMITMENTS and LOCATIONS schema, scheduling.py's travel_minutes, and
static/schedule/calendar.js's block rendering first.

Two problems, related.

1. THE IMPORT THROWS AWAY MOST OF THE EVENT. parse_events returns only
   {external_uid, title, start, end}. LOCATION and DESCRIPTION are parsed and
   discarded, so every imported commitment shows a bare module code and has a
   null location. The feed is not at fault -- the parser is.

   START BY LOOKING AT THE REAL DATA. The user's feed URL is already stored;
   fetch it and print a few complete VEVENTs before writing any parsing code.
   Institutional timetables pack several fields into SUMMARY, LOCATION and
   DESCRIPTION in a house format, and guessing that format will produce a
   parser that works on nothing. Write the parser against what is actually
   there, and keep the raw values so a later reparse is possible without
   re-fetching.

   Extract, where present:
     delivery_type   Optional event, Studio, Lecture, Induction, Workshop
     site            A Building, E Building, Forum, Online
     room            e.g. E1.01
     details         what the session actually is -- CLO3D, Briefing
     module_name     THE IMPORTANT ONE
     module_code     e.g. 5FADE002W
     lecturer

   Store them as JSON in a new commitments.meta column rather than seven
   columns. This is parsed source data whose shape will change when the
   university changes its export -- the same reasoning as deliverables.spec.
   Anything the parser cannot confidently identify goes in raw form rather than
   being guessed at or dropped.

   Re-syncing must repopulate meta on existing rows, not only on new ones, or
   the 96 commitments already imported stay bare.

2. LOCATIONS CONFLATE DISPLAY WITH TRAVEL. The Studio and the Library are
   different places you need to be told apart, but they are in the same
   building and the travel time is identical. Right now one location must serve
   both purposes and cannot.

   Add locations.parent_location_id, nullable. A specific place (Studio,
   Library, E1.01) points at an umbrella (Harrow Campus). Then:

     - DISPLAY uses the specific location. "Studio 3", not "Harrow Campus".
     - TRAVEL resolves each location to the root of its parent chain before
       any lookup. Two places under the same umbrella are zero travel apart,
       however different their names. travel_minutes_from_home and
       location_travel rows are held at the UMBRELLA level; a child with no
       parent behaves exactly as today.

   This is the whole point: two blocks on the same day in different rooms of
   the same building must not generate a travel block between them.

   Guard the parent chain -- a location cannot be its own ancestor, and depth
   is one level in practice. Reject a cycle rather than looping forever.

   ONLINE is a special case. An online session has no travel from anywhere, and
   -- this part is subtle -- it does not change where you are. A Studio block,
   then an online lecture, then another Studio block must produce no travel at
   all. Model it as a flag on the location, not as a magic name string.

   Map the feed's `site` onto locations on import, creating them under a
   configurable default umbrella when unseen, so the 96 existing commitments
   acquire locations without hand-entry. Never invent a travel time for a newly
   created location; leave it unset and let the user fill it in.

3. DISPLAY. On the week and day views a block shows: module name (largest),
   delivery type and room, its times, and -- where travel applies -- the travel
   time and the time to leave, derived from the resolved umbrella.

   Clicking a block opens the rest: module code, lecturer, details, site, and
   the raw values the parser could not classify. Keep the block itself sparse;
   a calendar cell that tries to show seven fields shows none of them.

   Follow the established block styling -- background: var(--bg) with
   --raise-sm, no fills, no borders, hierarchy from size and weight.

Tests: a real VEVENT from the user's feed parses into the expected meta fields;
re-sync backfills meta on an existing row; two locations sharing an umbrella
resolve to zero travel; an umbrella-less location behaves as before; a parent
cycle is rejected; an online session generates no travel and does not change
the current location for the next block.
````

**Exit criteria:** imported events show module name, type and room; two rooms in one building generate no travel between them; an online session breaks no journeys; nothing in the feed is silently discarded.

---

### Session 9b — Schedule shell: its own page, its own front door

**Delivers:** the schedule and tasks lifted out of the archive SPA into a standalone page, which becomes what the app opens on. Structure only — the visual language is session 9c.

**Why before session 10:** the day and month views mount into this shell. Building them inside `index.html` first and moving them afterwards means doing the work twice.

**Model:** Sonnet 5, `high` · 3–4 h · 280–380k tokens · ~1 window

````
Read static/index.html, static/app.js, static/tasks.js, every module in
static/schedule/, static/project.html and static/project/main.js (the existing
standalone-page pattern), app.py's index route, and CLAUDE.md first.

Move the schedule and tasks onto their own page. This is a restructure, not a
rewrite: the modules already exist and mostly work. Do not redesign the
scheduler, the task model or the calendar component's behaviour.

1. NEW PAGE. static/schedule.html with its own entry, static/schedule/main.js,
   following the precedent of project.html and graph.html rather than inventing
   a new pattern. It reuses style.css so the neumorphic system and dark mode
   carry over untouched.

   It holds what are currently the Tasks and Schedule tabs, plus the schedule's
   own settings, as its own navigation. Tasks and the calendar belong together
   -- they are one workflow -- so keep them on this page, not split.

2. STRIP THE ARCHIVE SPA. index.html loses the Tasks and Schedule tabs; app.js
   loses its imports of tasks.js, schedule/schedule.js, schedule/settings.js
   and schedule/bedtime-watch.js, and the initLocationsManager call at the
   bottom -- locations are schedule configuration and move with it.

   Split the Settings tab: dark mode, similarity scores and colour analysis
   stay in the archive; everything schedule-related moves. Do not leave a
   settings surface that spans both.

   Verify every remaining archive tab still works afterwards, including the
   #archive and #ref= deep links.

3. FRONT DOOR. GET / now serves schedule.html. The 3D graph stays reachable at
   /graph.html, which already works through static serving -- only the index
   route changes.

   Update CLAUDE.md's Frontend table in the same commit: it currently states
   graph.html "is the homepage -- GET / serves it, not index.html", which this
   makes false. A standing-context file that lies is worse than one that is
   silent. Add schedule.html to that table too.

   bedtime-watch.js follows to this page. That is an improvement, not a
   regression: the bedtime notification only fires while the app is open, and
   the schedule is now what is open.

4. CROSS-NAVIGATION. A clear way between the three surfaces -- schedule,
   archive (index.html), and the 3D graph. Consistent placement on each. Do not
   reinstate a header on project.html, which deliberately has none.

5. NO VISUAL WORK IN THIS SESSION. The schedule's visual language is being
   replaced wholesale in session 9c -- a drafting aesthetic that is deliberately
   incompatible with the current neumorphic styling. Restyling here would be
   thrown away.

   Carry the existing styles across as they are. Keep the markup semantic and
   the class names honest so 9c has something clean to restyle: a band is a
   band, a block is a block, chrome is chrome.

Verify by hand: every archive tab still works; the schedule page carries tasks,
calendar and its settings; GET / opens the schedule; /graph.html and
/project.html are unaffected; dark mode is correct on the new page; the week
still renders and the band drag still works.

Run the full pytest suite -- route changes are easy to break tests with.
````

**Exit criteria:** the archive and the schedule are separate surfaces, the app opens on the schedule, nothing that worked before is broken, and `CLAUDE.md` reflects the new front door.

---

### Session 9c — The drafting language

**Delivers:** a technical-drawing visual system, defined once and applied to the schedule surface.

**Reference:** architectural section drawings, medieval treatises, anatomical plates, astronomical charts, urban plans; Chloé Vanderstraeten's *Embryon* series. White paper ground, hierarchy from line weight, construction geometry left visible, tone from hatching, colour scarce and muted, small letterspaced annotation, orthographic discipline.

**This suspends hard rule 6 on the schedule surface.** Neumorphism is soft, shadow-based and forbids borders; drafting is flat, linear and made of hairlines. They do not blend. Rule 6 continues to govern the archive, the project shell and everything else until a later session migrates them.

**Model:** Opus 5, `max` · 4–5 h · 350–500k tokens · 1–1.5 windows
**Why Opus:** this is a visual system to be invented and then applied consistently, not a spec to implement. The risk is incoherence across twenty surfaces, which is exactly what a stronger model holds in mind.

````
LOOK AT design-references/ FIRST -- all four images and the README. They are
the brief. Prose cannot carry a visual language, and everything below assumes
you have actually seen them.

Then read static/style.css (the custom properties at the top especially),
static/schedule/calendar.js, the schedule markup as session 9b left it, and
CLAUDE.md's hard rule 6.

Build a technical-drafting visual language for the schedule surface. Reference:
architectural section drawings, medieval medical treatises, anatomical plates,
astronomical maps, urban plans -- and Chloe Vanderstraeten's Embryon series.

This DELIBERATELY REPLACES the neumorphic styling on this surface. Do not try
to reconcile the two. Rule 6 still governs everywhere else; scope every new
rule so nothing outside the schedule changes.

1. THE SYSTEM FIRST, THE SCREENS SECOND. Define it as custom properties in one
   place -- line weights, hatch patterns, the annotation type scale, the two
   accents -- then build every surface from those. A language invented per
   screen is not a language.

   - GROUND is paper. Near-white, warm rather than blue. Not grey.
   - LINE carries the hierarchy. Three or four weights, hairline to structural.
     Nothing is bold; things are heavier.
   - TONE is hatching and stipple, never a flat fill. Bands, unavailable hours
     and disabled states are hatched at different pitches and angles.
   - COLOUR is scarce. One red for annotation, warning and now, at the weight
     of a fine pen line -- the existing --accent (#c23b2e) is already right. One
     cool wash for secondary emphasis. Nothing else. Colour is never a fill
     behind text.
   - TYPE is small, uppercase, letterspaced for labels; sentence case for
     content. Numbered keys with leader lines instead of tooltips.

2. VENDOR A DRAFTING TYPEFACE into static/vendor/fonts/, the same way Ballet
   already is -- an @font-face, no build step, no CDN.

   Choose something condensed and technical: a drafting face in the ISO 3098
   tradition, or a condensed grotesque. VERIFY THE LICENCE PERMITS
   REDISTRIBUTION and record it beside the file. Do not vendor a font you
   cannot confirm is open-licensed.

   Bind it to a new custom property; do not repurpose --display, which is Ballet
   and belongs to the archive.

3. CONSTRUCTION GEOMETRY IS VISIBLE. This is the point of the references -- the
   setting-out is part of the drawing rather than cleaned away.

   - the hour axis is a measured rule with tick marks and extension lines, not
     a list of times
   - grid lines extend fractionally past their content, as drawn rules do
   - deadlines are marked with compass arcs struck from the deadline point
   - recurring tasks show ghosted repetitions at their other occurrences, faint,
     the way a rotating mechanism is drawn through its arc
   - travel is a dashed leader line between blocks, not a solid block
   - block detail opens as a numbered key with leader lines, not a tooltip

   CRITICAL CONSTRAINT: the construction layer is TEXTURE, never information.
   It sits far back -- very low opacity, hairline only -- and must never
   compete with what you actually need to read. In every reference image the
   setting-out is faint and the subject is dark; hold that ratio. A calendar
   checked every morning that takes effort to parse has failed regardless of
   how it looks.

   Put the construction layer behind one toggle so it can be turned off, and
   make sure the surface still reads correctly without it.

4. PERFORMANCE. Arcs, hatches and ghosts multiply fast across a week of forty
   blocks. Draw the construction layer once per render rather than per block
   where possible, prefer CSS patterns to per-element SVG, and check that
   dragging a block or resizing a band still feels immediate. If it does not,
   simplify the geometry rather than accepting the lag.

5. DARK MODE. A paper aesthetic has no natural dark equivalent, and inverting
   to white-on-black looks like a negative rather than a drawing. Treat dark
   mode as a different material -- a dark ground with light lettering, the way
   an astronomical chart is printed -- rather than an inversion. Both modes must
   work; neither should look like the other's mistake.

6. Update CLAUDE.md: record that rule 6 does not apply to the schedule surface,
   what governs it instead, and where the language is defined. A standing rule
   with an unrecorded exception is worse than no rule.

BUILD A SPECIMEN PAGE BEFORE ANY SCREEN. static/schedule/specimen.html, a
static page showing every primitive the system defines: each line weight
against the ground, each hatch pattern, the full type scale, both accents, and
a block in every state -- task, timetabled, travel, prep, break, at-risk,
locked, ghosted. It is not linked from the app and ships as a design artefact.

This exists because you cannot see what you build. The specimen renders in one
screenshot the user can react to precisely -- "the hairline is too heavy, try
0.35" -- instead of them describing a whole calendar in prose. Get it approved
before restyling a single screen; the system is the deliverable, the screens
are its application.

Verify by hand: the WEEK view at a glance -- can you find today's next block in
under a second? Turn the construction layer off and confirm nothing essential
vanished. Check the archive and project shell are visually unchanged.

The day and month views do not exist yet; sessions 10 and 11 build them in this
language. Define the primitives they will need -- a single wide column, and a
monthly grid with no hourly axis -- rather than only what a seven-column week
happens to use.
````

**Exit criteria:** the schedule reads as a technical drawing, remains scannable in under a second, the construction layer is decorative rather than load-bearing, and nothing outside the schedule changed.

---

### Session 9d — Physical texture: ink, graphite, paper

**Delivers:** the analogue delicacy the flat system misses — irregular strokes, pencil tooth in the hatching, ink wash, paper grain.

**Runs before 9c's screens are restyled.** Texture belongs in the system, not applied to screens afterwards. Adoption is currently the specimen sheet only, which is exactly the right moment.

**Model:** Opus 5, `max` · 3–4 h · 300–420k tokens · ~1 window

````
Look at design-references/ again -- all four images, closely. Then read
static/drafting.css in full and static/schedule/specimen.html.

The system is correct but reads as generated rather than drawn. The cause is
regularity: a CSS hairline is identical along its whole length, where graphite
varies in density, ink pools where the pen slows, and paper tooth catches
pigment unevenly. Physicality comes from variation, not from style.

Three things must work together. Any one alone reads as a filter.

1. PAPER GROUND. A tooth over the whole surface, so ink sits ON something
   rather than floating. Two routes -- pick one and say why in a comment:
     - procedural: an SVG feTurbulence fractal noise layer, desaturated, very
       low opacity, fixed to the viewport. No asset, no seams, free.
     - scanned: a real paper tile vendored under static/vendor/textures/ with
       its licence beside it, as the font is. More authentic because it IS
       physical; costs an asset and needs care at the tile seams.
   Whichever, it is ONE element that never re-renders, and it must not tint the
   ground -- paper is texture, not colour.

2. INK BEHAVIOUR. Two cheap changes that do most of the work:
     - mix-blend-mode: multiply on ink against the paper. Crossing strokes
       darken where they overlap, exactly as pen does. This single property
       buys more authenticity than any filter.
     - irregularity via feTurbulence + feDisplacementMap on strokes. Keep the
       displacement SMALL -- around 1-2 units. Enough that no line is
       mechanically straight, not so much that it looks shaky. A drawing is
       precise AND handmade; wobble reads as neither.
   Seed every feTurbulence explicitly. An unseeded filter can differ between
   renders and the drawing will shimmer.

3. GRAPHITE AND WASH.
     - hatching gets tooth: displace the pattern slightly rather than ruling it
       perfectly, so the pitch breathes
     - tone becomes wash: turbulence plus a gaussian blur, uneven at its edges
       and pooling unevenly within, replacing flat opacity
   Both resolve their colour through the existing properties. Do not introduce
   a new colour to carry texture.

PERFORMANCE IS THE ARCHITECTURE HERE, not an afterthought. SVG filters are
expensive and this calendar re-renders on every drag. Separate the layers by
whether they move:

  never moves    paper grain, the construction layer -- filter freely, once
  moves rarely   bands, axis, chrome -- light filtering acceptable
  moves on drag  task blocks -- NO FILTERS AT ALL

  A dragged block must not carry a filter. Give moving elements their
  irregularity through pre-rendered means -- a displaced border-image, a
  background pattern that is already rough -- not a live filter recomputed each
  frame. Check a drag still feels immediate; if it does not, remove effects
  until it does. Legibility and responsiveness both outrank texture.

DARK MODE IS A DIFFERENT MATERIAL. Paper grain inverted is not dark paper, it
is a photographic negative. On dark, think of what these drawings become when
printed as a plate or a blueprint -- the ground is a surface that emits rather
than absorbs, and multiply becomes screen. Design it as its own material rather
than flipping the light one, per the note already in drafting.css's dark
handling.

Every value stays at the top of drafting.css under the .drafting scope, as
before -- turbulence frequencies, displacement scales, grain opacity. Nothing
further down the file introduces its own.

Update the specimen sheet to show each texture on and off, so the contribution
of each is inspectable in isolation. Add a .dr-no-texture root class that
blanks all of it, matching .dr-no-construction -- if texture ever costs too
much on a slower machine, it should come off in one class.

Verify: turn texture off and confirm the system still reads correctly
underneath. Drag a block across a week and confirm no frame drops. Check both
themes. Then look at the specimen beside design-references/01 and 02 -- closer
or merely busier? If busier, reduce.
````

**Exit criteria:** the surface reads as drawn rather than rendered, drags stay immediate, both themes work as their own material, and every effect can be switched off in one class.

---

### Session 9e — Real media: density over alpha, and scanned texture

**Delivers:** an ink system that varies by density rather than opacity, more than one drawing medium, scanned paper and graphite, and the textures already defined actually deployed.

**Model:** Opus 5, `max` · 4–5 h · 350–500k tokens · 1–1.5 windows

````
Look at design-references/ again -- 02 and 04 especially, closely, at full size.
Then read static/drafting.css in full and static/schedule/specimen.html.

The system is correct and still reads as generated. Two measured causes:

  ONE INK AT EIGHT OPACITIES. --dr-ink-rgb is a single colour (33, 32, 30) and
  the entire hierarchy is that colour at different alphas: cut 0.88, line 0.58,
  hair 0.32, construction 0.20, setting-out 0.11, plus ink-2/3/4 at 0.74/0.52/
  0.34. The widths are properly distinct; the colour never is.

  TEXTURE DEFINED BUT NOT DEPLOYED. --dr-hatch-a is used twice, --dr-wash
  twice, --dr-grain once, across 3,213 lines. The vocabulary exists and almost
  nothing speaks it.

1. DENSITY, NOT ALPHA. Graphite does not get lighter, it gets SPARSER. A faint
   pencil line is black particles with gaps, catching only the peaks of the
   paper tooth; it is not grey. Uniform alpha is the single thing most
   responsible for this reading as rendered rather than drawn.

   Rebuild the faint end of the scale as masked density: full-strength ink
   masked by high-frequency noise, so the line breaks up rather than fading.
   The strong end -- cut and line -- stays solid, because a firm line IS solid.
   The transition from solid to broken is where the drawing comes alive.

   CONSTRAINT THAT STILL HOLDS: masks are as expensive as filters, and
   CLAUDE.md already forbids a task block from carrying a filter, blend or mask.
   Density-masked ink is for STATIC elements only -- rules, bands, axis, the
   construction layer. Blocks keep ruled edges. Check a drag still feels
   immediate.

2. MORE THAN ONE MEDIUM. The references are not one pencil. They are graphite,
   ink, and wash, and they differ in hue as well as darkness -- graphite is
   cool and slightly reflective, ink is denser and warmer or bluer, wash is
   transparent and pools.

   Give each its own base RGB rather than deriving everything from one:
     graphite   the setting-out, construction, hatching
     ink        object lines, cut lines, type
     wash       tone and bands only, never a line
   Keep the difference small -- this is not colour-coding, it is the difference
   between two pencils. If a viewer notices the hues as colours, it has gone
   too far.

3. VENDOR SCANNED TEXTURE. Procedural noise got the system this far and cannot
   get it further: real paper tooth is irregular in a way feTurbulence is not.

   Vendor seamless tiles under static/vendor/textures/ with provenance and
   licence beside them, as the fonts already are:
     paper tooth, graphite grain, and a wash/bleed tile

   Best source is your own scanner -- scan a sheet of cartridge paper and a
   graphite swatch at 600dpi, tile them seamlessly. That is more authentic than
   anything stock and has no licensing question at all. Otherwise use a CC0
   source and record it.

   Size discipline: seamless tiles around 512px, JPEG where there is no alpha,
   and keep the total well under a megabyte. Four 2MB PNGs would be a worse
   sin than flat colour.

4. DEPLOY WHAT ALREADY EXISTS. Hatch, stipple and wash are defined and unused.
   Every band, every unavailable region, every disabled or ghosted state,
   every tonal area should carry one. Tone in this language is hatching, never
   a flat fill at reduced opacity -- that rule is already written and is being
   honoured in two places out of many.

5. DARK MODE IS STILL A DIFFERENT MATERIAL. A scanned paper tile inverted is a
   photographic negative. Either scan a dark ground -- a plate, a blueprint, a
   toned sheet -- or drive dark mode from the graphite tile alone with the
   ground as flat tone. Design it; do not invert it.

6. Everything stays behind .dr-no-texture, and the system must still read
   correctly with it on. If the drawing only works with texture, the texture is
   doing work the ruled system should be doing.

Update the specimen sheet: the ink scale shown as a strip from solid to broken,
each medium beside the others, each texture on and off. Change a value in
drafting.css and check it there first.

Verify: put the specimen beside design-references/02 and 04 at full size --
closer, or merely busier? Drag a block across a week and confirm no frame
drops. Both themes. Then turn texture off and confirm the drawing still stands.
````

**Exit criteria:** faint lines break up rather than fading, three media are distinguishable without reading as colours, scanned tiles are vendored with provenance, tone is hatched everywhere it appears, and drags stay immediate.

---

### Session 10 — Day view

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.75 window

````
Read static/schedule/calendar.js from session 9 first.

Mount the shared component as a single-day view. If it needs week-specific
assumptions removed to do this, remove them -- that is the point of session 9
having built it as a component.

BUILD IT IN THE DRAFTING LANGUAGE session 9c defines. Read design-references/
and static/schedule/specimen.html first, and use the system's tokens -- line
weights, hatches, annotation type, the two accents. Do not invent treatment for
this view, and do not fall back to the neumorphic styling that still governs
the rest of the app. If a primitive you need is missing, add it to the system
rather than styling locally.

Set snapToWeek false here -- a single-day view showing Monday when you asked
for Thursday would be nonsense. That option exists for exactly this.

Beyond the layout:
- Today's energy, shown and adjustable inline. This is the daily check-in and
  must be one tap.
- A running sense of the day: what is done, what remains, whether it still fits.
- Completion is the primary action here, so the three outcomes are one tap each
  rather than behind a menu.
- Travel blocks show where you are going and how long, since this is the view
  you look at while actually moving between places.

This is the view that will be opened most often. Optimise for glanceability
over completeness.
````

**Exit criteria:** the day reads at a glance, energy adjusts in one tap, and all three outcomes are immediately reachable.

---

### Session 11 — Month view

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.6 window

````
Read static/schedule/calendar.js first.

Mount the shared component as a month grid. Individual blocks are meaningless at
this density, so show:
- deadline markers, weighted by deliverable importance
- per-day load as a simple density indicator
- at-risk days marked
- the protected finishing buffers before each deadline, visibly reserved

This is an overview for spotting collisions weeks out -- two deadlines in one
week, a finishing buffer that overlaps a trip. Clicking a day opens the day view.

Do not try to render every block. A month of packed rectangles tells you
nothing.

BUILD IT IN THE DRAFTING LANGUAGE session 9c defines -- read design-references/
and static/schedule/specimen.html first.

This is the surface where the construction geometry earns its keep. A month has
no hourly axis and little text, so it is closest to the astronomical chart and
urban plan among the references: compass arcs struck from each deadline,
projection lines running across weeks, density read as tone rather than as
counted blocks. Take it further here than on the week view.

The constraint still holds -- the construction layer is texture, not
information. A month you cannot read at a glance has failed however well drawn.
````

**Exit criteria:** deadline collisions and overloaded weeks are visible at a glance.

---

### Session 11b — The isometric month

**Delivers:** a second month visualisation — an axonometric sheet with the month grid on the base plane and each day's work rising from it, over a plan view of the same month, drawn as one drawing.

**Visual before functional.** The plain month view stays reachable and keeps the analytical job. This one is allowed to be beautiful first.

**Model:** Opus 5, `max` · 4–5 h · 350–500k tokens · 1–1.5 windows
**Why Opus:** projection geometry, draw order and visual judgement at once, with no spec that can fully pre-empt how it looks.

````
LOOK AT THE ATTACHED IMAGE FIRST, and at design-references/04, which is the
same drawing. Everything below assumes you have.

Then read static/drafting.css in full, static/schedule/specimen.html,
static/schedule/calendar.js (its month mode), and CLAUDE.md's hard rule 6
schedule exception.

Build a second month visualisation on the month page: an AXONOMETRIC sheet,
with the existing month view kept and switchable. This is the drawing in the
reference image applied to a calendar.

1. THE GEOMETRY. The month grid lies on the base plane, on the two horizontal
   axes: weekday along one, week along the other. The VERTICAL axis carries
   that day's work, stacked in the order it happens -- morning at the base,
   evening at the top. Height is therefore load, and that is the whole idea: a
   heavy day is a tower, an empty day is flat ground, and a deadline week reads
   as a ridge before you have read a single word.

   Use a true isometric projection, axes at 30 degrees:
     sx = (col - row) * cos(30) * cellW
     sy = (col + row) * sin(30) * cellH - z * unitH
   with col = weekday, row = week index. Put the projection in one function and
   derive every position from it; nothing may be positioned by eye.

   DRAW BACK TO FRONT, sorted by (row + col) ascending, or towers will overlap
   wrongly and no amount of styling will fix it. This is the single most common
   way an isometric drawing goes wrong.

2. WHAT MAPS TO WHAT.
     a day             a cell on the base plane
     a task            a block in that day's stack, at its scheduled position
     a commitment      the same, distinguished as the existing block vocabulary
                       distinguishes them -- hatch against rule, not colour
     travel            the thin connective element it already is
     a deadline        struck as a circle on the base plane, which in
                       projection becomes an ellipse. Strike it WHOLE with its
                       centre marked, as the reference does -- an arc is only
                       the part that got inked.
     today             marked on the base plane, not by colouring its tower

3. STYLE COMES ENTIRELY FROM drafting.css. Line weights, pencil setting-out,
   tones, hatches, the two accents, the type. Introduce no value of its own; if
   something is missing, add it to the system.

   Carry the reference's qualities deliberately:
     - construction lines projected from the base grid up the vertical axis,
       overrunning as --dr-overrun already specifies
     - the setting-out visible under the object lines, thinner and lighter
     - small studies clustered at the sheet's edges -- a legend, a key, the
       month's totals drawn as marginal figures rather than a data panel
     - the whole sheet reading as one drawing, not as a chart with decoration

   The construction layer remains texture, never information, and
   .dr-no-construction must still strip it cleanly.

4. THE PLAN BELOW. Under the axonometric, on the same sheet and aligned to the
   same vertical centre line, draw the month in plan -- the ordinary calendar
   grid, in the same hand. One horizontal rule divides them, exactly as the
   reference divides its two halves. They are one drawing, not two panels
   stacked: the plan's columns must line up with the base plane's axes so the
   eye reads them as the same month seen twice.

5. THE SWITCH. The existing month view stays, reachable in one control on the
   month page. Remember which was last used. The plain view keeps the
   analytical job -- deadline collisions, overloaded weeks -- and this one is
   not required to do that job as well.

6. SVG, NOT THREE.JS. This is a drawing, not a scene: it wants exact hairlines,
   the existing pencil textures and no lighting. A WebGL renderer would fight
   every part of the drafting language and pull in scene-host.js for something
   that never moves. CLAUDE.md's fourth-caller rule is about 3D views of the
   archive; this is not one.

7. PERFORMANCE. A busy month is several hundred blocks, each with setting-out.
   Draw the construction layer once for the sheet rather than per block, reuse
   pencil textures as background images rather than per-element filters -- the
   rule drafting.css already holds -- and keep the whole sheet static. If it
   cannot stay smooth, reduce what is drawn at low zoom rather than accepting
   lag.

8. INTERACTION IS MINIMAL, deliberately. Hover identifies a block; clicking a
   day opens the day view. No dragging, no editing, no rotation in this
   session. Adding orientation control later is easy once the projection lives
   in one function; adding it now would cost the drawing.

Verify: a month with a heavy week and an empty week reads as ridge and flat at
a glance; towers never overlap wrongly; the plan below aligns with the base
plane above; the switch persists; .dr-no-construction and .dr-no-texture both
still strip cleanly; then put it beside the reference image -- closer, or
merely busier?
````

**Exit criteria:** load is legible as height, the projection is correct back-to-front, plan and axonometric read as one sheet, and the plain month view is still one control away.

---

### Session 12 — Deliverables UI

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.6 window

````
Read the deliverables routes from session 1 and the at-risk work from session 7.

Deliverables are how you are actually marked, so give them a first-class view.

- Per project: deliverables in order, each with due date, weighting, and the
  spec JSON rendered readably (page counts, required items as a checklist).
- Progress per deliverable, from its tasks -- done, remaining, at-risk.
- Risk stated at deliverable level: "Part 2 cannot be completed in time" is more
  actionable than five separate at-risk tasks.
- Create and edit deliverables by hand. Session 15 adds import from a brief;
  this session must work without it.
- A task's deliverable is settable from the task itself and from here.

The spec JSON's shape varies by brief -- render what is present rather than
expecting fixed keys, and degrade gracefully when a key is missing.
````

**Exit criteria:** progress and risk are legible per deliverable, and hand-created deliverables work fully.

---

### Session 13 — Recurrence

> **Shipped without a UI** (`c371247`). The prompt below specifies the rules, the table and the spawning logic but never says to build a way to create a recurring task — the same omission as the working-hours gap after session 4. `/api/recurrence-rules` exists and `scheduling.spawn_recurrence_successor` works; nothing in `static/` references recurrence, so it is unreachable. A follow-up prompt closes it; see the note under Status.

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.6 window

````
Read recurrence_rules from session 1 and scheduling.py first.

Recurrence here is INTERVAL-BASED AND FLOATING, not calendar-based. "About every
three days" with a tolerance window -- not "every Monday". This is deliberate:
the point is fitting around everything else, not pinning to a date.

- The next instance is due interval_days after the previous one COMPLETED, not
  after it was scheduled. A weekly task done late shifts the next one.
- window_days is the tolerance -- the scheduler places it in the best slot in
  that window rather than on an exact day.
- A missed instance does not stack. If three are overdue, one is scheduled, not
  three. Backlogs of recurring tasks are how these systems become useless.
- Editing a rule affects future instances only; completed history is untouched.
- Pausing a rule stops generation without deleting history.

Tests: completing late shifts the next instance; missed instances do not
accumulate; pausing stops generation; the tolerance window is respected.
````

**Exit criteria:** recurring tasks float sensibly and never pile up.

---

### Session 14 — Resource archive

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.6 window

````
Read the resources routes from session 1 and static/shared/cards.js first.

A manual archive of places to get things — fabric shops, haberdashers,
suppliers. No external lookup in v1; that needs a places API and a decision
about sending location data off-machine, and is out of scope.

- A resource has a name, a location (reusing locations, so travel and opening
  hours come free), a URL, and notes.
- resource_items records what it stocks, tagged, searchable across everything --
  "who sells horsehair canvas" should be one search.
- Link a resource to a task, so a shop trip carries what you are going for.
  A task with a linked resource inherits that resource's location by default.
- Reachable from the schedule tab and from a task.

The brief for a project like Construction mandates fabric shop visits and swatch
collection, so this is real working data, not an address book.
````

**Exit criteria:** a stock search finds the right shops, and linking a resource to a task sets its location.

---

### Session 15 — Brief import and concept analysis

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read analyze.py, tagging.py, app.py's PDF handling (fitz usage in the thumbnail
route), the deliverables routes, and SCHEDULE_SCOPE.md's brief section first.

1. BRIEF IMPORT. Attach a brief PDF to a project. Extract its text with the
   PyMuPDF already in the stack, and have Claude propose:
     - key dates (briefing, hand-in, any interim reviews)
     - deliverables, with page counts, required items and weightings
     - a task skeleton for each deliverable
     - mandatory activities that imply location-bound tasks -- shop visits,
       archive and museum visits, studio sampling

   RECONCILE AGAINST THE TIMETABLE BEFORE PROPOSING ANYTHING. A brief names
   things already in the imported feed -- inductions, reviews, presentations,
   the briefing itself. Turning those into tasks states the same obligation
   twice: a commitment you attend, and a task telling you to attend it.
   ATTENDANCE IS NEVER A TASK. It is already a commitment.

   For every candidate, decide which of three it is:

     ALREADY COVERED -- a commitment exists for it. Propose nothing, but say so
     in the review list with the commitment it matched, so the omission reads
     as a decision rather than a miss.

     IMPLIES PREPARATION -- a commitment exists, but attending it requires work
     beforehand. "Bring your concept statement, primary research and first
     samples pinned up" is a real task; "attend the interim review" is not.
     Propose the preparation, with its deadline set to the commitment's start.
     This is the case most worth getting right -- it is where a brief's
     checkpoints become work you would otherwise do the night before.

     GENUINELY UNSCHEDULED -- fabric sourcing, archive visits, sampling,
     drawing. These become tasks as normal.

   MATCH ON DATE FIRST, NOT TITLE. This feed's titles are the module code and
   name and nothing else -- every Surface session reads "5FADE002W/1 Surface",
   so an induction is indistinguishable from a studio day by title alone. A
   brief naming "Wednesday 23 September" against a commitment that day is a
   match; keyword agreement raises confidence but cannot be required. Where
   session 9a's meta is populated, delivery_type and details are better signals
   and should be preferred when present.

   Be conservative in both directions: propose a task on a weak match and let
   the user delete it, rather than suppressing one. A missing task is
   invisible; a duplicate is merely annoying.

   NOTHING ENTERS THE SCHEDULE UNAPPROVED. Present everything as a reviewable
   list where each item can be edited, accepted or discarded. A misread brief
   that silently fills a schedule with wrong work is far worse than one that
   proposes badly and is corrected in thirty seconds.

   Brief formats change year to year -- next year's will likely add tutor
   contact points, reviews and presentations, and shift sessions from skills
   teaching toward project development. Extract what is present; never assume a
   fixed shape. This is why deliverables.spec is JSON.

   Store the extraction in briefs.extracted so a re-import can be compared
   against what was accepted before.

2. CONCEPT ANALYSIS. Given the brief and the user's own initial notes and
   references, produce a critique: where the connection to the brief is strong,
   where it is asserted rather than demonstrated, and what research directions
   would strengthen it.

   THE INPUT SET COMES FROM THE CANVAS MARQUEE. The infinite canvas already has
   box-selection -- middle-drag or modifier-drag selects several nodes at once
   -- and that is exactly the gesture for "these are the things I am thinking
   with". Do not build a second picker.

   Lasso a mix of references and text notes, then run the analysis on the
   selection. Both kinds matter and they carry different weight: reference
   nodes are the visual research, text nodes are the user's own thinking about
   it, and the critique is largely about whether the second is actually
   supported by the first. Pass them as distinct inputs, not as one flat list.

   INCLUDE BY WHAT A NODE CONTAINS, NOT BY ITS KIND. The line is whether it
   holds the user's own words:

     include   kind='text' (Simple text, plain, in content)
               kind='widget' with config.type='notepad' -- Notepad is a WIDGET
               by implementation but it is the user writing, and on a real
               canvas half the widget nodes are notepads. Excluding it by kind
               silently drops most of the thinking.
     exclude   colourspace, similarity, colour-palette, title, grid-button --
               views of data or navigation, not ideas.

   THE TEXT IS IN TWO DIFFERENT PLACES. A text node keeps plain text in
   canvas_nodes.content; a notepad keeps HTML in config.widget.content, written
   by rich-text.js as inline-styled spans. Read both, and strip the notepad's
   markup before it reaches the prompt -- raw, it is mostly style attributes.

   Strip rather than flatten: rich-text.js encodes hierarchy in size and
   weight, so a large bold run is a heading and should survive as one. Losing
   that turns structured notes into a wall of sentences.

   An `analysis` widget holds a previous critique. Include it if selected, but
   label it as earlier AI output rather than the user's own position -- a model
   shown its own prior conclusions as though they were the user's will agree
   with itself.

   Two things need extending, both narrowly:

     - canvas/nodes.js keeps selectedNodeIds internally but its returned object
       exposes only setData, addNode, removeNode, bounds, count and destroy.
       Add a selection accessor returning the selected nodes with their kind,
       reference_id and content. Do not change how selection itself works.

     - analyze.py's start_conversation(ref_ids, mode) takes reference ids only.
       Concept analysis also needs the brief and free text. Add an entry point
       beside it rather than overloading that signature -- the existing
       Analyze action must behave exactly as it does now.

   Fall back sensibly: an empty selection analyses the project's references
   against the brief, which is still useful and means the feature works before
   anyone has put anything on a canvas.

   Be useful rather than flattering. A critique that says everything is fine is
   worthless; the value is in naming the weak link -- the reference that is
   there because it looks good rather than because it argues for anything.

   Output saves back to the canvas as a text node, so the critique lands beside
   the work it is about and can itself be selected into the next round.
````

**Exit criteria:** the 2026 Construction brief produces a sensible reviewable skeleton, nothing enters unapproved, and a concept critique reads as genuinely critical.

---

### Session 15b — Timetable groups, and classification as a fallback

**Delivers:** the group setting that resolves half the missing rooms, filtering of sessions that are not yours, and a cached Claude pass for whatever the deterministic parser cannot classify.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read ics_import.py, the meta parsing from session 9a, db.py's COLOUR_ANALYSIS
schema (the versioned-cache pattern this reuses), and tagging.py first.

Measured against the real feed before writing this: 99 commitments, delivery_type
parsing cleanly into nine values including Induction, room missing on 49,
details missing on 27, and 8 events belonging to one group only. The parser is
not the main problem. Do not replace it.

1. WHICH GROUP AM I IN. Westminster splits this cohort into gp3 and gp4, and the
   feed encodes it on a trailing line: "gp3; gp4" for a session running both
   groups in parallel rooms, "gp4" for one group only.

   Add a group setting to the schedule's settings. Then:

     - ROOM RESOLUTION. When a session lists several rooms and several groups,
       the orders correspond -- "A4-07 - FD L5 Studio; A4-05 - FD L5 Studio"
       against "gp4; gp3" means gp4 is in A4-07. Pick the room matching the
       user's group. This alone resolves most of the 49 missing rooms, with no
       model involved.

     - SESSIONS THAT ARE NOT YOURS. 8 events name only gp4. If the user is gp3
       those are not their sessions and are blocking hours that are free. Do
       not delete them -- the feed is the source of truth and a re-sync would
       bring them back. Mark them as not-mine and exclude them from capacity,
       with a way to see and override the exclusion. Getting this wrong in
       either direction is costly: a missed class, or a fortnight of phantom
       commitments.

   Handle the group line being absent (63 events have none) as "applies to
   everyone", which it does.

2. CLASSIFICATION AS A FALLBACK, NEVER THE HAPPY PATH. After the deterministic
   parser and the group logic have run, some events will still have gaps, and
   next year's export will change shape. For those only, batch the raw
   descriptions to Claude and ask for the same meta fields.

   Four constraints, each of which matters more than the feature:

     - BATCH BY DISTINCT DESCRIPTION SHAPE, not per event. Ninety-nine events
       reduce to a handful of layouts; normalise, group, classify the groups,
       apply to members. One call, not ninety-nine.

     - CACHE IT LIKE colour_analysis. Its own table, keyed by a hash of the raw
       description with an algorithm version alongside -- the exact pattern
       COLOUR_ANALYSIS_SCHEMA already uses. A re-sync must not re-pay for a
       description it has already classified, and re-syncs are frequent.

     - NEVER REQUIRED. No API key, no network, or a failed call means import
       still completes with whatever the parser got. This app is local-first
       and a timetable import that hard-fails offline is a worse bug than a
       missing room.

     - NEVER OVERWRITE A CONFIDENT PARSE. The deterministic result wins where
       it exists. The model fills gaps; it does not get a second opinion on
       fields that already parsed.

   Show which fields came from the model, so a wrong classification is
   attributable rather than mysterious.

3. USE delivery_type NOW THAT IT IS RELIABLE. It parses cleanly and nothing
   consumes it. At minimum: Induction and Workshop should default to
   support_level 'priority' on import rather than 'none', since those are
   precisely the sessions where a tutor is present and you have their
   attention. Optional Event should not consume capacity by default.

   This is the session 4 bulk-reclassify problem solving itself from data that
   was already there.

Tests: a gp3 user gets A4-05 where the feed lists both rooms; a gp4-only event
is excluded from a gp3 user's capacity and restorable by hand; a re-sync does
not re-issue a classification call for an unchanged description; import
succeeds with the Anthropic key removed; a confidently parsed field is never
replaced by a model value.
````

**Exit criteria:** rooms resolve from the group setting, sessions that are not yours stop consuming capacity, and the model runs only on what the parser could not do — never twice for the same description.

---

### Session 15c — Brief provenance: re-import as a diff, and a scoped reset

**Delivers:** a link from every brief-created row back to its brief, re-import that updates instead of duplicating, and a reset that removes what a brief made without touching your work.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read app.py's api_apply_brief and api_delete_brief, db.py's DELIVERABLES and
TASKS schema plus delete_brief, and db.py's reset_schedule (the scoped-reset
pattern this narrows) first.

Two bugs with one cause: nothing records which brief created a row.
api_apply_brief inserts deliverables and tasks with no back-reference, so a
second import has nothing to match against and inserts a duplicate set, and
delete_brief removes only the brief row while everything it created stays.

1. PROVENANCE. Add to both deliverables and tasks:
     brief_id    TEXT, nullable -- which brief created this row
     source_key  TEXT, nullable -- a stable identifier for the thing in the
                 brief that produced it
   Null on both means hand-made, which is the common case and must keep
   behaving exactly as it does now.

   THE KEY MUST BE STABLE ACROSS RE-IMPORTS, and that rules out the obvious
   choice. Do not derive it from the title the model produced -- "Part 1 -
   Research and Design Development Portfolio" may come back phrased slightly
   differently next run, and then every deliverable looks new. Derive it from
   the brief's own text: the part number, the heading as printed. If the source
   document is unchanged, the key must be identical.

2. RE-IMPORT IS A DIFF, NOT A REPLACE. Match extracted items against existing
   rows by (brief_id, source_key) and present four groups:

     unchanged  matched, no field differs -- listed, no action
     changed    matched, something differs (a moved date, a revised page count)
                -- show old against new, per field, and let the user accept
                each
     new        no match -- propose as session 15 already does
     gone       exists locally but absent from the re-import -- propose
                removal, never remove silently

   A brief reissued with one date moved is the case this exists for, and it
   must not cost you your task breakdown to absorb.

3. SCOPED RESET, IN TWO STRENGTHS.

     Remove what this brief created -- deliverables and tasks carrying its
     brief_id.

     Delete the brief and everything it created -- the same, plus the brief row
     and its stored PDF. api_delete_brief should offer this rather than
     orphaning rows as it does now.

   PRESERVE WORK BY DEFAULT. A brief-created task that has been completed, is
   partially complete, or has a row in task_actuals is no longer just an
   import artefact -- it is a record of what you did. Default to keeping those
   and clearing only untouched ones, and say plainly how many were kept and
   why. Removing everything must be a separate, explicit choice.

   Getting this wrong is the expensive direction: someone clearing a bad import
   should not lose a fortnight of recorded actuals, which are also the
   estimator's training data.

   Report counts per table, as reset_schedule already does.

4. Tasks whose deliverable is removed keep existing with deliverable_id nulled,
   matching the cascade session 1 already defines. Do not delete a task because
   its deliverable went.

Tests: importing the same brief twice produces one set of deliverables, not
two; a changed due date appears as changed rather than new; a hand-made
deliverable is never touched by a brief reset; a completed brief-created task
survives the default reset and is removed by the explicit one; deleting a brief
leaves no orphans.
````

**Exit criteria:** re-importing is idempotent, a reissued brief diffs cleanly, and no reset can silently destroy recorded work.

---

### Session 15d — Year anchoring, task ordering, supporting documents

**Delivers:** dates resolved against what the app already knows, tasks that arrive in a defensible order, and supplementary documents parsed alongside a brief.

**Model:** Sonnet 5, `high` · 3–4 h · 280–380k tokens · ~1 window

````
Read briefs.py in full, the brief extraction prompt, db.py's TASKS and
TASK_DEPENDENCIES schema, and scheduling.py's scoring first.

Three faults, found by importing a real brief.

1. THE YEAR IS GUESSED WHEN IT SHOULD BE KNOWN. A real 2026 brief extracted as
   2025-10-26 and 2025-10-27. Briefs give bare dates -- "Monday 26th October" --
   and the model resolves the year from nothing.

   The app already knows. That project's imported commitments run 21 September
   to 27 October 2026. Pass that range into the extraction as explicit context
   and instruct that bare dates resolve inside or near it.

   Then VALIDATE rather than trust: any extracted date falling outside the
   project's commitment range by more than a month is suspect. Do not silently
   correct it -- surface it in the review sheet as needing attention, with the
   range it was checked against. A wrong year that imports quietly is worse
   than one flagged, because every downstream deadline inherits it.

   Where a project has no commitments to anchor against, say so and fall back
   to the current academic year rather than to nothing.

2. TASKS ARRIVE UNORDERED, SO SUMMARY WORK GETS SCHEDULED FIRST. There are
   zero rows in task_dependencies against thirty brief-created tasks, because
   the extraction never asked for ordering. "Create hero look page -- highlight
   strongest/final outcome" was placed immediately after the briefing, when by
   its nature it cannot be done until there are outcomes to select from.

   The scheduler is not at fault: given no dependency and a distant deadline, a
   short easy task correctly scores well. The information was never captured.

   Ask the extraction for two things:

     SEQUENCE. For each deliverable, the order its tasks actually happen in.
     This is far more reliable from a model than a dependency graph, and a
     portfolio chapter genuinely has one: research, develop, select, mount.

     DEPENDENCIES, but only where real. A task that cannot start until another
     finishes. Be sparing -- chaining everything serialises work that could run
     in parallel and the scheduler will then refuse to fill days.

   Turn sequence into a SOFT EARLIEST START rather than a hard chain: a task
   late in its deliverable's sequence should not be placed in the project's
   first week even when nothing formally blocks it. Derive it from position in
   the sequence across the project's span, and let it bias placement without
   making the schedule brittle. A hard dependency is a promise the brief did
   not make; an earliest start is the shape of the work.

   Surface both in the review sheet, editable before anything is applied.

3. SUPPORTING DOCUMENTS. A brief rarely arrives alone. A workshop and materials
   list, a reading list, a technical handout -- each generates real preparation
   work with a hard date.

   Let a project carry supplementary documents alongside its brief: attach,
   parse, propose, review, apply, through the path session 15 already built.
   Accept .docx as well as PDF.

   Two things they do that a brief does not:

     THEY ARE OFTEN SPLIT BY GROUP. "Groups 1 & 2: Monday 21st September.
     Groups 3 & 4: Wednesday 23rd." Reconcile against the user's group setting
     from session 15b and propose only their date. Where the document's group
     names do not match the timetable's, ask rather than guess.

     THEY PRODUCE DEADLINED PREPARATION. "Bring at least 3 artefacts", "bring
     your Construction toile from first year", a list of specific media -- these
     are tasks due before a session that already exists as a commitment. This
     is exactly session 15's "implies preparation" branch: the workshop itself
     is already in the timetable and must not become a task; what you must
     gather beforehand must.

     A materials list is one task per thing to obtain, not one task called
     "gather materials" -- you will acquire them at different times and in
     different places, and some you already own.

Tests: a brief with bare dates resolves into the project's commitment year; a
date outside that range is flagged, not corrected; a terminal task is never
placed in the first week of a project; a materials list produces separate
deadlined tasks; a group-split document proposes only the user's group's date.
````

**Exit criteria:** years resolve from the timetable, summary work cannot land on day one, and a workshop handout produces the right preparation tasks against the session already in the calendar.

---

### Session 15e — Concept analysis as curation, not critique

**Delivers:** an analysis that reads the clusters already in the work, names what binds them, and offers lateral directions to extend them — instead of auditing references against a brief.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read analyze.py's _build_concept_prompt and start_concept_analysis, the routes
/api/projects/<pid>/similarity/graph and /api/projects/<pid>/colour/map,
graph_layout.py's clustering, and db.py's deliverable and task queries first.

THE PREMISE IS WRONG, not just the tone. The prompt at analyze.py:379 asks for
"the single reference doing the least argumentative work -- there because it
looks good rather than because it argues for anything". That is how a written
argument is assessed. It is not how fashion research works.

Connection in fashion is associative and lateral. A real chain from a student
on this course: an artist who builds architecture out of other materials, some
of them translucent -> that recalls animals moulting, a lizard's shed skin ->
a photograph of wallpaper peeling -> the pattern printed on that wallpaper. Each
step is a jump on a shared physical quality, not a deduction. Nobody could
defend it as an argument, and being asked to would have killed it at the second
step. Early on the designer is finding a vibe and gathering clusters that feel
right; the connection is the designer's eye, and the tool's job is to widen it,
not to grade it.

Rebuild the analysis around that.

1. USE THE CLUSTERS THE APP ALREADY COMPUTES. analyze.py references none of
   this, though it is all project-scoped and sitting there:
     /api/projects/<pid>/similarity/graph -- CLIP k-means clusters, with an
       edge structure showing what sits near what
     /api/projects/<pid>/colour/map -- where each reference falls in colour
     each reference's tags and description from tagging.py
   Feed the cluster structure in as INPUT. The model should be reasoning about
   groupings that were measured, not inventing groupings from titles.

2. NAME WHAT BINDS EACH CLUSTER. Three images often feel right together before
   the designer can say why, and putting a word to it is genuinely useful --
   it is the difference between a mood and a direction. Say what each cluster
   holds in common: a form, a surface, a colour behaviour, a process, a
   quality of light. Offer it, do not assert it; the eye may have been after
   something else and naming the wrong thing out loud is still useful.

3. SUGGEST LATERAL MOVES, WHICH IS THE PRIMARY OUTPUT. For each cluster, take
   the quality that binds it and ask where else in the world that quality
   appears -- in nature, decay, industry, architecture, other cultures, other
   materials. Moulting to peeling paint to birch bark to palimpsest.

   Make them CONCRETE AND COLLECTIBLE: things to look at, search for, or go
   and photograph, not themes to consider. "Look at snake sheds and blistered
   paint" is usable. "Consider the theme of transformation" is not.

4. EVALUATE THE WHOLE BODY, not each reference. This is where judgement
   belongs. Do the clusters speak to each other, or are they three unrelated
   projects sharing a folder? Is a through-line emerging, and what is it? Is
   one cluster carrying everything while another is a single image that has
   not grown? Which two clusters are closest to touching, and what would sit
   between them?

   That last question is the most valuable thing this feature can ask, because
   the space between two clusters is usually where the project actually is.

5. NEVER ASK A REFERENCE TO JUSTIFY ITSELF. Delete the weak-link section and
   the "argues for anything" framing entirely -- do not merely gate it. A
   reference that is there because it looks right is doing its job; that is
   what a mood is made of. If something genuinely sits apart from everything
   else, say it is unattached and might be a fourth direction or might be a
   stray, and leave the call to the designer.

6. STAGE AWARENESS, still. Pass days elapsed and remaining, which deliverables
   are done, task counts, and what the scheduler flags at risk. ABSENCE IS ONLY
   WORTH RAISING WHEN IT IS LATE: no garment research in week one is what a
   project that has just started looks like; in week five it is the finding.
   Brief compliance is a late-stage concern and should be nearly silent early.

7. ANSWER IN DIRECTIVES, NOT PROSE. A short read of where the work stands; the
   clusters and what binds them; lateral directions as a bulleted list, one
   line each; and specific next actions phrased as instructions -- "add garment
   research on trench coats", never "the project would benefit from
   consideration of outerwear precedents". Length tracks how much there is to
   say. A thin canvas deserves a short answer.

   Drop "a critique that says everything is fine is worthless". That line is
   what makes it hunt.

8. The next actions are already tasks. Offer them through the same review path
   brief import uses -- proposed, editable, nothing applied unasked.

Verify on a real project in its first week: the answer should name the clusters,
say what each seems to be about, suggest places to look next, and contain no
paragraph about what is missing. Then on a project in its last fortnight, gaps
should be raised plainly, because by then they are the point.
````

**Exit criteria:** the analysis reasons about measured clusters, proposes concrete lateral research, judges the body rather than the reference, and never asks an image to argue.

---

### Session 16 — Project integration and hardening

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read static/project/registry.js, the widget contract in CLAUDE.md, and every
schedule module built so far.

1. Project widgets, following the existing contract so they reach the widget
   dock automatically via shell.addableTypes():
     - deliverables: progress and risk for this project
     - upcoming: this project's next scheduled tasks
     - brief: the imported brief, rendered readably
   All three are homepage widgets. Set canvasEligible deliberately per widget
   and say why in a comment.

2. Integrity pass. Verify every cascade from session 1 actually fires, and write
   a query per table that finds rows whose parent no longer exists, asserting it
   returns nothing after a delete. Look especially for scheduled_blocks and
   task_actuals orphaned by task deletion, and dependencies pointing at deleted
   tasks.

3. Check the scheduler against a realistic full project: import a six-week brief,
   accept the skeleton, add a timetable, and confirm the output is something you
   would actually follow. This is a judgement check, not a unit test, and it is
   the most valuable half hour in the session. Report what looked wrong.

4. Desktop-readiness audit for the new code, matching CLAUDE.md's rules: no
   localStorage for user data, relative fetch paths only, no hard-coded ports,
   no new webkit* APIs.

5. Run the whole pytest suite. Update README.md to describe the schedule.
````

**Exit criteria:** no orphans, widgets work, the suite is green, and a realistic project schedules sensibly.

---

### Session 16b — Migrate the archive to the drafting language

**Delivers:** one visual language across the app, replacing neumorphism outside the 3D pages.

**Deliberately last.** The drafting system should live on the schedule surface for a while first — long enough to know which parts work daily and which were only good in a mockup. Migrating on the strength of a first impression means doing it twice.

**Model:** Sonnet 5, `high` · 3–4 h · 280–380k tokens · ~1 window

````
Read the drafting system defined in session 9c, static/style.css, and
CLAUDE.md's hard rule 6 first.

Apply the schedule's drafting language to index.html (Add, Archive, Projects,
Settings) and the project shell. Use the system as it stands; do not redesign it
on the way — if something needs changing, change it at the definition so both
surfaces move together.

The 3D pages (graph.html, connections.html, colour-connections.html) are OUT OF
SCOPE. They are WebGL scenes whose palette lives in graph-common.js, not CSS,
and their existing treatment already suits them.

Two things that need real thought rather than mechanical substitution:

- THE IMAGE GRID. An archive of photographs on a paper ground is a different
  problem from a calendar: the images bring their own colour and the drawing
  language has to frame rather than compete. Look at how plates are set in the
  reference works — ruled borders, captions below, generous margins — rather
  than making cards into outlined boxes.

- PROJECT WIDGETS keep their flat-at-rest rule, which was always closer to
  drafting than to neumorphism. config.shadow becomes meaningless under the new
  system; decide whether it dies or becomes a ruled border, and migrate the
  stored value rather than orphaning it.

Rewrite hard rule 6 in CLAUDE.md to describe what the app now actually does,
and remove the schedule exception added in 9c — there is no longer an exception
to make.

Verify every page by hand, both modes.
````

**Exit criteria:** one language across the app, the 3D pages untouched, `CLAUDE.md` describing reality.

---

## Phase 4 — Phone companion

### Session 17 — Remote access and the phone day view

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read app.py's entry point and CORS handling, config.py's ARCHIVE_API_TOKEN,
capture.py's auth check, and static/schedule/calendar.js first.

1. Make the server reachable from a phone. Bind beyond 127.0.0.1, gated behind
   an explicit setting so the default stays localhost-only. When bound wider,
   ARCHIVE_API_TOKEN becomes REQUIRED rather than optional -- an open schedule
   API on a shared network is not acceptable. The token already exists for the
   browser extension; reuse that check rather than writing a second one.

   This does not breach CLAUDE.md rule 3: client code still uses relative paths
   and still knows nothing about the port.

   Document in README.md that Tailscale (or equivalent) is how this works away
   from home, and that a sleeping Mac is unreachable.

2. A mobile day view at its own route -- today's tasks, the day's calendar, and
   completion with all three outcomes. Reuse calendar.js in its day
   configuration; do not write a second calendar.

   Design for one thumb. Large targets, no hover, no drag as the only route to
   anything. This is used standing up in a studio.

3. PWA manifest and icons so Add to Home Screen gives a fullscreen app with no
   Safari chrome. Standalone display, sensible name and theme colour.

4. Token entry on the phone: a single screen that stores the token and is easy
   to clear. This is the one thing that may live in localStorage -- it is a
   credential, not user-created data, so rule 2 does not apply.

Offline comes in session 18. This session assumes the server is reachable.
````

**Exit criteria:** the phone reaches the Mac over Tailscale, the day view works one-handed, and Add to Home Screen produces an app-like icon.

---

### Session 18 — Offline cache and sync queue

**Delivers:** the phone works without a connection and syncs when it has one.

**Model:** Sonnet 5, `high` · 3–4 h · 250–350k tokens · ~1 window

````
Read session 17's phone view, the completion routes, and SCHEDULE_SCOPE.md's
"offline queue" section — particularly the rule 2 exception — first.

1. A service worker caching the app shell and the day's data, so opening the app
   with no connection shows today rather than an error.

2. A mutation queue in IndexedDB. Completions, edits and new tasks made offline
   are queued and flushed when the server is reachable.

   THIS IS A NARROW, DELIBERATE EXCEPTION TO CLAUDE.MD RULE 2. IndexedDB here is
   a TRANSIT BUFFER, never the system of record. SQLite on the Mac remains
   authoritative. Entries are deleted once acknowledged, and nothing is ever
   read back from it as truth. Write that in a comment. Do not extend this into
   a general offline mode, and do not use it for anything the server has not
   yet seen and confirmed.

   In-memory state and sessionStorage are both wrong -- the queue must survive
   the app being fully closed and the phone rebooting.

3. Every queued action carries two things:
     a client-generated id, so a retry cannot double-apply
     THE PHONE'S OWN TIMESTAMP, not the server's receipt time
   The second matters more than it looks. A task completed at 09:00 whose queue
   flushes at 18:00 must record 09:00. Otherwise every actual is stamped with
   whenever the laptop happened to open, and the estimator -- the whole point of
   the learning loop -- trains on durations that never happened.

4. Make the completion and task-edit endpoints IDEMPOTENT, keyed on the client
   id. Replaying the queue must be safe.

5. Add a single GET /api/schedule/today returning everything the phone needs in
   one request -- blocks, tasks, energy, at-risk. One round trip on a bad
   connection beats five.

6. Call navigator.storage.persist() on first launch to exempt the queue from
   routine eviction. Show sync state plainly: how many actions are pending, when
   it last synced.

Tests: replaying a queued completion twice records it once; a queued action's
phone timestamp survives to task_actuals.completed_at; the queue survives a
simulated full close.
````

**Exit criteria:** the phone is usable with no connection, the queue survives a full close, replays are safe, and completion times are the phone's.

---

### Session 19 — Photo capture from the phone

**Model:** Sonnet 5, `medium` · 1.5–2.5 h · 120–200k tokens · ~0.5 window

````
Read capture.py in full, its routes in app.py, ingest.py's IMAGE_EXTS, and
session 18's queue first.

Add photo capture to the phone, reusing the existing capture pipeline rather
than adding a second ingest path.

1. capture.py already does the hard part: POST /api/captures accepts a multipart
   file, writes it to PENDING_DIR, queues it, returns 202 immediately, and a
   background worker does the slow tagging and embedding. It survives restarts
   through resume_pending(), GET /api/captures/<id> polls status, and it is
   already token-authenticated for remote clients. Use it as-is.

2. Camera or library picker on the phone, producing a capture envelope in the
   shape capture.py already expects.

3. iPhone photos are HEIC and ingest.IMAGE_EXTS does not accept it. Convert to
   JPEG in a canvas before queueing. This also shrinks a 4MB photo to a few
   hundred KB, which matters because the offline queue lives in browser storage
   with real limits. Pick a quality that keeps the image useful for CLIP and
   tagging without storing the original.

4. Queue the resulting blob through session 18's queue so a photo taken with no
   connection uploads later. Show its status once uploaded, polling
   /api/captures/<id>.

5. Optionally attach the capture to a project on the phone -- the envelope
   already supports project_ids.

Do not add HEIC support server-side; converting client-side is simpler and
solves the size problem at the same time.
````

**Exit criteria:** a photo taken offline uploads when reachable, arrives as a tagged reference, and never exceeds sensible storage.

---

## Archive-side work

Not part of the schedule sequence, but this is the plan being worked from.

### Session A1 — Getting files out of the archive

**Delivers:** a reference as a usable file — named, downloadable, draggable, and exportable in bulk.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read app.py's /media routes (~line 1295), static/shared/cards.js, static/app.js's
archive selection (archiveSelectedIds and its toolbar), ingest.py's file layout,
and desktop.py first.

References are stored under references/images/ with UUID filenames -- 128 of
them, none findable by hand -- and filepath is deliberately never exposed by the
API. There is no download, drag-out or reveal anywhere in the UI, so putting a
reference into InDesign currently means querying SQLite for its UUID. Fix that.

Do NOT expose filepath through the API. The fix is better ways to get the
BYTES out, not handing the client a path into the archive.

1. NAMED DOWNLOAD. /media/<ref_id> serves the file with no Content-Disposition,
   so a browser displays it and any save gets a UUID or a guess. Add a download
   variant that sets `attachment` with a filename built from the reference's
   TITLE, not its id.

   Slug the title properly: strip path separators and characters the filesystem
   or another OS will object to, collapse whitespace, cap the length, keep the
   real extension from the stored file. Two references called "Balenciaga 1967"
   must not produce the same filename -- dedupe with a short suffix.

   This is the one mechanism that works everywhere, including WKWebView, so
   everything else is an improvement on top of it rather than a replacement.

2. DRAG-OUT, where the browser supports it. On dragstart from a card, set
   dataTransfer's DownloadURL to
   "<mime>:<filename>:<absolute url>" and the browser hands a real file to
   Finder, InDesign or Photoshop on drop.

   Chrome supports this well; WebKit historically does not, and the desktop
   wrapper is WKWebView. Feature-detect and degrade to the download control
   rather than offering a gesture that silently does nothing. Say in a comment
   which engines this is expected to work in -- a later session will otherwise
   "fix" the fallback.

3. BULK EXPORT, which is the case that actually matters for portfolio work.
   The archive and project grids already have selection; add an export to their
   toolbars.

   Stream a zip of the selected references, named as in item 1. Do not build it
   in memory -- a folder of 40 images is tens of megabytes.

   Offer an ordering that survives the zip: prefix with a zero-padded index in
   the order they appear on screen, so a line-up stays in order when placed.

   Handle every type, not just images: PDFs export as themselves, text
   references as .txt with their content.

4. REVEAL IN FINDER, desktop build only. desktop.py currently calls
   webview.create_window(...) with no js_api bridge. Add one exposing a single
   reveal(reference_id) that resolves the path server-side and runs
   `open -R` on macOS.

   Guard it: the bridge must accept a reference id and look the path up itself,
   never accept a path from the page. Absent in the browser, where the control
   should simply not appear rather than erroring.

5. COPY IMAGE to the clipboard from a card, for quick pasting. Cheap, and it is
   what you reach for half the time.

Tests: a title with a slash, a colon and 200 characters produces a safe unique
filename; two identical titles do not collide; a zip of a mixed selection
contains images, a PDF and a .txt; the reveal bridge rejects anything that is
not a known reference id.
````

**Exit criteria:** a reference reaches InDesign in one gesture, a selection exports as named files in order, and no path from the archive is ever exposed to the page.

---

### Session A2 — Drop files straight onto a canvas

**Delivers:** dragging an image from Finder onto a project canvas ingests it, adds it to the project and places it where you dropped it.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read static/project/canvas/palette.js (its comment on why internal drags are
pointer events, not HTML5 DnD), canvas/nodes.js, canvas/store.js, capture.py in
full, its routes in app.py, and ingest.py's duplicate handling first.

The canvas has no external file handling -- every drag in it is the internal
pointer-based palette. Getting an image from Finder onto a canvas currently
means the Add tab, waiting for tagging, opening the project, adding to it, then
placing it. Make it one gesture.

1. DROP LOOSE FILES ON THE CANVAS. Use dataTransfer.files. This does NOT need
   webkitGetAsEntry, so hard rule 5 is satisfied: that API is only required for
   FOLDERS. A folder drop must therefore be refused with a clear message
   pointing at the Add tab, not handled -- do not add a third use of that API.

   Internal palette drags stay pointer-based and must keep working; the file
   drop is a separate listener and the two must not fight over the same events.

2. GO THROUGH THE CAPTURE QUEUE, do not add an ingest path. POST /api/captures
   accepts a multipart file, writes it to PENDING_DIR, returns 202 immediately
   and does the slow tagging and embedding on its worker. Its envelope already
   takes project_ids, so pass the current project and the reference lands in it
   without extra calls.

3. PLACE THE NODE OPTIMISTICALLY. Ingestion takes seconds -- Claude tagging and
   a CLIP embedding -- and a drop that appears to do nothing for ten seconds
   reads as broken.

   Draw a node at the drop point immediately, in a pending state, previewing
   the dropped File through URL.createObjectURL so you see what you dropped
   rather than a spinner. Poll /api/captures/<id> and swap in the real
   reference when it resolves. Revoke the object URL when you do.

   The node is client-side only until it has a reference_id -- canvas_nodes
   requires one. A reload mid-ingest loses the placement but never the
   reference, because the capture queue survives restarts. Say so in a comment
   rather than building persistence for a five-second window.

4. A DUPLICATE IS A PLACEMENT, NOT AN ERROR. ingest.py hashes content and
   capture.py resolves a duplicate to the reference that already holds those
   bytes. Dropping something already in your archive should quietly place the
   existing reference at the drop point -- that is the behaviour you want, and
   it is already computed for you.

5. MULTI-FILE DROP cascades from the drop point rather than stacking at it --
   dropping eight images must not produce one visible node with seven hidden
   underneath.

6. Non-images: PDFs and text go through the same path, since ingest handles
   them. Refuse anything ingest does not support by name and extension, before
   uploading, rather than after a failed round trip.

Tests: a loose image drop creates a capture with the project attached; a folder
drop is refused without touching webkitGetAsEntry; dropping a file already in
the archive places the existing reference and creates no second row; an
unsupported type is refused before upload; a failed capture removes its
placeholder and says why.
````

**Exit criteria:** a Finder drag lands where you dropped it, is in the project, and a duplicate places rather than errors.

---

### Session A3 — Shapes on the canvas

**Delivers:** rectangles and ellipses drawn directly on the canvas, with fill, stroke and stroke width.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read static/project/canvas/nodes.js (its kind switch and gesture handling),
canvas/store.js, canvas/palette.js, canvas/edges.js, and db.py's CANVAS_NODES
schema first.

Add shapes as a new canvas node kind.

1. A NEW KIND, NOT A WIDGET. canvas_nodes.kind becomes
   reference | text | widget | shape. A shape has no host contract, no
   lifecycle and nothing to destroy, so routing it through the widget registry
   would give it machinery it does not need and put a decorative ellipse in the
   project grid's Add Widget dock, where it does not belong.

   The one-table rationale in CLAUDE.md still holds and is the reason this
   fits: a shape drags, locks, z-orders and connects exactly like everything
   else. Only its body differs.

   config: { shape: "rect" | "ellipse", fill, stroke, strokeWidth }. Fill and
   stroke both accept a colour or none -- an outline-only shape and a fill-only
   shape are both ordinary requests.

2. DRAWING. Pick the tool, then drag on empty canvas to draw. Use the pointer
   gestures nodes.js already uses; do not introduce native drag.

   SHIFT CONSTRAINS WHILE DRAWING: held, a rectangle becomes a square and an
   ellipse a circle. Released, free proportions.

3. RESIZING AN EXISTING SHAPE INVERTS THAT, DELIBERATELY:
     no modifier -- scales uniformly, keeping proportion
     shift held -- changes one axis only

   This is the opposite of Figma and most editors, and it is intended. Once a
   shape exists you usually want to keep its proportion and occasionally to
   stretch it; while drawing you usually want freedom and occasionally a true
   square. Write that reasoning in a comment, or a later session will "fix" it
   to match convention.

4. Shapes sit behind by default -- they are usually grounds for other things.
   Give z-order controls, at minimum send-to-back and bring-to-front, using the
   z_index column that already exists.

5. Shapes connect with edges like any other node, and lock like any other node.

6. Colour here is free. The two-colour rule belongs to drafting.css and the
   schedule surface; the project canvas is the neumorphic side of the app and a
   shape is the user's own mark.

Tests: shift while drawing gives an exact square; shift while resizing moves
one axis and no modifier keeps the ratio; a shape persists its fill, stroke and
width across a reload; send-to-back survives a reload; an edge can attach to a
shape.
````

**Exit criteria:** shapes draw, resize by the stated convention, layer correctly and persist.

---

### Session A4 — Pages: laying out a portfolio on the canvas

**Delivers:** a region of canvas given over to A4 pages, filled with images, arranged singly or as spreads, and exportable as a PDF.

**Model:** Opus 5, `max` · 4–5 h · 350–500k tokens · 1–1.5 windows
**Why Opus:** layout geometry, a new node type owning children, image fitting and PDF generation at once, with several decisions that are cheap now and expensive later.

````
Read static/project/canvas/nodes.js, canvas/store.js, db.py's CANVAS_NODES
schema, capture.py and its routes, ingest.py (is_own_work especially), and
app.py's existing PyMuPDF use in the thumbnail route first.

Portfolio layout, on the canvas. The deliverables this app tracks are PDFs of
roughly thirty pages, and there is currently nowhere to see them as pages.

1. A SPREAD IS ONE NODE THAT OWNS ITS PAGES. Draw a rectangle on the canvas and
   it fills with pages. Do not make each page its own node: the spread owns
   count, orientation, spacing and order, and moving or resizing it must move
   and rescale everything together.

   kind = "pages". config holds the layout and an ordered array of page
   entries, each { reference_id, fit }. A page with no reference is an empty
   slot and must render as one -- a portfolio in progress is mostly empty
   slots and that is the normal state, not an error.

2. PAGE GEOMETRY. Pages are A4 proportioned -- 1 : 1.414 -- with orientation
   chosen per spread, portrait by default. Pages size themselves to fit the
   drawn region: the region sets the bounds, the count and orientation set how
   many fit across, and the page size follows. Never distort the ratio to fill
   the region; leave the slack.

3. TWO LAYOUTS.
     sequential -- pages evenly spaced in a grid, equal gaps throughout
     booklet    -- pages paired, a TIGHT GUTTER inside a pair and a wider gap
                  between pairs. The pages in a pair never touch; the gutter
                  is what makes it read as a spread rather than one wide page.
   Offer whether page 1 stands alone as a cover, which shifts every pair after
   it. Getting that wrong silently renumbers the whole document.

4. FILLING A PAGE. Click an empty page to upload an image.

   Route it through capture.py as session A2 does -- accept fast, ingest on the
   worker, place optimistically -- rather than adding a second upload path.

   SET is_own_work = 1. These are portfolio outputs, not research, and that
   column already exists and already drives the archive's Own work filter. Thirty
   portfolio pages appearing in reference search would make the archive worse.

5. FITTING. Most uploads will already be A4 proportioned and should land exactly.
   For anything else:
     contain -- default. The whole image, letterboxed, nothing lost.
     cover   -- fills the page, crops the overflow, with the crop adjustable.
     never distort. Stretching artwork to fit is not a mode.
   Show the mismatch when there is one rather than silently choosing.

   WARN ON RESOLUTION. An image that would print below roughly 150dpi at A4
   looks fine on screen and bad on paper, and this is a print deliverable.
   Say so at upload, do not block it.

6. PDF EXPORT. Server-side with the PyMuPDF already in the stack -- no new
   dependency. True A4 pages at the images' native resolution, in the spread's
   page order, empty slots exported as blank pages rather than skipped so
   pagination survives.

   Stream it; do not build thirty full-resolution pages in memory.

7. Pages are not separately draggable, do not take edges individually, and are
   reordered within the spread rather than moved around the canvas. The spread
   is the thing on the canvas; the pages are its contents.

Tests: a drawn region produces correctly proportioned A4 pages; booklet pairs
have a tighter gutter than the gap between pairs; a cover page shifts the
pairing; a non-A4 image contains without distortion; an uploaded page is
is_own_work and does not appear in a default reference search; export produces
A4 pages in order with blanks preserved; a low-resolution upload warns.
````

**Exit criteria:** a spread lays out A4 pages correctly in both modes, images fit without distortion, uploads land as own work, and the PDF matches what is on screen.

---

### Session A5 — Split a PDF into pages on import

**Delivers:** an option, when adding a PDF, to burst it into one image reference per page instead of storing it as a single document.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read ingest.py (PDF_EXTS, _extract_pdf_content, add_reference), app.py's
PDF_THUMB_DPI and its thumbnail route, capture.py in full, and the Add tab in
static/index.html and static/app.js first.

A PDF currently becomes one reference. A lookbook, a scanned magazine or an
exhibition catalogue is more useful as its pages: each page is a reference that
can be tagged, embedded, found by colour, put on a canvas and placed on a
portfolio page. Add that as an option at import.

1. THE CONTROL LIVES ON THE ADD TAB, beside the existing own-work checkbox, and
   appears only when what is being added is a PDF. Default OFF -- storing the
   document whole stays the normal case.

2. RENDER WITH THE PyMuPDF ALREADY IN THE STACK. ingest.py imports fitz and
   app.py already renders page one at PDF_THUMB_DPI = 72 for thumbnails.

   72dpi is a thumbnail resolution and is far too low for a reference that will
   be zoomed into, colour-analysed and possibly placed on a printed page.
   Render pages at a genuinely useful resolution -- around 150 to 200dpi -- and
   make it a named constant separate from the thumbnail one. Do not reuse
   PDF_THUMB_DPI; they are answering different questions.

3. LET THE USER CHOOSE PAGES. Most of the time a few pages out of forty are
   wanted, not all forty. Offer a page range, defaulting to all, and show the
   page count before committing. This is the single control that keeps this
   feature from being expensive.

4. SPLIT SYNCHRONOUSLY, INGEST THROUGH THE QUEUE. Rendering is fast -- tens of
   milliseconds a page -- so do it in the request. Tagging and embedding are
   not, so enqueue each rendered page as an ordinary capture through
   capture.py rather than blocking or writing a second ingest path.

   That also means a forty-page split reports progress and survives a restart,
   both of which capture.py already provides.

5. NAME AND ATTRIBUTE THE PAGES. One PDF becoming thirty references named alike
   is a worse archive than the PDF was.
     - title: the document's title with its page number, so sorting is natural
     - source: carry the original filename through, so provenance survives
       without a schema change -- the column already exists
     - is_own_work follows whatever the user set for the import

6. COST IS THE REAL CONSTRAINT. Every page gets a Claude tagging call and a
   CLIP embedding. Forty pages is forty calls. Say so before starting -- show
   the page count and what will be created -- and let the range control be the
   answer. Do not silently start forty API calls because someone dragged in a
   catalogue.

7. Duplicate detection works for free and should be left alone: each rendered
   page is hashed like any other file, so re-splitting the same PDF at the same
   DPI resolves to the existing references rather than creating a second set.
   That only holds while the DPI constant is stable -- note it beside the
   constant.

8. The original PDF is not kept when splitting, as requested. Out of scope, but
   worth leaving room for: the extension's capture path and session A2's canvas
   drop both take PDFs too, and would want the same option eventually.

Tests: a three-page PDF produces three references with page-numbered titles and
the original filename as source; a page range imports only those pages;
re-splitting the same PDF creates no duplicates; the option does not appear for
a non-PDF; splitting a forty-page document does not block the request.
````

**Exit criteria:** a PDF can be imported as pages at a useful resolution, the page count and cost are stated before it starts, and pages are named so the archive stays legible.

---

### Session A6 — Rotate a reference

**Delivers:** a 90° rotate for a single reference, and the same across a multi-selection in the archive.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read ingest.py (add_reference, _file_hash, IMAGE_EXTS), app.py's /media and
/media/<id>/thumb routes, db.py's list_references_needing_colour and
save_colour_analysis, embeddings.py, static/shared/carousel.js, and
static/app.js's archive selection toolbar first.

Scans arrive upside down. Add a rotate, working the way Preview's does: one
button, 90° a press, four presses back to where you started.

1. ROTATE THE BYTES, DO NOT STORE A DISPLAY ANGLE. A rotation flag applied at
   render time would have to be honoured by every consumer -- the thumbnail
   route, the media route, drag-out, the portfolio PDF, the canvas, the 3D
   scenes' thumbnails -- and the first one missed sends an upside-down image
   into InDesign. A scan that is wrong is simply wrong; there is nothing worth
   preserving about its original orientation.

   Rotate with Pillow, which is already a dependency, and write the file back
   in place. Note in a comment that a JPEG round-trip re-encodes: save at high
   quality and accept it, or the alternative is a lossless-rotate dependency
   this project does not need.

2. THE CONTENT HASH CHANGES, AND TWO THINGS HANG OFF IT.

   Update reference_items.content_hash. Dedupe then correctly treats the
   rotated file as different bytes, which it is.

   CARRY THE COLOUR ANALYSIS FORWARD rather than letting it invalidate.
   list_references_needing_colour re-queues anything where
   `c.content_hash IS NOT r.content_hash`, so doing nothing means every
   rotation schedules a re-analysis -- and rotation does not change a palette.
   Update the stored analysis's content_hash alongside and the work is skipped
   correctly.

   RE-EMBED, though. Rotation genuinely changes a CLIP embedding, so the
   vector must be recomputed or similarity search quietly degrades. That is
   local CPU, no API call.

   DO NOT RE-TAG automatically. Tags may well be poor if the image was tagged
   upside down, but re-tagging is an API call each and a bulk rotate would fire
   dozens. Offer it as a separate action.

3. CACHE-BUST THE THUMBNAIL. /media/<id>/thumb serves the file straight off
   disk with no cache headers, so the browser will happily show the old
   orientation after a rotate. Append the content hash as a query parameter
   wherever thumbnails are requested, so the URL changes when the bytes do.
   This is the part most likely to look like "rotation didn't work".

4. SINGLE REFERENCE. An "Edit reference" control in the viewer opens a small
   editor with the image and a rotate button. It applies immediately and
   saves; there is no confirm step, because four presses is the undo.

5. MULTI-SELECTION. "Edit references" in the archive's selection toolbar, with
   a rotate that turns every selected reference 90°. No preview, but every
   selected thumbnail currently on screen must visibly turn as it is pressed --
   that feedback is the whole interface.

   Rotating twenty references is twenty file writes and twenty CLIP embeds.
   Queue it, report progress, and let the thumbnails update as each completes
   rather than at the end.

6. IMAGES ONLY. The control does not appear for text, and does not appear for
   PDFs -- rotating PDF pages is a different job with a different tool, and
   this is not it. Say so rather than silently doing nothing.

Tests: a rotated image has new bytes and a new content_hash; its colour
analysis survives rather than being re-queued; its embedding is recomputed;
four rotations restore the original orientation; a thumbnail URL changes after
a rotation; the control is absent for a .txt and a .pdf.
````

**Exit criteria:** a rotate is one press and immediately visible, the file itself is correct wherever it goes, and a bulk rotate reports progress without re-tagging anything.

---

### Session A7 — Real thumbnails, and a canvas that stays smooth

**Delivers:** generated thumbnails, lazy decoding and off-screen culling — the canvas and the archive grid both stop loading full-resolution originals.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read app.py's media_thumb route, static/shared/cards.js's makeCard,
static/project/canvas/nodes.js, db.py's COLOUR_ANALYSIS schema (the versioned
derived-data pattern this copies), and config.py first.

THE CANVAS IS SLOW BECAUSE /media/<id>/thumb DOES NOT MAKE A THUMBNAIL. For an
image it calls send_file on the original:

    if ext in ingest.IMAGE_EXTS:
        return send_file(path, mimetype=...)

Only PDFs get a rendered pixmap. So every card everywhere -- canvas nodes, the
archive grid, project grids, the carousel's similar-items strip -- downloads
and decodes the full-size original to draw it at a couple of hundred pixels.

Measured on the real archive: 193 images, mean 1.2 MB, largest 11.9 MB, 231 MB
on disk. Decoded is what costs: a 4000x3000 JPEG is roughly 48 MB of bitmap
whatever it compresses to, so a canvas of forty references can hold hundreds of
megabytes of pixels. Nothing about the canvas's own architecture is at fault --
nodes already use translate3d and the world layer is a single transform.

1. GENERATE AND CACHE THUMBNAILS. Resize with Pillow, which is already a
   dependency, to a sensible longest edge -- around 400px for grid and canvas
   use -- and cache the result on disk.

   KEY THE CACHE BY CONTENT HASH, NOT REFERENCE ID. That makes it correct for
   free in two places: identical bytes share one thumbnail, and session A6's
   rotate changes content_hash, so a rotated reference gets a new thumbnail
   rather than a stale one. Version the key the way colour_analysis does, so
   the size or quality can change later and old entries fall out.

   Derived data, recomputable, its own cache directory beside data/ -- hard
   rule 8's shape. Deleting the directory must cost nothing but regeneration.

   Generate on demand and serve, rather than a migration pass: the first load
   of a big archive warms it, and a missing thumbnail is never an error.

2. SERVE IT PROPERLY. The thumbnail route should set a long cache lifetime and
   an ETag from the content hash -- the bytes for a given hash never change, so
   this is safely cacheable, unlike today where the route has no headers at all
   and the browser guesses.

   Keep /media/<id> serving the original untouched. The carousel, the portfolio
   pages and drag-out all want full resolution; only cards want thumbnails.

3. LAZY AND ASYNC IN makeCard. Add loading="lazy" and decoding="async" to the
   card image. Two attributes, no downside, and they stop a grid of 193 cards
   decoding everything at once.

   Give the image intrinsic dimensions -- width and height attributes or an
   aspect-ratio -- so lazy loading does not collapse the layout and reflow as
   each one arrives.

4. CULL OFF-SCREEN NODES ON THE CANVAS. content-visibility: auto on a canvas
   node lets the browser skip rendering work for anything outside the viewport,
   which on a large canvas is most of it. It needs contain-intrinsic-size set
   from the node's own w/h, or scrolling past unrendered nodes jumps.

   Verify it does not break the marquee or the edge layer, both of which need
   to reason about nodes they cannot see. If it does, cull by adding and
   removing a class from the viewport subscription instead -- the node data is
   already in memory either way.

5. Leave the Three.js widget nodes alone. scene-host.js already pauses a scene
   when its element leaves the viewport, which is the equivalent fix and is
   working.

Measure before and after on a real canvas with forty-odd references: total
bytes transferred, decoded image memory, and frames during a pan. State the
numbers in the commit message -- this is a performance change and a claim
without a measurement is not one.

Tests: a thumbnail is generated once and reused; two references with identical
bytes share a cache entry; changing a file's content hash produces a new
thumbnail; deleting the cache directory is harmless; /media/<id> still returns
the original at full size.
````

**Exit criteria:** a forty-reference canvas pans smoothly, cards load lazily, and the archive grid stops pulling 231 MB of originals to draw thumbnails.

---

### Session A8 — Portfolio pages stage outside the archive

**Delivers:** page uploads that cost nothing and pollute nothing, a homepage widget showing the document as it stands, a configurable export resolution, and archiving only what you choose.

**Revises session A4**, which routed page uploads through `capture.py` into the archive as own work. That was the wrong call: a page being iterated on is not research, and it made every draft cost a Claude call and a row in reference search.

**Model:** Sonnet 5, `high` · 3–4 h · 280–380k tokens · ~1 window

````
Read static/project/canvas/spread.js, spread-panel.js, spreads.py,
canvas/captures.js, ingest.py's add_reference, db.py's schema constants, and
config.py's directory layout first.

A portfolio page currently goes through the capture queue, gets tagged by
Claude, embedded by CLIP and inserted as a reference with is_own_work = 1.
Seven already exist. Every revision of a page therefore costs an API call and
leaves another near-duplicate in the archive. Stage them instead.

1. A STAGING STORE, SEPARATE FROM THE ARCHIVE.

     portfolio_pages   id, project_id, filepath, content_hash,
                       width, height, uploaded_at

   Files go in their own directory beside references/ and deleted/ -- they are
   not archive material and should not live in the archive's tree.

   Upload is DIRECT AND SYNCHRONOUS: store the bytes, hash them, read the
   dimensions, return. No capture queue, no Claude call, no CLIP embedding.
   That is the whole point, and it also makes placing a page feel instant
   rather than pending.

2. SPREAD PAGES POINT AT STAGED PAGES. Each entry becomes
   { page_id, fit, crop? } rather than { reference_id, fit, crop?, capture_id? }.

   MIGRATE THE SEVEN CAREFULLY. is_own_work is also set by the Add tab's own
   checkbox, so not every own-work reference is a portfolio page. Migrate only
   references actually named by a spread's config, and leave the rest alone.
   Copy them into the staging store, repoint the spread, and do not delete the
   archive rows -- the user may have come to rely on them.

3. STAGE FIRST, PLACE SECOND. The store is project-scoped, not spread-scoped,
   so a page can exist before it has a slot. Upload thirty pages in one go,
   then fill slots from what is staged. That is how the work actually arrives.

4. VERSIONS BELONG HERE. Replacing a slot's image leaves the previous page in
   the store rather than discarding it -- in staging a draft is cheap,
   deletable and invisible to search, which is exactly where versions should
   accumulate. The problem was never having versions; it was versions reaching
   the archive.

5. A PORTFOLIO WIDGET THAT SHOWS THE PAGES, not just a door to them. On the
   project homepage it displays the current pages as thumbnails, in page order,
   so the state of the document is visible from the homepage without opening
   anything. Clicking opens the full management view: which slot each page
   fills if any, and per-page delete, replace and promote.

   Thumbnails come from session A7's cache, which has shipped -- `thumbnails.py`
   and `thumbnail_for(path, content_hash)`. Key staged pages the same way; it
   does not care whether the bytes are a reference or a page.

   Reuse the grid-page pattern where it fits, but do not force staged pages
   through a component expecting reference objects -- they are not references
   and pretending otherwise is how the archive got polluted in the first place.

   EXPORT DPI LIVES IN THE WIDGET'S CONFIG, edited in homepage edit mode like
   any other widget setting, per the widget contract. `config.exportDpi`, with
   a sensible default.

   What it does is DOWNSAMPLE, not upscale. An image already above the target
   is resampled down on export; one below it is left alone and still warned
   about, because resampling up invents detail that is not there. spreads.py
   already computes an effective dpi per page against MIN_PRINT_DPI = 150 --
   reuse that calculation rather than adding a second one.

   This matters practically: a thirty-page portfolio of 600dpi scans makes a
   PDF too large for most university submission portals, and 300dpi is the
   submission standard. A draft at 150 exports in seconds and is small enough
   to email.

   Export offers the widget's value as its default and allows an override for
   that one export -- a final submission should not require editing the
   homepage to change.

6. PROMOTION IS EXPLICIT. "Add to archive" runs a staged page through
   ingest.add_reference with is_own_work = 1, tagging and embedding it then and
   only then. Content hashing makes re-promotion a no-op for free.

   Export may OFFER promotion when it finishes -- default OFF, so a working
   export archives nothing, and a deliberate tick on a final one archives the
   set. Do not archive on export automatically; three exports during a week
   would be three sets.

7. Thumbnails come from session A7's cache, which is keyed by content hash and
   therefore does not care whether the bytes are a reference or a staged page.
   If A7 has not run, serve the file and leave a comment pointing at it.

8. Deleting a project deletes its staged pages and their files. Deleting a
   staged page that a spread still uses empties that slot rather than breaking
   it -- pagination is the document, as A4 already establishes.

Tests: uploading a page makes no Claude call and creates no reference; the
seven existing pages migrate and their spreads still render; a replaced page
leaves its predecessor in the store; promotion creates exactly one reference
and promoting twice creates none; deleting a staged page empties its slot;
export renders from staging with no archive write.
````

**Exit criteria:** placing a page is instant and free, drafts accumulate where they are harmless, and nothing reaches the archive without being asked for.

---

### Session A9 — A watched inbox folder

**Delivers:** drop anything into a synced folder from any app on the phone; the server ingests it next time it starts.

**Complements the phone queue, does not replace it.** `offline-queue.js` and `photo-capture.js` already let the PWA capture with the Mac off. But both require opening the app, and the thing you want to keep is usually in Safari or Photos, not in a calendar.

**Model:** Sonnet 5, `high` · 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read capture.py in full (especially resume_pending and the worker), ingest.py's
add_folder, app.py's startup block where resume_pending is called, and
config.py first.

Add an inbox: a folder the server watches and ingests from. Save to it from the
iOS share sheet via iCloud Drive -- or Dropbox, or anything that syncs -- and
the next time the server starts, everything in it becomes a reference.

The shape already exists here. capture.py is a durable queue that survives
restarts, resume_pending() already runs at boot, and ingest.add_folder already
walks a directory. This is those three joined up.

1. A CONFIGURED FOLDER, off by default. One path in config.py, unset until the
   user sets it. Nothing happens if it is not configured, and the app behaves
   exactly as it does now.

2. SCAN AT STARTUP AND ON DEMAND. At boot, after resume_pending, walk the
   folder and enqueue anything new. Add a control in Settings to scan now, so
   the server does not need restarting to pick things up.

   Do not add a filesystem watcher. A poll at startup plus a button is enough
   for a tool that is opened deliberately, and a watcher is a background thread
   whose failure modes are all silent.

3. ENQUEUE, DO NOT INGEST DIRECTLY. Each file goes through capture.py so
   tagging and embedding happen on the worker, progress is visible, and a crash
   mid-batch resumes. Forty holiday photos should not block startup.

4. MOVE WHAT IS PROCESSED. A file that has been enqueued moves to a `done`
   subfolder inside the inbox, so the next scan does not see it again. Moving
   rather than deleting means a mistake is recoverable, and it mirrors how
   deleted references already go to `deleted/` rather than being unlinked.

   Content hashing still protects you if a file is somehow seen twice -- a
   duplicate resolves to the existing reference, as it already does.

5. THE iCLOUD TRAP, which will otherwise waste an afternoon. iCloud Drive
   leaves placeholder stubs for files it has not downloaded -- a tiny
   `.<name>.icloud` file rather than the real bytes. Ingesting one gives you a
   corrupt reference.

   Skip anything whose name begins with a dot, and skip any file whose size
   looks implausible for its type. Report them as "not downloaded yet" and
   leave them for the next scan rather than failing them permanently.

6. REPORT AT STARTUP the way resume_pending already does -- how many were
   found, enqueued and skipped, and why anything was skipped. A silent inbox is
   indistinguishable from a broken one.

7. Unsupported file types are left in place and named in the report, not moved
   and not failed. The user put them there for a reason, even if that reason
   was a mistake.

8. Everything the inbox creates carries a source recording that it came from
   the inbox, so provenance survives -- the column exists.

On the phone side there is nothing to build: the iOS share sheet already saves
to iCloud Drive from any app. Document the setup in README.md, including that
a Shortcut can make it one tap.

Tests: a configured inbox ingests an image and moves it to done; a second scan
does not re-ingest it; a `.icloud` placeholder is skipped and reported, not
failed; an unsupported type stays put; an unconfigured inbox changes nothing;
startup reports counts.
````

**Exit criteria:** a photo shared to the folder from any app on the phone becomes a tagged reference the next time the server starts, with nothing to open and nothing to remember.

---

## Estimates

| # | Session | Model / level | Hours | Tokens | Windows |
|---|---|---|---|---|---|
| 1 | Schema and task API | Sonnet `high` | 3–4 | 250–350k | 1 |
| 2 | Task entry and completion | Sonnet `high` | 3–4 | 250–350k | 1 |
| 3 | Locations, hours, travel | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 4 | Commitments, ICS, capacity | Sonnet `high` | 3–4 | 250–350k | 1 |
| 5 | Scheduler core | **Opus** `max` | 4–5 | 350–500k | 1–1.5 |
| 6 | Location/support/travel/finishing | **Opus** `max` | 3–4 | 250–350k | 1 |
| 6b | Personal events, home-first, domestic | Sonnet `high` | 3–4 | 250–350k | 1 |
| 7 | Replan, outcomes, at-risk | Sonnet `high` | 3–4 | 250–350k | 1 |
| 8 | Estimator | Sonnet `high` | 3–4 | 250–350k | 1 |
| 9 | Week view | Sonnet `high` | 3–4 | 250–350k | 1 |
| 9a | Timetable detail, location grouping | Sonnet `high` | 3–4 | 280–380k | 1 |
| 9b | Schedule shell and front door | Sonnet `high` | 3–4 | 280–380k | 1 |
| 9c | The drafting language | **Opus** `max` | 4–5 | 350–500k | 1–1.5 |
| 9d | Physical texture | **Opus** `max` | 3–4 | 300–420k | 1 |
| 9e | Real media: density, scanned texture | **Opus** `max` | 4–5 | 350–500k | 1–1.5 |
| 10 | Day view | Sonnet `medium` | 2–3 | 150–250k | 0.75 |
| 11 | Month view | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 11b | The isometric month | **Opus** `max` | 4–5 | 350–500k | 1–1.5 |
| 12 | Deliverables UI | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 13 | Recurrence | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 14 | Resource archive | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 15 | Brief import, concept analysis | Sonnet `high` | 3–4 | 250–350k | 1 |
| 15b | Timetable groups, classification fallback | Sonnet `high` | 3–4 | 250–350k | 1 |
| 15c | Brief provenance, diff re-import, reset | Sonnet `high` | 3–4 | 250–350k | 1 |
| 15d | Year anchoring, ordering, supporting docs | Sonnet `high` | 3–4 | 280–380k | 1 |
| 15e | Concept analysis as curation | Sonnet `high` | 3–4 | 250–350k | 1 |
| 16 | Project integration, hardening | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| 16b | Migrate archive to drafting language | Sonnet `high` | 3–4 | 280–380k | 1 |
| 17 | Remote access, phone day view | Sonnet `high` | 3–4 | 250–350k | 1 |
| 18 | Offline cache and sync queue | Sonnet `high` | 3–4 | 250–350k | 1 |
| 19 | Photo capture | Sonnet `medium` | 1.5–2.5 | 120–200k | 0.5 |
| A1 | Getting files out of the archive | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A2 | Drop files onto a canvas | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A3 | Shapes on the canvas | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A4 | Pages: portfolio layout | **Opus** `max` | 4–5 | 350–500k | 1–1.5 |
| A5 | Split a PDF into pages | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A6 | Rotate a reference | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A7 | Real thumbnails, canvas performance | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| A8 | Portfolio pages stage outside the archive | Sonnet `high` | 3–4 | 280–380k | 1 |
| A9 | A watched inbox folder | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| | **Total** | | **71–93 h** | **6.1–8.4M** | **22–24** |

Roughly four weeks at a window a day. Sessions 1–8 are the product; 9–16 make it usable; 17–19 make it portable. Stopping after 16 leaves a complete desktop application.

---

## Checkpoints

Commit after every session. Four are worth tagging:

- after **4** — data layer complete, nothing schedules yet
- after **8** — the scheduler works and learns; usable from the API alone
- after **12** — usable daily
- after **16** — v1 complete

---

## Risks

**Session 5 is the product.** If placement feels wrong, no UI rescues it. Give it the most manual checking and be willing to spend a second window. It and session 6 are the two Opus sessions; everywhere else Opus is better held back for debugging.

**Cold start.** For the first weeks every estimate is Claude guessing. The UI must say so; false precision here is worse than an honest range.

**Energy inference will annoy before it helps.** Keep the rule simple enough to predict and the override obvious.

**The dependency repoint in session 7** is the most likely silent bug in the plan. Test it first, not last.

**The phone queue is the only place browser storage holds user actions.** It is bounded and justified. A later session must not extend it into a general offline mode or treat it as a source of truth.

**Scope creep toward a general to-do app.** The value is the rewiring, the learning, and the protected finish. Anything not serving those three can wait.
