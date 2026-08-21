# Schedule — scope, systems and timeline

Pre-plan document. Agreed here first; session prompts follow in a separate plan once this is approved.

---

## What it is

A scheduling layer inside the existing reference tool. You describe what you want to do; it decides when. Tasks can belong to a project or stand alone, and everything competes for the same finite hours — university, studio time, travel and life admin.

The distinguishing behaviours are that **the schedule rewires itself daily** as things slip, that it **learns how long your work actually takes**, and that it **protects the end of a project** rather than letting finishing work get squeezed.

That last one is the point. On the Construction module the marks lost were finishing failures, not skills gaps — garment not fitting the mannequin, flaps and chest pocket unattached, patterns short of printable standard, no final press, threads untrimmed. The tutor's closing note was "focus on managing your time effectively." A scheduler that packs six weeks efficiently but lets the last week compress would reproduce that result exactly.

---

## Decisions taken

| Decision | Choice |
|---|---|
| Codebase | Same Flask app, new tables |
| Scheduler | Deterministic placement, LLM at the edges |
| Energy | Inferred from calendar, manually overridable |
| Resources | Manual archive in v1; auto-lookup later |
| Timetable | ICS feed or file import |
| Travel | Per-location typical minutes |
| Project link | Optional — standalone tasks compete for the same hours |
| Views | Week first, then day, then month |
| Deliverables | First-class: project → deliverable → task |
| Brief parsing | Claude suggests; nothing enters the schedule unapproved |
| Finishing time | Automatic and protected before each deadline |
| Horizon | Project-length, not a rolling window |

---

## Data model

New tables, following existing conventions — schema constants at the top of `db.py`, registered in `init_db()`, raw `sqlite3`, derived data in its own table.

```
deliverables       id, project_id, title, description, due_at, weighting,
                   spec (JSON: page counts, required items), position

tasks              id, project_id (nullable), deliverable_id (nullable),
                   title, description, measurable_goal, deadline,
                   required_location_id (nullable), support_level,
                   est_minutes, importance, difficulty, is_finishing,
                   status, recurrence_id (nullable), continues_task_id (nullable),
                   slip_count, created_at
                   -- status: pending | scheduled | done | partial | abandoned
                   -- continues_task_id chains a remainder back to what it continues
                   -- plus a *_source flag per estimated field: user | generated

task_dependencies  task_id, depends_on_task_id            PK (both)

task_actuals       task_id PK, actual_minutes, actual_difficulty,
                   actual_importance, completed_at, notes

scheduled_blocks   id, task_id, start, end, is_locked, generated_at

commitments        id, title, start, end, kind, location_id (nullable),
                   support_level, source, external_uid, energy_cost

locations          id, name, address, travel_minutes_from_home, notes

location_hours     location_id, weekday, opens, closes    PK (location_id, weekday)

location_overrides id, location_id, date, opens, closes, closed

location_travel    from_location_id, to_location_id, minutes
                   PK (from_location_id, to_location_id)
                   -- only the pairs you actually make; missing pairs fall
                   -- back to via-home using travel_minutes_from_home

recurrence_rules   id, interval_days, window_days, preferred_time, active

resources          id, name, location_id, url, notes, date_added

resource_items     resource_id, item, tags                PK (resource_id, item)

briefs             id, project_id, filepath, extracted (JSON), imported_at

daily_capacity     date PK, inferred_energy, manual_energy, available_minutes
```

Shapes that matter:

- **`task_actuals` is separate from `tasks`** — derived data with its own lifecycle, the same reasoning that keeps `colour_analysis` out of `reference_items`.
- **`scheduled_blocks` is the scheduler's output**, regenerated on every replan, so a replan never mutates task data. A pinned block is a row with `is_locked = 1`.
- **Every estimated field records its source.** A duration you set and one Claude guessed must be distinguishable, or the estimator trains on its own guesses.
- **`deliverables.spec` is JSON** because brief formats vary — this year's has page counts and item lists; next year's may carry review dates and presentation checkpoints. Columns would need migrating every September.

---

## Locations, hours and support

The studio is open roughly 10:00–18:00 most days. Timetabled sessions do not create that availability — they add a **tutor**, and priority for their attention. The sewing technician is almost always in; pattern-cutting tutors are often in but you rank below whoever is timetabled.

