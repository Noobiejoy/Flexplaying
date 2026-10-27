export const CATEGORIES = ["anime", "gaming", "esports"] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export const CATEGORY_LABEL: Record<Category, string> = { anime: "Anime", gaming: "Gaming", esports: "Esports" };

export const CATEGORY_SCOPE: Record<Category, string> = {
  anime:
    "anime industry news, new and upcoming releases, manga-to-anime adaptations, studio announcements, production updates, streaming platforms, voice actors, industry developments and franchise news",
  gaming:
    "new game announcements, releases, updates and patches, game reviews and analysis, popular competitive games, gaming hardware and platforms, publishers, studios, market trends and gaming industry developments",
  esports:
    "competitive gaming tournaments, match results, roster changes, player transfers, team announcements, competitive scene developments, tournament schedules, organisational news and esports business developments",
};
