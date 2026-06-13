# Pocket COO Bot DETAILS Document

## SCREENS

### 1. Onboarding Screen (`/start`)
- **Trigger**: `/start` or new user
- **Message**: 
  ```
  📌 Welcome to Pocket COO!  
  Let's set up your timezone and get started.
  ```
- **Keyboard**: 
  - `📍 Use Telegram Timezone`  
  - `🌍 UTC`  
  - `Custom Timezone`
- **Transitions**:  
  - `Custom Timezone` → `Timezone Input Screen`  
  - All others → `Main Menu Screen`

---

### 2. Main Menu Screen
- **Trigger**: Onboarding completion or `/menu`
- **Message**: 
  ```
  📁 Your Pocket COO  
  What would you like to do?
  ```
- **Keyboard**: 
  - `➕ Capture` (`cat:new`)  
  - `📂 Projects` (`proj:list`)  
  - `✅ Tasks` (`tasks:list`)  
  - `🧭 Decisions` (`dec:list`)  
  - `⚠️ Risks` (`risk:list`)  
  - `⏰ Follow-ups` (`fu:list`)  
  - `📊 Digest` (`digest:now`)  
  - `🔍 Patterns` (`pat:list`)  
  - `📤 Export` (`export:now`)
- **Transitions**:  
  - `➕ Capture` → `Capture Card Screen`  
  - `📂 Projects` → `Projects List Screen`  
  - `✅ Tasks` → `Tasks List Screen`  
  - `🧭 Decisions` → `Decisions List Screen`  
  - `⚠️ Risks` → `Risks List Screen`  
  - `⏰ Follow-ups` → `Follow-ups List Screen`  
  - `📊 Digest` → `Weekly Digest Screen`  
  - `🔍 Patterns` → `Patterns List Screen`  
  - `📤 Export` → `Export Confirmation Screen`

---

### 3. Capture Card Screen
- **Trigger**: `/capture` or forwarded message
- **Message**: 
  ```
  📥 Got: [transcribed text]  
  Where should this go?
  ```
- **Keyboard**: 
  - `✅ Task` (`cat:task:<msg_id>`)  
  - `🧭 Decision` (`cat:decision:<msg_id>`)  
  - `⚠️ Risk` (`cat:risk:<msg_id>`)  
  - `⏰ Follow-up` (`cat:followup:<msg_id>`)  
  - `🗑 Ignore` (`cat:ignore:<msg_id>`)  
  - `📂 Pick Project` (`proj:pick:<msg_id>`)
- **Transitions**:  
  - Category buttons → respective detail flows  
  - `📂 Pick Project` → `Project Picker Screen`

---

### 4. Project Picker Screen
- **Trigger**: `proj:pick:<msg_id>`
- **Message**: 
  ```
  📂 Select a project for this message:
  [Active Projects List]
  ```
- **Keyboard**: 
  - `➕ New Project`  
  - `[Project 1]` (`proj:assign:<msg_id>:<proj_id>`)  
  - `[Project 2]` (`proj:assign:<msg_id>:<proj_id>`)
- **Transitions**:  
  - `➕ New Project` → `Project Creation Screen`  
  - Project selection → `Capture Card Screen` with project assigned

---

### 5. Project Creation Screen (`/newproject`)
- **Trigger**: `/newproject <name>` or `➕ New Project` from Project Picker
- **Message**: 
  ```
  📁 New Project: [name]  
  Add a description (optional):
  ```
- **Keyboard**: 
  - `Create`  
  - `Cancel`
- **Transitions**:  
  - `Create` → insert `projects` row → `Projects List Screen`  
  - `Cancel` → `Main Menu Screen`

---

### 6. Task Creation Flow
- **Trigger**: `cat:task:<msg_id>`
- **Message**: 
  ```
  📌 Title: [auto-filled from raw text]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Title`
- **Transitions**:  
  - `Next` → `Task Priority Screen`  
  - `Edit Title` → inline editing

---

### 7. Task Priority Screen
- **Trigger**: Task Creation Flow
- **Message**: 
  ```
  📌 Priority: [low/med/high]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Priority`
- **Transitions**:  
  - `Next` → `Task Deadline Screen`  
  - `Edit Priority` → inline editing

