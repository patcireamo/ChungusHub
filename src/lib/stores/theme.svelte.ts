/**
 * Theme store: resolves palette × accent × appearance knobs into `--theme-*` custom
 * properties on <html>. presets.ts holds the shipped palettes, accents and fonts;
 * app.css keeps a first-paint fallback of the defaults, and the paint cache below
 * closes the gap between that fallback and the reader's own look.
 *
 * It owns two things, on two keys of the synced settings spine. The **look** is the live
 * `appearance` blob, what the app is wearing and what every settings control writes. The
 * **palettes** are the ones the reader built, concatenated onto the shipped ones wherever
 * a palette is offered, which is what makes the colors of this app data rather than code.
 *
 * Pre-overhaul installs that only have the old `activeTheme` string get it mapped at
 * read time, with no data rewrite.
 */
import type {
	AppearanceScope,
	AppearanceState,
	AccentDef,
	ActionVisibility,
	AvatarShape,
	BubbleBorder,
	BubblePadding,
	BubbleShadow,
	ChatStyle,
	ClockFormat,
	ContrastLevel,
	GlassLevel,
	MessageSpacing,
	MotionLevel,
	PagerVisibility,
	PaletteDef,
	PaletteMode,
	ProseColorSource,
	SpeakerLabel,
	TimestampFormat
} from '$lib/types/theme';
import {
	palettes as shippedPalettes,
	accents,
	bodyFonts,
	uiFonts,
	APPEARANCE_SCOPE,
	FONT_MONO,
	DEFAULT_APPEARANCE,
	LEGACY_THEME_MAP,
	OVERLAY_BY_MODE,
	PALETTE_COLOR_KEYS,
	proseQuoteDefault
} from '$lib/themes/presets';
import { ensureFontLoaded } from '$lib/services/fonts';
import { db } from '$lib/services/database';
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';

/**
 * Two keys, deliberately not one blob.
 *
 * `appearance` is the look on screen and the only one a settings control ever writes, so
 * dragging a slider costs one small write per frame. The reader's palettes are documents
 * beside it, written when a palette is edited and at no other time.
 */
const SETTINGS_KEY = 'appearance';
const PALETTES_KEY = 'customPalettes';

/** Where the first-paint mirror lives. Hand-kept in step with app.html's inline script. */
const PAINT_CACHE_KEY = 'chungushub:paint';

/**
 * Mirror the resolved paint for the next boot's first frame.
 *
 * The theme rides the server settings spine, which nothing can read before the app
 * has booted, so without this every load paints app.css's shipped default until the
 * blob arrives: a dark flash for anyone reading on a light palette, and a
 * wrong-colored one for anyone on a palette they built themselves. app.html's inline
 * script reads this back and stamps it before the body paints; the shape is hand-kept
 * in step between the two, so a var or attribute added above lands there for free and
 * a change to this object's shape does not.
 *
 * localStorage rather than the spine, and it is not an exception to that rule: this is
 * a cache of what THIS device last painted, never a source of truth, and a device that
 * has never run the app has nothing here and correctly falls back to the CSS defaults.
 */
function writePaintCache(vars: Record<string, string>, attrs: Record<string, string>): void {
	localStorage.setItem(PAINT_CACHE_KEY, JSON.stringify({ vars, attrs }));
}

const RADIUS_BASE = { sm: 0.5, md: 0.8, lg: 1.1, xl: 1.45 };
const GLASS_BLUR: Record<GlassLevel, number> = { off: 0, subtle: 8, full: 16 };
/* Frosted panels (Workspace overlays/docks) trade translucency for blur; with less
   blur they must turn more opaque or the ambient layer behind turns into noise. */
const PANEL_ALPHA: Record<GlassLevel, number> = { off: 96, subtle: 72, full: 58 };
/* Interior surfaces (cards, inputs, raised rows painted ON a frosted panel).
   They never carry their own backdrop-filter (the panel already blurred the
   backdrop), so all they need is translucency that follows the glass level.
   Alphas sit above the panel's: panel + card must still stack to a readable
   surface over a busy background image. */
const CARD_ALPHA: Record<GlassLevel, number> = { off: 100, subtle: 84, full: 62 };
const INPUT_ALPHA: Record<GlassLevel, number> = { off: 100, subtle: 80, full: 58 };
/* The generic surface tiers (secondary/tertiary/elevated) double as card, chip
   and hover-row backgrounds all over the panel interiors, so they follow the
   glass level too. bgPrimary stays opaque: it is the app's base backdrop.
   Bubbles hold long prose over an unblurred background image, so they give up
   far less opacity than the chrome around them. */
const TIER_ALPHA: Record<GlassLevel, { secondary: number; tertiary: number; elevated: number }> =
	{
		off: { secondary: 100, tertiary: 100, elevated: 100 },
		subtle: { secondary: 88, tertiary: 88, elevated: 90 },
		full: { secondary: 70, tertiary: 72, elevated: 75 }
	};
const BUBBLE_ALPHA: Record<GlassLevel, number> = { off: 100, subtle: 94, full: 88 };
/* Floating surfaces over live content (dialogs, popovers, toasts, the chats
   modal, the assistant widget). These sit over unhidden UI, so they stay markedly
   more opaque than the workspace panels and carry their own backdrop blur. */
