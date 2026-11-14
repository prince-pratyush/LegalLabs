-- Needs a server with pgvector; the bundle's Postgres image ships it.
create extension if not exists vector;

-- Written with the chunk and never changed, like the text it describes.
alter table content.chunk
  add column embedding vector(1024),
  add column embedding_model text check (char_length(embedding_model) <= 200),
  add check ((embedding is null) = (embedding_model is null));

-- Functions get no default execute here, and casts and distances need pgvector's.
grant execute on all functions in schema public to legallabs_app;
