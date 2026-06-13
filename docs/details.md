# Pocket COO Bot DETAILS Document (Revised)

## SCREENS

### 1. Tasks List Screen (`/tasks`)
- **Trigger**: `/tasks` or `tasks:list`
- **Message**: 
  ```
  ✅ Tasks (Page 1/3)  
  [Filter: All] [Project A] [High Priority]  
  ┌───────────────────────────────┐
  │ ☐ Task 1 · Project A · Due 2d │ ✅ Done
  │ ☐ Task 2 · Project B · No due │ ✅ Done
  └───────────────────────────────┘
  ```
- **Keyboard**: 
  - `⬅️ Previous`  
  - `Next ➤`  
  - `➕ New Task`  
  - `Filter: [Current Filter]`
- **Transitions**:  
  - `✅ Done` → update `tasks.status=completed`  
  - `Next ➤` → `Tasks List Screen` (next page)  
  - `➕ New Task` → `Task Creation Flow`

---

### 2. Projects List Screen (`/projects`)
- **Trigger**: `/projects` or `proj:list`
- **Message**: 
  ```
  📂 Projects (Active)  
  [Project 1] · 4 tasks · 1 risk  
  [Project 2] · 0 tasks · 3 decisions  
  ...
  ```
- **Keyboard**: 
  - `📦 Archive` (`proj:archive:<id>`)  
  - `📋 Open` (`proj:open:<id>`)  
  - `➕ New Project`
- **Transitions**:  
  - `📦 Archive` → update `projects.status=archived`  
  - `➕ New Project` → `Project Creation Screen`

---

### 3. Decision Creation Flow
- **Trigger**: `cat:decision:<msg_id>`
- **Message**: 
  ```
  🧭 Decision Context: [auto-filled from raw text]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Context`
- **Transitions**:  
  - `Next` → `Decision Choice Screen`

---

### 4. Decision Choice Screen
- **Trigger**: Decision Creation Flow
- **Message**: 
  ```
  🧭 Decision Choice: [empty]  
  ```
- **Keyboard**: 
  - `Save`  
  - `Edit Choice`
- **Transitions**:  
  - `Save` → insert `decisions` row → `Decision Confirmation Screen`

---

### 5. Risk Creation Flow
- **Trigger**: `cat:risk:<msg_id>`
- **Message**: 
  ```
  ⚠️ Risk Description: [auto-filled from raw text]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Description`
- **Transitions**:  
  - `Next` → `Risk Severity Screen`

---

### 6. Risk Severity Screen
- **Trigger**: Risk Creation Flow
- **Message**: 
  ```
  ⚠️ Severity: [low/med/high]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Severity`
- **Transitions**:  
  - `Next` → `Risk Mitigation Screen`

---

### 7. Follow-up Creation Flow
- **Trigger**: `cat:followup:<msg_id>`
- **Message**: 
  ```
  ⏰ Deadline: [required]  
  ```
- **Keyboard**: 
  - `Next`  
  - `Edit Deadline`
- **Transitions**:  
  - `Next` → `Follow-up Priority Screen`

---

### 8. Follow-up Priority Screen
- **Trigger**: Follow-up Creation Flow
- **Message**: 
  ```
  ⏰ Priority: [low/med/high]  
  ```
- **Keyboard**: 
  - `Save`  
  - `Edit Priority`
- **Transitions**:  
  - `Save` → insert `follow_ups` row → `Follow-up Confirmation Screen`

---

## COMPONENTS

### 1. Tasks List Paginator
- **Purpose**: Navigate paginated task lists with filters.
- **Structure**:  
  ```markdown
  [⬅️ Previous]  Page 1 of 3  [Next ➤]  
  [Filter: All] [Project A] [High Priority]
  ```
- **Callback Format**: `tasks:page:<direction>:<page_num>` or `tasks:filter:<type>`

---

### 2. Project Archive/Restore Buttons
- **Purpose**: Toggle project status between active/archived.
- **Structure**:  
  ```markdown
  📦 Archive  |  📋 Open
  ```
- **Callback Format**: `proj:archive:<id>` or `proj:open:<id>`

---

## TRANSITIONS

### 1. Decision Creation Flow
- **State**: `decision:create`  
- **Input**: User selects `Save`  
- **Transition**:  
  - Insert into `decisions` table  
  - Send confirmation → `decision:confirm`  
  - Add to project → `proj:update`

---

### 2. Risk Creation Flow
- **State**: `risk:create`  
- **Input**: User selects `Save`  
- **Transition**:  
  - Insert into `risks` table  
  - Send confirmation → `risk:confirm`  
  - Add to project → `proj:update`

---

### 3. Follow-up Creation Flow
- **State**: `followup:create`  
- **Input**: User selects `Save`  
- **Transition**:  
  - Insert into `follow_ups` table  
  - Send confirmation → `followup:confirm`  
  - Add to task/decision/risk → `ref:update`

---

### 4. Reminder Sweep (Corrected)
- **State**: `cron:remind`  
- **Trigger**: Every 60s  
- **Transition**:  
  - Query `follow_ups` with `deadline <= now` AND `notified_at IS NULL`  
  - Send DMs → `remind:notify`  
  - Update `notified_at` → `follow_ups:update`

---

## DATA

### Entities & Fields (Updated)
| Entity | Fields |
| --- | --- |
| **FollowUp** | `id` PK, `user_tg_id` FK→users, `ref_kind` (task/decision/risk), `ref_id`, `deadline`, `priority` (low/med/high), `status` (pending/done/dismissed), `notified_at`, `created_at` |

---

## Acceptance Notes

1. **Tasks List Screen**  
   - Must support pagination (3 items per page)  
   - Filters: All/Project/High Priority  
   - Inline "✅ Done" action updates task status

2. **Projects List Screen**  
   - Shows active projects with task/risk counts  
   - Archive/Open toggles project status  
   - New project creation via `/newproject`

3. **Decision Flow**  
   - Requires context and choice fields  
   - Saves to `decisions` with open status  
   - Confirmation message includes context/choice

4. **Risk Flow**  
   - Requires severity (low/med/high)  
   - Optional mitigation field  
   - Confirmation message includes severity

5. **Follow-up Flow**  
   - Deadline required (must parse relative dates)  
   - Priority (low/med/high)  
   - Links to task/decision/risk via `ref_id`

6. **Reminder Sweep**  
   - Triggers at deadline (not 24h before)  
   - Only sends if `notified_at` is NULL  
   - Updates `notified_at` after sending

7. **Pattern Detection**  
   - Nightly job at 03:00 user-local  
   - Phrase must appear ≥3x in 7 days  
   - Excludes stoplist words (meeting, today, etc.)

8. **Privacy & Export**  
   - All data is user-scoped  
   - `/export` includes all entities and last 4 summaries  
   - No cross-user visibility