---

### 8. Task Deadline Screen
- **Trigger**: Task Priority Screen
- **Message**: 
  ```
  📌 Deadline: [optional]  
  ```
- **Keyboard**: 
  - `Save`  
  - `Skip Deadline`  
  - `Invalid Format?` → `Deadline Help Screen`
- **Transitions**:  
  - `Save` → insert `tasks` row → `Task Confirmation Screen`  
  - `Skip Deadline` → insert `tasks` row without deadline → `Task Confirmation Screen`

---

### 9. Task Confirmation Screen
- **Trigger**: Task Creation Flow
- **Message**: 
  ```
  ✅ Task: [title] · [priority] · [deadline or no due]  
  Assigned to project: [project name]
  ```
- **Keyboard**: 
  - `Main Menu`  
  - `Edit` → re-enter Task Creation Flow
- **Transitions**:  
  - All → `Main Menu Screen`

---

### 10. Decisions List Screen (`/decisions`)
- **Trigger**: `/decisions` or `dec:list`
- **Message**: 
  ```
  🧭 Open Decisions:  
  [Decision 1] · [context]  
  [Decision 2] · [context]  
  ...
  ```
- **Keyboard**: 
  - `🧭 Resolve` (`dec:resolve:<id>`)  
  - `✏️ Edit` (`dec:edit:<id>`)  
  - `🗑 Dismiss` (`dec:dismiss:<id>`)
- **Transitions**:  
  - `🧭 Resolve` → `Decision Outcome Screen`  
  - `✏️ Edit` → re-enter Decision Creation Flow  
  - `🗑 Dismiss` → update `decisions.status=dismissed` → `Main Menu Screen`

---

### 11. Decision Outcome Screen
- **Trigger**: `dec:resolve:<id>`
- **Message**: 
  ```
  🧭 Decision: [choice]  
  Outcome: [empty]  
  ```
- **Keyboard**: 
  - `Save`  
  - `Edit Outcome`
- **Transitions**:  
  - `Save` → update `decisions` row → `Decision Confirmation Screen`  
  - `Edit Outcome` → inline editing

---

### 12. Risks List Screen (`/risks`)
- **Trigger**: `/risks` or `risk:list`
- **Message**: 
  ```
  ⚠️ Open Risks:  
  [Risk 1] · [severity]  
  [Risk 2] · [severity]  
  ...
  ```
- **Keyboard**: 
  - `🛠 Mitigate` (`risk:mitigate:<id>`)  
  - `📦 Close` (`risk:close:<id>`)  
  - `✏️ Edit` (`risk:edit:<id>`)
- **Transitions**:  
  - `🛠 Mitigate` → `Risk Mitigation Screen`  
  - `📦 Close` → update `risks.status=mitigated` → `Main Menu Screen`  
  - `✏️ Edit` → re-enter Risk Creation Flow

---

### 13. Risk Mitigation Screen
- **Trigger**: `risk:mitigate:<id>`
- **Message**: 
  ```
  ⚠️ Risk: [description]  
  Mitigation: [empty]  
  Owner: [empty]
  ```
- **Keyboard**: 
  - `Save`  
  - `Edit Mitigation`  
  - `Assign Owner` → `User Picker Screen`
- **Transitions**:  
  - `Save` → update `risks` row → `Risk Confirmation Screen`  
  - `Edit Mitigation` → inline editing

---

### 14. Follow-ups List Screen (`/followups`)
- **Trigger**: `/followups` or `fu:list`
- **Message**: 
  ```
  ⏰ Pending Follow-ups:  
  [Follow-up 1] · [deadline] · [priority]  
  [Follow-up 2] · [deadline] · [priority]  
  ...
  ```
- **Keyboard**: 
  - `✅ Done` (`fu:done:<id>`)  
  - `🗑 Dismiss` (`fu:dismiss:<id>`)  
  - `✏️ Edit` (`fu:edit:<id>`)
- **Transitions**:  
  - `✅ Done` → update `follow_ups.status=done` → `Main Menu Screen`  
  - `🗑 Dismiss` → update `follow_ups.status=dismissed` → `Main Menu Screen`  
  - `✏️ Edit` → re-enter Follow-up Creation Flow

