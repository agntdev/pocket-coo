# DESIGN — Pocket COO

Architecture, command set and conversation flows for the Pocket COO
Telegram bot. Satisfies every entity, dependency and feature in
`docs/general.md`.

## 1. Architecture

```
Telegram ⇄ grammY bot (long polling)
              │
              ├─ command router  (/start /capture /projects /tasks …)
              ├─ callback router (cat:* pri:* proj:* wk:*)
              ├─ session store   (per-chat FSM for inline categorization)
              ├─ service layer
              │    ├─ categorizer  (rules → fallback NLP)
              │    ├─ stt          (voice → text)
              │    ├─ ocr          (image → text)
              │    ├─ pattern      (recurring-entity detector)
              │    └─ summarizer   (weekly digest)
              ├─ cron jobs
              │    ├─ reminder-sweep  (every 60s: due follow-ups)
              │    └─ weekly-digest   (Sunday 18:00 user-local)
              └─ SQLite persistence
                   (users, messages, projects, tasks, decisions, risks,
                    follow_ups, summaries, patterns)
```

- **Runtime**: single Node.js process, grammY, long polling. Media
  (voice/images/docs) is downloaded via `getFile` to a local volume (or
  S3 if `MEDIA_BUCKET` set).
- **Categorizer**: a rules engine runs **first** (cheap, deterministic,
  user-tunable). If rules don't match, the message is queued for NLP
  inference (off by default — controlled by `ENABLE_NLP=1`). The user
  always gets an immediate inline-categorize card so the bot stays
  interactive even when the model is slow.
- **Pattern detector**: a nightly job that scans the last 7 days of
  messages for recurring noun phrases (e.g. "Customer X" mentioned 5×)
  and surfaces them in the weekly summary.
- **Weekly digest**: every Sunday at 18:00 user-local, generate a
  summary card (see §4.8).

## 2. Data model (implements General "Core Entities")

