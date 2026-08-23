# Schedule — session plan

Nineteen sessions. Scope, data model and reasoning live in `SCHEDULE_SCOPE.md`; read that first if anything here seems arbitrary. Conventions come from `CLAUDE.md`, which Claude Code loads automatically.

**Status: sessions 1–5 complete. Next up: session 6, then the new 6b.**

**Known gap, deferred to session 9:** session 4 says to compute `available_minutes` "from working hours minus commitments" but never defines where working hours come from, and the scope document's data model omits them entirely. Session 4 correctly inferred a `working_hours` table and `GET/PUT /api/working-hours`, but nothing told it to build a UI, so there isn't one — and with no rows, every weekday has zero capacity and everything lands on the at-risk list. Not a deviation; my omission. Do not confuse this with `location_hours`, which is when a *place* is open; `working_hours` is when *you* are willing to work.

---

## How to run a session

Same loop as `DEVELOPMENT_PLAN.md`: commit any doc changes on `test-widget-dock` first, `/clear`, set the model and level, paste **only that session's prompt**, check the exit criteria before merging, then delete the worktree and branch so the next session cuts a fresh one.

Do not give Claude Code this file or the scope document. The prompts are self-contained and name what to read.

### Models and levels

Two different levers. **Thinking level buys care** — working through edge cases rather than rushing. **A stronger model buys the ability to hold many interacting constraints in mind at once** and get the shape right in one pass. Most sessions below have their shape fixed by the prompt, so the level does the useful work and Sonnet is right.

| Model | Sessions | Why |
|---|---|---|
| Opus | 5, 6 | The scheduler and its constraints. Several dimensions interacting at once, where a structural mistake is expensive downstream and a spec cannot fully pre-empt a bad interaction. |
| Sonnet | everything else | Shape already fixed by the prompt; the level does the work. |

| Level | Sessions |
|---|---|
| `medium` | 3, 10, 11, 12, 13, 14, 19 |
| `high` | 1, 2, 4, 6b, 7, 8, 9, 15, 16, 17, 18 |
| `max` | 5, 6 |
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

### Session 10 — Day view

**Model:** Sonnet 5, `medium` · 2–3 h · 150–250k tokens · ~0.75 window

````
Read static/schedule/calendar.js from session 9 first.

Mount the shared component as a single-day view. If it needs week-specific
assumptions removed to do this, remove them -- that is the point of session 9
having built it as a component.

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
````

**Exit criteria:** deadline collisions and overloaded weeks are visible at a glance.

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
       archive and museum visits, workshops with required attendance

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

2. CONCEPT ANALYSIS. Given the brief and the user's own initial notes or
   references, produce a critique: where the connection to the brief is strong,
   where it is asserted rather than demonstrated, and what research directions
   would strengthen it.

   Extend analyze.py rather than adding a second Claude path -- it already
   builds multi-reference prompts and manages a conversation. The output should
   be savable to the project canvas or homepage as a note.

   Be useful rather than flattering. A critique that says everything is fine is
   worthless; the value is in naming the weak link.
````

**Exit criteria:** the 2026 Construction brief produces a sensible reviewable skeleton, nothing enters unapproved, and a concept critique reads as genuinely critical.

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
| 10 | Day view | Sonnet `medium` | 2–3 | 150–250k | 0.75 |
| 11 | Month view | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 12 | Deliverables UI | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 13 | Recurrence | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 14 | Resource archive | Sonnet `medium` | 2–3 | 150–250k | 0.6 |
| 15 | Brief import, concept analysis | Sonnet `high` | 3–4 | 250–350k | 1 |
| 16 | Project integration, hardening | Sonnet `high` | 2.5–3.5 | 200–300k | 0.75 |
| 17 | Remote access, phone day view | Sonnet `high` | 3–4 | 250–350k | 1 |
| 18 | Offline cache and sync queue | Sonnet `high` | 3–4 | 250–350k | 1 |
| 19 | Photo capture | Sonnet `medium` | 1.5–2.5 | 120–200k | 0.5 |
| | **Total** | | **55–72 h** | **4.5–6.3M** | **17–18** |

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
