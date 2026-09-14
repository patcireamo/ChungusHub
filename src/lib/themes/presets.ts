/**
 * Theme data: the single source of truth for every color the app renders.
 *
 * The theme store (src/lib/stores/theme.svelte.ts) resolves one palette + one
 * accent + the user's appearance knobs into `--theme-*` custom properties on
 * <html>. app.css keeps ONE fallback copy of the default combination (Graphite
 * × Indigo) for first paint only. If you change those defaults here, update the
 * `:root` fallback block in app.css to match.
 *
 * `docs/docs.json` mirrors the same default from outside the app: the accent's
 * two hexes and the dark default mode. A change to DEFAULT_APPEARANCE's palette
 * mode or accent belongs there in the same pass, or the documentation stops
 * looking like the app it describes. Typography is deliberately NOT copied over,
 * so the font lists here stay out of it.
 */
import type {
	PaletteDef,
	AccentDef,
	FontOption,
	AppearanceState,
	PaletteMode,
	AppearanceScope
} from '$lib/types/theme';

/**
 * Every color a palette editor may touch, in the order the editor lays them out.
 *
 * `overlay` is deliberately absent. It is the modal backdrop's scrim, and a scrim
 * answers to one thing, which here is the mode it dims for: asking a reader to pick a
 * color for something whose whole job is to disappear is a question with no good
 * answer, and it is the one value in a palette carrying its own alpha, so a hex picker
 * could not express it either way.
 */
export const PALETTE_COLOR_KEYS = [
	'bgPrimary',
	'bgSecondary',
	'bgTertiary',
	'bgElevated',
	'cardBg',
	'inputBg',
	'textPrimary',
	'textSecondary',
	'textMuted',
	'border',
	'borderSubtle',
	'userBubble',
	'assistantBubble',
	'error',
	'success',
	'warning'
] as const;

export type PaletteColorKey = (typeof PALETTE_COLOR_KEYS)[number];

/** The scrim a palette dims its modals with, decided by the mode and nothing else. */
export const OVERLAY_BY_MODE: Record<PaletteMode, string> = {
	dark: 'rgb(0 0 0 / 66%)',
	light: 'rgb(38 34 30 / 42%)'
};

