export interface DemoCatalogPatch {
  title?: string;
  altTitles?: string[];
  year?: number | null;
  score?: number | null;
  popularity?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  episodes?: number | null;
  color?: string | null;
  genres?: string[];
  authors?: string[];
  synopsis?: string | null;
  coverUrl?: string | null;
  bannerUrl?: string | null;
}

const ALLOWED_IMAGE_HOSTS = new Set([
  's4.anilist.co',
  'static.tvmaze.com',
  'covers.openlibrary.org',
  'upload.wikimedia.org',
]);

export function sanitizeDemoImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#039;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Single-pass linear tag stripper avoids regex backtracking and multi-character sanitization issues.
  let out = '';
  let inTag = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '<') {
      inTag = true;
      out += ' ';
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  // Single-pass entity decode never double-unescapes.
  const text = out
    .replace(/&(quot|#0?39|amp|lt|gt);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 420 ? `${text.slice(0, 417).trimEnd()}...` : text;
}

const ANILIST_SLOT_TO_ID: Record<string, number> = {
  'anilist:900101': 30642, // Vinland Saga (Manga)
  'anilist:900102': 30656, // Vagabond (Manga)
  'anilist:900103': 98263, // Witch Hat Atelier (Manga)
  'anilist:900104': 132182, // Blue Box (Manga)
  'anilist:900105': 101233, // The Way of the Househusband (Manga)
  'anilist:900106': 117195, // [Oshi no Ko] (Manga)
  'anilist:900201': 105398, // Solo Leveling (Manhwa)
  'anilist:900202': 119257, // Omniscient Reader (Manhwa)
  'anilist:900203': 85143, // Tower of God (Manhwa)
  'anilist:900204': 100568, // The Horizon (Manhwa)
  'anilist:900301': 117324, // Nan Hao & Shang Feng (Manhua)
  'anilist:900302': 85734, // Tamen De Gushi (Manhua)
  'anilist:900501': 39115, // Spice & Wolf (Light Novel)
  'anilist:900502': 98610, // 86—EIGHTY-SIX (Light Novel)
  'anilist:900503': 99026, // The Apothecary Diaries (Light Novel)
  'anilist:900701': 154587, // Frieren: Beyond Journey's End (Anime)
  'anilist:900702': 5114, // Fullmetal Alchemist: Brotherhood (Anime)
  'anilist:900703': 21827, // Violet Evergarden (Anime)
  'anilist:900704': 130003, // BOCCHI THE ROCK! (Anime)
  'anilist:900951': 199, // Spirited Away (Animated Film)
};

const TVMAZE_SLOT_TO_ID: Record<string, number> = {
  'tmdb:tv-900801': 44933, // Severance
  'tmdb:tv-900802': 52341, // Andor
};

const OPEN_LIBRARY_PATCHES: Record<string, DemoCatalogPatch> = {
  'local:comic-900401': {
    title: 'Watchmen',
    year: 1986,
    score: 91,
    authors: ['Alan Moore', 'Dave Gibbons'],
    genres: ['Action', 'Mystery', 'Sci-Fi'],
    color: '#0ea5e9',
    synopsis:
      'In an alternate 1985 where costumed vigilantes reshaped world history, the murder of a former hero triggers an investigation into a looming global conspiracy.',
    coverUrl: 'https://covers.openlibrary.org/b/id/7774899-L.jpg',
  },
  'local:comic-900402': {
    title: 'Persepolis',
    year: 2000,
    score: 89,
    authors: ['Marjane Satrapi'],
    genres: ['Drama', 'History', 'Slice of Life'],
    color: '#38bdf8',
    synopsis:
      'An autobiographical graphic novel chronicling childhood and coming of age in Tehran through revolution, upheaval, and exile.',
    coverUrl: 'https://covers.openlibrary.org/b/id/12648921-L.jpg',
  },
  'local:comic-900403': {
    title: 'Blacksad',
    year: 2000,
    score: 88,
    authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
    genres: ['Mystery', 'Drama', 'Thriller'],
    color: '#0284c7',
    synopsis:
      'Private detective John Blacksad navigates 1950s noir America in a richly painted world of anthropomorphic characters and shadowed crime.',
    coverUrl: 'https://covers.openlibrary.org/b/id/6671224-L.jpg',
  },
  'local:wn-900551': {
    title: 'The Name of the Wind',
    year: 2007,
    score: 90,
    authors: ['Patrick Rothfuss'],
    genres: ['Fantasy', 'Adventure', 'Drama'],
    color: '#0369a1',
    synopsis:
      'An innkeeper known once as Kvothe recounts his life as a gifted musician, arcane student, and legend searching for the truth behind his family’s fate.',
    coverUrl: 'https://covers.openlibrary.org/b/id/11480483-L.jpg',
  },
  'local:novel-900601': {
    title: 'Dune',
    year: 1965,
    score: 93,
    authors: ['Frank Herbert'],
    genres: ['Sci-Fi', 'Adventure', 'Drama'],
    color: '#0ea5e9',
    synopsis:
      'On the desert planet Arrakis, young Paul Atreides is drawn into political betrayal, ecological survival, and the struggle for the universe’s most vital resource.',
    coverUrl: 'https://covers.openlibrary.org/b/id/11481354-L.jpg',
  },
  'local:novel-900602': {
    title: 'Project Hail Mary',
    year: 2021,
    score: 91,
    authors: ['Andy Weir'],
    genres: ['Sci-Fi', 'Adventure', 'Mystery'],
    color: '#38bdf8',
    synopsis:
      'A lone astronaut wakes millions of miles from home with fractured memories and must solve an extinction-level stellar crisis through improvisation and science.',
    coverUrl: 'https://covers.openlibrary.org/b/id/11200092-L.jpg',
  },
  'local:book-900651': {
    title: 'The Left Hand of Darkness',
    year: 1969,
    score: 88,
    authors: ['Ursula K. Le Guin'],
    genres: ['Sci-Fi', 'Drama', 'Adventure'],
    color: '#0284c7',
    synopsis:
      'An envoy travels to the frozen world of Gethen to invite its nations into an interstellar league, navigating court intrigue and a perilous glacial crossing.',
    coverUrl: 'https://covers.openlibrary.org/b/id/10618463-L.jpg',
  },
  'tmdb:movie-900901': {
    title: 'Tears of Steel',
    year: 2012,
    score: 84,
    authors: ['Ian Hubert', 'Blender Studio'],
    genres: ['Sci-Fi', 'Action', 'Drama'],
    color: '#38bdf8',
    synopsis:
      'In a futuristic Amsterdam, a group of scientists and warriors gather at the Oude Kerk to stage a crucial memory reconstruction and stop an uprising of rogue robots. Open movie (CC BY 3.0).',
    coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Tos-poster.png',
    bannerUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Tos-poster.png',
  },
};

interface AniListNode {
  id: number;
  isAdult?: boolean;
  title?: { english?: string | null; romaji?: string | null };
  startDate?: { year?: number | null };
  averageScore?: number | null;
  popularity?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  episodes?: number | null;
  genres?: string[];
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; color?: string | null };
  bannerImage?: string | null;
}

interface TvMazeShow {
  id: number;
  name?: string;
  premiered?: string | null;
  genres?: string[];
  summary?: string | null;
  rating?: { average?: number | null };
  image?: { original?: string | null; medium?: string | null };
}

let cachedCatalog: { expiresAt: number; data: Record<string, DemoCatalogPatch> } | null = null;

export async function fetchLiveDemoCatalog(): Promise<Record<string, DemoCatalogPatch>> {
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cachedCatalog.data;
  }

  const patches: Record<string, DemoCatalogPatch> = { ...OPEN_LIBRARY_PATCHES };
  const idToSlot = new Map<number, string>();
  for (const [slot, anilistId] of Object.entries(ANILIST_SLOT_TO_ID)) {
    idToSlot.set(anilistId, slot);
  }

  const anilistIds = [...idToSlot.keys()];
  const anilistTask = (async () => {
    try {
      const query = `query ($ids: [Int]) {
        Page(perPage: 30) {
          media(id_in: $ids, isAdult: false) {
            id
            isAdult
            title { english romaji }
            startDate { year }
            averageScore
            popularity
            chapters
            volumes
            episodes
            genres
            description(asHtml: false)
            coverImage { extraLarge large color }
            bannerImage
          }
        }
      }`;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables: { ids: anilistIds } }),
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { Page?: { media?: AniListNode[] } } };
      for (const item of body.data?.Page?.media ?? []) {
        if (item.isAdult) continue;
        const slot = idToSlot.get(item.id);
        if (!slot) continue;
        const title = item.title?.english?.trim() || item.title?.romaji?.trim();
        const alt =
          item.title?.romaji && item.title.romaji !== title ? [item.title.romaji] : [];
        const coverUrl = sanitizeDemoImageUrl(
          item.coverImage?.extraLarge ?? item.coverImage?.large,
        );
        const bannerUrl = sanitizeDemoImageUrl(item.bannerImage);
        patches[slot] = {
          ...(title ? { title } : {}),
          ...(alt.length > 0 ? { altTitles: alt } : {}),
          ...(item.startDate?.year ? { year: item.startDate.year } : {}),
          ...(typeof item.averageScore === 'number' ? { score: item.averageScore } : {}),
          ...(typeof item.popularity === 'number' ? { popularity: item.popularity } : {}),
          ...(typeof item.chapters === 'number' && item.chapters > 0
            ? { chapters: item.chapters }
            : {}),
          ...(typeof item.volumes === 'number' && item.volumes > 0
            ? { volumes: item.volumes }
            : {}),
          ...(typeof item.episodes === 'number' && item.episodes > 0
            ? { episodes: item.episodes }
            : {}),
          ...(item.coverImage?.color ? { color: item.coverImage.color } : {}),
          ...(Array.isArray(item.genres) && item.genres.length > 0
            ? { genres: item.genres.slice(0, 4) }
            : {}),
          ...(cleanDescription(item.description)
            ? { synopsis: cleanDescription(item.description) }
            : {}),
          ...(coverUrl ? { coverUrl } : {}),
          ...(bannerUrl ? { bannerUrl } : {}),
        };
      }
    } catch {
      /* Keep fallback entries when AniList is unavailable. */
    }
  })();

  const tvMazeTasks = Object.entries(TVMAZE_SLOT_TO_ID).map(async ([slot, showId]) => {
    try {
      const res = await fetch(`https://api.tvmaze.com/shows/${showId}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return;
      const show = (await res.json()) as TvMazeShow;
      const coverUrl = sanitizeDemoImageUrl(show.image?.original ?? show.image?.medium);
      const year = show.premiered ? Number(show.premiered.slice(0, 4)) : null;
      patches[slot] = {
        ...(show.name ? { title: show.name } : {}),
        ...(year && Number.isFinite(year) ? { year } : {}),
        ...(typeof show.rating?.average === 'number'
          ? { score: Math.round(show.rating.average * 10) }
          : {}),
        ...(Array.isArray(show.genres) && show.genres.length > 0
          ? { genres: show.genres.slice(0, 4) }
          : {}),
        ...(cleanDescription(show.summary) ? { synopsis: cleanDescription(show.summary) } : {}),
        ...(coverUrl ? { coverUrl, bannerUrl: coverUrl } : {}),
      };
    } catch {
      /* Keep fallback entries when TVMaze is unavailable. */
    }
  });

  await Promise.all([anilistTask, ...tvMazeTasks]);
  cachedCatalog = { expiresAt: now + 3_600_000, data: patches };
  return patches;
}
