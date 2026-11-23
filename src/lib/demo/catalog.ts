import { KIND_IDS, kindOfMedia, type Kind } from '@/domain/kinds';
import { DEFAULT_TIERS } from '@/domain/tiers';
import type {
  ChapterRelease,
  ContinueItem,
  DownloadBatch,
  Extension,
  MediaDetail,
  MergedChapter,
  NewsItem,
  PublicSettings,
  Ranking,
  ServicesStatus,
  SourceInfo,
  TrackedMedia,
  UnifiedMedia,
  UpdateEntry,
  VideoDetail,
  WorkList,
} from '@/types/shared';

interface DemoSeedWork {
  id: string;
  slug: string;
  type: UnifiedMedia['type'];
  format: UnifiedMedia['format'];
  origin: string;
  title: string;
  altTitles: string[];
  anilistId: number | null;
  year: number;
  startDate: string;
  score: number;
  popularity: number;
  status: 'RELEASING' | 'FINISHED';
  chapters: number | null;
  volumes: number | null;
  episodes: number | null;
  color: string;
  genres: string[];
  tags: string[];
  authors: string[];
  studios?: string[];
  cast?: string[];
  synopsis: string;
  hasBanner?: boolean;
  seasonsCount?: number;
  episodeDuration?: number;
}

