-- Hungarian (and other agglutinative languages): word forms differ by suffix ("WordPresst",
-- "Kovácséknak"). Trigram tokens let a query match the stem's 3-letter pieces.
DROP TRIGGER memories_ai;
DROP TRIGGER memories_ad;
DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, content = 'memories', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
INSERT INTO memories_fts (memories_fts) VALUES ('rebuild');
