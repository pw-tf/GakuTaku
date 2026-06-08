-- 0005_note_type_css.sql — store each note type's stylesheet (Anki "model" CSS).
-- Imported Anki cards are rendered with their own CSS so the author's styling/emphasis is faithful
-- (see the SRS redesign). The column is nullable; the built-in vocab note type leaves it null.
alter table public.note_types
  add column if not exists css text;
