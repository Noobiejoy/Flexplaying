import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createTestDb, createUser } from "./helpers/pg";

let db: PGlite;
let alice: { id: string; email: string };
let bob: { id: string; email: string };
let carol: { id: string; email: string };
let wsA: string;
let wsB: string;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDb();
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  carol = await createUser(db, "carol@example.com");
  wsA = await asUser(db, alice, async () => (await q<{ id: string }>(`select public.create_workspace('Alice Site', 'Asia/Kolkata') as id`))[0]!.id);
  wsB = await asUser(db, bob, async () => (await q<{ id: string }>(`select public.create_workspace('Bob Site', 'Asia/Kolkata') as id`))[0]!.id);
  // service-role style writes (as table owner) for pipeline data
  await q(`insert into public.runs (workspace_id, trigger, status, publishing_mode) values ($1,'manual','queued','draft_only'), ($2,'manual','queued','draft_only')`, [wsA, wsB]);
  await q(`insert into public.workspace_secrets (workspace_id, kind, ciphertext, key_id) values ($1,'wordpress_app_password','v1.k1.x.y.z','k1')`, [wsA]);
  await q(`insert into public.wordpress_connections (workspace_id, site_url, username) values ($1,'https://a.example','alice')`, [wsA]);
});

describe("database: workspace bootstrap", () => {
  it("create_workspace makes the caller owner with default settings, schedule and preferences", async () => {
    const m = await q(`select role from public.workspace_members where workspace_id=$1 and user_id=$2`, [wsA, alice.id]);
    expect(m).toEqual([{ role: "owner" }]);
    const s = await q<{ publishing_mode: string; automation_enabled: boolean; timezone: string }>(`select publishing_mode, automation_enabled, timezone from public.workspace_settings where workspace_id=$1`, [wsA]);
    expect(s[0]).toEqual({ publishing_mode: "draft_only", automation_enabled: false, timezone: "Asia/Kolkata" });
    const times = await q<{ t: string }>(`select local_time::text as t from public.schedules where workspace_id=$1 order by 1`, [wsA]);
    expect(times.map((r) => r.t)).toEqual(["09:00:00", "13:00:00", "19:00:00"]);
    const p = await q(`select version, active from public.editorial_preferences where workspace_id=$1`, [wsA]);
    expect(p).toEqual([{ version: 1, active: true }]);
    const profiles = await q(`select count(*)::int as n from public.profiles`);
    expect(profiles[0]).toEqual({ n: 3 });
  });

  it("anonymous callers cannot create workspaces", async () => {
    await expect(q(`select public.create_workspace('x')`)).rejects.toThrow(/not authenticated/);
  });
});

describe("database: tenant isolation (RLS)", () => {
  it("a user sees only their own workspace data", async () => {
    await asUser(db, bob, async () => {
      expect((await q(`select id from public.workspaces`)).map((r) => r.id)).toEqual([wsB]);
      expect(await q(`select * from public.runs where workspace_id=$1`, [wsA])).toEqual([]);
      expect(await q(`select * from public.workspace_settings where workspace_id=$1`, [wsA])).toEqual([]);
      expect(await q(`select * from public.wordpress_connections where workspace_id=$1`, [wsA])).toEqual([]);
      expect((await q(`select * from public.runs`)).length).toBe(1);
    });
  });

  it("a user cannot modify another workspace's settings", async () => {
    await asUser(db, bob, async () => {
      await q(`update public.workspace_settings set publishing_mode='auto_publish' where workspace_id=$1`, [wsA]);
    });
    const s = await q<{ publishing_mode: string }>(`select publishing_mode from public.workspace_settings where workspace_id=$1`, [wsA]);
    expect(s[0]!.publishing_mode).toBe("draft_only");
  });

  it("encrypted credentials are unreadable by every client role, including the owner", async () => {
    await asUser(db, alice, async () => {
      await expect(q(`select * from public.workspace_secrets`)).rejects.toThrow(/permission denied/);
    });
  });

  it("clients cannot write pipeline tables directly", async () => {
    await asUser(db, alice, async () => {
      await expect(q(`insert into public.runs (workspace_id, trigger, status, publishing_mode) values ($1,'manual','queued','auto_publish')`, [wsA])).rejects.toThrow(/row-level security/);
      await q(`update public.runs set status='published' where workspace_id=$1`, [wsA]);
    });
    const r = await q<{ status: string }>(`select status from public.runs where workspace_id=$1`, [wsA]);
    expect(r[0]!.status).toBe("queued");
  });
});