| Entity | Table | Fields |
| --- | --- | --- |
| **User** | `users` | `tg_id` PK, `name`, `tz_offset_min` (default 0), `nlp_enabled` (default 0), `created_at` |
| **Message** | `messages` | `id` PK, `user_tg_id` FK→users, `kind` (`text`/`voice`/`image`/`document`), `raw_text` (transcribed/OCR'd for media), `media_url` NULL, `received_at`, `forwarded_from_chat` NULL |
| **Project** | `projects` | `id` PK, `user_tg_id` FK→users, `name`, `description`, `status` (`active`/`archived`), `created_at` |
| **Task** | `tasks` | `id` PK, `project_id` FK→projects, `user_tg_id` FK→users, `title`, `description`, `deadline` NULL, `priority` (`low`/`med`/`high`), `status` (`pending`/`completed`), `source_message_id` FK→messages NULL, `created_at`, `completed_at` NULL |
| **Decision** | `decisions` | `id` PK, `project_id` FK→projects NULL, `user_tg_id` FK→users, `context`, `choice`, `outcome` NULL, `status` (`open`/`resolved`), `made_at` |
| **Risk** | `risks` | `id` PK, `project_id` FK→projects NULL, `user_tg_id` FK→users, `description`, `severity` (`low`/`med`/`high`), `mitigation` NULL, `owner_tg_id` NULL, `status` (`open`/`mitigated`) |
| **FollowUp** | `follow_ups` | `id` PK, `user_tg_id` FK→users, `ref_kind` (`task`/`decision`/`risk`), `ref_id`, `deadline`, `priority`, `status` (`pending`/`done`/`dismissed`), `notified_at` NULL |
| **Summary** | `summaries` | `id` PK, `user_tg_id` FK→users, `week_start` (date), `body_md`, `sent_at` |
| **Pattern** | `patterns` | `id` PK, `user_tg_id` FK→users, `phrase`, `occurrences`, `window_days`, `first_seen`, `last_seen` |

Relationships preserved exactly as General states: user 1—N of everything,
project 1—N tasks/decisions/risks, message 1—N entities (via
`source_message_id` on each), follow-up → task/decision/risk.

## 3. Command set

| Command | Purpose |
| --- | --- |
| `/start` | register user + onboarding + main menu |
| `/help` | command reference |
| `/capture` | (also: any forwarded message) — categorize into Task/Decision/Risk/Follow-up |
| `/projects` | list active projects |
| `/newproject <name>` | create a project (inline flow for description) |
| `/tasks` | list your pending tasks across projects (filter: project, priority, due) |
| `/decisions` | list open decisions |
| `/risks` | list open risks |
| `/followups` | list pending follow-ups |
| `/digest` | render this week's digest on demand |
| `/patterns` | show detected recurring phrases |
| `/export` | DM yourself a JSON of all structured data |

## 4. Conversation / UX flows

### 4.1 Onboarding (`/start`)
1. Upsert `users` row.
2. First contact: ask timezone (`📍 Use Telegram TZ` / `🌍 UTC` / custom).
3. Show the main menu:
   `➕ Capture` (CB `cat:new`) `📂 Projects` (CB `proj:list`)
   `✅ Tasks` (CB `tasks:list`) `📊 Digest` (CB `digest:now`).
4. Send a one-time tip: "Just forward me any message, voice note, or
   screenshot — I'll ask where it goes."

### 4.2 Capture (`/capture` or any forwarded message)
1. If text: store `raw_text`. If voice: transcribe (STT) then store
   `raw_text`. If image: OCR then store. If document: store with the
   file name as `raw_text` (no OCR by default).
2. Run the rules engine on `raw_text` to suggest a category
   (`task`/`decision`/`risk`/`follow-up`/`ignore`).
3. Reply with the capture card: "📥 Got: <raw_text>" and inline buttons:
   - `✅ Task` (CB `cat:task:<msg_id>`)
   - `🧭 Decision` (CB `cat:decision:<msg_id>`)
   - `⚠️ Risk` (CB `cat:risk:<msg_id>`)
   - `⏰ Follow-up` (CB `cat:followup:<msg_id>`)
   - `🗑 Ignore` (CB `cat:ignore:<msg_id>`)
   - `📂 Pick project` (CB `proj:pick:<msg_id>`)
4. Tap a category → state-driven detail flow:
   - **Task**: ask title (default = first 60 chars of `raw_text`) → priority
     (low/med/high) → deadline (optional; "tomorrow", "Fri", "in 2 weeks",
     or skip). Insert `tasks` row. Reply "✅ Task: <title> · <priority> ·
     <deadline or no due>".
   - **Decision**: ask context (default = `raw_text`) → choice. Insert
     `decisions` row with `status=open`. Reply "🧭 Decision logged".
   - **Risk**: ask severity → optional mitigation. Insert `risks` row.
     Reply "⚠️ Risk: <severity>".
   - **Follow-up**: ask deadline (required) → priority. Insert
     `follow_ups` row referencing whatever entity the user just created
     (or, if chosen before any entity, just a free-form follow-up).
5. Inline editing from any list (§4.6) goes back to the same flows with
   the existing values pre-filled.

### 4.3 Voice / image / document
- Voice: STT runs inline (`voice → text`); capture card shows the
  transcript. If STT fails, the user gets a "Couldn't transcribe, type
  the text" prompt and the message is still stored as `kind=voice`.
- Image: OCR runs inline. If OCR is disabled or fails, the user gets
  the same fallback as voice.
- Document: file name + size; capture card shows the name. The user
  can attach a free-text context.

### 4.4 Pattern detection (Nightly)
A cron at 03:00 user-local scans the last 7 days of `messages`:
- Extract noun phrases (length 2–4 words, lowercase, dedup).
- For any phrase that appears ≥ 3 times and is not in a stoplist
  (`meeting`, `today`, etc.), insert or update a `patterns` row with
  `occurrences` and `window_days=7`.
- Patterns surface in the weekly digest (§4.8) and on `/patterns`.

### 4.5 Projects
- `/projects` lists `active` projects with counts
  (`📂 Acme launch · 4 tasks · 1 risk · 0 decisions`).
- Inline per row: `📋 Open` (CB `proj:open:<id>`), `📦 Archive`
  (CB `proj:archive:<id>`).
- `/newproject <name>` creates a project; description is a follow-up
  text step.

### 4.6 Lists
- `/tasks` — paginated active tasks with inline filters
  (`All` / `Project: <name>` / `Priority: high`). Each row:
  `☐ <title> · <project> · <deadline or no due>` + `✅ Done` button
  (CB `tasks:done:<id>`).
- `/decisions` — open decisions with `🧭 Resolve` (CB `dec:resolve:<id>`)
  → text step asks for the outcome.
- `/risks` — open risks with `🛠 Mitigate` → text step asks for the
  mitigation; `📦 Close` (CB `risk:close:<id>`).
- `/followups` — pending follow-ups ordered by deadline, with
  `✅ Done` and `🗑 Dismiss`.

### 4.7 Reminder sweep (System)
Cron every 60s:
- For every `follow_ups` row where `deadline <= now`, `status='pending'`
  and `notified_at IS NULL`: DM the user "⏰ Follow-up: <ref summary>
  (due <relative>)" and set `notified_at = now`.

### 4.8 Weekly digest (System + `/digest`)
Every Sunday 18:00 user-local:
- Compute this week's:
  - Tasks created / completed
  - Decisions made / resolved
  - Risks opened / mitigated
  - Top 5 patterns
  - Pending follow-ups overdue
- Render a markdown card and send.
- `/digest` renders the same card on demand for the current week.

### 4.9 Export (`/export`)
DM a JSON document with all of the user's `projects`, `tasks`,
`decisions`, `risks`, `follow_ups`, and the last 4 weekly summaries.
File name: `pocket-coo-export-<YYYY-MM-DD>.json`.

## 5. Edge cases & rules

- **Rules-first categorization** — the rules engine is deterministic and
  free; NLP is opt-in (`ENABLE_NLP=1`) and only runs if rules didn't
  fire. The bot never blocks on inference.
- **Self-dealing** — when capturing from a forwarded message in a group,
  only the user who forwarded it is the owner; the group chat is
  metadata only.
- **Forwarded media** — Telegram file IDs are short-lived; we download
  on receipt and store a stable URL.
- **Timezone** — deadlines and the weekly digest are scheduled in the
  user's `tz_offset_min`. DST shifts don't move schedules.
- **Inline editing** — every list row carries an `✏️` button that
  re-enters the corresponding capture flow with the current values
  pre-filled.
- **Privacy** — all data is per-user; no aggregate views beyond the
  user's own digest. `/export` returns only the caller's data.

## 6. External dependencies (mirrors General)

- **Telegram Bot API** via grammY — long polling, inline keyboards,
  callback queries, media handling, scheduled messages.
- **Speech-to-text** — pluggable (`STT_PROVIDER=local|openai`); local
  default uses a small Whisper model, optional OpenAI via API key.
- **NLP** — opt-in, pluggable (`NLP_PROVIDER=openai|local`); disabled
  by default.
- **OCR** — pluggable (`OCR_PROVIDER=tesseract|openai`); tesseract
  default.
- **Cloud storage** — S3-compatible (optional via `MEDIA_BUCKET` env) for
  media; local volume otherwise.
- **Database** — SQLite (users, messages, projects, tasks, decisions,
  risks, follow_ups, summaries, patterns).

## 7. Non-goals (inherited from General)

No Trello/Asana/Notion integration, no team-shared workspaces (this is a
single-user "external brain"), no reliance on Telegram cloud storage
beyond message forwarding, no required markdown/templates — the bot
infers structure from forwarded content.

## 8. Feature → design traceability

| General feature | Design section |
| --- | --- |
| Message intake (any type) | 4.2, 4.3 |
| Automatic categorization | 4.2, 1 (rules engine) |
| Pattern recognition | 4.4 |
| Deadline & reminder management | 4.7 |
| Weekly executive summary | 4.8 |
| Action plan generation | 4.6 (lists surface plans) |
| Inline editing & prioritization | 4.2 step 5, 4.6 |
| Data export (JSON/markdown) | 4.9 |
