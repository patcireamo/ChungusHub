/**
 * Theme system types.
 *
 * A theme is composed at runtime from three orthogonal pieces:
 *   base palette (surfaces, text, borders)  ×  accent (one hue, tuned per mode)
 *   ×  appearance knobs (contrast, typography, layout, effects).
 * `src/lib/themes/presets.ts` holds the data; `src/lib/stores/theme.svelte.ts`
 * resolves everything into `--theme-*` custom properties on <html>.
 */

export type PaletteMode = 'dark' | 'light';

/**
 * One palette: the small set of colors every surface in the app is derived from.
 *
 * Shipped palettes live in `src/lib/themes/presets.ts`; the reader's own are the same
 * shape, stored on the settings spine, and the two lists are concatenated wherever a
 * palette is picked. That set is the whole contract: `applyTheme()` mints roughly
 * seventy-five custom properties out of it (the glass tiers, the raised border, the
 * on-accent and on-error inks, the scrims, the shadows), so an editor over a palette
 * never has to know those exist and cannot put them out of step with one another.
 * `overlay` is the one color no editor offers: it is a scrim, and a scrim answers to
 * the mode it dims for rather than to a picker.
 */
export interface PaletteDef {
	id: string;
	name: string;
	mode: PaletteMode;
	colors: {
		bgPrimary: string;
		bgSecondary: string;
		bgTertiary: string;
		bgElevated: string;

		textPrimary: string;
		textSecondary: string;
		textMuted: string;

		userBubble: string;
		assistantBubble: string;

		border: string;
		borderSubtle: string;

		inputBg: string;
		cardBg: string;
		/** Modal/backdrop dimmer. */
		overlay: string;

		error: string;
		success: string;
		warning: string;
	};
}

export interface AccentDef {
	id: string;
	name: string;
	/** The hue as rendered on dark palettes (pastel) and light palettes (deepened). */
	dark: string;
	light: string;
}

export type ContrastLevel = 'soft' | 'standard' | 'high';
export type GlassLevel = 'off' | 'subtle' | 'full';
export type MotionLevel = 'full' | 'reduced';
/**
 * How chat turns render: cozy bubbles, the same bubbles with both speakers down
 * the left (`flat`), forum-style portrait cards, or bare manuscript prose.
 * `flat` shares every card knob with `bubbles`: it only un-mirrors the user turn.
 */
export type ChatStyle = 'bubbles' | 'flat' | 'portrait' | 'manuscript';

/** Inner breathing room of a message card. */
export type BubblePadding = 'compact' | 'normal' | 'roomy';
/** Message card outline weight. */
export type BubbleBorder = 'none' | 'hairline' | 'bold';
export type BubbleShadow = 'none' | 'soft' | 'lifted';
/** Vertical air between turns in the transcript. */
export type MessageSpacing = 'compact' | 'cozy' | 'roomy';
/** Portrait frame silhouette. Circle forces a square ratio. */
export type AvatarShape = 'portrait' | 'square' | 'circle';
/** Chrome around the speaker's name. Casing is a separate, orthogonal knob
 *  (`speakerCaps`) so an outlined chip can also be set in small caps. */
export type SpeakerLabel = 'pill' | 'plain';
export type ActionVisibility = 'hover' | 'always';
export type PagerVisibility = 'always' | 'hover';
/** Where a prose accent color comes from. `off` leaves the run the color of the
 *  prose around it (the markup still renders, it just stops being tinted), `default`
 *  keeps the shipped derivation, `accent` follows the theme accent live, `custom` is
 *  used verbatim. All three accents offer all four: a vocabulary that changed per row
 *  is a card the reader has to re-learn on every line, and how much of a page tracks
 *  the accent is then the reader's own pick rather than a rule they cannot see. */
export type ProseColorSource = 'off' | 'default' | 'accent' | 'custom';
export type TimestampFormat = 'relative' | 'short' | 'full';
/** `auto` defers to the locale's own 12/24-hour habit. */
export type ClockFormat = 'auto' | '12' | '24';

export interface FontOption {
	id: string;
	label: string;
	/** CSS font-family stack. */
	stack: string;
	/**
	 * Slug of a bundled family in static/fonts/ (e.g. "literata" → /fonts/literata.css).
	 * Absent = already linked in app.html or a system font; nothing to load.
	 */
	bundledFont?: string;
}

/** Every user-tunable appearance knob. Persisted as one settings blob. */
export interface AppearanceState {
	palette: string;
	/** Accent preset id, or 'custom' to use `customAccent`. */
	accent: string;
	/** Hex color used when accent === 'custom'. */
	customAccent: string;
	contrast: ContrastLevel;

	bodyFont: string;
	uiFont: string;
	/** Multiplier over the base body size (1 = default). */
	fontScale: number;
	lineHeight: number;
	/** Paragraph spacing inside prose, in em. */
	paragraphSpacing: number;