const SEEDS: DemoSeedWork[] = [
  {
    id: 'anilist:900101',
    slug: 'glass-harbor',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Glass Harbor',
    altTitles: ['Garasu no Minato'],
    anilistId: 900101,
    year: 2024,
    startDate: '2024-04-12',
    score: 92,
    popularity: 184000,
    status: 'RELEASING',
    chapters: 64,
    volumes: 7,
    episodes: null,
    color: '#38bdf8',
    genres: ['Action', 'Sci-Fi', 'Mystery'],
    tags: ['Seinen', 'Maritime', 'Architecture', 'Investigation'],
    authors: ['Kenji Morita'],
    synopsis:
      'In a flooded coastal megacity built over sunken glass breakwaters, a young harbor surveyor uncovers tide-locked clocks that predict storms days before radar.',
    hasBanner: true,
  },
  {
    id: 'anilist:900102',
    slug: 'clockwork-meridian',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Clockwork Meridian',
    altTitles: ['Tokeijikake no Shigosen'],
    anilistId: 900102,
    year: 2023,
    startDate: '2023-01-18',
    score: 89,
    popularity: 162000,
    status: 'RELEASING',
    chapters: 118,
    volumes: 12,
    episodes: null,
    color: '#f59e0b',
    genres: ['Adventure', 'Fantasy', 'Drama'],
    tags: ['Shounen', 'Steampunk', 'Cartography', 'Ensemble Cast'],
    authors: ['Ren Takahashi'],
    synopsis:
      'Two apprentice horologists travel along the great meridian railway repairing bronze observatory towers that keep winter from swallowing the central plains.',
    hasBanner: true,
  },
  {
    id: 'anilist:900103',
    slug: 'paper-lantern-district',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Paper Lantern District',
    altTitles: ['Chochin Machi'],
    anilistId: 900103,
    year: 2022,
    startDate: '2022-05-03',
    score: 87,
    popularity: 118000,
    status: 'FINISHED',
    chapters: 86,
    volumes: 9,
    episodes: null,
    color: '#fb7185',
    genres: ['Slice of Life', 'Drama', 'Mystery'],
    tags: ['Seinen', 'Artisans', 'Atmospheric'],
    authors: ['Sora Fujimoto'],
    synopsis:
      'Every autumn, a narrow Kyoto alley trades hand-painted paper lanterns that preserve a single spoken memory inside their warm glow.',
  },
  {
    id: 'anilist:900104',
    slug: 'iron-botanist',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Iron Botanist',
    altTitles: ['Tetsu no Shokubutsugakusha'],
    anilistId: 900104,
    year: 2025,
    startDate: '2025-02-07',
    score: 85,
    popularity: 94000,
    status: 'RELEASING',
    chapters: 34,
    volumes: 4,
    episodes: null,
    color: '#34d399',
    genres: ['Sci-Fi', 'Adventure'],
    tags: ['Seinen', 'Ecology', 'Post-Industrial'],
    authors: ['Haruto Kawaguchi'],
    synopsis:
      'Armed with a greenhouse locomotive, a solitary botanist restores extinct highland flora across abandoned steel valleys.',
    hasBanner: true,
  },
  {
    id: 'anilist:900105',
    slug: 'saltwater-alchemist',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Saltwater Alchemist',
    altTitles: ['Shiomizu no Renkinjutsushi'],
    anilistId: 900105,
    year: 2021,
    startDate: '2021-09-14',
    score: 88,
    popularity: 131000,
    status: 'FINISHED',
    chapters: 72,
    volumes: 8,
    episodes: null,
    color: '#60a5fa',
    genres: ['Fantasy', 'Slice of Life'],
    tags: ['Shounen', 'Alchemy', 'Coastal'],
    authors: ['Aoi Nishimura'],
    synopsis:
      'An island apothecary distills ocean currents into luminous inks, helping fishermen navigate reefs that redraw themselves every full moon.',
  },
  {
    id: 'anilist:900106',
    slug: 'nocturne-rail',
    type: 'MANGA',
    format: 'MANGA',
    origin: 'JP',
    title: 'Nocturne Rail',
    altTitles: ['Yakyoku Tetsudo'],
    anilistId: 900106,
    year: 2024,
    startDate: '2024-10-04',
    score: 84,
    popularity: 88000,
    status: 'RELEASING',
    chapters: 41,
    volumes: 4,
    episodes: null,
    color: '#a78bfa',
    genres: ['Mystery', 'Supernatural', 'Thriller'],
    tags: ['Seinen', 'Trains', 'Urban Legend'],
    authors: ['Toma Shinoda'],
    synopsis:
      'A sleeper express that only appears on rainy Tuesdays stops at stations demolished fifty years ago, carrying passengers with unfinished letters.',
    hasBanner: true,
  },
  {
    id: 'anilist:900201',
    slug: 'tower-of-ash-amber',
    type: 'MANGA',
    format: 'MANHWA',
    origin: 'KR',
    title: 'Tower of Ash & Amber',
    altTitles: ['Jaewa Hobagui Tap'],
    anilistId: 900201,
    year: 2023,
    startDate: '2023-03-21',
    score: 91,
    popularity: 196000,
    status: 'RELEASING',
    chapters: 142,
    volumes: null,
    episodes: null,
    color: '#f97316',
    genres: ['Action', 'Fantasy', 'Adventure'],
    tags: ['Full Color', 'Dungeon', 'Strategy'],
    authors: ['Jiwon Han'],
    synopsis:
      'When an obsidian spire rises from the dry salt flats, a cartographer climbs its shifting floors using chalk maps instead of blades.',
    hasBanner: true,
  },
  {
    id: 'anilist:900202',
    slug: 'seoul-signal-1999',
    type: 'MANGA',
    format: 'MANHWA',
    origin: 'KR',
    title: 'Seoul Signal 1999',
    altTitles: ['1999 Seoul Sinho'],
    anilistId: 900202,
    year: 2024,
    startDate: '2024-06-11',
    score: 88,
    popularity: 141000,
    status: 'RELEASING',
    chapters: 68,
    volumes: null,
    episodes: null,
    color: '#22d3ee',
    genres: ['Mystery', 'Sci-Fi', 'Drama'],
    tags: ['Full Color', 'Time Loop', 'Radio'],
    authors: ['Minseo Kang'],
    synopsis:
      'A late-night college radio engineer tunes into a pirate frequency broadcasting weather reports from December 1999—and realizes the caller is asking for help.',
    hasBanner: true,
  },
  {
    id: 'anilist:900203',
    slug: 'silver-kiln',
    type: 'MANGA',
    format: 'MANHWA',
    origin: 'KR',
    title: 'Silver Kiln',
    altTitles: ['Eunbit Gama'],
    anilistId: 900203,
    year: 2022,
    startDate: '2022-08-19',
    score: 86,
    popularity: 103000,
    status: 'FINISHED',
    chapters: 95,
    volumes: null,
    episodes: null,
    color: '#cbd5e1',
    genres: ['Drama', 'Slice of Life'],
    tags: ['Full Color', 'Craftsmanship', 'Coming of Age'],
    authors: ['Yuna Baek'],
    synopsis:
      'Three siblings inherit a hillside celadon kiln and race to recreate a lost winter glaze before the regional exhibition opens.',
  },
  {
    id: 'anilist:900204',
    slug: 'monsoon-courier',
    type: 'MANGA',
    format: 'MANHWA',
    origin: 'KR',
    title: 'Monsoon Courier',
    altTitles: ['Jangma Baedalbu'],
    anilistId: 900204,
    year: 2025,
    startDate: '2025-01-24',
    score: 83,
    popularity: 79000,
    status: 'RELEASING',
    chapters: 29,
    volumes: null,
    episodes: null,
    color: '#4ade80',
    genres: ['Action', 'Comedy', 'Adventure'],
    tags: ['Full Color', 'Urban', 'Parkour'],
    authors: ['Doyun Park'],
    synopsis:
      'During the endless summer rains, rooftop bicycle couriers compete across flooded skybridges to deliver impossible packages on time.',
  },
  {
    id: 'anilist:900301',
    slug: 'cloud-pavilion-chronicles',
    type: 'MANGA',
    format: 'MANHUA',
    origin: 'CN',
    title: 'Cloud Pavilion Chronicles',
    altTitles: ['Yun Ge Ji'],
    anilistId: 900301,
    year: 2023,
    startDate: '2023-07-08',
    score: 85,
    popularity: 112000,
    status: 'RELEASING',
    chapters: 110,
    volumes: null,
    episodes: null,
    color: '#eab308',
    genres: ['Fantasy', 'Action', 'Adventure'],
    tags: ['Full Color', 'Martial Arts', 'Mountain Sect'],
    authors: ['Lin Chen'],
    synopsis:
      'A librarian from a cliffside mountain pavilion catalogues forgotten wind-sword manuals while mediating rivalries between nine sky valleys.',
  },
  {
    id: 'anilist:900302',
    slug: 'jade-cartographer',
    type: 'MANGA',
    format: 'MANHUA',
    origin: 'CN',
    title: 'Jade Cartographer',
    altTitles: ['Feicui Zhitu'],
    anilistId: 900302,
    year: 2024,
    startDate: '2024-03-15',
    score: 82,
    popularity: 71000,
    status: 'RELEASING',
    chapters: 54,
    volumes: null,
    episodes: null,
    color: '#10b981',
    genres: ['Adventure', 'Mystery'],
    tags: ['Full Color', 'Exploration', 'Historical'],
    authors: ['Wei Zhou'],
    synopsis:
      'Carving topographic maps onto thin jade plates, an imperial surveyor charts subterranean river kingdoms along the silk frontier.',
  },
  {
    id: 'local:comic-900401',
    slug: 'red-canyon-express',
    type: 'MANGA',
    format: 'COMIC',
    origin: 'FR',
    title: 'Red Canyon Express',
    altTitles: ['Le Train du Canyon Rouge'],
    anilistId: null,
    year: 2023,
    startDate: '2023-09-22',
    score: 88,
    popularity: 86000,
    status: 'RELEASING',
    chapters: 24,
    volumes: 4,
    episodes: null,
    color: '#ef4444',
    genres: ['Adventure', 'Mystery', 'Drama'],
    tags: ['Bande Dessinée', 'Desert', 'Railways'],
    authors: ['Camille Moreau'],
    synopsis:
      'A telegraph operator and a retired locomotive painter escort an armored mail carriage across three hundred miles of sun-bleached canyon tracks.',
    hasBanner: true,
  },
  {
    id: 'local:comic-900402',
    slug: 'brass-observatory',
    type: 'MANGA',
    format: 'COMIC',
    origin: 'BE',
    title: 'The Brass Observatory',
    altTitles: ["L'Observatoire de Laiton"],
    anilistId: null,
    year: 2022,
    startDate: '2022-11-10',
    score: 86,
    popularity: 74000,
    status: 'FINISHED',
    chapters: 18,
    volumes: 3,
    episodes: null,
    color: '#d97706',
    genres: ['Sci-Fi', 'Mystery'],
    tags: ['Bande Dessinée', 'Astronomy', 'Ensemble Cast'],
    authors: ['Étienne Laurent'],
    synopsis:
      'High above a fog-bound European port, an independent observatory logs a comet whose orbit matches an eighteenth-century clockwork globe.',
  },
  {
    id: 'local:comic-900403',
    slug: 'archipelago-drift',
    type: 'MANGA',
    format: 'COMIC',
    origin: 'NL',
    title: 'Archipelago Drift',
    altTitles: [],
    anilistId: null,
    year: 2025,
    startDate: '2025-03-04',
    score: 84,
    popularity: 62000,
    status: 'RELEASING',
    chapters: 12,
    volumes: 2,
    episodes: null,
    color: '#06b6d4',
    genres: ['Adventure', 'Slice of Life'],
    tags: ['Graphic Novel', 'Sailing', 'Islands'],
    authors: ['Nora Vermeer'],
    synopsis:
      'A floating bookshop catamaran sails from island to island across the northern archipelago, trading weather almanacs and illustrated travelogues.',
  },
  {
    id: 'anilist:900501',
    slug: 'quiet-archivist-oakhaven',
    type: 'NOVEL',
    format: 'LIGHT_NOVEL',
    origin: 'JP',
    title: 'The Quiet Archivist of Oakhaven',
    altTitles: ['Oakhaven no Shizuka na Shisho'],
    anilistId: 900501,
    year: 2023,
    startDate: '2023-05-19',
    score: 90,
    popularity: 129000,
    status: 'RELEASING',
    chapters: null,
    volumes: 9,
    episodes: null,
    color: '#c084fc',
    genres: ['Fantasy', 'Slice of Life', 'Mystery'],
    tags: ['Libraries', 'Cozy Fantasy', 'Letters'],
    authors: ['Mei Aoki'],
    synopsis:
      'Tasked with cataloging a century of unclaimed royal correspondence, a quiet archivist gently repairs old treaties and forgotten friendships.',
  },
  {
    id: 'anilist:900502',
    slug: 'orbital-lighthouse',
    type: 'NOVEL',
    format: 'LIGHT_NOVEL',
    origin: 'JP',
    title: 'Letters from an Orbital Lighthouse',
    altTitles: ['Kido Todai kara no Tegami'],
    anilistId: 900502,
    year: 2022,
    startDate: '2022-02-14',
    score: 88,
    popularity: 116000,
    status: 'FINISHED',
    chapters: null,
    volumes: 6,
    episodes: null,
    color: '#38bdf8',
    genres: ['Sci-Fi', 'Drama', 'Romance'],
    tags: ['Space', 'Epistolary', 'Atmospheric'],
    authors: ['Kaito Sato'],
    synopsis:
      'Two relay keepers stationed on opposite sides of Jupiter exchange delayed optical postcards while guiding deep-space freighters home.',
  },
  {
    id: 'anilist:900503',
    slug: 'merchant-frozen-steppe',
    type: 'NOVEL',
    format: 'LIGHT_NOVEL',
    origin: 'JP',
    title: 'Merchant of the Frozen Steppe',
    altTitles: ['Hyoheigen no Shonin'],
    anilistId: 900503,
    year: 2024,
    startDate: '2024-08-29',
    score: 85,
    popularity: 82000,
    status: 'RELEASING',
    chapters: null,
    volumes: 5,
    episodes: null,
    color: '#93c5fd',
    genres: ['Adventure', 'Fantasy'],
    tags: ['Economics', 'Winter', 'Caravan'],
    authors: ['Nao Ishikawa'],
    synopsis:
      'Guided by a compass tuned to geothermal springs, a traveling tea merchant builds winter trade routes across the northern glacier plateau.',
  },
  {
    id: 'local:wn-900551',
    slug: 'tidebinders-ledger',
    type: 'NOVEL',
    format: 'WEB_NOVEL',
    origin: 'NO',
    title: "Tidebinder's Ledger",
    altTitles: [],
    anilistId: null,
    year: 2024,
    startDate: '2024-01-09',
    score: 86,
    popularity: 78000,
    status: 'RELEASING',
    chapters: 164,
    volumes: null,
    episodes: null,
    color: '#14b8a6',
    genres: ['Fantasy', 'Adventure'],
    tags: ['Web Serial', 'Magic System', 'Maritime'],
    authors: ['Erik Halvorsen'],
    synopsis:
      'An apprentice harbor accountant learns that every debt written in sea-salt ink binds the wind itself.',
  },
  {
    id: 'local:novel-900601',
    slug: 'salt-glass-atlas',
    type: 'NOVEL',
    format: 'NOVEL',
    origin: 'FR',
    title: 'The Salt Glass Atlas',
    altTitles: ["L'Atlas de Verre et de Sel"],
    anilistId: null,
    year: 2021,
    startDate: '2021-10-01',
    score: 89,
    popularity: 95000,
    status: 'FINISHED',
    chapters: null,
    volumes: 1,
    episodes: null,
    color: '#f43f5e',
    genres: ['Mystery', 'Drama'],
    tags: ['Literary Fiction', 'Cartography', 'Mediterranean'],
    authors: ['Claire Delacroix'],
    synopsis:
      'Three generations of mapmakers trace an uncharted shoal that only surfaces during autumn equinoxes off the southern coast.',
  },
  {
    id: 'local:novel-900602',
    slug: 'winter-over-val-claire',
    type: 'NOVEL',
    format: 'NOVEL',
    origin: 'FR',
    title: 'Winter Over Val-Claire',
    altTitles: ["L'Hiver sur Val-Claire"],
    anilistId: null,
    year: 2024,
    startDate: '2024-11-06',
    score: 84,
    popularity: 64000,
    status: 'FINISHED',
    chapters: null,
    volumes: 1,
    episodes: null,
    color: '#818cf8',
    genres: ['Drama', 'Slice of Life'],
    tags: ['Mountains', 'Contemporary', 'Atmospheric'],
    authors: ['Lucas Mercer'],
    synopsis:
      'When an early snowstorm seals an alpine valley for three weeks, a retired watchmaker reopens the village cinema using archived 35mm reels.',
  },
  {
    id: 'local:book-900651',
    slug: 'nordic-lighthouses',
    type: 'NOVEL',
    format: 'BOOK',
    origin: 'SE',
    title: 'Field Notes on Nordic Lighthouses',
    altTitles: [],
    anilistId: null,
    year: 2023,
    startDate: '2023-06-15',
    score: 87,
    popularity: 59000,
    status: 'FINISHED',
    chapters: null,
    volumes: 1,
    episodes: null,
    color: '#fbbf24',
    genres: ['History', 'Architecture'],
    tags: ['Non-Fiction', 'Design', 'Maritime'],
    authors: ['Henrik Lindqvist'],
    synopsis:
      'Measured architectural drawings, Fresnel lens diagrams, and keepers’ journals documenting forty granite lighthouses across the North Sea.',
  },
  {
    id: 'anilist:900701',
    slug: 'starlight-foundry',
    type: 'ANIME',
    format: null,
    origin: 'JP',
    title: 'Starlight Foundry',
    altTitles: ['Hoshikage Seisakusho'],
    anilistId: 900701,
    year: 2024,
    startDate: '2024-10-06',
    score: 93,
    popularity: 245000,
    status: 'RELEASING',
    chapters: null,
    volumes: null,
    episodes: 24,
    color: '#60a5fa',
    genres: ['Sci-Fi', 'Adventure', 'Drama'],
    tags: ['Space', 'Mecha', 'Original Anime', 'Ensemble Cast'],
    authors: ['Studio Astra'],
    studios: ['Studio Astra'],
    synopsis:
      'Aboard an orbital shipyard orbiting a ringed gas giant, rookie hull-welders build deep-space telescope arrays while uncovering a drifting probe from an earlier expedition.',
    hasBanner: true,
    seasonsCount: 2,
    episodeDuration: 24,
  },
  {
    id: 'anilist:900702',
    slug: 'kestrel-academy',
    type: 'ANIME',
    format: null,
    origin: 'JP',
    title: 'Kestrel Academy of Winds',
    altTitles: ['Kaze no Hayabusa Gakuin'],
    anilistId: 900702,
    year: 2025,
    startDate: '2025-04-05',
    score: 89,
    popularity: 189000,
    status: 'RELEASING',
    chapters: null,
    volumes: null,
    episodes: 12,
    color: '#34d399',
    genres: ['Adventure', 'Fantasy'],
    tags: ['Aviation', 'School', 'Coming of Age'],
    authors: ['Studio Verdant'],
    studios: ['Studio Verdant'],
    synopsis:
      'Students at a cliffside glider academy chart high-altitude jet streams in ultralight canvas wings to reconnect isolated mountain towns.',
    hasBanner: true,
    seasonsCount: 1,
    episodeDuration: 24,
  },
  {
    id: 'anilist:900703',
    slug: 'midnight-ramen-radio',
    type: 'ANIME',
    format: null,
    origin: 'JP',
    title: 'Midnight Ramen & Radio',
    altTitles: ['Shinya Ramen to Rajio'],
    anilistId: 900703,
    year: 2023,
    startDate: '2023-07-09',
    score: 86,
    popularity: 151000,
    status: 'FINISHED',
    chapters: null,
    volumes: null,
    episodes: 12,
    color: '#fb923c',
    genres: ['Slice of Life', 'Comedy'],
    tags: ['Food', 'Music', 'Iyashikei'],
    authors: ['Studio Hibiki'],
    studios: ['Studio Hibiki'],
    synopsis:
      'An eight-seat late-night noodle counter streams ambient vinyl sets over a low-power neighborhood FM transmitter for night-shift workers.',
    hasBanner: true,
    seasonsCount: 1,
    episodeDuration: 24,
  },
  {
    id: 'anilist:900704',
    slug: 'echoes-copper-sea',
    type: 'ANIME',
    format: null,
    origin: 'JP',
    title: 'Echoes of the Copper Sea',
    altTitles: ['Akagane no Umi no Zankyo'],
    anilistId: 900704,
    year: 2022,
    startDate: '2022-04-10',
    score: 90,
    popularity: 174000,
    status: 'FINISHED',
    chapters: null,
    volumes: null,
    episodes: 24,
    color: '#f472b6',
    genres: ['Sci-Fi', 'Mystery', 'Drama'],
    tags: ['Oceanography', 'Atmospheric', 'Original Anime'],
    authors: ['Studio Marina'],
    studios: ['Studio Marina'],
    synopsis:
      'Acoustic divers descend into rust-colored thermal trenches after underwater hydrophones capture rhythmic chimes matching no known vessel.',
    hasBanner: true,
    seasonsCount: 2,
    episodeDuration: 24,
  },
  {
    id: 'tmdb:tv-900801',
    slug: 'northwatch-station',
    type: 'ANIME',
    format: 'SERIES',
    origin: 'NO',
    title: 'Northwatch Station',
    altTitles: [],
    anilistId: null,
    year: 2024,
    startDate: '2024-09-15',
    score: 90,
    popularity: 215000,
    status: 'RELEASING',
    chapters: null,
    volumes: null,
    episodes: 18,
    color: '#38bdf8',
    genres: ['Sci-Fi', 'Thriller', 'Mystery'],
    tags: ['Arctic', 'Telemetry', 'Ensemble Cast'],
    authors: ['Soren Lind'],
    studios: ['Nordic Television'],
    cast: ['Astrid Solberg', 'Mikkel Nyman', 'Hanna Berg', 'Jonas Falk'],
    synopsis:
      'At an automated polar weather relay above the Arctic Circle, a six-person relief crew discovers an extra module built onto the station blueprints.',
    hasBanner: true,
    seasonsCount: 2,
    episodeDuration: 52,
  },
  {
    id: 'tmdb:tv-900802',
    slug: 'velvet-timetable',
    type: 'ANIME',
    format: 'SERIES',
    origin: 'GB',
    title: 'The Velvet Timetable',
    altTitles: [],
    anilistId: null,
    year: 2023,
    startDate: '2023-11-02',
    score: 85,
    popularity: 138000,
    status: 'FINISHED',
    chapters: null,
    volumes: null,
    episodes: 8,
    color: '#e879f9',
    genres: ['Mystery', 'Drama'],
    tags: ['Period Drama', 'Railways', 'Whodunit'],
    authors: ['Eleanor Vance'],
    studios: ['Meridian Drama'],
    cast: ['Clara Finch', 'Arthur Reid', 'Beatrice Cole', 'David Hollis'],
    synopsis:
      'Across eight winter nights on a transcontinental sleeper line, a retired archivist pieces together why every passenger holds an identical brass key.',
    hasBanner: true,
    seasonsCount: 1,
    episodeDuration: 54,
  },
  {
    id: 'tmdb:movie-900901',
    slug: 'horizon-line-zero',
    type: 'ANIME',
    format: 'MOVIE',
    origin: 'FR',
    title: 'Horizon Line Zero',
    altTitles: ['Ligne d’Horizon Zéro'],
    anilistId: null,
    year: 2024,
    startDate: '2024-05-18',
    score: 88,
    popularity: 168000,
    status: 'FINISHED',
    chapters: null,
    volumes: null,
    episodes: 1,
    color: '#f59e0b',
    genres: ['Sci-Fi', 'Drama', 'Adventure'],
    tags: ['Cinema', 'Solar', 'Expedition'],
    authors: ['Julien Valois'],
    studios: ['Solaris Pictures'],
    cast: ['Mélanie Laurent-Dupont', 'Hugo Vidal', 'Sami Belkacem'],
    synopsis:
      'During a rare 72-hour solar silence, an atmospheric research glider crosses the equatorial cloud band to recover a drifting weather archive.',
    hasBanner: true,
    episodeDuration: 126,
  },
  {
    id: 'anilist:900951',
    slug: 'paper-whale-harbor-nine',
    type: 'ANIME',
    format: 'ANIMATION_FILM',
    origin: 'JP',
    title: 'The Paper Whale of Harbor Nine',
    altTitles: ['Kyu-ban Minato no Kamikujira'],
    anilistId: 900951,
    year: 2024,
    startDate: '2024-08-09',
    score: 92,
    popularity: 204000,
    status: 'FINISHED',
    chapters: null,
    volumes: null,
    episodes: 1,
    color: '#2dd4bf',
    genres: ['Fantasy', 'Adventure', 'Drama'],
    tags: ['Feature Film', 'Hand-Drawn', 'Coastal'],
    authors: ['Atelier Kumo'],
    studios: ['Atelier Kumo'],
    synopsis:
      'Every summer festival, children fold a thirty-meter paper whale at the drydock—until one evening the harbor wind lifts it into the clouds.',
    hasBanner: true,
    episodeDuration: 112,
  },
];

