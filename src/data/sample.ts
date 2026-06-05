/**
 * Sample data ported from the design prototype (gt-data.jsx). Used to populate screens whose
 * real backend is a later milestone:
 *   - Books / Feeds (Library)  → M3 (epub upload) / M7 (RSS)
 *   - Review queue + intervals → M4 (FSRS)
 *   - Decks sample + cards table → M4
 * Analytics samples were removed once M5 wired the dashboard to real review_logs.
 * Replace each remaining one with real queries as those milestones land.
 */

export interface SampleEntry {
  term: string;
  reading: string;
  pos: string;
  common: boolean;
  jlpt: string;
  senses: [string, string][];
  note?: string;
}

export interface SampleBook {
  id: string;
  title: string;
  author: string;
  romaji: string;
  type: string;
  pct: number;
  chapter: string;
  tone: string;
  current?: boolean;
}

export interface SampleFeed {
  id: string;
  title: string;
  level: string;
  unread: number;
  latest: string;
  time: string;
}

export interface SampleDeck {
  id: string;
  name: string;
  count: number;
  due: number;
  new: number;
  color: string;
}

export interface SampleCard {
  term: string;
  reading: string;
  gloss: string;
  deck: string;
  state: 'new' | 'learning' | 'young' | 'mature';
  due: string;
  jlpt: string;
}

const E: Record<string, SampleEntry> = {
  kentou: { term: '見当', reading: 'けんとう', pos: 'n', common: true, jlpt: 'N1', senses: [['n.', 'estimate; guess; approximation'], ['n.', 'direction; aim']] },
  kioku: { term: '記憶', reading: 'きおく', pos: 'n, vs', common: true, jlpt: 'N3', senses: [['n, vs.', 'memory; recollection; remembrance']] },
  usugurai: { term: '薄暗い', reading: 'うすぐらい', pos: 'adj-i', common: false, jlpt: 'N1', senses: [['adj.', 'dim; gloomy; somewhat dark']] },
  umareru: { term: '生まれる', reading: 'うまれる', pos: 'v1', common: true, jlpt: 'N4', senses: [['v1, vi.', 'to be born'], ['v1, vi.', 'to come into existence']], note: 'conjugated: 生まれた (past)' },
  tokoro: { term: '所', reading: 'ところ', pos: 'n', common: true, jlpt: 'N4', senses: [['n.', 'place; spot; scene'], ['n.', 'point; aspect']] },
  namae: { term: '名前', reading: 'なまえ', pos: 'n', common: true, jlpt: 'N5', senses: [['n.', 'name; full name'], ['n.', 'reputation; renown']] },
};

export const SAMPLE_BOOKS: SampleBook[] = [
  { id: 'neko', title: '吾輩は猫である', author: '夏目漱石', romaji: 'Natsume Sōseki', type: 'EPUB', pct: 47, chapter: '第一章', tone: '#b8492f', current: true },
  { id: 'rashomon', title: '羅生門', author: '芥川龍之介', romaji: 'Akutagawa Ryūnosuke', type: 'EPUB', pct: 12, chapter: '序', tone: '#5b6b58' },
  { id: 'kokoro', title: 'こころ', author: '夏目漱石', romaji: 'Natsume Sōseki', type: 'EPUB', pct: 0, chapter: '未読', tone: '#3d5a6b' },
  { id: 'ginga', title: '銀河鉄道の夜', author: '宮沢賢治', romaji: 'Miyazawa Kenji', type: 'EPUB', pct: 88, chapter: '第九章', tone: '#6b5b3d' },
];

export const SAMPLE_FEEDS: SampleFeed[] = [
  { id: 'nhk', title: 'NHK NEWS WEB やさしい', level: 'N4–N3', unread: 6, latest: '円相場、1ドル150円台に　約2か月ぶりの水準', time: '2時間前' },
  { id: 'asahi', title: '朝日新聞デジタル', level: 'N2–N1', unread: 21, latest: '桜前線、例年より早く北上の見込み', time: '4時間前' },
  { id: 'note', title: 'note・エッセイ', level: 'N3–N2', unread: 3, latest: '小さな本屋を続けるということ', time: '昨日' },
];

export const SAMPLE_DECKS: SampleDeck[] = [
  { id: 'mining', name: 'Reading · Mined', count: 412, due: 12, new: 5, color: 'var(--rust)' },
  { id: 'core', name: 'Core 2k/6k', count: 2000, due: 34, new: 10, color: 'var(--azure)' },
  { id: 'kanji', name: 'Kanji · KanjiDamage', count: 880, due: 7, new: 0, color: 'var(--sage)' },
];

const mkCard = (term: string, reading: string, gloss: string, deck: string, state: SampleCard['state'], due: string, jlpt: string): SampleCard => ({ term, reading, gloss, deck, state, due, jlpt });
export const SAMPLE_CARDS: SampleCard[] = [
  mkCard('見当', 'けんとう', 'estimate; guess', 'Reading · Mined', 'new', 'new', 'N1'),
  mkCard('記憶', 'きおく', 'memory; recollection', 'Reading · Mined', 'learning', '10m', 'N3'),
  mkCard('薄暗い', 'うすぐらい', 'dim; gloomy', 'Reading · Mined', 'new', 'new', 'N1'),
  mkCard('名前', 'なまえ', 'name', 'Core 2k/6k', 'mature', '4mo', 'N5'),
  mkCard('生まれる', 'うまれる', 'to be born', 'Core 2k/6k', 'young', '9d', 'N4'),
  mkCard('所', 'ところ', 'place; spot', 'Core 2k/6k', 'mature', '8mo', 'N4'),
  mkCard('泣く', 'なく', 'to cry; weep', 'Core 2k/6k', 'young', '12d', 'N4'),
  mkCard('人間', 'にんげん', 'human being', 'Core 2k/6k', 'mature', '1y', 'N4'),
  mkCard('猫', 'ねこ', 'cat', 'Core 2k/6k', 'mature', '2y', 'N5'),
  mkCard('獰悪', 'どうあく', 'ferocity; brutality', 'Reading · Mined', 'new', 'new', 'N1'),
  mkCard('書生', 'しょせい', 'student (hist.)', 'Reading · Mined', 'learning', '1d', 'N1'),
  mkCard('掌', 'てのひら', 'palm of the hand', 'Kanji · KanjiDamage', 'young', '6d', 'N2'),
];

export const SAMPLE_QUEUE: SampleEntry[] = [E.kentou, E.kioku, E.usugurai, E.umareru, E.tokoro];

export const SAMPLE_INTERVALS = [
  { again: '<10m', hard: '2d', good: '5d', easy: '11d' },
  { again: '<10m', hard: '1d', good: '4d', easy: '9d' },
  { again: '<10m', hard: '3d', good: '8d', easy: '16d' },
  { again: '<10m', hard: '2d', good: '6d', easy: '13d' },
  { again: '<10m', hard: '1d', good: '4d', easy: '10d' },
];

// Analytics samples (SAMPLE_STATS / SAMPLE_FORECAST / SAMPLE_HEATMAP / SAMPLE_TOD) were removed in
// M5 — the dashboard now computes those from real review_logs (see src/analytics/).