describe("database: roles and invitations", () => {
  it("invitation acceptance requires the invited email", async () => {
    await asUser(db, alice, async () => {
      await q(`insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at) values ($1,'carol@example.com','editor','hash-carol',$2, now() + interval '1 day')`, [wsA, alice.id]);
    });
    await asUser(db, bob, async () => {
      await expect(q(`select public.accept_invitation('hash-carol')`)).rejects.toThrow(/different email/);
    });
    await asUser(db, carol, async () => {
      expect((await q<{ ws: string }>(`select public.accept_invitation('hash-carol') as ws`))[0]!.ws).toBe(wsA);
      await expect(q(`select public.accept_invitation('hash-carol')`)).rejects.toThrow(/invalid or expired/);
    });
  });

  it("editors cannot change settings or credentials but can give feedback", async () => {
    const run = (await q<{ id: string }>(`select id from public.runs where workspace_id=$1`, [wsA]))[0]!.id;
    const cand = (await q<{ id: string }>(`insert into public.topic_candidates (workspace_id, run_id, category, headline, topic, summary) values ($1,$2,'anime','H','T','S') returning id`, [wsA, run]))[0]!.id;
    await asUser(db, carol, async () => {
      await q(`update public.workspace_settings set publishing_mode='auto_publish' where workspace_id=$1`, [wsA]);
      await q(`update public.wordpress_connections set site_url='https://evil.example' where workspace_id=$1`, [wsA]);
      await q(`insert into public.topic_feedback (workspace_id, candidate_id, user_id, verdict) values ($1,$2,$3,'interesting')`, [wsA, cand, carol.id]);
      await expect(q(`insert into public.topic_feedback (workspace_id, candidate_id, user_id, verdict) values ($1,$2,$3,'irrelevant')`, [wsA, cand, alice.id])).rejects.toThrow(/row-level security/);
    });
    expect((await q<{ publishing_mode: string }>(`select publishing_mode from public.workspace_settings where workspace_id=$1`, [wsA]))[0]!.publishing_mode).toBe("draft_only");
    expect((await q<{ site_url: string }>(`select site_url from public.wordpress_connections where workspace_id=$1`, [wsA]))[0]!.site_url).toBe("https://a.example");
  });

  it("owners can change settings", async () => {
    await asUser(db, alice, async () => {
      await q(`update public.workspace_settings set daily_article_limit=5 where workspace_id=$1`, [wsA]);
    });
    expect((await q<{ n: number }>(`select daily_article_limit as n from public.workspace_settings where workspace_id=$1`, [wsA]))[0]!.n).toBe(5);
  });

  it("an owner cannot remove themselves (no orphaned workspaces)", async () => {
    await asUser(db, alice, async () => {
      await q(`delete from public.workspace_members where workspace_id=$1 and user_id=$2`, [wsA, alice.id]);
    });
    expect((await q(`select 1 from public.workspace_members where workspace_id=$1 and user_id=$2`, [wsA, alice.id])).length).toBe(1);
  });
});

describe("database: durable job ledger", () => {
  it("slot keys are unique per workspace", async () => {
    await q(`insert into public.runs (workspace_id, trigger, slot_key, status, publishing_mode) values ($1,'schedule','2026-10-27T09:00','queued','draft_only')`, [wsA]);
    await expect(q(`insert into public.runs (workspace_id, trigger, slot_key, status, publishing_mode) values ($1,'schedule','2026-10-27T09:00','queued','draft_only')`, [wsA])).rejects.toThrow(/duplicate key/);
    // a different workspace may use the same slot
    await q(`insert into public.runs (workspace_id, trigger, slot_key, status, publishing_mode) values ($1,'schedule','2026-10-27T09:00','queued','draft_only')`, [wsB]);
  });

  it("claim_run grants a single lease and is not callable by clients", async () => {
    const id = (await q<{ id: string }>(`select id from public.runs where workspace_id=$1 and slot_key is not null`, [wsA]))[0]!.id;
    expect((await q<{ ok: boolean }>(`select public.claim_run($1,'w1',300) as ok`, [id]))[0]!.ok).toBe(true);
    expect((await q<{ ok: boolean }>(`select public.claim_run($1,'w2',300) as ok`, [id]))[0]!.ok).toBe(false);
    expect((await q<{ ok: boolean }>(`select public.claim_run($1,'w1',300) as ok`, [id]))[0]!.ok).toBe(true);
    await q(`select public.release_run($1,'w1')`, [id]);
    expect((await q<{ ok: boolean }>(`select public.claim_run($1,'w2',300) as ok`, [id]))[0]!.ok).toBe(true);
    await asUser(db, alice, async () => {
      await expect(q(`select public.claim_run($1,'evil',300)`, [id])).rejects.toThrow(/permission denied/);
    });
  });

  it("terminal runs cannot be claimed", async () => {
    const id = (await q<{ id: string }>(`insert into public.runs (workspace_id, trigger, status, publishing_mode) values ($1,'manual','published','draft_only') returning id`, [wsA]))[0]!.id;
    expect((await q<{ ok: boolean }>(`select public.claim_run($1,'w1',300) as ok`, [id]))[0]!.ok).toBe(false);
  });

  it("only google/* model overrides are accepted", async () => {
    await expect(q(`update public.workspace_settings set text_model='openai/gpt-x' where workspace_id=$1`, [wsA])).rejects.toThrow(/check constraint/);
  });
});