function seedToMedia(s: DemoSeedWork): UnifiedMedia {
  const isReading = s.type === 'MANGA';
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    altTitles: s.altTitles,
    anilistId: s.anilistId,
    mangadexId: null,
    mangaUpdatesId: null,
    coverUrl: `/demo/covers/${s.slug}.svg`,
    bannerUrl: s.hasBanner ? `/demo/covers/${s.slug}-banner.svg` : null,
    synopsis: s.synopsis,
    genres: s.genres,
    authors: s.authors,
    score: s.score,
    status: s.status,
    chapters: s.chapters,
    episodes: s.episodes,
    webUrl: null,
    providers: [s.id.startsWith('tmdb:') ? 'tmdb' : s.id.startsWith('local:') ? 'local' : 'anilist'],
    sources: isReading
      ? [
          {
            sourceId: 'demo-src-1',
            sourceName: 'Harbor Press (Demo)',
            suwayomiMangaId: 5000 + SEEDS.indexOf(s),
            mangaUrl: `/demo/source/${s.slug}`,
            thumbnailUrl: `/demo/covers/${s.slug}.svg`,
            lang: 'en',
          },
        ]
      : [],
    trackedId: null,
    kavitaSeriesId: null,
    format: s.format,
    origin: s.origin,
    year: s.year,
    volumes: s.volumes,
    color: s.color,
    popularity: s.popularity,
    startDate: s.startDate,
    kavita: null,
    adult: false,
    adultOverride: null,
    mine: null,
  };
}

