/**
 * Source reliability registry. Tiers are deliberately coarse and documented in
 * the dashboard so editors can see why a source scored the way it did.
 */
export type SourceTier = "official" | "established" | "standard" | "unknown" | "low";

export const TIER_SCORE: Record<SourceTier, number> = {
  official: 1,
  established: 0.85,
  standard: 0.6,
  unknown: 0.4,
  low: 0.1,
};

const OFFICIAL = [
  "crunchyroll.com", "aniplex.co.jp", "toei-anim.co.jp", "mappa.co.jp", "kyotoanimation.co.jp", "netflix.com",
  "shueisha.co.jp", "kodansha.us", "viz.com", "playstation.com", "xbox.com", "nintendo.com", "nintendo.co.jp",
  "steampowered.com", "store.steampowered.com", "epicgames.com", "ea.com", "ubisoft.com", "blizzard.com",
  "riotgames.com", "valvesoftware.com", "capcom.com", "square-enix.com", "bandainamcoent.com", "sega.com",
  "rockstargames.com", "bethesda.net", "activision.com", "lolesports.com", "valorantesports.com",
  "esl.com", "eslgaming.com", "blast.tv", "pgl.gg", "riftbound.com", "dota2.com", "counter-strike.net",
  "esportsworldcup.com", "olympics.com", "amd.com", "nvidia.com", "intel.com", "news.xbox.com", "blog.playstation.com",
];

const ESTABLISHED = [
  "animenewsnetwork.com", "anitrendz.net", "otakunews.com", "anime.eiga.com", "natalie.mu", "comicbook.com",
  "ign.com", "gamespot.com", "polygon.com", "eurogamer.net", "pcgamer.com", "rockpapershotgun.com", "kotaku.com",
  "theverge.com", "gamesindustry.biz", "videogameschronicle.com", "vgc.com", "gematsu.com", "siliconera.com",
  "destructoid.com", "gamesradar.com", "pushsquare.com", "nintendolife.com", "purexbox.com", "digitalfoundry.net",
  "hltv.org", "liquipedia.net", "dotesports.com", "esportsinsider.com", "esports.gg", "theesportsobserver.com",
  "vlr.gg", "dexerto.com", "reuters.com", "apnews.com", "bloomberg.com", "variety.com", "hollywoodreporter.com",
  "deadline.com", "bbc.co.uk", "bbc.com", "nytimes.com", "wsj.com", "ft.com", "techcrunch.com", "engadget.com",
  "arstechnica.com", "wired.com", "forbes.com", "insider-gaming.com", "gameinformer.com", "thegamer.com",
];

const STANDARD = [
  "screenrant.com", "cbr.com", "gamerant.com", "sportskeeda.com", "dualshockers.com", "wccftech.com",
  "windowscentral.com", "fandomwire.com", "animecorner.me", "myanimelist.net", "anilist.co", "reddit.com",
  "x.com", "twitter.com", "youtube.com", "wikipedia.org", "en.wikipedia.org", "fandom.com",
];

const LOW = ["medium.com", "blogspot.com", "wordpress.com", "quora.com", "pinterest.com", "tiktok.com", "facebook.com"];

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  } catch {
    return "";
  }
}

function matches(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface DomainRegistry {
  tierFor(url: string): SourceTier;
}

export function createDomainRegistry(extra: Partial<Record<SourceTier, string[]>> = {}): DomainRegistry {
  const lists: Record<SourceTier, string[]> = {
    official: [...OFFICIAL, ...(extra.official ?? [])],
    established: [...ESTABLISHED, ...(extra.established ?? [])],
    standard: [...STANDARD, ...(extra.standard ?? [])],
    low: [...LOW, ...(extra.low ?? [])],
    unknown: [],
  };
  return {
    tierFor(url: string): SourceTier {
      const d = domainOf(url);
      if (!d) return "low";
      if (matches(d, lists.low)) return "low";
      if (matches(d, lists.official)) return "official";
      if (matches(d, lists.established)) return "established";
      if (matches(d, lists.standard)) return "standard";
      return "unknown";
    },
  };
}

export const defaultDomainRegistry = createDomainRegistry();

/** Social posts and wikis are not independent corroboration for news claims. */
export function isCorroborationEligible(tier: SourceTier, url: string): boolean {
  if (tier === "low") return false;
  const d = domainOf(url);
  return !["reddit.com", "x.com", "twitter.com", "fandom.com", "wikipedia.org"].some((s) => d === s || d.endsWith(`.${s}`));
}

const TWO_PART_TLDS = new Set(["co.uk", "com.au", "co.jp", "co.kr", "com.br", "co.in", "com.sg"]);

function registrableLabel(url: string): string {
  const parts = domainOf(url).split(".");
  if (parts.length < 2) return "";
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_TLDS.has(lastTwo) && parts.length >= 3 ? parts[parts.length - 3]! : parts[parts.length - 2]!;
}

/**
 * True when the URL is the subject's own website, e.g. funcom.com for a story
 * about Funcom. The domain name must equal the entity name exactly (so
 * nintendolife.com is not Nintendo), and social, wiki and low-quality hosts
 * never qualify.
 */
export function isEntityOwnedDomain(url: string, entities: string[]): boolean {
  const tier = defaultDomainRegistry.tierFor(url);
  if (tier === "low" || tier === "standard") return false;
  const label = registrableLabel(url);
  if (label.length < 4) return false;
  return entities.some((e) => e.toLowerCase().replace(/[^a-z0-9]+/g, "") === label);
}
