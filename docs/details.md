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
  - `📊 Digest` (`digest:now`)
- **Transitions**:  
  - `➕ Capture` → `Capture Card Screen`  
  - `📂 Projects` → `Projects List Screen`  
  - `✅ Tasks` → `Tasks List Screen`  
  - `📊 Digest` → `Weekly Digest Screen`

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

### 4. Task Creation Flow
- **Trigger**: `cat:task:<msg_id>`
- **Message**: 
  ```
  📌 Title: [auto-filled from raw text]  
  Priority: [low/med/high]  
  Deadline: [optional]
  ```
- **Keyboard**: 
  - `Save`  
  - `Edit Title`  
  - `Edit Priority`  
  - `Set Deadline`
- **Transitions**:  
  - `Save` → `Task Confirmation Screen`  
  - Others → inline editing

---

### 5. Weekly Digest Screen
- **Trigger**: `/digest` or Sunday 18:00
- **Message**: 
  ```
  📊 Weekly Summary  
  - Tasks: 12 new, 5 completed  
  - Risks: 2 unresolved  
  - Patterns: "Customer X" mentioned 5×  
  - Overdue: 3 follow-ups
  ```
- **Keyboard**: 
  - `Export as PDF`  
  - `Dismiss`
- **Transitions**:  
  - `Export as PDF` → `Export Screen`  
  - `Dismiss` → `Main Menu Screen`

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
  - Query `follow_ups` with `deadline <= now`  
  - Send DMs → `remind:notify`  
  - Update `notified_at` → `follow_ups:update`

---

## DATA

### Entities & Fields

| Entity | Fields |
| --- | --- |
| **User** | `tg_id`, `name`, `tz_offset_min`, `nlp_enabled`, `created_at` |
| **Message** | `id`, `user_tg_id`, `kind`, `raw_text`, `media_url`, `received_at` |
| **Project** | `id`, `user_tg_id`, `name`, `description`, `status`, `created_at` |
| **Task** | `id`, `project_id`, `user_tg_id`, `title`, `deadline`, `priority`, `status` |
| **Decision** | `id`, `project_id`, `user_tg_id`, `context`, `choice`, `outcome`, `status` |
| **Risk** | `id`, `project_id`, `user_tg_id`, `description`, `severity`, `mitigation`, `status` |
| **FollowUp** | `id`, `user_tg_id`, `ref_kind`, `ref_id`, `deadline`, `priority`, `status` |
| **Pattern** | `id`, `user_tg_id`, `phrase`, `occurrences`, `window_days`, `first_seen`, `last_seen` |

### Relationships
- `User` owns all entities via `user_tg_id`  
- `Project` contains `Tasks`, `Decisions`, `Risks`  
- `Message` links to entities via `source_message_id`  
- `FollowUp` references `Task`, `Decision`, or `Risk` via `ref_id`

---

## Acceptance Notes

1. **Message Intake**  
   - Any forwarded message must generate a capture card with OCR/STT fallbacks.  
   - Voice notes must trigger transcription and show raw text in 3s.

2. **Pattern Recognition**  
   - Weekly digest must list top 5 phrases with ≥3 occurrences in the last 7 days.  
   - Stoplist excludes "meeting", "today", etc.

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
   - Every list item must have an `✏️ Edit` button that pre-fills current values.  
   - Project picker must show all active projects for message assignment.

7. **Error Handling**  
   - Failed OCR/STT must show "Type the text" prompt but retain original media.  
   - Invalid deadline formats must show "Try 'tomorrow' or '2024-01-01'".