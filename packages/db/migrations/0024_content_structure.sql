-- Headings above a chunk, so a citation can name its clause.
alter table content.chunk add column section text check (char_length(section) <= 2000);
-- Text read by OCR can be wrong in ways a text layer can't, so readers are told.
alter table content.page add column ocr boolean not null default false;

-- An attachment or a message inside a mailbox is a document of its own, filed under its source.
alter table content.document add column parent_id uuid check (parent_id <> id);
alter table content.document
  add foreign key (workspace_id, parent_id) references content.document (workspace_id, id)
  on delete cascade;
create index document_parent_idx on content.document (workspace_id, parent_id)
  where parent_id is not null;

-- A child stays on its parent's matter, so it can't step outside the parent's wall.
drop policy document_insert on content.document;
create policy document_insert on content.document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.can_access_matter(matter_id)
              and core.has_permission('threads.use')
              and (parent_id is null or exists (
                select 1 from content.document p
                 where p.id = document.parent_id
                   and p.matter_id is not distinct from document.matter_id)));
