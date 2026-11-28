-- The spreadsheet cell a citation quotes, such as Fees!B2.
alter table work.citation add column cell_ref text check (char_length(cell_ref) <= 200);
