// Keyword-to-tag mapper — derives mood_tags and theme_tags from TMDb keywords.
//
// Tag mappings are loaded from the tag_mappings Supabase table at runtime.
// To improve tagging: edit rows in Supabase directly — no code change needed.
// To add a new tag type: add a check constraint to tag_mappings.tag_type in a migration.
//
// Seed data (SEED_TAG_MAPPINGS) is inserted on first script run if the table is empty.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TagMapping } from '@/lib/types/sync'

// ─── Seed Data — 230 mappings across 23 mood tags and 30 theme tags ───────────
// Format: [keyword (lowercase), tag_value]
// Added to the tag_mappings table on first run of seed-content.ts.
//
// To expand: add rows directly to the tag_mappings table in Supabase,
// or add entries here and re-run the script.

const MOOD_SEED: [string, string][] = [
  // dark-comedy
  ['dark humor', 'dark-comedy'],
  ['black comedy', 'dark-comedy'],
  ['deadpan comedy', 'dark-comedy'],
  ['gallows humor', 'dark-comedy'],
  ['dark satire', 'dark-comedy'],
  ['tragicomedy', 'dark-comedy'],
  ['sardonic humor', 'dark-comedy'],
  ['mordant humor', 'dark-comedy'],
  ['darkly comic', 'dark-comedy'],
  ['absurd humor', 'dark-comedy'],

  // slow-burn
  ['slow burn', 'slow-burn'],
  ['slow-paced', 'slow-burn'],
  ['deliberate pacing', 'slow-burn'],
  ['patient storytelling', 'slow-burn'],
  ['gradual tension', 'slow-burn'],
  ['measured pace', 'slow-burn'],

  // feel-good
  ['feel good', 'feel-good'],
  ['feel-good', 'feel-good'],
  ['uplifting', 'feel-good'],
  ['heartwarming', 'feel-good'],
  ['life-affirming', 'feel-good'],
  ['inspiring', 'feel-good'],
  ['triumphant', 'feel-good'],
  ['redemptive', 'feel-good'],
  ['joyful', 'feel-good'],
  ['optimistic', 'feel-good'],
  ['warm-hearted', 'feel-good'],
  ['hopeful', 'feel-good'],

  // tense
  ['tense', 'tense'],
  ['suspenseful', 'tense'],
  ['edge of your seat', 'tense'],
  ['nail-biting', 'tense'],
  ['nail biting', 'tense'],
  ['claustrophobic', 'tense'],
  ['dread', 'tense'],
  ['anxiety-inducing', 'tense'],
  ['paranoia', 'tense'],
  ['white-knuckle', 'tense'],
  ['heart-pounding', 'tense'],
  ['nerve-wracking', 'tense'],

  // atmospheric
  ['atmospheric', 'atmospheric'],
  ['moody', 'atmospheric'],
  ['brooding', 'atmospheric'],
  ['immersive', 'atmospheric'],
  ['evocative', 'atmospheric'],
  ['dreamlike', 'atmospheric'],
  ['ethereal', 'atmospheric'],
  ['haunting', 'atmospheric'],
  ['lyrical', 'atmospheric'],
  ['visually rich', 'atmospheric'],
  ['meditative atmosphere', 'atmospheric'],

  // thought-provoking
  ['thought-provoking', 'thought-provoking'],
  ['cerebral', 'thought-provoking'],
  ['philosophical', 'thought-provoking'],
  ['intellectual', 'thought-provoking'],
  ['contemplative', 'thought-provoking'],
  ['introspective', 'thought-provoking'],
  ['meditative', 'thought-provoking'],
  ['challenging', 'thought-provoking'],
  ['morally complex', 'thought-provoking'],
  ['nuanced', 'thought-provoking'],
  ['layered', 'thought-provoking'],

  // light-hearted
  ['light-hearted', 'light-hearted'],
  ['lighthearted', 'light-hearted'],
  ['breezy', 'light-hearted'],
  ['carefree', 'light-hearted'],
  ['easygoing', 'light-hearted'],
  ['wholesome', 'light-hearted'],
  ['gentle humor', 'light-hearted'],
  ['fun', 'light-hearted'],
  ['undemanding', 'light-hearted'],
  ['enjoyable', 'light-hearted'],

  // emotional
  ['emotional', 'emotional'],
  ['tearjerker', 'emotional'],
  ['moving', 'emotional'],
  ['heartbreaking', 'emotional'],
  ['poignant', 'emotional'],
  ['bittersweet', 'emotional'],
  ['devastating', 'emotional'],
  ['heart-wrenching', 'emotional'],
  ['gut-wrenching', 'emotional'],
  ['cathartic', 'emotional'],
  ['affecting', 'emotional'],
  ['deeply moving', 'emotional'],

  // mind-bending
  ['mind-bending', 'mind-bending'],
  ['mind-blowing', 'mind-bending'],
  ['twist ending', 'mind-bending'],
  ['unreliable narrator', 'mind-bending'],
  ['non-linear narrative', 'mind-bending'],
  ['multiple timelines', 'mind-bending'],
  ['reality-bending', 'mind-bending'],
  ['surreal', 'mind-bending'],
  ['kafkaesque', 'mind-bending'],
  ['psychological complexity', 'mind-bending'],

  // disturbing
  ['disturbing', 'disturbing'],
  ['unsettling', 'disturbing'],
  ['bleak', 'disturbing'],
  ['harrowing', 'disturbing'],
  ['nihilistic', 'disturbing'],
  ['brutal', 'disturbing'],
  ['confrontational', 'disturbing'],
  ['transgressive', 'disturbing'],
  ['traumatic', 'disturbing'],
  ['dark themes', 'disturbing'],
  ['unsettling atmosphere', 'disturbing'],

  // action-packed
  ['action-packed', 'action-packed'],
  ['fast-paced', 'action-packed'],
  ['high-octane', 'action-packed'],
  ['adrenaline', 'action-packed'],
  ['kinetic', 'action-packed'],
  ['relentless', 'action-packed'],
  ['explosive', 'action-packed'],

  // funny
  ['funny', 'funny'],
  ['hilarious', 'funny'],
  ['laugh out loud', 'funny'],
  ['comical', 'funny'],
  ['farcical', 'funny'],
  ['slapstick', 'funny'],
  ['silly', 'funny'],
  ['comedy', 'funny'],

  // witty
  ['witty', 'witty'],
  ['clever humor', 'witty'],
  ['dry humor', 'witty'],
  ['verbal sparring', 'witty'],
  ['sharp dialogue', 'witty'],
  ['banter', 'witty'],
  ['wordplay', 'witty'],
  ['sharp wit', 'witty'],
  ['clever writing', 'witty'],

  // cozy
  ['cozy', 'cozy'],
  ['comforting', 'cozy'],
  ['warm atmosphere', 'cozy'],
  ['gentle', 'cozy'],
  ['soothing', 'cozy'],
  ['cozy mystery', 'cozy'],
  ['low-stakes', 'cozy'],
  ['peaceful', 'cozy'],

  // intense
  ['intense', 'intense'],
  ['gripping', 'intense'],
  ['riveting', 'intense'],
  ['absorbing', 'intense'],
  ['compelling', 'intense'],
  ['propulsive', 'intense'],
  ['urgent', 'intense'],
  ['breathless', 'intense'],

  // romantic
  ['romantic', 'romantic'],
  ['sweeping romance', 'romantic'],
  ['passionate', 'romantic'],
  ['love story', 'romantic'],
  ['chemistry', 'romantic'],
  ['star-crossed lovers', 'romantic'],
  ['romance', 'romantic'],
  ['tender', 'romantic'],

  // whimsical
  ['whimsical', 'whimsical'],
  ['fantastical', 'whimsical'],
  ['imaginative', 'whimsical'],
  ['playful', 'whimsical'],
  ['magical', 'whimsical'],
  ['enchanting', 'whimsical'],
  ['fanciful', 'whimsical'],
  ['fairy tale feel', 'whimsical'],
  ['magical realism', 'whimsical'],

  // nostalgic
  ['nostalgia', 'nostalgic'],
  ['nostalgic', 'nostalgic'],
  ['retro', 'nostalgic'],
  ['throwback', 'nostalgic'],
  ['period nostalgia', 'nostalgic'],
  ['retro aesthetic', 'nostalgic'],
  ['memory', 'nostalgic'],

  // satirical
  ['satire', 'satirical'],
  ['satirical', 'satirical'],
  ['parody', 'satirical'],
  ['social satire', 'satirical'],
  ['political satire', 'satirical'],
  ['mockumentary', 'satirical'],
  ['lampoon', 'satirical'],
  ['spoof', 'satirical'],
  ['tongue-in-cheek', 'satirical'],
  ['self-aware', 'satirical'],

  // gritty
  ['gritty', 'gritty'],
  ['raw', 'gritty'],
  ['unflinching', 'gritty'],
  ['naturalistic', 'gritty'],
  ['hard-boiled', 'gritty'],
  ['street-level', 'gritty'],
  ['grim realism', 'gritty'],
  ['unfiltered', 'gritty'],
  ['realistic', 'gritty'],

  // quirky
  ['quirky', 'quirky'],
  ['offbeat', 'quirky'],
  ['eccentric', 'quirky'],
  ['unusual', 'quirky'],
  ['oddball', 'quirky'],
  ['idiosyncratic', 'quirky'],
  ['unconventional', 'quirky'],
  ['indie sensibility', 'quirky'],

  // epic
  ['epic', 'epic'],
  ['sweeping', 'epic'],
  ['grand scale', 'epic'],
  ['monumental', 'epic'],
  ['sprawling', 'epic'],
  ['operatic', 'epic'],
  ['large-scale', 'epic'],
  ['grand narrative', 'epic'],
  ['ambitious', 'epic'],

  // melancholy
  ['melancholy', 'melancholy'],
  ['wistful', 'melancholy'],
  ['pensive', 'melancholy'],
  ['sorrowful', 'melancholy'],
  ['elegiac', 'melancholy'],
  ['mournful', 'melancholy'],
  ['subdued', 'melancholy'],
  ['quietly sad', 'melancholy'],
]