---

### 15. Patterns List Screen (`/patterns`)
- **Trigger**: `/patterns` or `pat:list`
- **Message**: 
  ```
  🔍 Top Patterns:  
  "Customer X" mentioned 5×  
  "API latency" mentioned 3×  
  ...
  ```
- **Keyboard**: 
  - `Dismiss`
- **Transitions**:  
  - `Dismiss` → `Main Menu Screen`

---

### 16. Weekly Digest Screen
- **Trigger**: `/digest` or Sunday 18:00
- **Message**: 
  ```
  📊 Weekly Summary  
  - Tasks: 12 new, 5 completed  
  - Decisions: 3 unresolved  
  - Risks: 2 open  
  - Patterns: "Customer X" mentioned 5×  
  - Overdue: 3 follow-ups
  ```
- **Keyboard**: 
  - `📤 Export as JSON`  
  - `Dismiss`
- **Transitions**:  
  - `📤 Export as JSON` → `Export Screen`  
  - `Dismiss` → `Main Menu Screen`

---

### 17. Export Confirmation Screen (`/export`)
- **Trigger**: `/export` or `export:now`
- **Message**: 
  ```
  📤 Exporting your data...  
  This will include:  
  - Projects  
  - Tasks  
  - Decisions  
  - Risks  
  - Follow-ups  
  - Last 4 weekly summaries
  ```
- **Keyboard**: 
  - `Export`  
  - `Cancel`
- **Transitions**:  
  - `Export` → generate JSON → `Export Sent Screen`  
  - `Cancel` → `Main Menu Screen`

---

### 18. Export Sent Screen
- **Trigger**: Export Completion
- **Message**: 
  ```
  📤 Export complete!  
  [JSON file attached]
  ```
- **Keyboard**: 
  - `Main Menu`
- **Transitions**:  
  - All → `Main Menu Screen`

---

### 19. Help Screen (`/help`)
- **Trigger**: `/help`
- **Message**: 
  ```
  📚 Pocket COO Commands:  
  /start – Onboarding  
  /capture – Manual categorization  
  /newproject – Create a project  
  /projects – List projects  
  /tasks – List tasks  
  /decisions – List decisions  
  /risks – List risks  
  /followups – List follow-ups  
  /digest – View weekly summary  
  /patterns – View recurring patterns  
  /export – Export data as JSON
  ```
- **Keyboard**: 
  - `Main Menu`
- **Transitions**:  
  - All → `Main Menu Screen`

---

## COMPONENTS

### 1. Inline Categorization Buttons
- **Purpose**: Let users classify messages immediately.
- **Structure**:  
  ```markdown
  [✅ Task] [🧭 Decision] [⚠️ Risk] [⏰ Follow-up] [🗑 Ignore]
  ```
- **Callback Format**: `cat:<type>:<msg_id>`

---

### 2. Paginated List Paginator
- **Purpose**: Navigate large datasets (tasks, projects).
- **Structure**:  
  ```markdown
  [⬅️ Previous]  Page 1 of 3  [Next ➀]
  ```
- **Callback Format**: `list:page:<direction>:<page_num>`

---

### 3. Confirmation Dialog
- **Purpose**: Confirm destructive actions (archive, delete).
- **Structure**:  
  ```markdown
  Are you sure?  
  [🗑 Confirm] [❌ Cancel]
  ```
- **Callback Format**: `confirm:<action>:<id>`

---

### 4. Project Picker Dropdown
- **Purpose**: Assign messages to projects.
- **Structure**:  
  ```markdown
  Select project:  
  [Acme Launch] [Product Roadmap] [Bug Fixes]
  ```
- **Callback Format**: `proj:assign:<msg_id>:<proj_id>`

---

### 5. Deadline Help Screen
- **Trigger**: Invalid deadline format
- **Message**: 
  ```
  ⏰ Please use:  
  - "tomorrow"  
  - "in 2 weeks"  
  - "2024-01-01"  
  - "next Friday"
  ```
- **Keyboard**: 
  - `Try Again`
- **Transitions**:  
  - `Try Again` → previous screen

---

## TRANSITIONS

