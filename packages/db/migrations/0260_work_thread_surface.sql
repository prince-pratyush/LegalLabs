-- Where a thread was started. Set once, when it is made: no update is granted. A thread from the
-- Outlook pane holds an email someone else wrote, so nothing is inferred from it as a memory.
alter table work.thread add column surface text not null default 'web'
  constraint thread_surface_check check (surface in ('web', 'word', 'outlook'));
