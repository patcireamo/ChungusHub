/** The app's Motion setting or the system's own reduced-motion preference. */
export function motionReduced(): boolean {
	return (
		document.documentElement.dataset.motion === 'reduced' ||
		matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}