export const DEMO_WORKS: UnifiedMedia[] = SEEDS.map(seedToMedia);
const SEED_BY_ID = new Map(SEEDS.map((s) => [s.id, s]));
export const WORK_BY_ID = new Map(DEMO_WORKS.map((w) => [w.id, w]));

const EPISODE_TITLES = [
  'Low Tide Telemetry',
  'Meridian Calibration',
  'The Seventh Drydock',
  'Driftwood & Brass',
  'Night Shift Frequency',
  'Copper Horizon',
  'Lanterns Over Pier Nine',
  'The Long Crossing',
  'Glass Breakwater',
  'Solstice Relay',
  'Echoes in the Hull',
  'Open Water',
];

export function buildDemoVideoDetail(id: string): VideoDetail | undefined {
  const s = SEED_BY_ID.get(id);
  if (!s || s.type !== 'ANIME') return undefined;
  const isFilm = s.format === 'MOVIE' || s.format === 'ANIMATION_FILM';
  const banner = s.hasBanner ? `/demo/covers/${s.slug}-banner.svg` : `/demo/covers/${s.slug}.svg`;
  if (isFilm) {
    return {
      ids: s.id.startsWith('tmdb:')
        ? { imdb: null, tmdb: Number(s.id.split('-')[1]) || 900901, kind: 'movie' }
        : undefined,
      episodes: 1,
      duration: s.episodeDuration ?? 114,
      studios: s.studios ?? s.authors,
      nextEpisode: null,
      aired: 1,
      list: [{ number: 1, title: s.title, thumbnail: banner, airDate: s.startDate }],
      seasons: [
        {
          number: 1,
          anilistId: s.anilistId,
          isFilm: true,
          coverUrl: `/demo/covers/${s.slug}.svg`,
          bannerUrl: banner,
          title: s.title,
          year: s.year,
          status: s.status,
          episodes: 1,
          aired: 1,
          duration: s.episodeDuration ?? 114,
          nextEpisode: null,
          list: [{ number: 1, title: s.title, thumbnail: banner, airDate: s.startDate }],
        },
      ],
    };
  }
  const seasonsCount = s.seasonsCount ?? 1;
  const totalEps = s.episodes ?? 12;
  const perSeason = Math.ceil(totalEps / seasonsCount);
  const seasons = Array.from({ length: seasonsCount }, (_, idx) => {
    const num = idx + 1;
    const count = idx === seasonsCount - 1 ? totalEps - perSeason * idx : perSeason;
    const aired = s.status === 'RELEASING' && idx === seasonsCount - 1 ? Math.max(1, count - 2) : count;
    const list = Array.from({ length: count }, (_, epIdx) => ({
      number: epIdx + 1,
      title: EPISODE_TITLES[(epIdx + idx * 5) % EPISODE_TITLES.length],
      thumbnail: banner,
      airDate: `${s.year + idx}-${String(((epIdx % 10) + 1)).padStart(2, '0')}-07`,
    }));
    const nextDate = new Date(Date.now() + 3 * 86_400_000).toISOString();
    return {
      number: num,
      tmdbSeason: num,
      anilistId: s.anilistId ? s.anilistId + idx * 10 : null,
      title: `${s.title} — Season ${num}`,
      year: s.year + idx,
      status: idx === seasonsCount - 1 ? s.status : 'FINISHED',
      episodes: count,
      aired,
      duration: s.episodeDuration ?? 24,
      nextEpisode:
        s.status === 'RELEASING' && idx === seasonsCount - 1 && aired < count
          ? { number: aired + 1, airingAt: nextDate }
          : null,
      list,
    };
  });
  const totalAired = seasons.reduce((sum, x) => sum + (x.aired ?? 0), 0);
  return {
    ids: s.id.startsWith('tmdb:')
      ? { imdb: null, tmdb: Number(s.id.split('-')[1]) || 900801, kind: 'tv' }
      : undefined,
    episodes: totalEps,
    duration: s.episodeDuration ?? 24,
    studios: s.studios ?? s.authors,
    nextEpisode: seasons[seasons.length - 1]?.nextEpisode ?? null,
    aired: totalAired,
    list: seasons[0].list,
    seasons,
  };
}