const THEME_SEED: [string, string][] = [
  // heist
  ['heist', 'heist'],
  ['bank robbery', 'heist'],
  ['caper', 'heist'],
  ['con artist', 'heist'],
  ['con game', 'heist'],
  ['jewel theft', 'heist'],

  // workplace
  ['workplace', 'workplace'],
  ['office setting', 'workplace'],
  ['work environment', 'workplace'],
  ['corporate world', 'workplace'],
  ['blue-collar', 'workplace'],
  ['professional life', 'workplace'],

  // family
  ['family', 'family'],
  ['family relationships', 'family'],
  ['dysfunctional family', 'family'],
  ['family drama', 'family'],
  ['generational conflict', 'family'],
  ['sibling rivalry', 'family'],
  ['family secrets', 'family'],

  // revenge
  ['revenge', 'revenge'],
  ['vengeance', 'revenge'],
  ['retribution', 'revenge'],
  ['payback', 'revenge'],
  ['settling scores', 'revenge'],

  // coming-of-age
  ['coming of age', 'coming-of-age'],
  ['adolescence', 'coming-of-age'],
  ['teen drama', 'coming-of-age'],
  ['growing up', 'coming-of-age'],
  ['self-discovery', 'coming-of-age'],
  ['youth', 'coming-of-age'],
  ['young adult', 'coming-of-age'],
  ['bildungsroman', 'coming-of-age'],

  // political
  ['political', 'political'],
  ['politics', 'political'],
  ['government', 'political'],
  ['election', 'political'],
  ['power struggle', 'political'],
  ['political intrigue', 'political'],
  ['diplomacy', 'political'],
  ['political corruption', 'political'],

  // survival
  ['survival', 'survival'],
  ['post-apocalyptic', 'survival'],
  ['dystopia', 'survival'],
  ['wilderness survival', 'survival'],
  ['catastrophe', 'survival'],
  ['end of the world', 'survival'],
  ['disaster', 'survival'],

  // true-story
  ['based on true story', 'true-story'],
  ['true events', 'true-story'],
  ['biographical', 'true-story'],
  ['real events', 'true-story'],
  ['inspired by true story', 'true-story'],
  ['true crime', 'true-story'],

  // crime
  ['crime', 'crime'],
  ['murder', 'crime'],
  ['detective', 'crime'],
  ['criminal investigation', 'crime'],
  ['criminal underworld', 'crime'],
  ['organized crime', 'crime'],
  ['mob', 'crime'],
  ['gang', 'crime'],

  // supernatural
  ['supernatural', 'supernatural'],
  ['paranormal', 'supernatural'],
  ['ghosts', 'supernatural'],
  ['demons', 'supernatural'],
  ['vampires', 'supernatural'],
  ['haunted', 'supernatural'],
  ['occult', 'supernatural'],
  ['witchcraft', 'supernatural'],

  // medical
  ['medical', 'medical'],
  ['hospital', 'medical'],
  ['doctor', 'medical'],
  ['surgery', 'medical'],
  ['healthcare', 'medical'],
  ['disease', 'medical'],
  ['emergency room', 'medical'],

  // historical
  ['historical', 'historical'],
  ['period drama', 'historical'],
  ['costume drama', 'historical'],
  ['ancient history', 'historical'],
  ['medieval', 'historical'],
  ['renaissance', 'historical'],
  ['historical epic', 'historical'],

  // friendship
  ['friendship', 'friendship'],
  ['bromance', 'friendship'],
  ['female friendship', 'friendship'],
  ['unlikely friendship', 'friendship'],
  ['best friends', 'friendship'],
  ['buddy story', 'friendship'],

  // mystery
  ['mystery', 'mystery'],
  ['whodunnit', 'mystery'],
  ['puzzle', 'mystery'],
  ['detective mystery', 'mystery'],
  ['unsolved mystery', 'mystery'],
  ['cold case', 'mystery'],
  ['enigma', 'mystery'],

  // road-trip
  ['road trip', 'road-trip'],
  ['road movie', 'road-trip'],
  ['journey', 'road-trip'],
  ['cross-country', 'road-trip'],
  ['odyssey', 'road-trip'],

  // sports
  ['sports', 'sports'],
  ['competition', 'sports'],
  ['underdog', 'sports'],
  ['football', 'sports'],
  ['basketball', 'sports'],
  ['soccer', 'sports'],
  ['baseball', 'sports'],
  ['athletics', 'sports'],

  // war
  ['war', 'war'],
  ['military', 'war'],
  ['combat', 'war'],
  ['world war', 'war'],
  ['soldier', 'war'],
  ['battlefield', 'war'],
  ['veterans', 'war'],

  // tech
  ['technology', 'tech'],
  ['artificial intelligence', 'tech'],
  ['hacking', 'tech'],
  ['cybersecurity', 'tech'],
  ['tech industry', 'tech'],
  ['silicon valley', 'tech'],
  ['robots', 'tech'],
  ['startup', 'tech'],

  // immigration
  ['immigration', 'immigration'],
  ['culture clash', 'immigration'],
  ['immigrant experience', 'immigration'],
  ['diaspora', 'immigration'],
  ['exile', 'immigration'],
  ['displacement', 'immigration'],

  // social-commentary
  ['class', 'social-commentary'],
  ['wealth inequality', 'social-commentary'],
  ['social commentary', 'social-commentary'],
  ['class struggle', 'social-commentary'],
  ['privilege', 'social-commentary'],
  ['systemic racism', 'social-commentary'],
  ['societal critique', 'social-commentary'],

  // space
  ['space', 'space'],
  ['space exploration', 'space'],
  ['astronaut', 'space'],
  ['galaxy', 'space'],
  ['outer space', 'space'],
  ['interstellar', 'space'],

  // time-travel
  ['time travel', 'time-travel'],
  ['time loop', 'time-travel'],
  ['alternate timeline', 'time-travel'],
  ['parallel universe', 'time-travel'],
  ['temporal paradox', 'time-travel'],

  // spy
  ['spy', 'spy'],
  ['espionage', 'spy'],
  ['secret agent', 'spy'],
  ['intelligence agency', 'spy'],
  ['undercover', 'spy'],
  ['covert operations', 'spy'],
  ['double agent', 'spy'],

  // food
  ['food', 'food'],
  ['cooking', 'food'],
  ['chef', 'food'],
  ['restaurant', 'food'],
  ['baking', 'food'],
  ['culinary arts', 'food'],
  ['gastronomy', 'food'],

  // music
  ['music', 'music'],
  ['musician', 'music'],
  ['rock and roll', 'music'],
  ['band', 'music'],
  ['singer', 'music'],
  ['concert', 'music'],
  ['hip-hop', 'music'],
  ['music industry', 'music'],

  // prison
  ['prison', 'prison'],
  ['incarceration', 'prison'],
  ['prison escape', 'prison'],
  ['jail', 'prison'],
  ['inmates', 'prison'],
  ['correctional facility', 'prison'],

  // addiction
  ['addiction', 'addiction'],
  ['substance abuse', 'addiction'],
  ['alcoholism', 'addiction'],
  ['drug addiction', 'addiction'],
  ['recovery', 'addiction'],
  ['sobriety', 'addiction'],

  // grief
  ['grief', 'grief'],
  ['loss', 'grief'],
  ['mourning', 'grief'],
  ['death of a loved one', 'grief'],
  ['bereavement', 'grief'],
  ['coping with death', 'grief'],

  // legal
  ['legal drama', 'legal'],
  ['courtroom', 'legal'],
  ['lawyer', 'legal'],
  ['trial', 'legal'],
  ['justice system', 'legal'],
  ['law firm', 'legal'],
  ['prosecutor', 'legal'],

  // parenting
  ['parenting', 'parenting'],
  ['parenthood', 'parenting'],
  ['motherhood', 'parenting'],
  ['fatherhood', 'parenting'],
  ['single parent', 'parenting'],
  ['raising children', 'parenting'],
]

