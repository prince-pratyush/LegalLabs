-- A thread that holds text taken from documents, such as a generated chronology, names them. It
-- is seen only by someone who can open every one now, whoever it is shared with; its messages,
-- drafts and runs follow, because each of those looks the thread up.
alter table work.thread
  add column source_documents uuid[] not null default '{}'
    check (cardinality(source_documents) <= 2000);

-- Restrictive: no share or other policy widens it. The count runs under the reader's own
-- policies on documents. Set when the thread is made; the app has no grant to change it.
create policy thread_sources on work.thread as restrictive for select to legallabs_app
  using (case when source_documents = '{}' then true
              else (select count(*) from content.document d where d.id = any (source_documents))
                   = cardinality(source_documents) end);