export function buildDemoMediaDetail(id: string, tracked?: TrackedMedia): MediaDetail | null {
  const base = WORK_BY_ID.get(id);
  const seed = SEED_BY_ID.get(id);
  if (!base || !seed) return null;
  const video = buildDemoVideoDetail(id);
  const sameKind = DEMO_WORKS.filter((w) => w.id !== id && kindOfMedia(w) === kindOfMedia(base));
  const other = DEMO_WORKS.filter((w) => w.id !== id && kindOfMedia(w) !== kindOfMedia(base));
  const recommendations = [...sameKind.slice(0, 4), ...other.slice(0, 4)].slice(0, 6);
  const relations = sameKind.slice(0, 2).map((m, i) => ({
    relation: i === 0 ? 'SIDE_STORY' : 'ALTERNATIVE',
    media: m,
  }));
  const ownedEps = tracked?.jellyfinOwned ?? 0;
  return {
    ...base,
    trackedId: tracked?.id ?? null,
    kavitaSeriesId: tracked?.kavitaSeriesId ?? null,
    kavita:
      tracked?.inKavita && tracked.kavitaSeriesId
        ? {
            seriesId: tracked.kavitaSeriesId,
            libraryId: 1,
            libraryName: 'Bunko Demo Library',
            chapters: tracked.progress.owned,
            url: null,
          }
        : null,
    credits: seed.cast ? { cast: seed.cast } : undefined,
    video,
    jellyfin:
      base.type === 'ANIME' && ownedEps > 0
        ? {
            seriesId: `jf-${seed.slug}`,
            name: base.title,
            bySeason: [
              {
                season: 1,
                owned: Array.from({ length: Math.min(ownedEps, 12) }, (_, i) => i + 1),
                played: Array.from(
                  { length: Math.min(tracked?.progress.read ?? 0, 12) },
                  (_, i) => i + 1,
                ),
                episodeIds: {},
              },
            ],
            ownedCount: ownedEps,
            playedCount: tracked?.progress.read ?? 0,
            url: 'https://jellyfin.demo.invalid',
            manual: false,
          }
        : null,
    openIn: [],
    tags: seed.tags,
    relations,
    recommendations,
    pending: false,
    partial: false,
  };
}

export function buildDemoChapters(mediaId: string, tracked?: TrackedMedia): {
  chapters: MergedChapter[];
  inKavita: number[];
  ownedVolumes: number[];
} {
  const work = WORK_BY_ID.get(mediaId);
  const total = Math.min(work?.chapters ?? 24, 36);
  const ownedCount = tracked?.progress.owned ?? Math.min(total, 12);
  const baseIdx = Math.max(1, DEMO_WORKS.findIndex((w) => w.id === mediaId) + 1);
  const chapters: MergedChapter[] = [];
  const inKavita: number[] = [];
  for (let n = 1; n <= total; n++) {
    const vol = Math.ceil(n / 8);
    const chapterId = baseIdx * 1000 + n;
    const isOwned = n <= ownedCount;
    if (isOwned) inKavita.push(n);
    chapters.push({
      key: `ch:${n}`,
      number: n,
      volume: vol,
      variants: [
        {
          id: chapterId,
          mangaId: 5000 + baseIdx,
          sourceId: 'demo-src-1',
          sourceName: 'Harbor Press (Demo)',
          name: `Chapter ${n}`,
          number: n,
          scanlator: 'Bunko Demo Editions',
          isDownloaded: isOwned,
          volume: vol,
        },
      ],
    });
  }
  const ownedVolumes = Array.from({ length: Math.floor(ownedCount / 8) }, (_, i) => i + 1);
  return { chapters, inKavita, ownedVolumes };
}

interface InitialTrackSpec {
  id: number;
  mediaId: string;
  status: TrackedMedia['status'];
  read: number | null;
  owned: number;
  rating: number | null;
  favorite?: boolean;
  newChapters?: number;
  hoursAgo: number;
}

const INITIAL_TRACK_SPECS: InitialTrackSpec[] = [
  { id: 1, mediaId: 'anilist:900101', status: 'READING', read: 58, owned: 62, rating: 9.4, favorite: true, newChapters: 2, hoursAgo: 2 },
  { id: 2, mediaId: 'anilist:900102', status: 'READING', read: 112, owned: 116, rating: 9.1, favorite: true, newChapters: 2, hoursAgo: 5 },
  { id: 3, mediaId: 'anilist:900103', status: 'COMPLETED', read: 86, owned: 86, rating: 8.8, favorite: true, hoursAgo: 48 },
  { id: 4, mediaId: 'anilist:900104', status: 'READING', read: 28, owned: 34, rating: 8.5, hoursAgo: 18 },
  { id: 5, mediaId: 'anilist:900105', status: 'COMPLETED', read: 72, owned: 72, rating: 9.0, favorite: true, hoursAgo: 96 },
  { id: 6, mediaId: 'anilist:900201', status: 'READING', read: 136, owned: 140, rating: 9.3, favorite: true, newChapters: 2, hoursAgo: 3 },
  { id: 7, mediaId: 'anilist:900202', status: 'READING', read: 61, owned: 66, rating: 8.9, favorite: true, newChapters: 1, hoursAgo: 9 },
  { id: 8, mediaId: 'anilist:900203', status: 'COMPLETED', read: 95, owned: 95, rating: 8.6, hoursAgo: 120 },
  { id: 9, mediaId: 'anilist:900301', status: 'READING', read: 98, owned: 105, rating: 8.4, newChapters: 3, hoursAgo: 30 },
  { id: 10, mediaId: 'local:comic-900401', status: 'READING', read: 20, owned: 24, rating: 8.9, favorite: true, hoursAgo: 14 },
  { id: 11, mediaId: 'local:comic-900402', status: 'COMPLETED', read: 18, owned: 18, rating: 8.7, hoursAgo: 160 },
  { id: 12, mediaId: 'anilist:900501', status: 'READING', read: 7, owned: 9, rating: 9.2, favorite: true, hoursAgo: 22 },
  { id: 13, mediaId: 'anilist:900502', status: 'COMPLETED', read: 6, owned: 6, rating: 9.0, hoursAgo: 180 },
  { id: 14, mediaId: 'local:novel-900601', status: 'COMPLETED', read: 1, owned: 1, rating: 9.1, favorite: true, hoursAgo: 210 },
  { id: 15, mediaId: 'local:book-900651', status: 'READING', read: 0, owned: 1, rating: 8.5, hoursAgo: 72 },
  { id: 16, mediaId: 'anilist:900701', status: 'READING', read: 19, owned: 22, rating: 9.5, favorite: true, hoursAgo: 1 },
  { id: 17, mediaId: 'anilist:900702', status: 'READING', read: 8, owned: 10, rating: 8.8, hoursAgo: 12 },
  { id: 18, mediaId: 'anilist:900703', status: 'COMPLETED', read: 12, owned: 12, rating: 8.7, favorite: true, hoursAgo: 80 },
  { id: 19, mediaId: 'anilist:900704', status: 'COMPLETED', read: 24, owned: 24, rating: 9.1, favorite: true, hoursAgo: 140 },
  { id: 20, mediaId: 'tmdb:tv-900801', status: 'READING', read: 14, owned: 16, rating: 9.2, favorite: true, hoursAgo: 4 },
  { id: 21, mediaId: 'tmdb:movie-900901', status: 'COMPLETED', read: 1, owned: 1, rating: 8.9, favorite: true, hoursAgo: 64 },
  { id: 22, mediaId: 'anilist:900951', status: 'COMPLETED', read: 1, owned: 1, rating: 9.4, favorite: true, hoursAgo: 36 },
  { id: 23, mediaId: 'anilist:900106', status: 'PLANNING', read: null, owned: 0, rating: null, hoursAgo: 40 },
  { id: 24, mediaId: 'tmdb:tv-900802', status: 'PAUSED', read: 4, owned: 8, rating: 8.2, hoursAgo: 110 },
];