export const palettes: PaletteDef[] = [
	{
		id: 'graphite-dark',
		name: 'Graphite',
		mode: 'dark',
		colors: {
			bgPrimary: '#131417',
			bgSecondary: '#1a1c20',
			bgTertiary: '#24262c',
			bgElevated: '#1e2025',
			textPrimary: '#edeef1',
			textSecondary: '#adb0b8',
			textMuted: '#80838c',
			userBubble: '#272a31',
			assistantBubble: '#1f2126',
			border: '#35383f',
			borderSubtle: '#2a2d33',
			inputBg: '#1e2025',
			cardBg: '#1f2126',
			overlay: 'rgb(0 0 0 / 66%)',
			error: '#ef7f7f',
			success: '#72cb9b',
			warning: '#e6bb6a'
		}
	},
	{
		id: 'literary-dark',
		name: 'Literary Dark',
		mode: 'dark',
		colors: {
			bgPrimary: '#141112',
			bgSecondary: '#1c1718',
			bgTertiary: '#271f21',
			bgElevated: '#21191b',
			textPrimary: '#f5efea',
			textSecondary: '#baaea4',
			textMuted: '#8d8078',
			userBubble: '#2f2427',
			assistantBubble: '#221b1d',
			border: '#3a2f32',
			borderSubtle: '#2f2528',
			inputBg: '#21191b',
			cardBg: '#221b1d',
			overlay: 'rgb(0 0 0 / 66%)',
			error: '#ef7a7a',
			success: '#6fd097',
			warning: '#f0bb5f'
		}
	},
	{
		id: 'warm-stone-dark',
		name: 'Warm Stone',
		mode: 'dark',
		colors: {
			bgPrimary: '#151211',
			bgSecondary: '#1d1917',
			bgTertiary: '#2a2421',
			bgElevated: '#231d1a',
			textPrimary: '#efe8de',
			textSecondary: '#b5a99b',
			textMuted: '#7f7469',
			userBubble: '#352c27',
			assistantBubble: '#231d1a',
			border: '#413730',
			borderSubtle: '#312a25',
			inputBg: '#221c19',
			cardBg: '#231d1a',
			overlay: 'rgb(0 0 0 / 68%)',
			error: '#df8686',
			success: '#7cbb91',
			warning: '#d4b16d'
		}
	},
	{
		id: 'midnight-dark',
		name: 'Midnight',
		mode: 'dark',
		colors: {
			bgPrimary: '#0f131c',
			bgSecondary: '#151a26',
			bgTertiary: '#1e2534',
			bgElevated: '#181f2c',
			textPrimary: '#e9edf6',
			textSecondary: '#a8b2c7',
			textMuted: '#7a8399',
			userBubble: '#232c40',
			assistantBubble: '#171e2b',
			border: '#303a4f',
			borderSubtle: '#242c3d',
			inputBg: '#181f2c',
			cardBg: '#171e2b',
			overlay: 'rgb(0 0 0 / 70%)',
			error: '#f08a8a',
			success: '#7bd3a2',
			warning: '#e8bc6d'
		}
	},
	{
		id: 'nocturne-dark',
		name: 'Nocturne',
		mode: 'dark',
		colors: {
			// The only shipped palette built on a hue rather than a neutral, so the base
			// tiers are taken a long way down from the violet the raised ones carry: a
			// backdrop at full saturation is what makes a colored theme tiring to read on.
			bgPrimary: '#150a2b',
			bgSecondary: '#1e1140',
			bgTertiary: '#2b0b59',
			bgElevated: '#241348',
			textPrimary: '#ece9f6',
			textSecondary: '#b3aacb',
			textMuted: '#8a82a4',
			userBubble: '#401c8c',
			assistantBubble: '#1f1139',
			border: '#4a2c91',
			borderSubtle: '#301a5c',
			inputBg: '#241348',
			cardBg: '#21123f',
			overlay: 'rgb(0 0 0 / 68%)',
			// Status colors stay the house set: they mean the same thing in every palette,
			// and a red tinted toward the violet reads as decoration rather than a warning.
			error: '#ef7f7f',
			success: '#72cb9b',
			warning: '#e6bb6a'
		}
	},
	{
		id: 'parchment-light',
		name: 'Parchment',
		mode: 'light',
		colors: {
			bgPrimary: '#f7f2ea',
			bgSecondary: '#f0e9dd',
			bgTertiary: '#e7ddcc',
			bgElevated: '#fcf9f3',
			textPrimary: '#2f2620',
			// Ink deep enough to match what every dark palette gives its own tiers
			// (~8.7:1 secondary, ~4.9:1 muted on the base surface). A light palette
			// authored a stop shallower reads fine on a bare page and falls apart the
			// moment anything translucent sits over a background image.
			textSecondary: '#4d4339',
			textMuted: '#74675b',
			userBubble: '#ece1cf',
			assistantBubble: '#f3ede2',
			border: '#d9ccb8',
			borderSubtle: '#e5dbc9',
			inputBg: '#fcf9f3',
			cardBg: '#fbf7ef',
			overlay: 'rgb(48 38 26 / 42%)',
			error: '#b3403f',
			success: '#2e7d4f',
			warning: '#9a6b1f'
		}
	}
];

export const accents: AccentDef[] = [
	{ id: 'indigo', name: 'Indigo', dark: '#8e9bd8', light: '#4a5aa8' },
	{ id: 'copper', name: 'Copper', dark: '#d08961', light: '#a45a2e' },
	{ id: 'ember', name: 'Ember', dark: '#c97a72', light: '#a8443c' },
	{ id: 'rose', name: 'Rose', dark: '#d18a9e', light: '#a94f6b' },
	{ id: 'amber', name: 'Amber', dark: '#d9a662', light: '#96661c' },
	{ id: 'sage', name: 'Sage', dark: '#8caf8b', light: '#4f7a4e' },
	{ id: 'teal', name: 'Teal', dark: '#5fb3a8', light: '#23796d' },
	{ id: 'azure', name: 'Azure', dark: '#6fa8c7', light: '#2f6b93' },
	{ id: 'amethyst', name: 'Amethyst', dark: '#a98ac9', light: '#74519f' },
	{ id: 'silver', name: 'Silver', dark: '#b8b3ae', light: '#6b655f' },
	// The brightest of the four warm accents, and the one Nocturne is built around.
	{ id: 'marigold', name: 'Marigold', dark: '#f26b1d', light: '#b7480a' }
];