/**
 * All seed mappings in the format expected by the tag_mappings table.
 * Inserted on first run if the table is empty.
 */
export const SEED_TAG_MAPPINGS: TagMapping[] = [
  ...MOOD_SEED.map(([keyword, tag_value]) => ({ keyword, tag_type: 'mood' as const, tag_value })),
  ...THEME_SEED.map(([keyword, tag_value]) => ({ keyword, tag_type: 'theme' as const, tag_value })),
]

// ─── Runtime Functions ────────────────────────────────────────────────────────

/**
 * Loads all tag mappings from the database.
 * Call once at pipeline start and pass the result to applyTagMappings().
 */
export async function loadTagMappings(supabase: SupabaseClient): Promise<TagMapping[]> {
  const { data, error } = await supabase
    .from('tag_mappings')
    .select('keyword, tag_type, tag_value')

  if (error) throw new Error(`Failed to load tag_mappings: ${error.message}`)
  return data as TagMapping[]
}

// Genre-level fallbacks applied when no keyword mapping produces a tag.
// These ensure titles with sparse keywords still get basic classification.
const GENRE_MOOD_FALLBACKS: Record<string, string> = {
  Comedy: 'funny',
  Horror: 'tense',
  Thriller: 'tense',
  Romance: 'romantic',
}