export function createInitialTracked(): TrackedMedia[] {
  const now = Date.now();
  return INITIAL_TRACK_SPECS.map((spec) => {
    const media = WORK_BY_ID.get(spec.mediaId)!;
    const isVideo = media.type === 'ANIME';
    const isText = media.type === 'NOVEL';
    const released = isVideo
      ? media.episodes
      : isText
        ? (media.volumes ?? media.chapters)
        : media.chapters;
    const unread = Math.max(0, spec.owned - (spec.read ?? 0));
    const ts = new Date(now - spec.hoursAgo * 3_600_000).toISOString();
    const baseIdx = Math.max(1, DEMO_WORKS.findIndex((w) => w.id === media.id) + 1);
    return {
      id: spec.id,
      anilistId: media.anilistId,
      mangadexId: null,
      title: media.title,
      type: media.type,
      coverUrl: media.coverUrl,
      kavitaSeriesId: !isVideo && spec.owned > 0 ? 100 + spec.id : null,
      inKavita: !isVideo && spec.owned > 0,
      jellyfinOwned: isVideo ? spec.owned : undefined,
      airedEpisodes: isVideo ? (media.status === 'RELEASING' && media.episodes && media.episodes > 2 ? media.episodes - 2 : media.episodes) : undefined,
      autoDownload: false,
      createdAt: new Date(now - (spec.hoursAgo + 240) * 3_600_000).toISOString(),
      media: { ...media, trackedId: spec.id },
      sources: media.sources.map((s) => ({
        suwayomiMangaId: s.suwayomiMangaId,
        sourceId: s.sourceId,
        sourceName: s.sourceName,
      })),
      status: spec.status,
      favorite: Boolean(spec.favorite),
      rating: spec.rating,
      completedThrough: spec.status === 'COMPLETED' ? released : null,
      progress: {
        read: spec.read,
        owned: spec.owned,
        released,
        unread,
        readSource: spec.read !== null ? (isVideo ? 'none' : 'kavita') : 'none',
      },
      newChapters: spec.newChapters ?? 0,
      lastReadAt: spec.read !== null ? ts : null,
      sourceStatus: media.sources.map((s) => ({
        sourceId: s.sourceId,
        suwayomiMangaId: s.suwayomiMangaId,
        title: media.title,
        thumbnailUrl: media.coverUrl,
        latestChapter: media.chapters,
        chapterCount: media.chapters,
        checkedAt: ts,
        auto: true,
        error: null,
      })),
      unit: isText && media.volumes ? 'volume' : 'chapter',
      ownedChapterCount: !isVideo ? spec.owned : undefined,
      ownedVolumes:
        !isVideo && spec.owned >= 8
          ? Array.from({ length: Math.floor(spec.owned / 8) }, (_, i) => i + 1)
          : [],
      chapterRead: !isVideo ? spec.read : null,
      volumeRead: isText ? spec.read : null,
      readerPosition:
        !isVideo && spec.status === 'READING' && spec.read
          ? {
              chapterId: baseIdx * 1000 + Math.min(spec.read + 1, 36),
              number: spec.read + 1,
              page: 1,
              pageCount: 3,
              unit: 'chapter',
              updatedAt: ts,
            }
          : null,
      coverChoice: 'auto',
      identity: 'catalog',
      coverFallbacks: [],
      kavitaCoverSync: true,
      kavitaCover: { state: !isVideo && spec.owned > 0 ? 'synced' : 'none', error: null },
      backdrop: 'auto',
      sourceMatch: media.type === 'MANGA' ? 'linked' : 'linked',
    };
  });
}

export function createInitialContinue(tracked: TrackedMedia[]): ContinueItem[] {
  const byId = new Map(tracked.map((t) => [t.media.id, t]));
  const pick = (
    mediaId: string,
    kind: 'read' | 'watch',
    label: string,
    href: string,
    position: number,
    hoursAgo: number,
  ): ContinueItem => {
    const entry = byId.get(mediaId)!;
    const m = entry.media;
    return {
      media: {
        id: m.id,
        title: m.title,
        coverUrl: m.coverUrl,
        bannerUrl: m.bannerUrl,
        type: m.type,
        format: m.format,
        origin: m.origin,
        adult: false,
        color: m.color,
      },
      kind,
      label,
      href,
      position,
      updatedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      trackedId: entry.id,
      progress: entry.progress,
    };
  };
  return [
    pick('anilist:900701', 'watch', 'S2 · Ep. 8', '/title/anilist/900701', 0.64, 1),
    pick('anilist:900101', 'read', 'ch:59', '/read/1059?media=anilist%3A900101', 0.66, 2),
    pick('anilist:900201', 'read', 'ch:137', '/read/7036?media=anilist%3A900201', 0.35, 3),
    pick('tmdb:tv-900801', 'watch', 'S2 · Ep. 6', '/title/tmdb/tv-900801', 0.48, 4),
    pick('anilist:900102', 'read', 'ch:113', '/read/2036?media=anilist%3A900102', 0.72, 5),
    pick('anilist:900202', 'read', 'ch:62', '/read/8036?media=anilist%3A900202', 0.4, 9),
    pick('anilist:900702', 'watch', 'ep:9', '/title/anilist/900702', 0.25, 12),
    pick('local:comic-900401', 'read', 'ch:21', '/read/13021?media=local%3Acomic-900401', 0.55, 14),
  ];
}