So support is a spectrum, and it is a property of both the window and the task:

- `location_hours` — the default weekly opening pattern per location
- `location_overrides` — a specific date closing early, or closed entirely
- `commitments.support_level` — `priority` for your timetabled session, `ambient` when staff are usually around, `none` otherwise
- `tasks.support_level` — `needs` (a new technique, schedule into a priority window), `prefers` (ambient is fine), `independent` (any open hours)

The scheduler matches the two. Work you already know how to do fills ordinary studio hours; work you need help with is placed against a supported window, and flagged if none exists before the deadline.

**`required_location_id` is a hard constraint**, distinct from travel cost. Pattern cutting cannot happen at home, so those tasks are only ever placed inside that location's open hours.

### Travel

`travel_minutes_from_home` covers home→X and X→home, which is the first and last leg of any day. It cannot express studio→fabric shop, so `location_travel` records the handful of pairs you actually make. A pair with no row falls back to via-home, which is honest but pessimistic — if it produces a silly number, add the pair.

Travel is **scheduled as visible blocks**, not deducted invisibly. A day that is full because of three trips should look full, and you should be able to see why.

---

## The scheduler

Input: incomplete tasks, deliverables, commitments, location hours, daily capacity, and a horizon that runs **to the furthest project deadline** rather than a fixed two weeks.

1. Topologically sort by dependencies. A cycle is rejected naming the tasks involved.
2. Score each task as **urgency × importance**, where urgency is a function of *slack* — time until deadline minus estimated duration — not raw deadline. A task due Friday needing four days is more urgent than one due Thursday needing an hour.
3. Walk days forward. For each day: subtract commitments, read energy, and take the eligible set — dependencies already placed, difficulty within what the day's energy admits, and a location open with adequate support.
4. Place the highest-scoring eligible task in the first slot that fits, inserting a travel block when consecutive blocks sit at different locations. **Among eligible tasks of comparable score, prefer one at the location you are already at.** Without this tie-break a greedy urgency-first walk will send you studio → shop → studio in a day, or split two fabric-shop visits across two days when they could be one trip — which is the kind of output that makes a scheduler stop being trusted.
5. Anything that cannot fit before its deadline goes on the **at-risk list**, reported per deliverable as well as per task.

**Detail decays with distance.** The next few days are placed to the slot; weeks four to six are allocated at day granularity. Precision that far out is false, and rewriting it daily wastes effort.

**Energy gates difficulty.** A low-energy day admits only low-difficulty work.

**Finishing time is reserved and protected.** A configurable buffer before each deadline is only available to tasks flagged `is_finishing`. Ordinary work cannot colonise it, however far behind you are — being behind is exactly when it would get taken.

**At-risk is the most valuable output.** Being told in week three that Part 2 is unreachable beats any amount of clever packing.

**Determinism.** Same inputs, same schedule. Ties break by id, so the whole thing is testable offline like the existing suite.

---

## The estimator

Cold start is the real constraint: with five completed tasks, "similar past tasks" means nothing.

1. **Global calibration** — the ratio of actual to estimated minutes across everything. Most people run consistently over, and this one number removes most of the error before any per-category data exists.
2. **Nearest neighbours** — task descriptions embed through the CLIP text path `embeddings.py` already provides, so finding similar completed tasks is a vector query against existing infrastructure. No new dependency.
3. **Claude** — for work unlike anything completed, estimating duration, difficulty and importance from the description, following the `tagging.py` pattern.

The UI states which layer answered: "about 2h — low confidence, 3 similar tasks", never "2h 15m".

---

## Task entry and completion

**One required field:** a sentence describing the task. Deadline, location, project, deliverable, importance, difficulty, estimate and measurable goal are all optional, and anything blank is generated. Generated values appear as editable chips after saving, never as a form to fill first. Leaving the time blank means auto-schedule; setting one pins it.

**Completion is one tap.** Actual duration defaults to the scheduled block's length, correctable, and the same for difficulty and importance. If recording actuals is a chore it will not happen and the estimator never improves.

**Recurrence is interval-based and floating** — "about every three days" with a tolerance window, not "every Monday".

### The three outcomes

A scheduled block resolves one of three ways, and they behave differently.

**Completed.** Record actuals. A clean data point for the estimator.

