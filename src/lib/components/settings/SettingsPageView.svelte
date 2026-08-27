<script lang="ts">
	import GeneralPage from './GeneralPage.svelte';
	import ConnectionsPage from './ConnectionsPage.svelte';
	import InterfacePage from './InterfacePage.svelte';
	import ChatPage from './ChatPage.svelte';
	import OverridesPage from './OverridesPage.svelte';	import AdvancedPage from './AdvancedPage.svelte';
	import SecurityPage from './SecurityPage.svelte';
	import EnginesPage from './EnginesPage.svelte';
	import ImportPage from './ImportPage.svelte';
	import BackupsPage from './BackupsPage.svelte';
	import RegexPage from './RegexPage.svelte';
	import AboutPage from './AboutPage.svelte';
	import DeveloperPage from './DeveloperPage.svelte';
	import PromptBuilderView from '$lib/components/promptBuilder/PromptBuilderView.svelte';
	import type { SettingsPage } from '$lib/config/settings-pages';

	/** One settings page's content. The drill-down panel and the split-view
	 *  centered panel render pages through this single switch. */
	interface Props {
		page: SettingsPage;
	}

	let { page }: Props = $props();
</script>

{#if page === 'overrides'}
	<OverridesPage />
{:else if page === 'connections'}
	<ConnectionsPage />{:else if page === 'interface'}
	<InterfacePage />
{:else if page === 'chat'}
	<ChatPage />
{:else if page === 'general'}
	<GeneralPage />
{:else if page === 'engines'}
	<EnginesPage />
{:else if page === 'security'}
	<SecurityPage />
{:else if page === 'import'}
	<ImportPage />
{:else if page === 'backups'}
	<BackupsPage />
{:else if page === 'prompt-builder'}
	<PromptBuilderView />
{:else if page === 'regex'}
	<RegexPage />
{:else if page === 'advanced'}
	<AdvancedPage />
{:else if page === 'about'}
	<AboutPage />
{:else if page === 'developer'}
	<DeveloperPage />
{/if}