### 1. Message Intake → Categorization
- **State**: `capture:new`  
- **Input**: Forwarded message  
- **Transition**:  
  - Parse message type → `capture:parsed`  
  - Auto-categorize via rules/NLP → `capture:auto`  
  - Show capture card → `capture:manual`

---

### 2. Task Creation → Completion
- **State**: `task:create`  
- **Input**: User selects `Save`  
- **Transition**:  
  - Insert into `tasks` table  
  - Send confirmation → `task:confirm`  
  - Add to project → `proj:update`

---

### 3. Weekly Digest Cron
- **State**: `cron:digest`  
- **Trigger**: Sunday 18:00 user-local  
- **Transition**:  
  - Generate summary from DB → `digest:render`  
  - Send via Telegram → `digest:sent`

---

### 4. Reminder Sweep
- **State**: `cron:remind`  
- **Trigger**: Every 60s  
- **Transition**:  
  - Query `follow_ups` with `deadline <= now + 24h`  
  - Send DMs → `remind:notify`  
  - Update `notified_at` → `follow_ups:update`

---

### 5. Pattern Detection Cron
- **State**: `cron:pattern`  
- **Trigger**: 03:00 user-local  
- **Transition**:  
  - Scan last 7 days of `messages`  
  - Insert/update `patterns` rows  
  - No user interaction

---

## DATA

### Entities & Fields

| Entity | Fields |
| --- | --- |
| **User** | `tg_id` PK, `name`, `tz_offset_min`, `nlp_enabled`, `created_at` |
| **Message** | `id` PK, `user_tg_id` FK→users, `kind` (text/voice/image/document), `raw_text`, `media_url`, `received_at`, `forwarded_from_chat` |
| **Project** | `id` PK, `user_tg_id` FK→users, `name`, `description`, `status` (active/archived), `created_at` |
| **Task** | `id` PK, `project_id` FK→projects, `user_tg_id` FK→users, `title`, `description`, `deadline`, `priority` (low/med/high), `status` (pending/completed), `source_message_id` FK→messages, `created_at`, `completed_at` |
| **Decision** | `id` PK, `project_id` FK→projects, `user_tg_id` FK→users, `context`, `choice`, `outcome`, `status` (open/resolved), `made_at` |
| **Risk** | `id` PK, `project_id` FK→projects, `user_tg_id` FK→users, `description`, `severity` (low/med/high), `mitigation`, `status` (open/mitigated), `owner_tg_id` |
| **FollowUp** | `id` PK, `user_tg_id` FK→users, `ref_kind` (task/decision/risk), `ref_id`, `deadline`, `priority` (low/med/high), `status` (pending/done/dismissed), `notified_at` |
| **Summary** | `id` PK, `user_tg_id` FK→users, `week_start` (date), `body_md`, `sent_at` |
| **Pattern** | `id` PK, `user_tg_id` FK→users, `phrase`, `occurrences`, `window_days`, `first_seen`, `last_seen` |

### Relationships
- `User` owns all entities via `user_tg_id`  
- `Project` contains `Tasks`, `Decisions`, `Risks`  
- `Message` links to entities via `source_message_id`  
- `FollowUp` references `Task`, `Decision`, or `Risk` via `ref_id`  
- `Pattern` is user-scoped and tracks message content

---

## Acceptance Notes

1. **Message Intake**  
   - Any forwarded message must generate a capture card with OCR/STT fallbacks.  
   - Voice/image/document intake must store `forwarded_from_chat` metadata.

2. **Pattern Recognition**  
   - Weekly digest must list top 5 phrases with ≥3 occurrences in the last 7 days.  
   - Stoplist excludes "meeting", "today", etc.  
   - `/patterns` must show all active patterns.

3. **Deadline Management**  
   - Relative deadlines ("tomorrow", "in 2 weeks") must convert to UTC timestamps.  
   - Overdue follow-ups must trigger DMs 24h before deadline.

4. **Privacy**  
   - All data must be user-scoped; no cross-user visibility.  
   - `/export` must include all entities and last 4 summaries in valid JSON.

5. **Timezone Handling**  
   - Digest and reminders must use user's `tz_offset_min`.  
   - DST shifts must not reschedule existing deadlines.

6. **Inline Editing**  
   - Every list item must have an `✏️ Edit` button that pre-f