export function createInitialLists(): WorkList[] {
  const now = new Date().toISOString();
  const item = (trackedId: number, tier: string | null = null, note = '') => ({
    trackedId,
    tier,
    note,
    addedAt: now,
  });
  return [
    {
      id: 1,
      name: '',
      description: '',
      kind: null,
      section: null,
      ranked: true,
      layout: 'grid',
      system: 'favorites',
      tiers: [],
      items: [16, 1, 22, 6, 20, 2, 12, 14, 19, 10, 5, 21, 7, 3, 18].map((id) => item(id)),
      hidden: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 2,
      name: 'Essential Sci-Fi & Mystery',
      description: 'Slow-burn investigations, maritime telemetry, and orbital lighthouses.',
      kind: null,
      section: null,
      ranked: true,
      layout: 'list',
      system: null,
      tiers: [],
      items: [
        item(16, null, 'Breathtaking orbital shipyard worldbuilding.'),
        item(1, null, 'Crisp ink architecture and tide-clock puzzles.'),
        item(20, null, 'Claustrophobic Arctic station mystery.'),
        item(7, null, 'Late-night 1999 radio nostalgia.'),
        item(13, null, 'Quiet epistolary science fiction.'),
        item(19, null, 'Haunting deep-sea acoustic design.'),
      ],
      hidden: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 3,
      name: '2025–2026 Standouts',
      description: 'Drag works across tiers or customize rows directly in this demo.',
      kind: null,
      section: null,
      ranked: false,
      layout: 'tiers',
      system: null,
      tiers: [...DEFAULT_TIERS],
      items: [
        item(16, 'S'),
        item(1, 'S'),
        item(22, 'S'),
        item(6, 'A'),
        item(20, 'A'),
        item(2, 'A'),
        item(12, 'A'),
        item(10, 'B'),
        item(7, 'B'),
        item(17, 'B'),
        item(4, 'C'),
        item(9, 'C'),
        item(24, 'D'),
      ],
      hidden: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 4,
      name: 'Cozy Rainy Weekend Reads',
      description: 'Lantern alleys, alpine cinemas, and island apothecaries.',
      kind: null,
      section: null,
      ranked: false,
      layout: 'grid',
      system: null,
      tiers: [],
      items: [3, 5, 12, 18, 14, 8].map((id) => item(id)),
      hidden: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function createInitialRankings(): Ranking[] {
  return [
    {
      id: 1,
      name: null,
      kind: 'manga',
      mode: 'auto',
      size: null,
      order: [1, 2, 5, 3, 4],
      builtin: true,
    },
    {
      id: 2,
      name: 'All-Time Top 10',
      kind: null,
      mode: 'auto',
      size: 10,
      order: [16, 1, 22, 6, 20, 12, 2, 19, 14, 5],
      builtin: false,
    },
  ];
}

export function createInitialSettings(): PublicSettings {
  return {
    suwayomiUrl: 'https://suwayomi.demo.invalid',
    suwayomiUsername: 'demo',
    kavitaUrl: 'https://kavita.demo.invalid',
    kavitaAuthMode: 'api-key',
    sonarrUrl: 'https://sonarr.demo.invalid',
    prowlarrUrl: 'https://prowlarr.demo.invalid',
    radarrUrl: 'https://radarr.demo.invalid',
    sonarrQualityProfile: 1,
    sonarrRootFolder: '/media/series',
    sonarrAnimeRootFolder: '/media/anime',
    radarrQualityProfile: 1,
    radarrRootFolder: '/media/movies',
    qbittorrentUrl: '',
    qbittorrentUsername: '',
    jellyfinUrl: 'https://jellyfin.demo.invalid',
    jellyfinUser: 'demo',
    stashUrl: '',
    videoAddons: [],
    newsFeeds: [
      { url: 'https://news.harborpress.invalid/feed.xml', kind: 'manga' },
      { url: 'https://dispatch.studioastra.invalid/atom.xml', kind: 'anime' },
    ],
    videoAudio: 'original',
    videoAnyLanguage: false,
    jellyfinLibraries: { 'jf-anime': 'anime', 'jf-series': 'series', 'jf-movies': 'movies' },
    autoImportJellyfin: true,
    tradocUrl: '',
    kavitaLibraryPath: '/library/demo',
    libraryTargets: {
      MANGA: { libraryId: 1, folder: '/library/demo/Manga' },
      MANHWA: { libraryId: 1, folder: '/library/demo/Manhwa' },
      COMIC: { libraryId: 2, folder: '/library/demo/Comics' },
      LIGHT_NOVEL: { libraryId: 3, folder: '/library/demo/LightNovels' },
    },
    autoImportKavita: true,
    metronUsername: '',
    mediaRoot: '/library/demo',
    adultContent: false,
    adultMode: false,
    hideNsfwSources: true,
    universe: 'all',
    extensionSection: null,
    universes: KIND_IDS.filter((k) => k !== 'extension'),
    universesKnown: [...KIND_IDS],
    showAllUniverse: true,
    librarySort: 'rating',
    kindOrder: [...KIND_IDS],
    hiddenSections: [],
    sectionOrder: [],
    progressSource: 'kavita',
    favoriteSourceIds: ['demo-src-1'],
    extensionRepos: ['https://extensions.demo.invalid/index.min.json'],
    updateIntervalMinutes: 30,
    secretsConfigured: {
      suwayomiPassword: true,
      kavitaApiKey: true,
      sonarrApiKey: true,
      prowlarrApiKey: true,
      radarrApiKey: true,
      qbittorrentPassword: false,
      qbittorrentApiKey: false,
      tradocApiKey: false,
      jellyfinApiKey: true,
      stashApiKey: false,
      googleBooksApiKey: false,
      tmdbApiKey: true,
      metronApiToken: false,
      metronPassword: false,
      rakutenApplicationId: false,
      rakutenAccessKey: false,
      hardcoverToken: false,
    },
    catalogs: {
      canManage: false,
      configured: {
        tmdb: true,
        googlebooks: true,
        metron: true,
        rakuten: false,
        hardcover: true,
      },
    },
    extensionSections: [],
    videoServer: 'jellyfin',
  };
}

export const DEMO_SERVICES_STATUS: ServicesStatus = {
  suwayomi: { state: 'ok', version: '2.4.0-demo' },
  kavita: { state: 'ok', admin: true },
  jellyfin: { state: 'ok', version: '10.10.0-demo' },
  stash: { state: 'unconfigured', version: null },
  tradoc: { state: 'unconfigured', version: null },
  sonarr: { state: 'ok', version: '4.0-demo' },
  radarr: { state: 'ok', version: '5.14-demo' },
  prowlarr: { state: 'ok', version: '1.28-demo' },
  qbittorrent: { state: 'unconfigured', version: null },
};

export const DEMO_SOURCES: SourceInfo[] = [
  {
    id: 'demo-src-1',
    name: 'Harbor Press (Demo)',
    lang: 'en',
    iconUrl: '/logo.svg',
    enabled: true,
    priority: 0,
    health: { state: 'ok', latencyMs: 140, error: null, checkedAt: new Date().toISOString() },
    extensionId: 'demo.harbor.press',
  },
  {
    id: 'demo-src-2',
    name: 'Éditions Méridien (Demo)',
    lang: 'fr',
    iconUrl: '/logo.svg',
    enabled: true,
    priority: 1,
    health: { state: 'ok', latencyMs: 185, error: null, checkedAt: new Date().toISOString() },
    extensionId: 'demo.meridien',
  },
];

export const DEMO_EXTENSIONS: Extension[] = [
  {
    id: 'demo.harbor.press',
    name: 'Harbor Press (Demo)',
    lang: 'en',
    versionName: '1.4.0',
    isInstalled: true,
    hasUpdate: false,
    iconUrl: '/logo.svg',
  },
  {
    id: 'demo.meridien',
    name: 'Éditions Méridien (Demo)',
    lang: 'fr',
    versionName: '1.2.1',
    isInstalled: true,
    hasUpdate: false,
    iconUrl: '/logo.svg',
  },
];

export function createDemoNews(): NewsItem[] {
  const w = (id: string) => WORK_BY_ID.get(id)!;
  const now = Date.now();
  return [
    {
      id: 'news:upcoming-1',
      type: 'upcoming',
      kind: 'anime',
      media: w('anilist:900702'),
      title: 'Kestrel Academy of Winds — Courtyard Arc',
      headline: 'Episode 11 air date confirmed',
      summary: 'The glider team prepares for the autumn ridge crossing.',
      imageUrl: w('anilist:900702').coverUrl,
      date: new Date(now - 6 * 3_600_000).toISOString(),
      releaseDate: '2026-12-14',
      trailer: null,
      url: null,
      source: 'Studio Verdant (Demo)',
    },
    {
      id: 'news:upcoming-2',
      type: 'upcoming',
      kind: 'movies',
      media: w('tmdb:movie-900901'),
      title: 'Horizon Line Zero — Director’s Restoration',
      headline: '4K Blu-ray & cinema rerelease',
      summary: 'Expanded atmospheric score and archival production sketchbook.',
      imageUrl: w('tmdb:movie-900901').coverUrl,
      date: new Date(now - 14 * 3_600_000).toISOString(),
      releaseDate: '2027-02-05',
      trailer: null,
      url: null,
      source: 'Solaris Pictures (Demo)',
    },
    {
      id: 'news:upcoming-3',
      type: 'upcoming',
      kind: 'manga',
      media: w('anilist:900104'),
      title: 'Iron Botanist — Volume 5 Collector Edition',
      headline: 'Includes fold-out highland flora map',
      summary: 'New chapter arc entering the northern glass terraces.',
      imageUrl: w('anilist:900104').coverUrl,
      date: new Date(now - 24 * 3_600_000).toISOString(),
      releaseDate: '2027-01-20',
      trailer: null,
      url: null,
      source: 'Harbor Press (Demo)',
    },
    {
      id: 'news:announced-1',
      type: 'announced',
      kind: 'anime',
      media: w('anilist:900701'),
      title: 'Starlight Foundry — Season 3 Announced',
      headline: 'Production greenlit for 2027',
      summary: 'Studio Astra returns to the Saturn shipyard for the final relay arc.',
      imageUrl: w('anilist:900701').coverUrl,
      date: new Date(now - 18 * 3_600_000).toISOString(),
      releaseDate: '2027',
      trailer: null,
      url: null,
      source: 'Studio Astra (Demo)',
    },
    {
      id: 'news:announced-2',
      type: 'announced',
      kind: 'series',
      media: w('tmdb:tv-900801'),
      title: 'Northwatch Station — Winter Special',
      headline: 'Feature-length solstice episode',
      summary: 'Filmed on location during the polar night in Svalbard.',
      imageUrl: w('tmdb:tv-900801').coverUrl,
      date: new Date(now - 36 * 3_600_000).toISOString(),
      releaseDate: '2027-03',
      trailer: null,
      url: null,
      source: 'Nordic Television (Demo)',
    },
    {
      id: 'news:announced-3',
      type: 'announced',
      kind: 'animation',
      media: w('anilist:900951'),
      title: 'The Paper Whale of Harbor Nine — Artbook',
      headline: '240-page watercolor background archive',
      summary: 'Complete gouache layouts and character sheets from Atelier Kumo.',
      imageUrl: w('anilist:900951').coverUrl,
      date: new Date(now - 52 * 3_600_000).toISOString(),
      releaseDate: '2027-04',
      trailer: null,
      url: null,
      source: 'Atelier Kumo (Demo)',
    },
    {
      id: 'news:edition-1',
      type: 'edition',
      kind: 'manga',
      media: w('anilist:900101'),
      title: 'Glass Harbor',
      headline: 'Vol. 7 · Print & Digital',
      summary: null,
      imageUrl: w('anilist:900101').coverUrl,
      date: new Date(now - 2 * 86_400_000).toISOString(),
      releaseDate: '2026-11-21',
      trailer: null,
      url: null,
      source: 'Harbor Press (Demo)',
    },
    {
      id: 'news:edition-2',
      type: 'edition',
      kind: 'comic',
      media: w('local:comic-900401'),
      title: 'Red Canyon Express',
      headline: 'Album 4 · Hardcover',
      summary: null,
      imageUrl: w('local:comic-900401').coverUrl,
      date: new Date(now - 4 * 86_400_000).toISOString(),
      releaseDate: '2026-11-19',
      trailer: null,
      url: null,
      source: 'Éditions Méridien (Demo)',
    },
    {
      id: 'news:edition-3',
      type: 'edition',
      kind: 'lightnovel',
      media: w('anilist:900501'),
      title: 'The Quiet Archivist of Oakhaven',
      headline: 'Vol. 9 · Illustrated Edition',
      summary: null,
      imageUrl: w('anilist:900501').coverUrl,
      date: new Date(now - 5 * 86_400_000).toISOString(),
      releaseDate: '2026-11-18',
      trailer: null,
      url: null,
      source: 'Oakhaven Books (Demo)',
    },
    {
      id: 'news:article-1',
      type: 'article',
      kind: 'manga',
      media: w('anilist:900101'),
      title: 'Inside the Architectural Ink Work of Glass Harbor',
      headline: null,
      summary:
        'How Kenji Morita drafts flooded breakwaters and submerged tramways using traditional dip pens and blue perspective grids.',
      imageUrl: '/demo/covers/glass-harbor-banner.svg',
      date: new Date(now - 8 * 3_600_000).toISOString(),
      releaseDate: null,
      trailer: null,
      url: null,
      source: 'Harbor Press Dispatch (Demo)',
    },
    {
      id: 'news:article-2',
      type: 'article',
      kind: 'anime',
      media: w('anilist:900701'),
      title: 'Sound Design in Vacuum: Recording the Hulls of Starlight Foundry',
      headline: null,
      summary:
        'Studio Astra’s foley team discusses contact microphones, steel cables, and quiet dialogue mixing for Season 2.',
      imageUrl: '/demo/covers/starlight-foundry-banner.svg',
      date: new Date(now - 28 * 3_600_000).toISOString(),
      releaseDate: null,
      trailer: null,
      url: null,
      source: 'Astra Journal (Demo)',
    },
  ];
}

export function createDemoBatches(tracked: TrackedMedia[]): DownloadBatch[] {
  const work = WORK_BY_ID.get('anilist:900101')!;
  const now = new Date(Date.now() - 45 * 60_000).toISOString();
  return [
    {
      id: 'demo-batch-1',
      media: { ...work, trackedId: tracked[0]?.id ?? 1 },
      chapterIds: [1061, 1062],
      importedIds: [1061, 1062],
      state: 'completed',
      error: null,
      createdAt: now,
      updatedAt: now,
      chapters: [
        {
          id: 1061,
          number: 61,
          name: 'Chapter 61',
          sourceName: 'Harbor Press (Demo)',
          state: 'done',
          progress: 1,
          error: null,
        },
        {
          id: 1062,
          number: 62,
          name: 'Chapter 62',
          sourceName: 'Harbor Press (Demo)',
          state: 'done',
          progress: 1,
          error: null,
        },
      ],
      scan: { state: 'done', error: null, at: now },
    },
  ];
}

export function createDemoUpdates(tracked: TrackedMedia[]): UpdateEntry[] {
  return tracked
    .filter((t) => t.newChapters > 0)
    .slice(0, 6)
    .map((t, i) => ({
      id: i + 1,
      trackedId: t.id,
      title: t.title,
      coverUrl: t.coverUrl,
      color: t.media.color,
      chapters: Array.from(
        { length: t.newChapters },
        (_, idx) => (t.progress.released ?? 20) - t.newChapters + idx + 1,
      ),
      sourceName: t.sources[0]?.sourceName ?? 'Harbor Press (Demo)',
      detectedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      state: 'pending',
    }));
}

export function createDemoReleases(trackedMap: Map<string, TrackedMedia>): ChapterRelease[] {
  const now = Date.now();
  const rel = (
    workId: string,
    num: number,
    hoursAgo: number,
    unit: ChapterRelease['unit'] = 'chapter',
    season?: number,
  ): ChapterRelease => {
    const work = WORK_BY_ID.get(workId)!;
    const tr = trackedMap.get(workId);
    const label =
      unit === 'episode'
        ? season
          ? `S${season} · Ep. ${num}`
          : `Ep. ${num}`
        : unit === 'volume'
          ? `Vol. ${num}`
          : unit === 'film'
            ? 'Film'
            : `Ch. ${num}`;
    return {
      id: `demo-rel:${workId}:${num}`,
      media: {
        ...work,
        trackedId: tr?.id ?? null,
        mine: tr
          ? {
              status: tr.status,
              owned: tr.progress.owned > 0,
              seen: tr.status === 'COMPLETED' ? 'done' : tr.progress.read ? 'partial' : null,
              progress:
                tr.progress.released && tr.progress.read
                  ? Math.min(1, tr.progress.read / tr.progress.released)
                  : null,
              rating: tr.rating ?? null,
            }
          : null,
      },
      chapter: unit === 'film' ? null : num,
      volume: unit === 'volume' ? num : null,
      label,
      group: work.type === 'MANGA' ? 'Harbor Press (Demo)' : null,
      releasedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      hasTime: true,
      provider: work.id.startsWith('tmdb:') ? 'tmdb' : work.type === 'ANIME' ? 'anilist' : 'source',
      unit,
      season: season ?? null,
      trackedId: tr?.id ?? null,
    };
  };

  return [
    rel('anilist:900101', 64, 2, 'chapter'),
    rel('anilist:900701', 10, 4, 'episode', 2),
    rel('anilist:900201', 142, 6, 'chapter'),
    rel('tmdb:tv-900801', 8, 9, 'episode', 2),
    rel('anilist:900102', 118, 12, 'chapter'),
    rel('anilist:900702', 10, 15, 'episode', 1),
    rel('anilist:900202', 68, 19, 'chapter'),
    rel('local:comic-900401', 24, 24, 'chapter'),
    rel('anilist:900104', 34, 28, 'chapter'),
    rel('anilist:900301', 110, 32, 'chapter'),
    rel('anilist:900106', 41, 38, 'chapter'),
    rel('anilist:900204', 29, 44, 'chapter'),
    rel('anilist:900501', 9, 50, 'volume'),
    rel('local:wn-900551', 164, 54, 'chapter'),
    rel('anilist:900302', 54, 60, 'chapter'),
    rel('local:comic-900403', 12, 66, 'chapter'),
    rel('tmdb:movie-900901', 1, 72, 'film'),
    rel('anilist:900951', 1, 80, 'film'),
    rel('anilist:900703', 12, 90, 'episode', 1),
    rel('anilist:900704', 24, 102, 'episode', 2),
    rel('tmdb:tv-900802', 8, 110, 'episode', 1),
    rel('anilist:900103', 86, 120, 'chapter'),
    rel('anilist:900105', 72, 130, 'chapter'),
    rel('anilist:900203', 95, 140, 'chapter'),
  ];
}

export const DEMO_GENRES = [
  'Action',
  'Adventure',
  'Architecture',
  'Comedy',
  'Drama',
  'Fantasy',
  'History',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Supernatural',
  'Thriller',
];

export const DEMO_TAG_GROUPS = [
  { category: 'demographic', names: ['Seinen', 'Shounen'] },
  { category: 'setting', names: ['Maritime', 'Space', 'Arctic', 'Railways', 'Libraries'] },
  { category: 'other', names: ['Atmospheric', 'Cartography', 'Ensemble Cast', 'Full Color', 'Craftsmanship'] },
];

export const ALL_DEMO_KINDS: readonly Kind[] = KIND_IDS;