const GENRE_THEME_FALLBACKS: Record<string, string> = {
  Animation: 'animation',
  Documentary: 'documentary',
  Family: 'family',
  Music: 'music',
  History: 'historical',
  War: 'war',
  Crime: 'crime',
  Mystery: 'mystery',
}

type DerivedTags = {
  moodTags: string[]
  themeTags: string[]
  unmappedKeywords: string[]
}

/**
 * Applies loaded tag mappings to a title's TMDb keywords and genres.
 * Pure function — no I/O. Safe to call in a tight loop.
 *
 * @param keywords - TMDb keyword strings (already lowercased and trimmed)
 * @param genres   - TMDb genre name strings (e.g. "Comedy", "Drama")
 * @param mappings - Full tag_mappings table rows (loaded once per pipeline run)
 */
export function applyTagMappings(
  keywords: string[],
  genres: string[],
  mappings: TagMapping[]
): DerivedTags {
  // Build O(1) lookup: "keyword|type" → tag_value
  const lookup = new Map<string, string>()
  for (const m of mappings) {
    lookup.set(`${m.keyword.toLowerCase().trim()}|${m.tag_type}`, m.tag_value)
  }

  const moodSet = new Set<string>()
  const themeSet = new Set<string>()
  const unmappedKeywords: string[] = []

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase().trim()
    const mood = lookup.get(`${kwLower}|mood`)
    const theme = lookup.get(`${kwLower}|theme`)

    if (mood) {
      moodSet.add(mood)
    } else if (theme) {
      themeSet.add(theme)
    } else {
      unmappedKeywords.push(kwLower)
    }
  }

  // Genre fallbacks — only applied when a genre produces no tag from keywords
  for (const genre of genres) {
    const moodFallback = GENRE_MOOD_FALLBACKS[genre]
    if (moodFallback && moodSet.size === 0) moodSet.add(moodFallback)

    const themeFallback = GENRE_THEME_FALLBACKS[genre]
    if (themeFallback) themeSet.add(themeFallback)
  }

  return {
    moodTags: [...moodSet],
    themeTags: [...themeSet],
    unmappedKeywords,
  }
}