const FLOAT_ALPHA: Record<GlassLevel, number> = { off: 100, subtle: 90, full: 80 };
/* Every alpha above is authored for a DARK palette, and glass composites the two
   modes asymmetrically: a translucent surface moves toward whatever is behind it,
   which over the workspace photo means a dark surface only ever gains contrast
   against light text, while a light surface loses it against dark text. Measured on
   the shipped stack (a photo under the 35% dim, panel at glass=full), a dark palette
   holds ~9.7:1 primary and ~5.1:1 secondary on its worst backdrop while a light one
   collapses to 4.8:1 and 2.0:1. The illegibility is structural, not a palette bug.
   So a light palette keeps the same glass HIERARCHY at a fraction of the
   transparency. One factor rather than a second set of maps, so the tuned order of
   the tiers (panel < card < tier < float < bubble) can never drift out of step; at
   0.42 it puts light mode back on parity with the dark palettes at every glass and
   contrast level. An alpha already at 100 stays there. */
const LIGHT_GLASS_KEEP = 0.42;

/* Message-card geometry per padding step. The inner gaps between the meta row,
   the diagnostics bar and the prose are rhythm, not padding, so they stay fixed. */
const BUBBLE_PAD: Record<BubblePadding, { x: string; top: string; bottom: string }> = {
	compact: { x: '0.72rem', top: '0.5rem', bottom: '0.62rem' },
	normal: { x: '0.98rem', top: '0.72rem', bottom: '0.95rem' },
	roomy: { x: '1.35rem', top: '0.98rem', bottom: '1.32rem' }
};

const BUBBLE_BORDER_WIDTH: Record<BubbleBorder, string> = {
	none: '0px',
	hairline: '1px',
	bold: '2px'
};

/* Vertical air around a turn. `cozy` is the shipped clamp, verbatim. */
const MESSAGE_SPACING: Record<MessageSpacing, string> = {
	compact: 'clamp(0.2rem, 0.15rem + 0.24vw, 0.4rem)',
	cozy: 'clamp(0.45rem, 0.36rem + 0.42vw, 0.75rem)',
	roomy: 'clamp(0.85rem, 0.68rem + 0.8vw, 1.4rem)'
};

/* Desktop silhouette per shape, plus the phone variant: below 900px every avatar
   squares up for row height (shipped behavior), so only the radius follows. */
const AVATAR_SHAPE: Record<AvatarShape, { ratio: string; radius: string; radiusSm: string }> = {
	portrait: {
		ratio: '2 / 3',
		radius: 'calc(var(--radius-xl) - 0.12rem)',
		radiusSm: 'var(--radius-lg)'
	},
	square: {
		ratio: '1 / 1',
		radius: 'calc(var(--radius-xl) - 0.12rem)',
		radiusSm: 'var(--radius-lg)'
	},
	circle: { ratio: '1 / 1', radius: 'var(--radius-full)', radiusSm: 'var(--radius-full)' }
};

/* The one vocabulary every story-text accent answers to. Whitelisted here so a row
   can never quietly grow a fifth source or lose one the other rows still offer. */
