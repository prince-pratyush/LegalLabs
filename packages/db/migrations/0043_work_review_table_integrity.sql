-- A cell's row and column, and a citation's or history entry's cell, must belong to the same
-- table as the row itself names, so no write can point across tables the policies don't check.
alter table work.rt_row add constraint rt_row_table_id_key unique (table_id, id);
alter table work.rt_column add constraint rt_column_table_id_key unique (table_id, id);
alter table work.rt_cell add constraint rt_cell_table_id_key unique (table_id, id);

alter table work.rt_cell
  add constraint rt_cell_row_in_table foreign key (table_id, row_id)
    references work.rt_row (table_id, id) on delete cascade,
  add constraint rt_cell_column_in_table foreign key (table_id, column_id)
    references work.rt_column (table_id, id) on delete cascade;

alter table work.rt_cell_citation
  add constraint rt_cell_citation_cell_in_table foreign key (table_id, cell_id)
    references work.rt_cell (table_id, id) on delete cascade;

alter table work.rt_cell_history
  add constraint rt_cell_history_cell_in_table foreign key (table_id, cell_id)
    references work.rt_cell (table_id, id) on delete cascade;