export const bodyFonts: FontOption[] = [
	{
		id: 'newsreader',
		label: 'Newsreader (serif)',
		stack: "'Newsreader', 'Iowan Old Style', Georgia, serif"
	},
	{
		id: 'literata',
		label: 'Literata (serif)',
		stack: "'Literata', Georgia, serif",
		bundledFont: 'literata'
	},
	{
		id: 'lora',
		label: 'Lora (serif)',
		stack: "'Lora', Georgia, serif",
		bundledFont: 'lora'
	},
	{
		id: 'source-serif',
		label: 'Source Serif (serif)',
		stack: "'Source Serif 4', Georgia, serif",
		bundledFont: 'source-serif-4'
	},
	{
		id: 'atkinson',
		label: 'Atkinson Hyperlegible (sans)',
		stack: "'Atkinson Hyperlegible', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'atkinson-hyperlegible'
	},
	{
		id: 'manrope',
		label: 'Manrope (sans)',
		stack: "'Manrope', 'Segoe UI', system-ui, sans-serif"
	},
	{
		id: 'inter',
		label: 'Inter (sans)',
		stack: "'Inter', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'inter'
	},
	{
		id: 'system',
		label: 'System default',
		stack: "system-ui, 'Segoe UI', sans-serif"
	}
];

export const uiFonts: FontOption[] = [
	{
		id: 'manrope',
		label: 'Manrope',
		stack: "'Manrope', 'Segoe UI', system-ui, sans-serif"
	},
	{
		id: 'inter',
		label: 'Inter',
		stack: "'Inter', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'inter'
	},
	{
		id: 'figtree',
		label: 'Figtree',
		stack: "'Figtree', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'figtree'
	},
	{
		id: 'nunito-sans',
		label: 'Nunito Sans',
		stack: "'Nunito Sans', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'nunito-sans'
	},
	{
		id: 'source-sans',
		label: 'Source Sans',
		stack: "'Source Sans 3', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'source-sans-3'
	},
	{
		id: 'ibm-plex',
		label: 'IBM Plex Sans',
		stack: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'ibm-plex-sans'
	},
	{
		id: 'work-sans',
		label: 'Work Sans',
		stack: "'Work Sans', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'work-sans'
	},
	{
		id: 'atkinson',
		label: 'Atkinson Hyperlegible',
		stack: "'Atkinson Hyperlegible', 'Segoe UI', system-ui, sans-serif",
		bundledFont: 'atkinson-hyperlegible'
	},
	{
		id: 'system',
		label: 'System default',
		stack: "system-ui, 'Segoe UI', sans-serif"
	}
];

export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";

/** The house tint for quoted speech. A fixed hue, deliberately not the theme accent:
 *  story text must not shift because the chrome did (see `ProseColorSource`). */
const PROSE_QUOTE_HUE = '#d08961';

/** That hue mixed toward whatever text color is in force, which is what
 *  `quoteColorSource: 'default'` resolves to. One expression rather than two, since
 *  `applyTheme` paints it and the Story Text swatch has to show the same color under
 *  the word "Default". Two copies would drift and the picker would start lying. */
export const proseQuoteDefault = (textPrimary: string): string =>
	`color-mix(in srgb, ${PROSE_QUOTE_HUE} 80%, ${textPrimary} 20%)`;

export const DEFAULT_APPEARANCE: AppearanceState = {
	palette: 'graphite-dark',
	accent: 'indigo',
	// The default accent's own hex, so opening the custom picker on a fresh install
	// starts from the color already on screen instead of jumping to another one.
	customAccent: '#8e9bd8',
	contrast: 'standard',
	bodyFont: 'newsreader',
	uiFont: 'manrope',
	fontScale: 1,
	lineHeight: 1.72,
	paragraphSpacing: 1.05,
	chatWidth: 1,
	radius: 1,
	chatStyle: 'bubbles',
	bubbleRadius: 1,
	bubblePadding: 'normal',
	bubbleBorder: 'hairline',
	bubbleShadow: 'soft',
	bubbleWidth: 1,
	// Strength 0 on both tints: the palette's own bubble colors, untouched. The hex
	// only decides where the picker opens until someone drags the strength up.
	userBubbleTint: '#d08961',
	userBubbleTintStrength: 0,
	assistantBubbleTint: '#d08961',
	assistantBubbleTintStrength: 0,
	bubbleOpacity: 1,
	// Each accent's face is two independent switches, and the shipped answers are what
	// the markup already means: dialogue plain, emphasis slanted, strong text bold.
	quoteColorSource: 'default',
	quoteColor: '#d08961',
	quoteBold: false,
	quoteItalic: false,
	emphasisColorSource: 'default',
	emphasisColor: '#d08961',
	emphasisBold: false,
	emphasisItalic: true,
	strongColorSource: 'default',
	strongColor: '#d08961',
	strongBold: true,
	strongItalic: false,
	// Zero: the shipped story reads exactly as it did until someone asks for a halo.
	proseShadow: 0,
	messageSpacing: 'cozy',
	archivedOpacity: 0.6,
	showAvatars: true,
	avatarShape: 'portrait',
	avatarSize: 1,
	showMessageNumbers: true,
	showTimestamps: true,
	timestampFormat: 'full',
	clockFormat: 'auto',
	showModelName: true,
	showTokenCount: true,
	showReasoningTokenCount: true,
	showGenerationTime: true,
	showSpeakerName: true,
	speakerLabel: 'pill',
	speakerCaps: false,
	messageActions: 'hover',
	compactActions: false,
	floatingActions: false,
	branchPager: 'always',
	glass: 'full',
	motion: 'full',
	shadeOpacity: 0
};