**Partially completed.** Record the time actually spent, then spawn a remainder task prefilled from the original — title, description, project, deliverable, location, support level, importance, difficulty all inherited and editable, with a fresh estimate for what is left. It enters the schedule like any new task. The original is closed as `partial` and linked by `continues_task_id`, so the two form a chain.

**Not completed.** The whole task returns to the pool and is replanned unchanged.

Three consequences that are easy to get wrong:

- **A partial must not teach the estimator that work is faster than estimated.** If a task estimated at 3h had 2h spent and is not finished, recording 2h as its actual is backwards. Instead the estimator trains on the **chain**: when the final link completes, sum the time across every segment and compare that to the *original* estimate. No "what percentage done are you?" prompt, and a more honest signal.
- **Not-completed carries zero information about duration.** Never starting a task says nothing about how long it takes, so it must not become an actual. It is, however, information about the *schedule* — so track a slip count per task and an overall slip rate. A day that regularly fails to deliver is over-packed, and that is worth surfacing.
- **Dependencies must repoint to the remainder.** If B depends on A and A goes partial, B must now depend on A′. Leaving it pointed at A would let the scheduler treat the work as finished and place B too early. This is the single most likely bug in the whole feature.

A task that slips repeatedly should say so rather than being quietly rescheduled forever — three slips usually means it is underestimated, blocked, or being placed on days whose energy cannot carry it.

---

## Brief ingestion and concept work

These sit on the reference-tool side and could ship separately, but they came out of the same conversation.

**Brief import.** A brief PDF attached to a project is parsed by Claude into deliverables, dates and a proposed task skeleton, presented as a reviewable list. Nothing enters the schedule until approved. The 2026 Construction brief shows this is tractable: it states briefing and hand-in dates, six weeks of study, and enumerates deliverables with page counts and required items, plus mandatory activities — fabric shop visits, museum and archive visits, three documented fabric tests, workshop attendance.

Next year's briefs will differ — more tutor contact, review and presentation checkpoints, sessions shifting from skills teaching toward project development. So the parser must extract what is present rather than expect a fixed shape, and `deliverables.spec` stays JSON.

**Brief widget.** The brief rendered on the project homepage, with deliverables and their status.

**Concept analysis.** Your initial reactions to a brief, analysed against it: where the connection is strong, where it is asserted rather than shown, and what research directions would strengthen it. Extends `analyze.py` rather than adding a second Claude path. Output lands on the project canvas or homepage.

---

## Phone companion

A home-screen PWA, not a native app. Add to Home Screen gives an icon that opens fullscreen with no Safari chrome; there is no App Store, no developer account, and no seven-day re-signing expiry that a free-account side-loaded build would suffer. It lives in the same Flask app and reuses the same API, auth and CSS variables. Updates are instant — change the server, the phone has it next open.

**Reachability is the actual problem, not the app.** The server binds to `127.0.0.1`, which a phone cannot see. Tailscale gives both devices a stable private IP regardless of physical network, so the phone works on cellular while the Mac is on someone else's Wi-Fi. Flask binds beyond localhost and `ARCHIVE_API_TOKEN` — already in `config.py` for the browser extension — is switched on. This does not breach hard rule 3: client code still uses relative paths and still knows nothing about the port.

**A sleeping Mac is unreachable, and iOS gives PWAs no meaningful background execution.** So the queue flushes when you *open the app* with the Mac awake, not silently in your pocket. This is the one real advantage a native app would have.

### The offline queue, and a narrow exception to hard rule 2

Rule 2 forbids browser storage for anything the user created. The phone queue needs an explicit, bounded exception:

**IndexedDB is a transit buffer, never the system of record.** SQLite on the Mac remains authoritative. The queue holds actions that have not yet reached the server, and each entry is deleted once acknowledged. Nothing is ever read back from it as truth. In-memory state and `sessionStorage` are both wrong here — the queue must survive a full app close.

Two properties every queued action carries:

- **A client-generated id**, so a retry cannot double-apply. The completion endpoint must be idempotent.
- **The phone's own timestamp.** If a task is completed at 09:00 and the queue does not flush until 18:00, the server records 09:00. Otherwise every actual is stamped with whenever the laptop happened to open, and the estimator learns from durations that never happened. Given the learning loop is the point, this is the difference between the data being useful and being noise.

`navigator.storage.persist()` is requested on first launch to exempt the queue from routine eviction.

