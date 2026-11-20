-- Projects under workspaces (ADR-0031): threads and tasks carry a project slug (no FK: projects
-- are folders under $ACHORDS_HOME/projects, not rows).
ALTER TABLE threads ADD COLUMN project TEXT;
ALTER TABLE tasks ADD COLUMN project TEXT;