	/** Multiplier over the chat column width cap (1 = default). */
	chatWidth: number;
	/** Multiplier over the corner-radius scale (0 = sharp, 1 = default). */
	radius: number;
	chatStyle: ChatStyle;

	/* --- Message card shape. Manuscript draws no card, so these are inert there;
	   `bubbleWidth` is Bubbles-only (Portraits cards are always full width). --- */
	/** Multiplier over the message card's own corner radius (1 = default). */
	bubbleRadius: number;
	bubblePadding: BubblePadding;
	bubbleBorder: BubbleBorder;
	bubbleShadow: BubbleShadow;
	/** Fraction of the chat column a message card may occupy (1 = the full column). */
	bubbleWidth: number;

	/* --- Message card colors. Tints MIX into the palette's bubble color rather
	   than replacing it, so switching palettes keeps the contrast floor. --- */
	userBubbleTint: string;
	/** 0 = the palette's own bubble color, 1 = the tint alone. */
	userBubbleTintStrength: number;
	assistantBubbleTint: string;
	assistantBubbleTintStrength: number;
	/** Multiplier over the glass-derived bubble alpha (1 = whatever Glass decided). */
	bubbleOpacity: number;

	/* --- Story text: the prose accents inside a turn. Each accent answers the same
	   three questions (where its color comes from, is it bold, is it slanted), so the
	   card reads identically down every row. Bold and slant are separate booleans and
	   not one four-value face: they are independent questions, and an enum spelling a
	   cross-product is the shape the speaker label/casing split already refused. --- */
	quoteColorSource: ProseColorSource;
	quoteColor: string;
	quoteBold: boolean;
	quoteItalic: boolean;
	emphasisColorSource: ProseColorSource;
	emphasisColor: string;
	emphasisBold: boolean;
	emphasisItalic: boolean;
	strongColorSource: ProseColorSource;
	strongColor: string;
	strongBold: boolean;
	strongItalic: boolean;
	/** Strength of the legibility halo behind story text, 0 (none) .. 1. Always the
	 *  counterpart of the palette's own ink, never a color the reader picks: like the
	 *  workspace scrims, its whole job is to disappear behind what it protects. */
	proseShadow: number;

	/* --- Transcript density --- */
	messageSpacing: MessageSpacing;
	/** Opacity of turns already folded into chat memory. */
	archivedOpacity: number;

	/* --- Portraits. Shape is Bubbles-only: the Portraits chat style owns its
	   in-card 2:3 frame, and Manuscript draws no portrait at all. --- */
	showAvatars: boolean;
	avatarShape: AvatarShape;
	/** Multiplier over the portrait frame's width (1 = default). */
	avatarSize: number;

	/* --- Meta row + per-message controls --- */
	/** Show each turn's position in the visible transcript (#1, #2, …) under its portrait. */
	showMessageNumbers: boolean;
	/** Show each turn's timestamp in the meta row. */
	showTimestamps: boolean;
	timestampFormat: TimestampFormat;
	clockFormat: ClockFormat;
	/** Show provider/model in the meta row's generation tooltip. */
	showModelName: boolean;
	/** Show per-turn token counts (meta tooltip + the streaming estimate). */
	showTokenCount: boolean;
	/** Show the reasoning block's own ~token estimate in its headers. */
	showReasoningTokenCount: boolean;
	/** Show how long each reply took to generate: live while streaming, then locked to the turn. */
	showGenerationTime: boolean;
	showSpeakerName: boolean;
	/** Applies to Bubbles, Flat and Portraits; Manuscript keeps its own label. */
	speakerLabel: SpeakerLabel;
	/** Letter-spaced uppercase, independent of `speakerLabel`'s chrome. */
	speakerCaps: boolean;
	messageActions: ActionVisibility;
	/** Icons only: drops the Edit/Copy/Retry/Delete word labels. */
	compactActions: boolean;
	/** The foot toolbar sticks to the bottom of the view while its turn is on screen, so a long
	 *  reply's actions stay within reach while it scrolls. */
	floatingActions: boolean;
	branchPager: PagerVisibility;

	glass: GlassLevel;
	motion: MotionLevel;
	/** Strength of the reading column's shade, 0 (none at all) .. 1 (the palette's
	 *  own surface tone, opaque). It is the only thing this scrim answers to: the
	 *  colour is always the palette's, so recolouring it is not a question the user
	 *  is asked, and the background image's dim is a separate control on the page
	 *  that owns the image (`BackgroundConfig.dim`). */
	shadeOpacity: number;
}

/**
 * Which half of the look a knob tunes, and so which page carries it: the frame the app
 * draws (Settings → Appearance → Interface) or the story inside it (→ Chat).
 * `APPEARANCE_SCOPE` in presets.ts answers it for every key, and each page's Restore
 * defaults acts on exactly the keys it owns.
 */
export type AppearanceScope = 'interface' | 'chat';