### Photo capture

Uploads reuse `capture.py` rather than adding a path. It already exists for exactly this shape of problem: `POST /api/captures` accepts a multipart file, writes it to `PENDING_DIR`, queues it, returns 202 immediately, and a background worker does the slow tagging and embedding. It survives restarts through `resume_pending()`, `GET /api/captures/<id>` polls status, and it is already token-authenticated for remote clients.

iPhone photos are HEIC, which `IMAGE_EXTS` does not accept. Converting to JPEG in a canvas before queueing solves the format and shrinks a 4MB photo to a few hundred KB — which also keeps the offline queue well inside iOS storage limits.


---

## v1 boundary

**In:** tasks with the full attribute set, deliverables, dependencies, ICS timetable import, manual commitments, location hours with overrides, support matching, energy inference with override, the scheduler with project-length horizon and protected finishing time, daily replan, the at-risk list, the estimator's three layers, actuals capture, interval recurrence, the manual resource archive, brief import with approval, and week / day / month views.

**Later:** automatic nearby-shop lookup and real travel times, concept analysis and the brief widget if they slip, shared schedules, notifications.

**Phase 2 — phone companion (sessions 17–19):** remote access, the mobile day view, offline queue and sync, photo capture. Deliberately after the sixteen, because it consumes the API rather than shaping it.

---

## Setup

One small ICS parsing library. Everything else is the existing stack — Flask, raw `sqlite3`, numpy, the Anthropic client, and the CLIP text path already in `embeddings.py`. No build step, no new frontend dependency, nothing that complicates pywebview packaging.

---

## Timeline

Sixteen sessions.

| # | Session | Notes |
|---|---|---|
| 1 | Schema and task CRUD API | All tables, routes, tests. No UI. |
| 2 | Task entry and completion UI | One-field entry, generated chips, one-tap completion. |
| 3 | Locations, hours, travel | Opening patterns, closures, from-home minutes, per-pair travel. |
| 4 | Commitments, ICS import, capacity | Timetable in, support levels, energy inference. |
| 5 | Scheduler core | The hard one. Likely two windows. |
| 6 | Location, support, travel and finishing constraints | Hard location constraints, support matching, travel blocks and the same-location tie-break, protected finishing time. |
| 7 | Replan, outcomes, at-risk, pinning | Daily rewire, the three outcomes and chaining, per-deliverable risk. |
| 8 | Estimator | Calibration, CLIP neighbours, Claude fallback. |
| 9 | Week view | The primary planning surface. |
| 10 | Day view | Execution and drag-to-reschedule. |
| 11 | Month view | Overview and deadline density. |
| 12 | Deliverables UI | Progress and risk against the brief's structure. |
| 13 | Recurrence | Floating interval tasks. |
| 14 | Resource archive | Shops, stock, linking to tasks. |
| 15 | Brief import and concept analysis | Parse, review, approve; the analysis pass. |
| 16 | Project integration and hardening | Schedule widgets, full test pass. |
| 17 | Remote access and phone day view | Bind beyond localhost with token auth, mobile day view, PWA manifest, add to home screen. Online only. |
| 18 | Offline cache and sync queue | Service worker, IndexedDB queue, client ids and phone timestamps, idempotent completion, one `today` payload. |
| 19 | Photo capture from the phone | HEIC→JPEG in canvas, queued blobs, existing `/api/captures`, status polling. |

At one window a day on Pro, four to five weeks for the core sixteen, plus about half a week for the phone. Session 5 is the one most likely to overrun. Sessions 9–11 share a calendar component, so 10 and 11 should be much cheaper than 9. Session 19 is small because the backend already exists.

---

## Open risks

**The scheduler is the product.** If placement feels wrong, no UI rescues it. Session 5 deserves the most care and the most manual testing.

**Cold start is unavoidable.** For the first weeks the estimates are Claude guessing, and the UI should say so.

**Energy inference will annoy before it helps.** Keep the rule simple enough to predict and the override obvious.

**Brief parsing will misread something.** That is why nothing enters the schedule unapproved.

**The phone queue is the one place browser storage holds user actions.** It is bounded and explicitly justified above. A later session must not extend it into a general offline mode, and must not treat it as a source of truth.

**Scope creep toward a general to-do app.** The value is the rewiring, the learning, and the protected finish. Anything not serving those three can wait.
