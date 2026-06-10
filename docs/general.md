# Pocket COO Bot Design Document

## Summary  
Pocket COO is a Telegram bot designed for startup founders, remote teams, and knowledge workers who want to use Telegram as their primary productivity hub. Users forward messages (text, voice notes, screenshots, meeting summaries, etc.) to the bot throughout the day, which automatically organizes them into structured entities like projects, tasks, decisions, risks, and follow-ups. The bot analyzes patterns (e.g., recurring customer issues), sends reminders for unresolved decisions, generates weekly executive summaries, and converts chaotic chat threads into actionable plans. By eliminating the need to switch between apps or learn new systems, Pocket COO turns Telegram into an "external brain" for operational efficiency.

---

## Core Entities  
- **User**: Telegram account linked to Pocket COO; owns all data.  
- **Message**: User-submitted content (text, voice, image, document) with metadata (timestamp, type, original chat context).  
- **Project**: A named initiative containing related tasks, decisions, and risks.  
- **Task**: Actionable item with deadline, status (pending/completed), and linked project.  
- **Decision**: A recorded choice with context, outcome, and resolution status.  
- **Risk**: Identified problem with severity level, mitigation steps, and owner.  
- **Follow-up**: Pending action requiring user attention, with deadline and priority.  
- **Summary**: Weekly report aggregating key patterns, unresolved items, and progress.  

Relationships:  
- A `User` owns multiple `Projects`, `Tasks`, `Decisions`, etc.  
- A `Message` is categorized into one or more entities (e.g., a voice note might spawn a `Task` and a `Risk`).  
- `Projects` contain `Tasks`, `Decisions`, and `Risks`.  
- `Follow-ups` reference unresolved `Tasks` or `Decisions`.  

---

## External Dependencies  
- **Telegram Bot API**:  
  - Message handling (text, voice, images, documents).  
  - Inline buttons for user interactions (e.g., categorizing messages).  
  - Scheduled messages for reminders and weekly summaries.  
- **Third-party APIs**:  
  - Speech-to-text for voice notes.  
  - NLP models for intent detection (e.g., identifying tasks, risks, decisions).  
  - Image OCR for extracting text from screenshots.  
- **Persistence**:  
  - Database for storing users, messages, projects, tasks, decisions, risks, and follow-ups.  
  - Cloud storage for media (images, voice notes).  

---

## Full Feature List  
- **Message Intake**: Accept and store any message type (text, voice, image, document) forwarded to the bot.  
- **Automatic Categorization**: Classify messages into projects, tasks, decisions, risks, or follow-ups using NLP and user-defined rules.  
- **Pattern Recognition**: Detect recurring themes (e.g., "customer X" mentioned 5x this week) and flag anomalies.  
- **Deadline & Reminder Management**: Set implicit deadlines based on message content and send reminders for unresolved items.  
- **Weekly Executive Summary**: Generate a digest of key trends, unresolved risks, and progress since last week.  
- **Action Plan Generation**: Convert unstructured chat threads into step-by-step plans with assigned owners and deadlines.  
- **Inline Editing & Prioritization**: Allow users to adjust categorization, set priorities, or add context via inline buttons.  
- **Data Export**: Export structured data (tasks, projects) as JSON or markdown for external use.  

---

## Non-Goals  
- No integration with external project management tools (e.g., Trello, Asana).  
- No collaborative features (e.g., team task assignment).  
- No support for multi-user project management or shared workspaces.  
- No reliance on Telegram's cloud storage beyond basic message forwarding.  
- Avoid requiring users to adopt new workflows (e.g., markdown formatting or templates).