const PROSE_SOURCES = ['off', 'default', 'accent', 'custom'] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function clamp(n: unknown, min: number, max: number, fallback: number): number {
	return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function hex(value: unknown, fallback: string): string {
	return typeof value === 'string' && HEX_RE.test(value) ? value : fallback;
}

/**
 * Coerce a raw settings blob into a valid appearance state.
 *
 * `known` is every palette that exists right now, the reader's own included, which is
 * why the store loads palettes before it loads the look: checked against the shipped
 * five alone, a look built on a palette someone made would fail this test on every
 * boot and land back on the house default. A palette that has genuinely been deleted
 * still falls back here, which is the one thing that keeps the app painting.
 */
function normalize(raw: Partial<AppearanceState> | null, known: PaletteDef[]): AppearanceState {
	const d = DEFAULT_APPEARANCE;
	return {
		palette: known.some((p) => p.id === raw?.palette) ? raw!.palette! : d.palette,
		accent:
			raw?.accent === 'custom' || accents.some((a) => a.id === raw?.accent)
				? raw!.accent!
				: d.accent,
		customAccent: hex(raw?.customAccent, d.customAccent),
		contrast: oneOf<ContrastLevel>(raw?.contrast, ['soft', 'standard', 'high'], d.contrast),
		bodyFont: bodyFonts.some((f) => f.id === raw?.bodyFont) ? raw!.bodyFont! : d.bodyFont,
		uiFont: uiFonts.some((f) => f.id === raw?.uiFont) ? raw!.uiFont! : d.uiFont,
		fontScale: clamp(raw?.fontScale, 0.85, 1.25, d.fontScale),
		lineHeight: clamp(raw?.lineHeight, 1.4, 2.1, d.lineHeight),
		paragraphSpacing: clamp(raw?.paragraphSpacing, 0.4, 1.8, d.paragraphSpacing),
		chatWidth: clamp(raw?.chatWidth, 0.75, 1.2, d.chatWidth),
		radius: clamp(raw?.radius, 0, 1.35, d.radius),
		chatStyle: oneOf<ChatStyle>(
			raw?.chatStyle,
			['bubbles', 'flat', 'portrait', 'manuscript'],
			d.chatStyle
		),
		bubbleRadius: clamp(raw?.bubbleRadius, 0, 1.6, d.bubbleRadius),
		bubblePadding: oneOf<BubblePadding>(
			raw?.bubblePadding,
			['compact', 'normal', 'roomy'],
			d.bubblePadding
		),
		bubbleBorder: oneOf<BubbleBorder>(
			raw?.bubbleBorder,
			['none', 'hairline', 'bold'],
			d.bubbleBorder
		),
		bubbleShadow: oneOf<BubbleShadow>(
			raw?.bubbleShadow,
			['none', 'soft', 'lifted'],
			d.bubbleShadow
		),
		bubbleWidth: clamp(raw?.bubbleWidth, 0.55, 1, d.bubbleWidth),
		userBubbleTint: hex(raw?.userBubbleTint, d.userBubbleTint),
		userBubbleTintStrength: clamp(raw?.userBubbleTintStrength, 0, 1, d.userBubbleTintStrength),
		assistantBubbleTint: hex(raw?.assistantBubbleTint, d.assistantBubbleTint),
		assistantBubbleTintStrength: clamp(
			raw?.assistantBubbleTintStrength,
			0,
			1,
			d.assistantBubbleTintStrength
		),
		// Floor of 0 on purpose: a fully transparent card with its outline still on is
		// a deliberate look (prose on the background, structure intact), not a mistake.
		bubbleOpacity: clamp(raw?.bubbleOpacity, 0, 1, d.bubbleOpacity),
		quoteColorSource: oneOf<ProseColorSource>(
			raw?.quoteColorSource,
			PROSE_SOURCES,
			d.quoteColorSource
		),
		quoteColor: hex(raw?.quoteColor, d.quoteColor),
		quoteBold: bool(raw?.quoteBold, d.quoteBold),
		quoteItalic: bool(raw?.quoteItalic, d.quoteItalic),
		emphasisColorSource: oneOf<ProseColorSource>(
			raw?.emphasisColorSource,
			PROSE_SOURCES,
			d.emphasisColorSource
		),
		emphasisColor: hex(raw?.emphasisColor, d.emphasisColor),
		emphasisBold: bool(raw?.emphasisBold, d.emphasisBold),
		emphasisItalic: bool(raw?.emphasisItalic, d.emphasisItalic),
		strongColorSource: oneOf<ProseColorSource>(
			raw?.strongColorSource,
			PROSE_SOURCES,
			d.strongColorSource
		),
		strongColor: hex(raw?.strongColor, d.strongColor),
		strongBold: bool(raw?.strongBold, d.strongBold),
		strongItalic: bool(raw?.strongItalic, d.strongItalic),
		proseShadow: clamp(raw?.proseShadow, 0, 1, d.proseShadow),
		messageSpacing: oneOf<MessageSpacing>(
			raw?.messageSpacing,
			['compact', 'cozy', 'roomy'],
			d.messageSpacing
		),
		archivedOpacity: clamp(raw?.archivedOpacity, 0.25, 1, d.archivedOpacity),
		showAvatars: bool(raw?.showAvatars, d.showAvatars),
		avatarShape: oneOf<AvatarShape>(
			raw?.avatarShape,
			['portrait', 'square', 'circle'],
			d.avatarShape
		),
		avatarSize: clamp(raw?.avatarSize, 0.7, 1.6, d.avatarSize),
		showMessageNumbers: bool(raw?.showMessageNumbers, d.showMessageNumbers),
		showTimestamps: bool(raw?.showTimestamps, d.showTimestamps),
		timestampFormat: oneOf<TimestampFormat>(
			raw?.timestampFormat,
			['relative', 'short', 'full'],
			d.timestampFormat
		),
		clockFormat: oneOf<ClockFormat>(raw?.clockFormat, ['auto', '12', '24'], d.clockFormat),
		showModelName: bool(raw?.showModelName, d.showModelName),
		showTokenCount: bool(raw?.showTokenCount, d.showTokenCount),
		showReasoningTokenCount: bool(raw?.showReasoningTokenCount, d.showReasoningTokenCount),
		showGenerationTime: bool(raw?.showGenerationTime, d.showGenerationTime),
		showSpeakerName: bool(raw?.showSpeakerName, d.showSpeakerName),
		speakerLabel: oneOf<SpeakerLabel>(raw?.speakerLabel, ['pill', 'plain'], d.speakerLabel),
		speakerCaps: bool(raw?.speakerCaps, d.speakerCaps),
		messageActions: oneOf<ActionVisibility>(
			raw?.messageActions,
			['hover', 'always'],
			d.messageActions
		),
		compactActions: bool(raw?.compactActions, d.compactActions),
		floatingActions: bool(raw?.floatingActions, d.floatingActions),
		branchPager: oneOf<PagerVisibility>(raw?.branchPager, ['always', 'hover'], d.branchPager),
		glass: oneOf<GlassLevel>(raw?.glass, ['off', 'subtle', 'full'], d.glass),
		motion: oneOf<MotionLevel>(raw?.motion, ['full', 'reduced'], d.motion),
		shadeOpacity: clamp(raw?.shadeOpacity, 0, 1, d.shadeOpacity)
	};
}

/**
 * The keys one Appearance page owns, in one fixed order.
 *
 * The order is load-bearing rather than cosmetic: `isModified()` compares two of these
 * as JSON strings, and both sides come out of `pickScope()`, so two equal looks always
 * serialise identically.
 */
const SCOPE_KEYS = Object.entries(APPEARANCE_SCOPE) as [keyof AppearanceState, AppearanceScope][];

/** The half of a look one Appearance page owns. */
function pickScope(
	appearance: AppearanceState,
	scope: AppearanceScope
): Partial<AppearanceState> {
	const picked: Record<string, unknown> = {};
	for (const [key, owner] of SCOPE_KEYS) {
		if (owner === scope) picked[key] = appearance[key];
	}
	return picked as Partial<AppearanceState>;
}

/** A name nothing else in the list already carries: two rows reading "Night" would
 *  leave the reader choosing between them on nothing at all. */
function uniqueName(wanted: string, taken: { name: string }[]): string {
	const base = wanted.trim() || 'Untitled';
	if (!taken.some((t) => t.name === base)) return base;
	let n = 2;
	while (taken.some((t) => t.name === `${base} ${n}`)) n++;
	return `${base} ${n}`;
}

/** Coerce one stored or imported palette. Colors fall back to the house default's,
 *  which is what keeps a truncated file from painting an app with holes in it. */
function normalizePalette(raw: unknown): PaletteDef {
	const p = (raw ?? {}) as Partial<PaletteDef>;
	const base = shippedPalettes[0].colors;
	const mode: PaletteMode = p.mode === 'light' ? 'light' : 'dark';
	const stored = (p.colors ?? {}) as Record<string, unknown>;
	const colors = {} as PaletteDef['colors'];
	for (const key of PALETTE_COLOR_KEYS) {
		colors[key] = hex(stored[key], base[key]);
	}
	return {
		id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
		name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Untitled palette',
		mode,
		colors: { ...colors, overlay: OVERLAY_BY_MODE[mode] }
	};
}

function normalizePalettes(raw: unknown): PaletteDef[] {
	return Array.isArray(raw) ? raw.map(normalizePalette) : [];
}

class ThemeStore {
	/** The look on screen. Every appearance control writes straight here. */
	appearance = $state<AppearanceState>({ ...DEFAULT_APPEARANCE });
	/** Palettes the reader built, in the order they made them. */
	customPalettes = $state<PaletteDef[]>([]);

	accents = accents;
	bodyFonts = bodyFonts;
	uiFonts = uiFonts;

	/** Every palette a picker may offer: the shipped set first, then the reader's own. */
	palettes = $derived([...shippedPalettes, ...this.customPalettes]);

	activePalette = $derived(
		this.palettes.find((p) => p.id === this.appearance.palette) ?? shippedPalettes[0]
	);

	/** The accent hex actually in use, resolved for the active palette's mode. */
	accentColor = $derived.by(() => {
		if (this.appearance.accent === 'custom') return this.appearance.customAccent;
		const accent = accents.find((a) => a.id === this.appearance.accent) ?? accents[0];
		return accent[this.activePalette.mode];
	});

	/**
	 * One Appearance page's half of the look has moved off the shipped default, which is
	 * what puts its Restore defaults on screen.
	 *
	 * A plain JSON comparison is exact here because both sides come out of `pickScope()`,
	 * which walks one fixed key order, so two equal looks always serialise to the same
	 * string.
	 */
	isModified(scope: AppearanceScope): boolean {
		return (
			JSON.stringify(pickScope(this.appearance, scope)) !==
			JSON.stringify(pickScope(DEFAULT_APPEARANCE, scope))
		);
	}

	/**
	 * Put one page's knobs back to the shipped default. The other page is left alone, and
	 * so is everything on this one that is not an appearance knob: the background image
	 * and the ambient mix are their own stores with their own controls.
	 */
	restoreDefaults(scope: AppearanceScope): void {
		this.update(pickScope(DEFAULT_APPEARANCE, scope));
	}

	async initialize(): Promise<void> {
		await this.syncReload();
		registerSettingsReload(() => this.syncReload());
	}

	/**
	 * Re-read everything and apply (also runs on live sync from another device).
	 *
	 * Palettes first, and the order is load-bearing: `normalize()` checks the stored
	 * palette id against the palettes that exist, so a look built on one the reader made
	 * would be dragged back to the house default by its own boot.
	 */
	async syncReload(): Promise<void> {
		this.customPalettes = normalizePalettes(await readSetting<unknown>(PALETTES_KEY, null));

		const raw = await readSetting<Partial<AppearanceState> | null>(SETTINGS_KEY, null);
		if (raw) {
			this.appearance = normalize(raw, this.palettes);
		} else {
			// Fresh blob from the pre-overhaul theme id, if one was ever saved.
			const legacy = await db.getSetting('activeTheme');
			const mapped = legacy ? LEGACY_THEME_MAP[legacy] : undefined;
			this.appearance = normalize(mapped ? { ...mapped } : null, this.palettes);
		}
		this.applyTheme();
	}

	/** Change any subset of knobs; persists and applies immediately. */
	update(partial: Partial<AppearanceState>): void {
		this.appearance = normalize({ ...this.appearance, ...partial }, this.palettes);
		writeSetting(SETTINGS_KEY, this.appearance);
		this.applyTheme();
	}

	/** Swatch color for an accent preset under the active palette's mode. */
	accentSwatch(accent: AccentDef): string {
		return accent[this.activePalette.mode];
	}

	/* --- The reader's palettes -------------------------------------------------- */

	/** Copy any palette into one the reader owns, and wear it straight away. */
	createPalette(fromId: string): string {
		const source = this.palettes.find((p) => p.id === fromId);
		if (!source) throw new Error(`[theme] no palette with id "${fromId}"`);
		const palette: PaletteDef = {
			id: crypto.randomUUID(),
			name: uniqueName(`${source.name} copy`, this.palettes),
			mode: source.mode,
			colors: { ...source.colors }
		};
		this.customPalettes = [...this.customPalettes, palette];
		this.writePalettes();
		this.update({ palette: palette.id });
		return palette.id;
	}

	/** One color at a time, which is how the editor moves. */
	updatePalette(id: string, patch: Partial<PaletteDef['colors']>): void {
		const palette = this.ownPalette(id);
		palette.colors = { ...palette.colors, ...patch };
		this.writePalettes();
		this.applyTheme();
	}

	/** Put a palette back exactly as the editor found it: the way out of a session of
	 *  edits that have all already landed on the app. */
	restorePalette(snapshot: PaletteDef): void {
		const palette = this.ownPalette(snapshot.id);
		palette.name = snapshot.name;
		palette.mode = snapshot.mode;
		palette.colors = { ...snapshot.colors };
		this.writePalettes();
		this.applyTheme();
	}

	renamePalette(id: string, name: string): void {
		const palette = this.ownPalette(id);
		palette.name = uniqueName(
			name,
			this.palettes.filter((p) => p.id !== id)
		);
		this.writePalettes();
	}

	/**
	 * Dark or light, and it is nothing like cosmetic. The mode decides how far every
	 * translucent surface may go (a light surface loses contrast against dark ink exactly
	 * where a dark one gains it), which way the shadows and the story's halo are mixed,
	 * what the modal scrim dims with, and what glyphs a phone paints its status bar.
	 */
	setPaletteMode(id: string, mode: PaletteMode): void {
		const palette = this.ownPalette(id);
		palette.mode = mode;
		palette.colors = { ...palette.colors, overlay: OVERLAY_BY_MODE[mode] };
		this.writePalettes();
		this.applyTheme();
	}

	/**
	 * Delete one of the reader's palettes. A look still pointing at it falls back to the
	 * house default. The confirm says so before the press, so the repaint is the thing the
	 * reader agreed to rather than a surprise.
	 */
	deletePalette(id: string): void {
		this.customPalettes = this.customPalettes.filter((p) => p.id !== id);
		this.writePalettes();
		if (this.appearance.palette === id) this.update({ palette: DEFAULT_APPEARANCE.palette });
		else this.applyTheme();
	}

	private ownPalette(id: string): PaletteDef {
		const palette = this.customPalettes.find((p) => p.id === id);
		if (!palette) throw new Error(`[theme] "${id}" is not a palette this reader owns`);
		return palette;
	}

	private writePalettes(): void {
		writeSetting(PALETTES_KEY, this.customPalettes);
	}

	applyTheme(): void {
		if (typeof document === 'undefined') return;

		const a = this.appearance;
		const p = this.activePalette;
		const c = p.colors;
		const dark = p.mode === 'dark';
		const accent = this.accentColor;

		// Contrast: nudge the secondary tiers toward (high) or away from (soft)
		// the primary text; borders follow so hierarchy stays coherent.
		let textSecondary = c.textSecondary;
		let textMuted = c.textMuted;
		let border = c.border;
		let borderSubtle = c.borderSubtle;
		if (a.contrast === 'high') {
			textSecondary = `color-mix(in oklab, ${c.textSecondary} 50%, ${c.textPrimary})`;
			textMuted = `color-mix(in oklab, ${c.textMuted} 55%, ${c.textSecondary})`;
			border = `color-mix(in oklab, ${c.border} 78%, ${c.textPrimary})`;
			borderSubtle = `color-mix(in oklab, ${c.borderSubtle} 84%, ${c.textPrimary})`;
		} else if (a.contrast === 'soft') {
			textSecondary = `color-mix(in oklab, ${c.textSecondary} 88%, ${c.bgPrimary})`;
			textMuted = `color-mix(in oklab, ${c.textMuted} 86%, ${c.bgPrimary})`;
			border = `color-mix(in oklab, ${c.border} 82%, ${c.bgPrimary})`;
			borderSubtle = `color-mix(in oklab, ${c.borderSubtle} 82%, ${c.bgPrimary})`;
		}

		const blur = GLASS_BLUR[a.glass];

		const bodyFont = bodyFonts.find((f) => f.id === a.bodyFont) ?? bodyFonts[0];
		const uiFont = uiFonts.find((f) => f.id === a.uiFont) ?? uiFonts[0];
		ensureFontLoaded(bodyFont.bundledFont);
		ensureFontLoaded(uiFont.bundledFont);

		const rem = (base: number) => `${(base * a.radius).toFixed(3)}rem`;

		// Every surface alpha passes through here, so light mode can never inherit a
		// dark palette's translucency by accident (see LIGHT_GLASS_KEEP).
		const glassAlpha = (alpha: number) =>
			dark ? alpha : Math.round(100 - (100 - alpha) * LIGHT_GLASS_KEEP);
		const tier = TIER_ALPHA[a.glass];
		const tinted = (color: string, alpha: number) =>
			alpha >= 100 ? color : `color-mix(in srgb, ${color} ${alpha}%, transparent)`;

		// Bubble tints MIX into the palette's own bubble color instead of replacing
		// it, so a palette switch carries the tint with it and the readability floor
		// the palette guarantees survives any hex the user picks.
		const tintBubble = (base: string, tint: string, strength: number) =>
			strength <= 0 ? base : `color-mix(in oklab, ${tint} ${Math.round(strength * 100)}%, ${base})`;
		const bubbleAlpha = Math.round(glassAlpha(BUBBLE_ALPHA[a.glass]) * a.bubbleOpacity);

		// Prose accents, on the other hand, are text: a mixed custom color would make
		// the picker lie about what you get, so `custom` is used verbatim. All three
		// accents answer the same four sources, and the theme accent is reachable from
		// any of them, so how much of the page repaints when the accent changes is then
		// the reader's own pick rather than a rule they cannot see.
		//
		// `off` MUST resolve to `currentColor` and never to the `inherit` keyword. A
		// custom property whose entire value is a CSS-wide keyword IS that keyword for
		// the property itself, so `--prose-quote-color: inherit` on <html> inherits from
		// nothing, leaves the property invalid, and every `var(--prose-quote-color, …)`
		// reader silently takes its fallback, which is the shipped tint. Off would
		// paint the default color instead of standing down.
		const proseColor = (source: ProseColorSource, custom: string, fallback: string) =>
			source === 'off'
				? 'currentColor'
				: source === 'accent'
					? accent
					: source === 'custom'
						? custom
						: fallback;

		// The story's legibility halo, for prose read straight off the workspace (a card
		// faded out, or Manuscript, which never draws one). Always the counterpart of the
		// palette's own ink (black behind light text, white behind dark), so it is one
		// number and not a color question, exactly like the two workspace scrims.
		const shadowInk = dark ? '0 0 0' : '255 255 255';
		const proseShadow =
			a.proseShadow <= 0
				? 'none'
				: `0 1px 2px rgb(${shadowInk} / ${(a.proseShadow * 62).toFixed(1)}%), 0 0 0.55em rgb(${shadowInk} / ${(a.proseShadow * 42).toFixed(1)}%)`;

		const pad = BUBBLE_PAD[a.bubblePadding];
		const avatar = AVATAR_SHAPE[a.avatarShape];
		// The outline and the drop shadow are parts of the card, so they fade WITH it:
		// every alpha on this card rides `bubbleOpacity`, which is what makes a drag of
		// that slider read as one surface dissolving instead of a fill sliding out from
		// under a full-strength frame. At zero all three reach transparent together, so
		// no branch is needed to "turn off" the card. Width stays put through the whole
		// range: fading the color leaves the geometry alone, so nothing reflows.
		const cardAlpha = (base: number) => (base * a.bubbleOpacity).toFixed(1);
		const msgShadow =
			a.bubbleShadow === 'none'
				? 'none'
				: a.bubbleShadow === 'lifted'
					? dark
						? `0 8px 22px rgb(0 0 0 / ${cardAlpha(32)}%)`
						: `0 6px 16px rgb(60 45 30 / ${cardAlpha(15)}%)`
					: dark
						? `0 2px 12px rgb(0 0 0 / ${cardAlpha(24)}%)`
						: `0 1px 3px rgb(60 45 30 / ${cardAlpha(10)}%)`;

		// The card's own radius, and the tighter notch on the corner nearest the
		// speaker. The notch tracks bubbleRadius only (the global Corners knob has
		// always left it at a flat 0.58rem, and shrinking it twice reads as a bug),
		// but it is capped at the card radius: a notch ROUNDER than the other corners
		// (sharp Corners × a wide card radius) inverts the whole point of it.
		const bubbleRadiusRem = (RADIUS_BASE.xl * a.radius + 0.14) * a.bubbleRadius;
		const notchRem = Math.min(0.58 * a.bubbleRadius, bubbleRadiusRem);

		const vars: Record<string, string> = {
			'--theme-bg-primary': c.bgPrimary,
			'--theme-bg-secondary': tinted(c.bgSecondary, glassAlpha(tier.secondary)),
			'--theme-bg-tertiary': tinted(c.bgTertiary, glassAlpha(tier.tertiary)),
			'--theme-bg-elevated': tinted(c.bgElevated, glassAlpha(tier.elevated)),
			// Fully opaque elevated tone, immune to the Glass setting. It is for surfaces
			// where content bleeding through would hurt (animated mockup popovers).
			'--theme-bg-solid': c.bgElevated,

			'--theme-text-primary': c.textPrimary,
			'--theme-text-secondary': textSecondary,
			'--theme-text-muted': textMuted,

			'--theme-accent': accent,
			'--theme-accent-hover': dark
				? `color-mix(in oklab, ${accent} 82%, white)`
				: `color-mix(in oklab, ${accent} 84%, black)`,
			'--theme-accent-muted': `color-mix(in srgb, ${accent} ${dark ? 23 : 18}%, transparent)`,
			'--theme-on-accent': dark
				? `color-mix(in srgb, ${accent} 20%, #16100d)`
				: `color-mix(in srgb, ${accent} 8%, white)`,

			'--theme-user-bubble': tinted(
				tintBubble(c.userBubble, a.userBubbleTint, a.userBubbleTintStrength),
				bubbleAlpha
			),
			'--theme-assistant-bubble': tinted(
				tintBubble(c.assistantBubble, a.assistantBubbleTint, a.assistantBubbleTintStrength),
				bubbleAlpha
			),

			'--theme-border': border,
			'--theme-border-subtle': borderSubtle,
			// A separator drawn ON a raised translucent tier (the composer's interior,
			// anything else painted over --theme-input-bg). `borderSubtle` is calibrated
			// against the BASE surface and has nothing left over up there, measuring
			// ~1.2:1 on every palette, which is no line at all. Nudging it toward the
			// palette's ink fixes both modes with one expression, since the ink is
			// near-white on a dark palette and near-black on a light one. The two
			// percentages are not one number because the ratio moves less per unit of
			// mix on a near-white surface: 80/65 lands every shipped palette at ~2.3:1.
			'--theme-border-raised': `color-mix(in srgb, ${borderSubtle} ${dark ? 80 : 65}%, ${c.textPrimary})`,

			'--theme-error': c.error,
			// The ink on a FILLED error surface (ui/Button's danger variant), minted the
			// same way as on-accent and for the same reason: every palette's error is a
			// light red, so plain white text on it measures around 2.5:1 and a hardcoded
			// one cannot answer a light palette at all.
			'--theme-on-error': dark
				? `color-mix(in srgb, ${c.error} 18%, #16100d)`
				: `color-mix(in srgb, ${c.error} 8%, white)`,
			'--theme-success': c.success,
			// Same recipe, same reason: the assistant launcher's badge sits ON the
			// success fill, and every palette's success is a light green.
			'--theme-on-success': dark
				? `color-mix(in srgb, ${c.success} 18%, #16100d)`
				: `color-mix(in srgb, ${c.success} 8%, white)`,
			'--theme-warning': c.warning,

			'--theme-sidebar-bg': dark
				? `color-mix(in srgb, ${c.bgPrimary} 86%, black 14%)`
				: `color-mix(in srgb, ${c.bgPrimary} 96%, black 4%)`,
			'--theme-input-bg': tinted(c.inputBg, glassAlpha(INPUT_ALPHA[a.glass])),
			'--theme-card-bg': tinted(c.cardBg, glassAlpha(CARD_ALPHA[a.glass])),
			'--theme-overlay': c.overlay,

			'--theme-shadow-sm': dark
				? '0 2px 12px rgb(0 0 0 / 24%)'
				: '0 1px 3px rgb(60 45 30 / 10%)',
			'--theme-shadow-md': dark
				? '0 18px 40px rgb(0 0 0 / 36%)'
				: '0 10px 28px rgb(60 45 30 / 14%)',
			'--theme-shadow-lg': dark
				? '0 30px 78px rgb(0 0 0 / 50%)'
				: '0 22px 56px rgb(60 45 30 / 20%)',
			'--theme-shadow-glow': `0 0 ${dark ? 44 : 36}px color-mix(in srgb, ${accent} ${dark ? 25 : 20}%, transparent)`,

			'--theme-backdrop-blur': `blur(${blur}px)`,
			'--theme-glass-border': `color-mix(in srgb, ${border} 76%, transparent)`,
			'--theme-panel-bg': `color-mix(in srgb, ${c.bgPrimary} ${glassAlpha(PANEL_ALPHA[a.glass])}%, transparent)`,
			'--theme-float-bg': tinted(c.bgElevated, glassAlpha(FLOAT_ALPHA[a.glass])),

			// Two workspace scrims, deliberately independent. Each is the palette's own
			// surface tone and nothing else: a scrim painted toward black is wrong on a
			// light palette by construction, and asking the user to pick a colour for a
			// thing whose whole job is to disappear was a question with no good answer.
			//
			// The column shade is handed over as an OPAQUE tone plus a separate strength
			// the shell applies as `opacity`, rather than pre-mixed with transparent.
			// That is what keeps the dither honest: the grain that stops the alpha ramp
			// banding is a second background layer on the same element, so pre-mixing
			// left it painting at full strength with the shade at zero: a stripe of
			// film grain sliding across the workspace whenever a dock animated the
			// column's overhang. Under one opacity the tint and its dither can only
			// move together, and zero means gone.
			'--theme-column-shade': c.bgSecondary,
			'--theme-column-shade-opacity': String(a.shadeOpacity),
			// The background image's dim is NOT here: it is plain black, hardcoded in
			// Workspace's `.background-dim`, because darkening a photograph is what a
			// dim IS and the palette has no say in it. Its strength lives with the
			// image it acts on (`backgroundConfig.dim`, Settings → Background).

			'--theme-font-body': bodyFont.stack,
			'--theme-font-ui': uiFont.stack,
			'--theme-font-mono': FONT_MONO,

			'--theme-radius-sm': rem(RADIUS_BASE.sm),
			'--theme-radius-md': rem(RADIUS_BASE.md),
			'--theme-radius-lg': rem(RADIUS_BASE.lg),
			'--theme-radius-xl': rem(RADIUS_BASE.xl),
			'--theme-radius-full': '9999px',

			'--user-font-scale': String(a.fontScale),
			'--user-line-height': String(a.lineHeight),
			'--user-paragraph-spacing': `${a.paragraphSpacing}em`,
			'--user-chat-width': String(a.chatWidth),

			// --- Message card (Settings → Chat). Chat/StreamingIndicator read
			// these instead of hardcoding the shipped geometry; the fallbacks baked
			// into those components are the same numbers, for first paint. ---
			'--msg-radius': `${bubbleRadiusRem.toFixed(3)}rem`,
			'--msg-radius-notch': `${notchRem.toFixed(3)}rem`,
			'--msg-radius-card': `${(RADIUS_BASE.lg * a.radius * a.bubbleRadius).toFixed(3)}rem`,
			'--msg-pad-x': pad.x,
			'--msg-pad-top': pad.top,
			'--msg-pad-bottom': pad.bottom,
			'--msg-border-width': BUBBLE_BORDER_WIDTH[a.bubbleBorder],
			'--msg-border-color':
				a.bubbleBorder === 'bold'
					? `color-mix(in srgb, ${border} ${cardAlpha(92)}%, transparent)`
					: `color-mix(in srgb, ${borderSubtle} ${cardAlpha(88)}%, transparent)`,
			'--msg-shadow': msgShadow,
			'--user-bubble-width': String(a.bubbleWidth),
			'--msg-row-gap': MESSAGE_SPACING[a.messageSpacing],
			'--msg-archived-opacity': String(a.archivedOpacity),
			'--msg-actions-idle-opacity': a.messageActions === 'always' ? '1' : '0',
			'--msg-actions-idle-events': a.messageActions === 'always' ? 'auto' : 'none',
			'--msg-action-label': a.compactActions ? 'none' : 'inline',
			'--msg-action-pad': a.compactActions ? '0 0.4rem' : '0 0.5rem',
			'--msg-action-gap': a.compactActions ? '0' : '0.3rem',
			'--msg-pager-idle-opacity': a.branchPager === 'always' ? '1' : '0',
			'--msg-pager-idle-events': a.branchPager === 'always' ? 'auto' : 'none',

			'--avatar-ratio': avatar.ratio,
			'--avatar-radius': avatar.radius,
			'--avatar-radius-sm': avatar.radiusSm,
			'--avatar-scale': String(a.avatarSize),

			// --- Story prose accents. Only the COLORS ride vars; each accent's face is
			//     an attribute below, for the reason stated there. ---
			'--prose-quote-color': proseColor(
				a.quoteColorSource,
				a.quoteColor,
				proseQuoteDefault(c.textPrimary)
			),
			'--prose-em-color': proseColor(a.emphasisColorSource, a.emphasisColor, textSecondary),
			'--prose-strong-color': proseColor(a.strongColorSource, a.strongColor, c.textPrimary),
			'--prose-shadow': proseShadow
		};

		// Attributes rather than vars, for two different reasons. `data-speaker-label`
		// and `-caps` each swing half a dozen properties, so one selector per state beats
		// a dozen vars, and they are two attributes because chrome and casing are two
		// combinable choices. The six story faces swing one property each and are
		// attributes because an attribute can declare NOTHING: a var has to spell its
		// neutral answer out, and `font-style: normal` on strong text cancels the emphasis
		// it sits inside, while `***word***` is one run wearing both accents. The base
		// rules in app.css ARE the shipped faces; each attribute states only its departure.
		const attrs: Record<string, string> = {
			'data-theme': p.id,
			'data-mode': p.mode,
			'data-motion': a.motion,
			'data-chat-style': a.chatStyle,
			'data-speaker-label': a.speakerLabel,
			'data-speaker-caps': a.speakerCaps ? 'on' : 'off',
			'data-quote-bold': a.quoteBold ? 'on' : 'off',
			'data-quote-italic': a.quoteItalic ? 'on' : 'off',
			'data-em-bold': a.emphasisBold ? 'on' : 'off',
			'data-em-italic': a.emphasisItalic ? 'on' : 'off',
			'data-strong-bold': a.strongBold ? 'on' : 'off',
			'data-strong-italic': a.strongItalic ? 'on' : 'off'
		};

		const html = document.documentElement;
		for (const [key, value] of Object.entries(vars)) {
			html.style.setProperty(key, value);
		}
		for (const [name, value] of Object.entries(attrs)) {
			html.setAttribute(name, value);
		}
		html.style.colorScheme = p.mode;

		// Keep mobile browser chrome in step with the surface color.
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', c.bgPrimary);

		// iOS standalone reads its status-bar glyphs from its own tag and ignores
		// theme-color entirely: `black-translucent` paints them white over a
		// transparent bar, which is right on every dark palette and unreadable on a
		// light one, where `default` gives dark glyphs on a light bar instead.
		document
			.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
			?.setAttribute('content', p.mode === 'dark' ? 'black-translucent' : 'default');

		writePaintCache(vars, attrs);
	}
}

export const themeStore = new ThemeStore();
