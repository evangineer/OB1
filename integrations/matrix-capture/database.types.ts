// Replace this placeholder with CLI-generated types from your self-hosted
// Supabase/PostgREST surface when available. See README.md for the exact
// generation command used by this package.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ThoughtMetadata = {
  source: "matrix";
  matrix_encrypted?: boolean;
  matrix_event_id: string;
  matrix_homeserver: string;
  matrix_msgtype: string;
  matrix_origin_server_ts: number;
  matrix_room_id: string;
  matrix_room_name: string;
  matrix_sender: string;
  matrix_sender_display: string;
  [key: string]: Json | undefined;
};

type ThoughtsRow = {
  content: string;
  created_at: string;
  embedding: number[];
  id: string;
  metadata: ThoughtMetadata;
};

type ThoughtsInsert = {
  content: string;
  created_at?: string;
  embedding: number[];
  id?: string;
  metadata: ThoughtMetadata;
};

type ThoughtsUpdate = Partial<ThoughtsInsert>;

export interface Database {
  public: {
    Tables: {
      thoughts: {
        Row: ThoughtsRow;
        Insert: ThoughtsInsert;
        Update: ThoughtsUpdate;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