/**
 * Which half of the look each knob belongs to, and so which page tunes it: the frame the
 * app draws, or the story inside it. A page's Restore defaults acts on exactly the keys
 * it owns here and leaves the other half of the look alone.
 *
 * Spelled out key by key rather than derived from a short list of exceptions: a knob
 * added to `AppearanceState` fails to compile until it says which page tunes it, and
 * that is the one moment anybody knows the answer.
 */
export const APPEARANCE_SCOPE: Record<keyof AppearanceState, AppearanceScope> = {
	palette: 'interface',
	accent: 'interface',
	customAccent: 'interface',
	contrast: 'interface',
	uiFont: 'interface',
	radius: 'interface',
	glass: 'interface',
	motion: 'interface',

	chatWidth: 'chat',
	shadeOpacity: 'chat',
	messageSpacing: 'chat',
	bodyFont: 'chat',
	fontScale: 'chat',
	lineHeight: 'chat',
	paragraphSpacing: 'chat',
	chatStyle: 'chat',
	bubbleRadius: 'chat',
	bubblePadding: 'chat',
	bubbleBorder: 'chat',
	bubbleShadow: 'chat',
	bubbleWidth: 'chat',
	bubbleOpacity: 'chat',
	userBubbleTint: 'chat',
	userBubbleTintStrength: 'chat',
	assistantBubbleTint: 'chat',
	assistantBubbleTintStrength: 'chat',
	showAvatars: 'chat',
	avatarShape: 'chat',
	avatarSize: 'chat',
	quoteColorSource: 'chat',
	quoteColor: 'chat',
	quoteBold: 'chat',
	quoteItalic: 'chat',
	emphasisColorSource: 'chat',
	emphasisColor: 'chat',
	emphasisBold: 'chat',
	emphasisItalic: 'chat',
	strongColorSource: 'chat',
	strongColor: 'chat',
	strongBold: 'chat',
	strongItalic: 'chat',
	proseShadow: 'chat',
	showSpeakerName: 'chat',
	speakerLabel: 'chat',
	speakerCaps: 'chat',
	messageActions: 'chat',
	compactActions: 'chat',
	floatingActions: 'chat',
	branchPager: 'chat',
	archivedOpacity: 'chat',
	showMessageNumbers: 'chat',
	showTimestamps: 'chat',
	timestampFormat: 'chat',
	clockFormat: 'chat',
	showModelName: 'chat',
	showTokenCount: 'chat',
	showReasoningTokenCount: 'chat',
	showGenerationTime: 'chat'
};

/**
 * Pre-overhaul `activeTheme` ids mapped onto the palette × accent split.
 * Read-time only: nothing is rewritten until the user changes a setting.
 */
export const LEGACY_THEME_MAP: Record<string, { palette: string; accent: string }> = {
	'literary-dark': { palette: 'literary-dark', accent: 'copper' },
	'warm-stone-dark': { palette: 'warm-stone-dark', accent: 'copper' },
	'literary-sage': { palette: 'literary-dark', accent: 'sage' },
	'literary-azure': { palette: 'literary-dark', accent: 'azure' },
	'literary-rose': { palette: 'literary-dark', accent: 'rose' },
	'literary-amethyst': { palette: 'literary-dark', accent: 'amethyst' },
	'literary-crimson': { palette: 'literary-dark', accent: 'ember' },
	'literary-teal': { palette: 'literary-dark', accent: 'teal' }
};
