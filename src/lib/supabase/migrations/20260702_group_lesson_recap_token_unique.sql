-- Group Lesson Recap Public Token Hardening
-- Run in development first, then production before sending public recap links.

create unique index if not exists group_lesson_recap_recipients_secure_token_unique
  on public.group_lesson_recap_recipients (secure_token);
