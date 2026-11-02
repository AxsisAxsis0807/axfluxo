-- V6 preferences only; submitted ranges/names belong exclusively to immutable render snapshots.
BEGIN;
CREATE TABLE axfluxo_video.developer_preferences(owner_id uuid NOT NULL,kind text NOT NULL CHECK(kind='fnf-showcase'),revision bigint NOT NULL CHECK(revision>0),preferences jsonb NOT NULL,PRIMARY KEY(owner_id,kind));
ALTER TABLE axfluxo_video.developer_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.developer_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON axfluxo_video.developer_preferences TO axfluxo_video_api USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
REVOKE ALL ON axfluxo_video.developer_preferences FROM PUBLIC;
GRANT SELECT,INSERT ON axfluxo_video.developer_preferences TO axfluxo_video_api;
GRANT UPDATE(revision,preferences) ON axfluxo_video.developer_preferences TO axfluxo_video_api;
COMMIT;
